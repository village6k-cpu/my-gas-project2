import { spawn as nodeSpawn } from 'node:child_process';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile } from 'node:fs/promises';
import { makeProbe } from './probe-contract.mjs';

// This is deliberately immutable. Terminal and LaunchAgent runners import the
// same bytes so a live probe cannot silently drift between launch modes.
export const PROBE_PAYLOAD = Object.freeze(
  'Use node_repl with @oai/sky only to check whether Chrome accessibility is available and whether screenshot capability is available. Return JSON only: {"chromeAccessibilityAvailable":true|false,"screenshotAvailable":true|false}. Do not return accessibility text, an AX tree, a screenshot, page text, credentials, or any other data. Do not click, type, submit, or mutate anything.',
);
export const PROBE_ARGS = Object.freeze(['exec', '--ephemeral', '--json']);
export const PINNED_CODEX_PATH = '/opt/homebrew/bin/codex';

const BOOLEAN_KEYS = new Set(['chromeAccessibilityAvailable', 'screenshotAvailable']);
const ERROR_CLASSES = new Set(['command_failed', 'timeout', 'malformed_evidence', 'not_available']);
const readProcessStart = promisify(execFile);
const identityEqual = (a, b) => typeof a === 'string' && typeof b === 'string' ? a === b : JSON.stringify(a) === JSON.stringify(b);
async function defaultIdentityReader(pid) { const r = await readProcessStart('/bin/ps', ['-p', String(pid), '-o', 'pid=,pgid=,ppid=,sess=,lstart=']); const parts = String(r.stdout).trim().split(/\s+/); if (parts.length < 5) throw new Error('identity'); return Object.freeze({ pid: parts[0], pgid: parts[1], ppid: parts[2], session: parts[3], start: parts.slice(4).join(' ') }); }
async function boundedIdentity(reader, pid, deadline) { const remaining = deadline - Date.now(); if (remaining <= 0) return undefined; let timer; const timeout = new Promise(resolve => { timer = setTimeout(() => resolve(undefined), remaining); }); try { return await Promise.race([Promise.resolve().then(() => reader(pid)), timeout]); } finally { clearTimeout(timer); } }

function safeErrorClass(value) { return ERROR_CLASSES.has(value) ? value : 'command_failed'; }

function collectBooleans(value, out) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  for (const [key, item] of Object.entries(value)) {
    if (BOOLEAN_KEYS.has(key) && typeof item === 'boolean') out[key] = item;
    if (item && typeof item === 'object') collectBooleans(item, out);
  }
}

export function parseProbeJsonl(text) {
  const found = {};
  const lines = String(text ?? '').split(/\r?\n/).filter(Boolean);
  if (!lines.length) throw new Error('malformed');
  for (const line of lines) {
    let event;
    try { event = JSON.parse(line); } catch { throw new Error('malformed'); }
    collectBooleans(event, found);
  }
  if (typeof found.chromeAccessibilityAvailable !== 'boolean' || typeof found.screenshotAvailable !== 'boolean') throw new Error('malformed');
  return Object.freeze(found);
}

function makeEvidence(result, checkedAt, runId) {
  return makeProbe({
    probeId: 'terminal_cua', result, checkedAt, runId,
    evidence: { status: result === 'PASS' ? 'available' : 'unknown', criterion: 'chrome_accessibility_screenshot', pointer: 'boolean_only' },
    ...(result !== 'PASS' ? { errorClass: result === 'BLOCKED' ? 'timeout' : 'malformed_evidence' } : {}),
  });
}

function assertPinnedPath(codexPath) {
  if (typeof codexPath !== 'string' || !codexPath.startsWith('/')) throw new TypeError('codex path must be absolute');
}

export function terminateOwnedGroup(child, codexPath, kill = process.kill, expectedIdentity, currentIdentity = expectedIdentity, signal = 'SIGTERM') {
  if (!child || !Number.isInteger(child.pid) || child.pid <= 1) return false;
  if (child.spawnfile !== codexPath || child.exitCode !== null || child.signalCode !== null || child.killed || expectedIdentity === undefined || !identityEqual(currentIdentity, expectedIdentity)) return false;
  if (!signal) return true;
  try { kill(-child.pid, signal); return true; } catch { return false; }
}

