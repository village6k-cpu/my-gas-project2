// Incident recovery intake only. No imports from the worker, gateway, ledger or notification stack.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const RESERVE_BYTES = 256 * 1024 * 1024;
const ALLOWED_ORIGINS = new Set(['https://business.kakao.com', 'https://center-pf.kakao.com']);
export function createRecoveryCollector({
  directory, maxBodyBytes = 1024 * 1024, maxJournalBytes = 64 * 1024 * 1024,
  availableBytes = () => { const s = fs.statfsSync(directory); return Number(s.bavail) * Number(s.bsize); }
} = {}) {
  if (!directory || !path.isAbsolute(directory) || !fs.statSync(directory).isDirectory()) {
    throw new Error('An existing absolute recovery directory is required');
  }
  const runId = randomUUID(), startedAt = new Date().toISOString();
  const lockPath = path.join(directory, 'recovery-collector.lock');
  const journalPath = path.join(directory, 'events-' + runId + '.ndjson');
  const lockFd = fs.openSync(lockPath, 'wx');
  fs.writeFileSync(lockFd, JSON.stringify({ runId, pid: process.pid, startedAt }));
  fs.fsyncSync(lockFd);
  fs.closeSync(lockFd);
  let journalFd;
  try { journalFd = fs.openSync(journalPath, 'wx'); } catch (error) { fs.unlinkSync(lockPath); throw error; }
  let received = 0, bytes = 0, lastReceivedAt = null, storageError = null, closed = false;
  function closeStorage() {
    if (closed) return;
    closed = true;
    fs.closeSync(journalFd);
    // A crashed collector leaves its lock intact; never steal another collector's ownership.
    if (JSON.parse(fs.readFileSync(lockPath, 'utf8')).runId === runId) fs.unlinkSync(lockPath);
  }
  function persist(event) {
    if (storageError) throw new Error('storage_fault_requires_review');
    const receivedAt = new Date().toISOString(), sequence = received + 1;
    const source = JSON.stringify(event);
    const line = Buffer.from(JSON.stringify({
      schema: 'village-recovery-intake/v1', runId, sequence, receivedAt,
      processed: false, sourceSha256: createHash('sha256').update(source).digest('hex'), event
    }) + '\n');
    if (availableBytes() - line.length < RESERVE_BYTES || bytes + line.length > maxJournalBytes) {
      storageError = 'storage_capacity';
      throw new Error('storage_capacity');
    }
    try {
      let written = 0;
      while (written < line.length) {
        const n = fs.writeSync(journalFd, line, written, line.length - written);
        if (n <= 0) throw new Error('short_write');
        written += n;
      }
      fs.fsyncSync(journalFd);
    } catch (error) {
      storageError = String(error.code || 'storage_write_failed');
      throw new Error('storage_fault_requires_review');
    }
    received = sequence; bytes += line.length; lastReceivedAt = receivedAt;
    return { sequence, receivedAt };
  }
  const server = http.createServer(async (req, res) => {
    const origin = req.headers.origin;
    const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };
    const reply = (status, body) => { res.writeHead(status, headers); res.end(JSON.stringify(body)); };
    if (origin && !ALLOWED_ORIGINS.has(origin)) return reply(403, { ok: false, error: 'origin_not_allowed' });
    if (origin) Object.assign(headers, {
      'Access-Control-Allow-Origin': origin, Vary: 'Origin',
      'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Allow-Private-Network': 'true'
    });
    const pathname = new URL(req.url, 'http://127.0.0.1').pathname;
    if (req.method === 'GET' && pathname === '/health') return reply(200, {
      ok: !storageError, mode: 'recovery_collect_only', businessAutomationReady: false,
      customerSendingEnabled: false, workerEnabled: false, gatewayRecoveryEnabled: false,
      runId, pid: process.pid, startedAt, received, bytes, lastReceivedAt, storageError
    });
    if (req.method === 'OPTIONS' && pathname === '/events') return reply(200, { ok: true });
    if (req.method !== 'POST' || pathname !== '/events') {
      return reply(503, { ok: false, error: 'recovery_collect_only', processed: false });
    }
    let size = 0;
    const chunks = [];
    try {
      for await (const chunk of req) {
        size += chunk.length;
        if (size > maxBodyBytes) { req.resume(); return reply(413, { ok: false, persisted: false }); }
        chunks.push(chunk);
      }
      let event;
      try { event = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch {
        return reply(400, { ok: false, persisted: false, error: 'invalid_json' });
      }
      if (!event || typeof event !== 'object' || Array.isArray(event)) {
        return reply(400, { ok: false, persisted: false, error: 'event_object_required' });
      }
      const receipt = persist(event);
      return reply(200, { ok: true, persisted: true, processed: false, mode: 'recovery_collect_only', ...receipt });
    } catch (error) {
      return reply(507, { ok: false, persisted: false, processed: false, error: String(error.message) });
    }
  });
  server.requestTimeout = 10000;
  server.headersTimeout = 10000;
  server.on('close', closeStorage);
  return { server, journalPath, closeStorage };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const directory = process.argv[2], port = Number(process.argv[3] || 8787);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid local port');
  const collector = createRecoveryCollector({ directory });
  collector.server.once('error', error => { collector.closeStorage(); console.error(error.code || error.message); process.exitCode = 1; });
  collector.server.listen(port, '127.0.0.1', () => console.log(JSON.stringify({
    mode: 'recovery_collect_only', businessAutomationReady: false, pid: process.pid,
    port, journalPath: collector.journalPath
  })));
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => collector.server.close());
}
