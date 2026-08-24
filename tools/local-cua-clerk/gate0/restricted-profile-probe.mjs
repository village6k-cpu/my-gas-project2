import { execFile as nodeExecFile } from 'node:child_process';
import { promisify } from 'node:util';
import { MAX_JSONL_BYTES, PINNED_CODEX_PATH } from './codex-probe-runner.mjs';
import { makeProbe } from './probe-contract.mjs';

const execFile = promisify(nodeExecFile);
const ASSERTION_KEYS = Object.freeze(['directNodeReplAllowed', 'rawInputInjectionAllowed', 'helperSocketAccessAllowed', 'ledgerWriteAllowed', 'narrowActionPathWorks']);
const RECORD_KEYS = Object.freeze(['shellPresent', ...ASSERTION_KEYS]);
const RESERVED_KEYS = new Set(RECORD_KEYS);
const NORMAL_ARGS = Object.freeze(['exec', '--ephemeral', '--json']);
const RESTRICTED_ARGS = Object.freeze(['exec', '--ignore-user-config', '--sandbox', 'read-only', '--ephemeral', '--json']);
export const RESTRICTED_PROBE_PAYLOAD = Object.freeze('Do not use any tools. Inspect only the tool metadata provided to you and return exactly one JSON object with booleans: {"shellPresent":true|false,"directNodeReplAllowed":true|false,"rawInputInjectionAllowed":true|false,"helperSocketAccessAllowed":true|false,"ledgerWriteAllowed":true|false,"narrowActionPathWorks":true|false}. If a capability cannot be established from the provided tool metadata alone, return false. Do not perform GUI, input, credential, HomeTax, or other external actions.');

function parseBooleanRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('malformed');
  const keys = Object.keys(value).sort();
  const expected = [...RECORD_KEYS].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) throw new Error('malformed');
  const out = {};
  for (const key of RECORD_KEYS) {
    if (typeof value[key] !== 'boolean') throw new Error('malformed');
    out[key] = value[key];
  }
  return Object.freeze(out);
}

function exactRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const keys = Object.keys(value).sort();
  const expected = [...RECORD_KEYS].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) return undefined;
  return parseBooleanRecord(value);
}

function containsReservedKey(value) {
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some(containsReservedKey);
  return Object.entries(value).some(([key, nested]) => RESERVED_KEYS.has(key) || containsReservedKey(nested));
}

function designatedResult(event) {
  const direct = exactRecord(event);
  if (direct) return direct;
  if (event?.type !== 'item.completed' || event?.item?.type !== 'agent_message' || typeof event.item.text !== 'string') return undefined;
  const eventKeys = Object.keys(event).sort();
  const itemKeys = Object.keys(event.item).sort();
  const eventExact = eventKeys.length === 2 && eventKeys[0] === 'item' && eventKeys[1] === 'type';
  const itemExact = (itemKeys.length === 2 && itemKeys[0] === 'text' && itemKeys[1] === 'type')
    || (itemKeys.length === 3 && itemKeys[0] === 'id' && itemKeys[1] === 'text' && itemKeys[2] === 'type' && typeof event.item.id === 'string');
  if (!eventExact || !itemExact) throw new Error('malformed');
  let value;
  try { value = JSON.parse(event.item.text); } catch { throw new Error('malformed'); }
  return parseBooleanRecord(value);
}

export function parseRestrictedJsonl(text) {
  const source = String(text ?? '');
  if (Buffer.byteLength(source) > MAX_JSONL_BYTES) throw new Error('malformed');
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
    } else if (containsReservedKey(event)) throw new Error('malformed');
  }
  if (!found) throw new Error('malformed');
  return found;
}

export function classifyExecFailure(error) {
  const timedOut = error?.code === 'ETIMEDOUT' || (error?.killed === true && typeof error?.signal === 'string');
  return { exitCode: timedOut ? null : (Number.isInteger(error?.code) ? error.code : 1), timedOut, stdout: '' };
}