export async function runCodexProbe({ codexPath = PINNED_CODEX_PATH, allowTestOverrides = false, spawnImpl = nodeSpawn, timeoutMs = 30_000, killImpl = process.kill, identityReader = defaultIdentityReader, probeId = 'terminal_cua', now = () => new Date().toISOString(), runId = undefined } = {}) {
  assertPinnedPath(codexPath);
  if (!allowTestOverrides && codexPath !== PINNED_CODEX_PATH) throw new TypeError('codex path is not pinned');
  if (probeId !== 'terminal_cua' && probeId !== 'launchagent_cua') throw new TypeError('invalid probe id');
  const cleanupReserve = Math.min(50, Math.max(10, Math.floor(timeoutMs / 2)));
  const deadline = Date.now() + timeoutMs;
  if (await boundedIdentity(identityReader, process.pid, deadline - cleanupReserve) === undefined) return makeProbe({ probeId, result: 'BLOCKED', checkedAt: now(), runId, evidence: { status: 'unknown', criterion: 'codex_probe_identity', pointer: 'preflight_unavailable' }, errorClass: 'timeout' });
  const child = spawnImpl(codexPath, [...PROBE_ARGS, PROBE_PAYLOAD], { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let earlyClose;
  child.once?.('close', code => { earlyClose = code; });
  child.stdout?.on('data', chunk => { stdout += String(chunk); });
  child.stderr?.on('data', () => {}); // Never retain or print subprocess diagnostics.
  let expectedIdentity;
  try { expectedIdentity = await boundedIdentity(identityReader, child.pid, deadline - cleanupReserve); } catch { expectedIdentity = undefined; }
  if (expectedIdentity === undefined) { try { child.kill?.('SIGTERM'); } catch {} return makeProbe({ probeId, result: 'BLOCKED', checkedAt: now(), runId, evidence: { status: 'unknown', criterion: 'codex_probe_identity', pointer: 'cleanup_incomplete' }, errorClass: 'timeout' }); }
  const outcome = await new Promise(resolve => {
    let settled = false;
    let escalation;
    const finish = value => { if (!settled) { settled = true; clearTimeout(timer); clearTimeout(escalation); resolve(value); } };
    const timer = setTimeout(() => { void (async () => {
      let currentIdentity;
      try { currentIdentity = await boundedIdentity(identityReader, child.pid, deadline); } catch {}
      const owned = terminateOwnedGroup(child, codexPath, killImpl, expectedIdentity, currentIdentity);
      if (owned) escalation = setTimeout(() => { void (async () => { let latest; try { latest = await boundedIdentity(identityReader, child.pid, deadline); } catch {} const revalidated = latest !== undefined && identityEqual(latest, expectedIdentity) && terminateOwnedGroup(child, codexPath, killImpl, expectedIdentity, latest, null); if (revalidated) { try { killImpl(-child.pid, 'SIGKILL'); } catch {} } finish(makeProbe({ probeId, result: 'BLOCKED', checkedAt: now(), runId, evidence: { status: 'unknown', criterion: 'codex_probe_timeout', pointer: revalidated ? 'child_group_escalated' : 'child_group_not_terminated' }, errorClass: 'timeout' })); })(); }, 25);
      else finish(makeProbe({ probeId, result: 'BLOCKED', checkedAt: now(), runId, evidence: { status: 'unknown', criterion: 'codex_probe_timeout', pointer: 'child_group_not_terminated' }, errorClass: 'timeout' }));
    })(); }, Math.max(1, deadline - Date.now() - cleanupReserve));
    child.once?.('error', () => finish(makeProbe({ probeId, result: 'BLOCKED', checkedAt: now(), runId, evidence: { status: 'unknown', criterion: 'codex_probe', pointer: 'spawn_error' }, errorClass: 'command_failed' })));
    const handleClose = code => {
      try {
        const result = parseProbeJsonl(stdout);
        if (code !== 0) throw new Error('command');
        if (!result.chromeAccessibilityAvailable || !result.screenshotAvailable) throw new Error('not_available');
        finish(makeProbe({ probeId, result: 'PASS', checkedAt: now(), runId, evidence: { status: 'available', criterion: 'chrome_accessibility_screenshot', pointer: 'boolean_only' } }));
      } catch (error) { const notAvailable = error?.message === 'not_available'; finish(makeProbe({ probeId, result: notAvailable ? 'FAIL' : 'BLOCKED', checkedAt: now(), runId, evidence: { status: notAvailable ? 'denied' : 'unknown', criterion: 'codex_probe', pointer: notAvailable ? 'capability_unavailable' : (code === 0 ? 'malformed_jsonl' : 'command_failed') }, errorClass: notAvailable ? 'not_available' : (code === 0 ? 'malformed_evidence' : 'command_failed') })); }
    };
    if (earlyClose !== undefined) handleClose(earlyClose); else child.once?.('close', handleClose);
  });
  return outcome;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const value = name => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : undefined; };
  const output = value('--output');
  const result = await runCodexProbe({ codexPath: value('--codex-path'), probeId: value('--probe-id') ?? 'terminal_cua' });
  if (output) await writeFile(output, JSON.stringify(result) + '\n', { mode: 0o600 });
  else process.stdout.write(JSON.stringify(result) + '\n');
}
