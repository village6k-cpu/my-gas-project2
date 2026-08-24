import { execFile, spawn as nodeSpawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { PINNED_CODEX_PATH } from '../gate0/codex-probe-runner.mjs';

export const BRIDGE_SCHEMA_VERSION = 'gate1-desktop-cua/v1';
export const GATE1_CODEX_PATH = PINNED_CODEX_PATH;

const EVIDENCE_KEYS = Object.freeze([
  'threadCreated',
  'fixedActionDispatched',
  'nodeReplCallCompleted',
  'desktopThreadCuaAvailable',
  'chromeWasRunning',
  'chromeAccessibilityAvailable',
  'screenshotAvailable',
  'resultValidated',
  'cleanupCompleted',
]);
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const RUN_ID = /^[a-f0-9]{16}$/;
const ERROR_CLASSES = new Set(['command_failed', 'timeout', 'malformed_evidence', 'not_available', 'cleanup_incomplete']);
const CUA_KEYS = Object.freeze([
  'desktopThreadCuaAvailable',
  'chromeWasRunning',
  'chromeAccessibilityAvailable',
  'screenshotAvailable',
]);
const MAX_EVENT_BYTES = 64 * 1024;

const FIXED_DESKTOP_READINESS_CODE = Object.freeze([
  "var gate1FixedAvailable = false;",
  "var gate1FixedChromeRunning = false;",
  "var gate1FixedAccessibility = false;",
  "var gate1FixedScreenshot = false;",
  "try {",
  "  globalThis.gate1FixedSky = (await import('@oai/sky')).sky;",
  "  var gate1FixedApps = await gate1FixedSky.list_apps();",
  "  gate1FixedAvailable = true;",
  "  var gate1FixedChrome = gate1FixedApps.find(app => app.id === 'com.google.Chrome' || app.displayName === 'Google Chrome');",
  "  gate1FixedChromeRunning = Boolean(gate1FixedChrome?.isRunning);",
  "  if (gate1FixedChromeRunning) {",
  "    var gate1FixedState = await gate1FixedSky.get_app_state({ app: gate1FixedChrome.id || 'com.google.Chrome' });",
  "    gate1FixedAccessibility = typeof gate1FixedState?.text === 'string' && gate1FixedState.text.length > 0;",
  "    gate1FixedScreenshot = Boolean(gate1FixedState?.screenshot?.url);",
  "  }",
  "} catch {}",
  "nodeRepl.write(JSON.stringify({",
  "  desktopThreadCuaAvailable: gate1FixedAvailable,",
  "  chromeWasRunning: gate1FixedChromeRunning,",
  "  chromeAccessibilityAvailable: gate1FixedAccessibility,",
  "  screenshotAvailable: gate1FixedScreenshot,",
  "}));",
].join('\n'));

function exactKeys(value, expected, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${name} must be an object`);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new TypeError(`${name} has unknown or missing keys`);
  }
}

export function validateBridgeRecord(record) {
  const topKeys = ['schemaVersion', 'status', 'checkedAt', 'runId', 'evidence', ...(record?.errorClass === undefined ? [] : ['errorClass'])];
  exactKeys(record, topKeys, 'Gate 1 record');
  if (record.schemaVersion !== BRIDGE_SCHEMA_VERSION || !['PASS', 'BLOCKED'].includes(record.status)) throw new TypeError('invalid Gate 1 header');
  if (!ISO.test(record.checkedAt) || !RUN_ID.test(record.runId)) throw new TypeError('invalid Gate 1 identity');
  exactKeys(record.evidence, EVIDENCE_KEYS, 'Gate 1 evidence');
  for (const key of EVIDENCE_KEYS) if (typeof record.evidence[key] !== 'boolean') throw new TypeError(`invalid Gate 1 boolean ${key}`);
  if (record.status === 'PASS') {
    if (record.errorClass !== undefined) throw new TypeError('PASS cannot include errorClass');
    for (const key of EVIDENCE_KEYS) if (record.evidence[key] !== true) throw new TypeError(`PASS requires true ${key}`);
  } else {
    if (!ERROR_CLASSES.has(record.errorClass)) throw new TypeError('BLOCKED requires a fixed errorClass');
    if (!record.evidence.cleanupCompleted && record.errorClass !== 'cleanup_incomplete') throw new TypeError('incomplete cleanup must be explicit');
  }
  return Object.freeze(record);
}

export function serializeBridgeRecord(record) {
  return `${JSON.stringify(validateBridgeRecord(record), null, 2)}\n`;
}

function exactCuaResult(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const actual = Object.keys(value).sort();
  const expected = [...CUA_KEYS].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) return undefined;
  if (CUA_KEYS.some(key => typeof value[key] !== 'boolean')) return undefined;
  return Object.freeze(Object.fromEntries(CUA_KEYS.map(key => [key, value[key]])));
}

function parseCuaText(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > 1024) return undefined;
  try { return exactCuaResult(JSON.parse(text)); }
  catch { return undefined; }
}

function makeRunId(seed = `${Date.now()}-${Math.random()}`) {
  return createHash('sha256').update(seed).digest('hex').slice(0, 16);
}

const readProcessIdentity = promisify(execFile);

async function defaultIdentityReader(pid) {
  const response = await readProcessIdentity('/bin/ps', ['-p', String(pid), '-o', 'pid=,pgid=,ppid=,sess=,lstart=']);
  const parts = String(response.stdout).trim().split(/\s+/);
  if (parts.length < 5) throw new Error('identity unavailable');
  return Object.freeze({
    pid: parts[0],
    pgid: parts[1],
    ppid: parts[2],
    session: parts[3],
    start: parts.slice(4).join(' '),
  });
}

function identitiesMatch(left, right) {
  if (typeof left === 'string' || typeof right === 'string') return typeof left === 'string' && left === right;
  return Boolean(left && right && JSON.stringify(left) === JSON.stringify(right));
}

async function boundedIdentity(reader, pid, deadline) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) return undefined;
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(() => reader(pid)),
      new Promise(resolve => { timer = setTimeout(() => resolve(undefined), remaining); }),
    ]);
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

function childAlreadyClosed(child) {
  return child?.exitCode != null || child?.signalCode != null;
}

async function waitForClose(child, deadline) {
  if (childAlreadyClosed(child)) return true;
  const remaining = deadline - Date.now();
  if (remaining <= 0 || typeof child.once !== 'function') return false;
  return new Promise(resolve => {
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
}

async function cleanupExactChild({ child, codexPath, expectedIdentity, identityReader, timeoutMs }) {
  if (childAlreadyClosed(child)) return true;
  const deadline = Date.now() + timeoutMs;
  const slice = Math.max(1, Math.floor(timeoutMs / 3));
  try { child.stdin?.end?.(); } catch {}
  if (await waitForClose(child, Math.min(deadline, Date.now() + slice))) return true;
  if (child.spawnfile !== codexPath || !Number.isInteger(child.pid) || child.pid <= 1 || expectedIdentity === undefined) return false;

  const currentIdentity = await boundedIdentity(identityReader, child.pid, deadline);
  if (!identitiesMatch(expectedIdentity, currentIdentity) || childAlreadyClosed(child) || typeof child.kill !== 'function') return false;
  try { child.kill('SIGTERM'); } catch { return false; }
  if (await waitForClose(child, Math.min(deadline, Date.now() + slice))) return true;

  const latestIdentity = await boundedIdentity(identityReader, child.pid, deadline);
  if (!identitiesMatch(expectedIdentity, latestIdentity) || childAlreadyClosed(child)) return false;
  try { child.kill('SIGKILL'); } catch { return false; }
  return waitForClose(child, deadline);
}

function appServerResponse(message, expectedId) {
  if (!message || typeof message !== 'object' || Array.isArray(message)) return undefined;
  if (!Object.hasOwn(message, 'id')) return Object.hasOwn(message, 'method') ? { notification: message } : undefined;
  if (message.id !== expectedId) return undefined;
  const hasResult = Object.hasOwn(message, 'result');
  const hasError = Object.hasOwn(message, 'error');
  if (hasResult === hasError) return undefined;
  const expectedKeys = hasResult ? ['id', 'result'] : ['id', 'error'];
  try { exactKeys(message, expectedKeys, 'JSON-RPC response'); }
  catch { return undefined; }
  return hasError ? { error: true } : { result: message.result };
}

function nodeReplReadiness(notification, expectedThreadId) {
  if (notification?.method !== 'mcpServer/startupStatus/updated') return 'ignore';
  const params = notification.params;
  if (params?.name !== 'node_repl') return 'ignore';
  try { exactKeys(notification, ['emittedAtMs', 'method', 'params'], 'MCP startup notification'); }
  catch { return 'invalid'; }
  if (typeof notification.emittedAtMs !== 'number' || !Number.isFinite(notification.emittedAtMs)) return 'invalid';
  if (!params || typeof params !== 'object' || Array.isArray(params)) return 'invalid';
  const allowed = new Set(['name', 'status', 'threadId', 'error', 'failureReason']);
  if (Object.keys(params).some(key => !allowed.has(key))) return 'invalid';
  if (!['starting', 'ready', 'failed', 'cancelled'].includes(params.status)) return 'invalid';
  if (params.threadId !== expectedThreadId) return 'ignore';
  return params.status === 'ready' ? 'ready' : 'waiting';
}

function parseMcpCuaResponse(result) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return { errorClass: 'malformed_evidence' };
  const allowed = new Set(['content', 'isError', '_meta', 'structuredContent']);
  const keys = Object.keys(result);
  if (!keys.includes('content') || keys.some(key => !allowed.has(key))) return { errorClass: 'malformed_evidence' };
  if (Object.hasOwn(result, 'isError') && typeof result.isError !== 'boolean') return { errorClass: 'malformed_evidence' };
  if (result.isError === true) return { errorClass: 'command_failed' };
  if (!Array.isArray(result.content) || result.content.length !== 1) return { errorClass: 'malformed_evidence' };
  const block = result.content[0];
  try { exactKeys(block, ['type', 'text'], 'MCP text block'); }
  catch { return { errorClass: 'malformed_evidence' }; }
  if (block.type !== 'text') return { errorClass: 'malformed_evidence' };
  const capabilities = parseCuaText(block.text);
  return capabilities ? { capabilities } : { errorClass: 'malformed_evidence' };
}

function blockedRecord({ checkedAt, runId, errorClass, cleanupCompleted, threadCreated = false, fixedActionDispatched = false, nodeReplCallCompleted = false, capabilities, resultValidated = false }) {
  const safeCapabilities = exactCuaResult(capabilities) ?? Object.fromEntries(CUA_KEYS.map(key => [key, false]));
  return validateBridgeRecord({
    schemaVersion: BRIDGE_SCHEMA_VERSION,
    status: 'BLOCKED',
    checkedAt,
    runId,
    evidence: {
      threadCreated,
      fixedActionDispatched,
      nodeReplCallCompleted,
      ...safeCapabilities,
      resultValidated,
      cleanupCompleted,
    },
    errorClass: cleanupCompleted ? errorClass : 'cleanup_incomplete',
  });
}

export async function runDesktopCuaBridge({
  codexPath = GATE1_CODEX_PATH,
  allowTestOverrides = false,
  spawnImpl = nodeSpawn,
  timeoutMs = 120_000,
  cleanupTimeoutMs = 2_000,
  identityReader = defaultIdentityReader,
  now = () => new Date().toISOString(),
  runId = makeRunId(),
} = {}) {
  if (typeof codexPath !== 'string' || !codexPath.startsWith('/')) throw new TypeError('codex path must be absolute');
  if (!allowTestOverrides && codexPath !== GATE1_CODEX_PATH) throw new TypeError('codex path is not pinned');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) throw new TypeError('timeoutMs must be positive');
  if (!Number.isInteger(cleanupTimeoutMs) || cleanupTimeoutMs < 3) throw new TypeError('cleanupTimeoutMs must be at least 3');
  const startedAt = Date.now();
  let child;
  try { child = spawnImpl(codexPath, ['app-server', '--stdio'], { stdio: ['pipe', 'pipe', 'pipe'] }); }
  catch {
    return blockedRecord({ checkedAt: now(), runId, errorClass: 'command_failed', cleanupCompleted: true });
  }

  if (!child || typeof child !== 'object') {
    return blockedRecord({ checkedAt: now(), runId, errorClass: 'command_failed', cleanupCompleted: true });
  }
  let childFailureSeen = false;
  let settleChildFailure;
  const noteChildFailure = () => {
    childFailureSeen = true;
    settleChildFailure?.('command_failed');
  };
  child.on?.('error', noteChildFailure);
  child.on?.('close', noteChildFailure);
  for (const stream of [child.stdin, child.stdout, child.stderr]) {
    stream?.on?.('error', noteChildFailure);
  }

  const expectedIdentity = await boundedIdentity(identityReader, child.pid, startedAt + timeoutMs);
  if (!child.stdin || !child.stdout || !child.stderr) {
    const cleanupCompleted = await cleanupExactChild({ child, codexPath, expectedIdentity, identityReader, timeoutMs: cleanupTimeoutMs });
    return blockedRecord({ checkedAt: now(), runId, errorClass: 'command_failed', cleanupCompleted });
  }
  let threadId;
  let fixedActionDispatched = false;
  let fixedActionAttempts = 0;
  let nodeReplCallCompleted = false;
  let nodeReplResult;
  let buffer = '';

  const outcome = await new Promise(resolve => {
    let settled = false;
    let timer;
    let phase = 'initialize';
    let pendingId = 1;
    const finish = errorClass => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ errorClass });
    };
    const send = message => {
      try {
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
        return true;
      } catch {
        finish('command_failed');
        return false;
      }
    };
    const dispatchFixedAction = () => {
      const requestId = 20 + fixedActionAttempts;
      fixedActionAttempts += 1;
      phase = 'fixedAction';
      pendingId = requestId;
      const dispatched = send({
        id: requestId,
        method: 'mcpServer/tool/call',
        params: {
          threadId,
          server: 'node_repl',
          tool: 'js',
          arguments: {
            title: 'Gate 1 fixed Desktop CUA readiness',
            code: FIXED_DESKTOP_READINESS_CODE,
          },
        },
      });
      fixedActionDispatched ||= dispatched;
    };

    child.stderr.on('data', () => {});
    child.stdout.on('data', chunk => {
      if (settled) return;
      buffer += String(chunk);
      if (Buffer.byteLength(buffer) > MAX_EVENT_BYTES) return finish('malformed_evidence');
      while (buffer.includes('\n') && !settled) {
        const splitAt = buffer.indexOf('\n');
        const line = buffer.slice(0, splitAt);
        buffer = buffer.slice(splitAt + 1);
        if (!line.trim()) continue;
        let message;
        try { message = JSON.parse(line); }
        catch { return finish('malformed_evidence'); }
        const response = appServerResponse(message, pendingId);
        if (!response) return finish('command_failed');
        if (response.notification) {
          if (phase !== 'mcpStartup') continue;
          const readiness = nodeReplReadiness(response.notification, threadId);
          if (readiness === 'invalid') return finish('command_failed');
          if (readiness === 'ready') dispatchFixedAction();
          continue;
        }
        if (response.error) return finish('command_failed');

        if (phase === 'initialize') {
          if (!response.result) return finish('command_failed');
          if (!send({ method: 'initialized' })) return;
          phase = 'threadStart';
          pendingId = 10;
          if (!send({
            id: 10,
            method: 'thread/start',
            params: {
              cwd: process.cwd(),
              ephemeral: true,
              approvalPolicy: 'never',
              sandbox: 'read-only',
              serviceName: 'village-desktop-cua-gate1',
              developerInstructions: [
                'This is a read-only Desktop CUA capability probe.',
                'Never click, type, press keys, scroll, navigate, log in, submit, or change permissions.',
                'Never return accessibility text, screenshots, page content, file content, or credentials.',
                'Use only node_repl + @oai/sky for the UI inspection itself.',
              ].join(' '),
            },
          })) return;
          continue;
        }

        if (phase === 'threadStart') {
          threadId = response.result?.thread?.id;
          if (typeof threadId !== 'string' || threadId.length === 0) return finish('command_failed');
          phase = 'mcpStartup';
          pendingId = undefined;
          continue;
        }

        if (phase === 'fixedAction') {
          nodeReplCallCompleted = true;
          const parsed = parseMcpCuaResponse(response.result);
          if (parsed.errorClass) return finish(parsed.errorClass);
          nodeReplResult = parsed.capabilities;
          const coldStartMiss = nodeReplResult && CUA_KEYS.every(key => nodeReplResult[key] === false);
          if (coldStartMiss && fixedActionAttempts < 2) {
            dispatchFixedAction();
            continue;
          }
          finish(undefined);
          continue;
        }
        return finish('command_failed');
      }
    });

    const remaining = Math.max(1, startedAt + timeoutMs - Date.now());
    timer = setTimeout(() => finish('timeout'), remaining);
    settleChildFailure = finish;
    if (childFailureSeen || expectedIdentity === undefined) finish('command_failed');
    else send({
      id: 1,
      method: 'initialize',
      params: {
        clientInfo: { name: 'village-gate1', title: 'Village Gate 1', version: '1.0.0' },
        capabilities: { experimentalApi: true },
      },
    });
  });

  const cleanupCompleted = await cleanupExactChild({ child, codexPath, expectedIdentity, identityReader, timeoutMs: cleanupTimeoutMs });
  if (!cleanupCompleted) {
    return blockedRecord({
      checkedAt: now(), runId, errorClass: 'cleanup_incomplete', cleanupCompleted,
      threadCreated: Boolean(threadId), fixedActionDispatched, nodeReplCallCompleted,
    });
  }
  if (outcome.errorClass) {
    return blockedRecord({
      checkedAt: now(), runId, errorClass: outcome.errorClass, cleanupCompleted,
      threadCreated: Boolean(threadId), fixedActionDispatched, nodeReplCallCompleted,
    });
  }

  const resultValidated = Boolean(nodeReplResult);
  if (!resultValidated) {
    return blockedRecord({
      checkedAt: now(), runId, errorClass: 'malformed_evidence', cleanupCompleted,
      threadCreated: Boolean(threadId), fixedActionDispatched, nodeReplCallCompleted,
    });
  }
  const allAvailable = CUA_KEYS.every(key => nodeReplResult[key] === true);
  if (!allAvailable) {
    return blockedRecord({
      checkedAt: now(), runId, errorClass: 'not_available', cleanupCompleted,
      threadCreated: true, fixedActionDispatched: true, nodeReplCallCompleted: true,
      capabilities: nodeReplResult, resultValidated: true,
    });
  }
  return validateBridgeRecord({
    schemaVersion: BRIDGE_SCHEMA_VERSION,
    status: 'PASS',
    checkedAt: now(),
    runId,
    evidence: {
      threadCreated: true,
      fixedActionDispatched: true,
      nodeReplCallCompleted: true,
      ...nodeReplResult,
      resultValidated: true,
      cleanupCompleted: true,
    },
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const record = await runDesktopCuaBridge();
  process.stdout.write(serializeBridgeRecord(record));
  if (record.status !== 'PASS') process.exitCode = 1;
}
