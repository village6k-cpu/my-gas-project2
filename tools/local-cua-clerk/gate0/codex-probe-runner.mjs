import { spawn as nodeSpawn } from 'node:child_process';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile } from 'node:fs/promises';
import { makeProbe } from './probe-contract.mjs';

// This is deliberately immutable. Terminal and LaunchAgent runners import the
// same bytes so a live probe cannot silently drift between launch modes.
export const PROBE_PAYLOAD = Object.freeze(
  'Use node_repl with @oai/sky only to check whether Chrome accessibility is available and whether screenshot capability is available. If node_repl is not present in your provided tools, do not use shell or command execution as a fallback; return both booleans as false. Return JSON only: {"chromeAccessibilityAvailable":true|false,"screenshotAvailable":true|false}. Do not return accessibility text, an AX tree, a screenshot, page text, credentials, or any other data. Do not click, type, submit, or mutate anything.',
);
export const PROBE_ARGS = Object.freeze(['exec', '--ephemeral', '--json']);
export const PINNED_CODEX_PATH = '/Users/choijaehyeong/.codex/packages/standalone/releases/0.147.0-aarch64-apple-darwin/bin/codex';

const BOOLEAN_KEYS = new Set(['chromeAccessibilityAvailable', 'screenshotAvailable']);
const ERROR_CLASSES = new Set(['command_failed', 'timeout', 'malformed_evidence', 'not_available']);
const FAILURE_CRITERIA = Object.freeze({
  terminal_cua: Object.freeze({ command: 'codex_probe', identity: 'codex_probe_identity', timeout: 'codex_probe_timeout' }),
  launchagent_cua: Object.freeze({ command: 'launchagent_probe', identity: 'launchagent_probe_identity', timeout: 'launchagent_probe_timeout' }),
});
export const MAX_JSONL_BYTES = 64 * 1024;
const readProcessStart = promisify(execFile);
const identityEqual = (a, b) => typeof a === 'string' && typeof b === 'string' ? a === b : JSON.stringify(a) === JSON.stringify(b);
async function defaultIdentityReader(pid) { const r = await readProcessStart('/bin/ps', ['-p', String(pid), '-o', 'pid=,pgid=,ppid=,sess=,lstart=']); const parts = String(r.stdout).trim().split(/\s+/); if (parts.length < 5) throw new Error('identity'); return Object.freeze({ pid: parts[0], pgid: parts[1], ppid: parts[2], session: parts[3], start: parts.slice(4).join(' ') }); }
async function boundedIdentity(reader, pid, deadline) { const remaining = deadline - Date.now(); if (remaining <= 0) return undefined; let timer; const timeout = new Promise(resolve => { timer = setTimeout(() => resolve(undefined), remaining); }); try { return await Promise.race([Promise.resolve().then(() => reader(pid)), timeout]); } catch { return undefined; } finally { clearTimeout(timer); } }

async function cleanupExactChild(child, codexPath, deadline) {
  if (!child || child.spawnfile !== codexPath || !Number.isInteger(child.pid) || child.pid <= 1) return false;
  if (child.exitCode !== null || child.signalCode !== null) return true;
  if (typeof child.kill !== 'function' || typeof child.once !== 'function') return false;

  const waitForClose = until => new Promise(resolve => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve(true);
    const remaining = until - Date.now();
    if (remaining <= 0) return resolve(false);
    let settled = false;
    const finish = value => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.removeListener?.('close', onClose);
      resolve(value);
    };
    const onClose = () => finish(true);
    const timer = setTimeout(() => finish(false), remaining);
    child.once('close', onClose);
  });

  const remaining = deadline - Date.now();
  if (remaining <= 0) return false;
  try { child.kill('SIGTERM'); } catch { return false; }
  const termDeadline = Math.min(deadline, Date.now() + Math.max(1, Math.floor(remaining / 2)));
  if (await waitForClose(termDeadline)) return true;
  if (child.exitCode !== null || child.signalCode !== null) return true;
  try { child.kill('SIGKILL'); } catch { return false; }
  return waitForClose(deadline);
}

function safeErrorClass(value) { return ERROR_CLASSES.has(value) ? value : 'command_failed'; }

function containsProbeBooleanKey(value) {
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some(containsProbeBooleanKey);
  return Object.entries(value).some(([key, nested]) => BOOLEAN_KEYS.has(key) || containsProbeBooleanKey(nested));
}

function exactBooleanRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const keys = Object.keys(value).sort();
  if (keys.length !== 2 || keys[0] !== 'chromeAccessibilityAvailable' || keys[1] !== 'screenshotAvailable') return undefined;
  if (typeof value.chromeAccessibilityAvailable !== 'boolean' || typeof value.screenshotAvailable !== 'boolean') return undefined;
  return Object.freeze({ chromeAccessibilityAvailable: value.chromeAccessibilityAvailable, screenshotAvailable: value.screenshotAvailable });
}

function designatedResult(event) {
  const direct = exactBooleanRecord(event);
  if (direct) return direct;
  if (event?.type !== 'item.completed' || event?.item?.type !== 'agent_message' || typeof event.item.text !== 'string') return undefined;
  const eventKeys = Object.keys(event).sort();
  const itemKeys = Object.keys(event.item).sort();
  const eventExact = eventKeys.length === 2 && eventKeys[0] === 'item' && eventKeys[1] === 'type';
  const itemExact = (itemKeys.length === 2 && itemKeys[0] === 'text' && itemKeys[1] === 'type')
    || (itemKeys.length === 3 && itemKeys[0] === 'id' && itemKeys[1] === 'text' && itemKeys[2] === 'type' && typeof event.item.id === 'string');
  if (!eventExact || !itemExact) throw new Error('malformed');
  let record;
  try { record = JSON.parse(event.item.text); } catch { throw new Error('malformed'); }
  const parsed = exactBooleanRecord(record);
  if (!parsed) throw new Error('malformed');
  return parsed;
}