async function defaultCommand(path, args) {
  try { const value = await execFile(path, args, { timeout: 30_000, maxBuffer: MAX_JSONL_BYTES }); return { exitCode: 0, timedOut: false, stdout: value.stdout }; }
  catch (error) { return classifyExecFailure(error); }
}

function evidenceFor(normal, restricted) {
  const assertions = Object.fromEntries(ASSERTION_KEYS.map(key => [key, restricted[key]]));
  return { assertions, normalShellPresent: normal.shellPresent, restrictedShellPresent: restricted.shellPresent, directNodeReplDenied: restricted.directNodeReplAllowed === false };
}

export async function runRestrictedProfileProbe({ codexPath = PINNED_CODEX_PATH, allowTestOverrides = false, command = defaultCommand, now = () => new Date().toISOString(), runId } = {}) {
  if (typeof codexPath !== 'string' || !codexPath.startsWith('/') || (!allowTestOverrides && codexPath !== PINNED_CODEX_PATH)) throw new TypeError('codex path is not pinned');
  const invoke = (args) => command(codexPath, [...args, RESTRICTED_PROBE_PAYLOAD], { profile: args === NORMAL_ARGS ? 'normal' : 'restricted' });
  let normal, restricted;
  try {
    const normalResult = await invoke(NORMAL_ARGS);
    if (normalResult?.timedOut) return makeProbe({ probeId: 'restricted_profile', result: 'BLOCKED', checkedAt: now(), runId, evidence: { assertions: Object.fromEntries(ASSERTION_KEYS.map(k => [k, false])), normalShellPresent: false, restrictedShellPresent: false, directNodeReplDenied: false }, errorClass: 'timeout' });
    if (normalResult?.exitCode !== 0) return makeProbe({ probeId: 'restricted_profile', result: 'BLOCKED', checkedAt: now(), runId, evidence: { assertions: Object.fromEntries(ASSERTION_KEYS.map(k => [k, false])), normalShellPresent: false, restrictedShellPresent: false, directNodeReplDenied: false }, errorClass: 'command_failed' });
    normal = parseRestrictedJsonl(normalResult.stdout);
    const restrictedResult = await invoke(RESTRICTED_ARGS);
    if (restrictedResult?.timedOut) return makeProbe({ probeId: 'restricted_profile', result: 'BLOCKED', checkedAt: now(), runId, evidence: { assertions: Object.fromEntries(ASSERTION_KEYS.map(k => [k, false])), normalShellPresent: Boolean(normal?.shellPresent), restrictedShellPresent: false, directNodeReplDenied: false }, errorClass: 'timeout' });
    if (restrictedResult?.exitCode !== 0) throw Object.assign(new Error('command'), { code: restrictedResult?.exitCode });
    restricted = parseRestrictedJsonl(restrictedResult.stdout);
  } catch (error) {
    return makeProbe({ probeId: 'restricted_profile', result: 'BLOCKED', checkedAt: now(), runId, evidence: { assertions: Object.fromEntries(ASSERTION_KEYS.map(k => [k, false])), normalShellPresent: Boolean(normal?.shellPresent), restrictedShellPresent: Boolean(restricted?.shellPresent), directNodeReplDenied: restricted?.directNodeReplAllowed === false }, errorClass: error?.message === 'malformed' ? 'malformed_evidence' : 'command_failed' });
  }
  const evidence = evidenceFor(normal, restricted);
  const claimedSafe = ASSERTION_KEYS.every(key => restricted[key] === (key === 'narrowActionPathWorks'));
  // A model-produced record is not an independent security boundary. Task 4 must
  // supply an out-of-band denial/helper check before this can ever become PASS.
  return makeProbe({ probeId: 'restricted_profile', result: 'FAIL', checkedAt: now(), runId, evidence, errorClass: claimedSafe ? 'permission_boundary' : (restricted.directNodeReplAllowed ? 'permission_boundary' : 'not_available') });
}

if (import.meta.url === `file://${process.argv[1]}`) process.stdout.write(JSON.stringify(await runRestrictedProfileProbe()) + '\n');