export function parseProbeJsonl(text) {
  const source = String(text ?? '');
  if (Buffer.byteLength(source) > MAX_JSONL_BYTES) throw new Error('overflow');
  const lines = source.split(/\r?\n/).filter(Boolean);
  if (!lines.length) throw new Error('malformed');
  let found;
  for (const line of lines) {
    let event;
    try { event = JSON.parse(line); } catch { throw new Error('malformed'); }
    const result = designatedResult(event);
    if (result) {
      if (found) throw new Error('malformed');
      found = result;
    } else if (containsProbeBooleanKey(event)) throw new Error('malformed');
  }
  if (!found) throw new Error('malformed');
  return found;
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
  if (await boundedIdentity(identityReader, process.pid, deadline - cleanupReserve) === undefined) return makeProbe({ probeId, result: 'BLOCKED', checkedAt: now(), runId, evidence: { status: 'unknown', criterion: FAILURE_CRITERIA[probeId].identity, pointer: 'preflight_unavailable' }, errorClass: 'timeout' });
  let child;
  try { child = spawnImpl(codexPath, [...PROBE_ARGS, PROBE_PAYLOAD], { detached: true, stdio: ['ignore', 'pipe', 'pipe'] }); } catch {
    return makeProbe({ probeId, result: 'BLOCKED', checkedAt: now(), runId, evidence: { status: 'unknown', criterion: FAILURE_CRITERIA[probeId].command, pointer: 'spawn_error' }, errorClass: 'command_failed' });
  }
  if (!child || typeof child !== 'object') return makeProbe({ probeId, result: 'BLOCKED', checkedAt: now(), runId, evidence: { status: 'unknown', criterion: FAILURE_CRITERIA[probeId].command, pointer: 'spawn_error' }, errorClass: 'command_failed' });
  let childErrorSeen = false;
  let handleChildError;
  child.once?.('error', () => { childErrorSeen = true; handleChildError?.(); });
  let stdout = '';
  let stdoutBytes = 0;
  let stdoutOverflowed = false;
  let earlyClose;
  child.once?.('close', code => { earlyClose = code; });
  child.stdout?.on('data', chunk => {
    if (stdoutOverflowed) return;
    const bytes = Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(String(chunk));
    if (stdoutBytes + bytes > MAX_JSONL_BYTES) {
      stdoutOverflowed = true;
      stdout = '';
      return;
    }
    stdoutBytes += bytes;
    stdout += String(chunk);
  });
  child.stderr?.on('data', () => {}); // Never retain or print subprocess diagnostics.
  let expectedIdentity;
  try { expectedIdentity = await boundedIdentity(identityReader, child.pid, deadline - cleanupReserve); } catch { expectedIdentity = undefined; }
  if (childErrorSeen) return makeProbe({ probeId, result: 'BLOCKED', checkedAt: now(), runId, evidence: { status: 'unknown', criterion: FAILURE_CRITERIA[probeId].command, pointer: 'spawn_error' }, errorClass: 'command_failed' });
  if (expectedIdentity === undefined) {
    const reaped = await cleanupExactChild(child, codexPath, deadline);
    if (childErrorSeen) return makeProbe({ probeId, result: 'BLOCKED', checkedAt: now(), runId, evidence: { status: 'unknown', criterion: FAILURE_CRITERIA[probeId].command, pointer: 'spawn_error' }, errorClass: 'command_failed' });
    return makeProbe({ probeId, result: 'BLOCKED', checkedAt: now(), runId, evidence: { status: 'unknown', criterion: FAILURE_CRITERIA[probeId].identity, pointer: reaped ? 'identity_capture_failed_child_reaped' : 'cleanup_incomplete' }, errorClass: 'timeout' });
  }
  const outcome = await new Promise(resolve => {
    let settled = false;
    let escalation;
    let timeoutStarted = false;
    const finish = value => { if (!settled) { settled = true; clearTimeout(timer); clearTimeout(escalation); resolve(value); } };
    handleChildError = () => finish(makeProbe({ probeId, result: 'BLOCKED', checkedAt: now(), runId, evidence: { status: 'unknown', criterion: FAILURE_CRITERIA[probeId].command, pointer: 'spawn_error' }, errorClass: 'command_failed' }));
    if (childErrorSeen) handleChildError();
    const timer = setTimeout(() => { timeoutStarted = true; void (async () => {
      let currentIdentity;
      try { currentIdentity = await boundedIdentity(identityReader, child.pid, deadline); } catch {}
      const owned = terminateOwnedGroup(child, codexPath, killImpl, expectedIdentity, currentIdentity);
      if (owned) escalation = setTimeout(() => { void (async () => { let latest; try { latest = await boundedIdentity(identityReader, child.pid, deadline); } catch {} const revalidated = latest !== undefined && identityEqual(latest, expectedIdentity) && terminateOwnedGroup(child, codexPath, killImpl, expectedIdentity, latest, null); if (revalidated) { try { killImpl(-child.pid, 'SIGKILL'); } catch {} } finish(makeProbe({ probeId, result: 'BLOCKED', checkedAt: now(), runId, evidence: { status: 'unknown', criterion: FAILURE_CRITERIA[probeId].timeout, pointer: revalidated ? 'child_group_escalated' : 'child_group_not_terminated' }, errorClass: 'timeout' })); })(); }, 25);
      else finish(makeProbe({ probeId, result: 'BLOCKED', checkedAt: now(), runId, evidence: { status: 'unknown', criterion: FAILURE_CRITERIA[probeId].timeout, pointer: 'child_group_not_terminated' }, errorClass: 'timeout' }));
    })(); }, Math.max(1, deadline - Date.now() - cleanupReserve));
    const handleClose = code => {
      if (timeoutStarted) return;
      try {
        if (stdoutOverflowed) throw new Error('overflow');
        const result = parseProbeJsonl(stdout);
        if (code !== 0) throw new Error('command');
        if (!result.chromeAccessibilityAvailable || !result.screenshotAvailable) throw new Error('not_available');
        finish(makeProbe({ probeId, result: 'PASS', checkedAt: now(), runId, evidence: { status: 'available', criterion: 'chrome_accessibility_screenshot', pointer: 'boolean_only' } }));
      } catch (error) {
        const notAvailable = error?.message === 'not_available';
        const overflow = error?.message === 'overflow';
        finish(makeProbe({ probeId, result: notAvailable ? 'FAIL' : 'BLOCKED', checkedAt: now(), runId, evidence: { status: notAvailable ? 'denied' : 'unknown', criterion: FAILURE_CRITERIA[probeId].command, pointer: notAvailable ? 'capability_unavailable' : overflow ? 'output_limit_exceeded' : (code === 0 ? 'malformed_jsonl' : 'command_failed') }, errorClass: notAvailable ? 'not_available' : (overflow || code === 0 ? 'malformed_evidence' : 'command_failed') }));
      }
    };
    if (earlyClose !== undefined) handleClose(earlyClose); else child.once?.('close', handleClose);
  });
  return outcome;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const value = name => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : undefined; };
  const output = value('--output');
  const result = await runCodexProbe({ codexPath: value('--codex-path'), probeId: value('--probe-id') ?? 'terminal_cua', runId: value('--run-id') });
  if (output) await writeFile(output, JSON.stringify(result) + '\n', { mode: 0o600 });
  else process.stdout.write(JSON.stringify(result) + '\n');
}
