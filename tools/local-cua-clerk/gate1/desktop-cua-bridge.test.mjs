import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';

async function loadBridge() {
  try { return await import('./desktop-cua-bridge.mjs'); }
  catch { return null; }
}

const ALL_TRUE = Object.freeze({
  desktopThreadCuaAvailable: true,
  chromeWasRunning: true,
  chromeAccessibilityAvailable: true,
  screenshotAvailable: true,
});

function fakeAppServer({
  toolResult = ALL_TRUE,
  toolResults = [toolResult],
  mcpResponseId,
  mcpResultExtra = {},
  duplicateThreadStart = false,
  emitNodeReplReady = true,
} = {}) {
  const sent = [];
  const signals = [];
  const child = new EventEmitter();
  Object.assign(child, {
    pid: 4321,
    spawnfile: '/opt/codex',
    exitCode: null,
    signalCode: null,
    killed: false,
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
  });
  const emit = message => queueMicrotask(() => child.stdout.emit('data', `${JSON.stringify(message)}\n`));
  const emitNodeReplStatus = status => emit({
    emittedAtMs: 1,
    method: 'mcpServer/startupStatus/updated',
    params: { name: 'node_repl', status, threadId: 'thread-safe', error: null, failureReason: null },
  });
  child.stdin = {
    write(line) {
      const message = JSON.parse(String(line));
      sent.push(message);
      if (message.method === 'initialize') emit({ id: message.id, result: { userAgent: 'test' } });
      if (message.method === 'thread/start') {
        emit({ id: message.id, result: { thread: { id: 'thread-safe' } } });
        if (emitNodeReplReady) emitNodeReplStatus('ready');
        if (duplicateThreadStart) emit({ id: message.id, result: { thread: { id: 'thread-duplicate' } } });
      }
      if (message.method === 'mcpServer/tool/call') {
        const nextResult = toolResults.shift() ?? toolResult;
        emit({
          id: mcpResponseId ?? message.id,
          result: { content: [{ type: 'text', text: JSON.stringify(nextResult) }], isError: false, ...mcpResultExtra },
        });
      }
      return true;
    },
    end() {
      queueMicrotask(() => {
        child.exitCode = 0;
        child.emit('close', 0, null);
      });
    },
  };
  child.kill = signal => {
    signals.push(signal);
    child.signalCode = signal;
    queueMicrotask(() => child.emit('close', null, signal));
    return true;
  };
  return { child, sent, signals, emitNodeReplStatus };
}

function hungAppServer({ closeOnSignal = null } = {}) {
  const signals = [];
  const child = new EventEmitter();
  Object.assign(child, {
    pid: 5432,
    spawnfile: '/opt/codex',
    exitCode: null,
    signalCode: null,
    killed: false,
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    stdin: { write: () => true, end: () => {} },
  });
  child.kill = signal => {
    signals.push(signal);
    if (signal === closeOnSignal) queueMicrotask(() => {
      child.signalCode = signal;
      child.emit('close', null, signal);
    });
    return true;
  };
  return { child, signals };
}

test('strict Gate 1 record accepts the fixed boolean-only PASS evidence and rejects extra fields', async () => {
  const bridge = await loadBridge();
  assert.equal(typeof bridge?.validateBridgeRecord, 'function');
  const record = {
    schemaVersion: 'gate1-desktop-cua/v1',
    status: 'PASS',
    checkedAt: '2026-08-24T03:00:00.000Z',
    runId: '0123456789abcdef',
    evidence: {
      threadCreated: true,
      fixedActionDispatched: true,
      nodeReplCallCompleted: true,
      desktopThreadCuaAvailable: true,
      chromeWasRunning: true,
      chromeAccessibilityAvailable: true,
      screenshotAvailable: true,
      resultValidated: true,
      cleanupCompleted: true,
    },
  };
  assert.deepEqual(bridge.validateBridgeRecord(record), record);
  assert.throws(
    () => bridge.validateBridgeRecord({ ...record, evidence: { ...record.evidence, pageText: 'forbidden' } }),
    /unknown or missing keys/,
  );
});

test('serializer emits one validated record with a trailing newline', async () => {
  const bridge = await loadBridge();
  assert.equal(typeof bridge?.serializeBridgeRecord, 'function');
  const record = {
    schemaVersion: 'gate1-desktop-cua/v1', status: 'PASS',
    checkedAt: '2026-08-24T03:00:00.000Z', runId: '0123456789abcdef',
    evidence: {
      threadCreated: true, fixedActionDispatched: true, nodeReplCallCompleted: true,
      desktopThreadCuaAvailable: true, chromeWasRunning: true,
      chromeAccessibilityAvailable: true, screenshotAvailable: true,
      resultValidated: true, cleanupCompleted: true,
    },
  };
  assert.equal(bridge.serializeBridgeRecord(record), `${JSON.stringify(record, null, 2)}\n`);
});

test('committed Gate 1 live evidence strict-roundtrips', async () => {
  const bridge = await loadBridge();
  const path = new URL('../../../docs/gate1/2026-08-24-desktop-cua-bridge-evidence.json', import.meta.url);
  const raw = await readFile(path, 'utf8');
  assert.equal(bridge.serializeBridgeRecord(JSON.parse(raw)), raw);
});

test('one local request dispatches one fixed MCP action and returns validated all-true CUA evidence', async () => {
  const bridge = await loadBridge();
  assert.equal(typeof bridge?.runDesktopCuaBridge, 'function');
  const fake = fakeAppServer();
  let spawnCall;
  const result = await bridge.runDesktopCuaBridge({
    codexPath: '/opt/codex',
    allowTestOverrides: true,
    spawnImpl(path, args, options) {
      spawnCall = { path, args, options };
      return fake.child;
    },
    now: () => '2026-08-24T03:00:00.000Z',
    runId: '0123456789abcdef',
    timeoutMs: 1_000,
    identityReader: async () => 'start-1',
  });
  assert.equal(result.status, 'PASS');
  assert.deepEqual(result.evidence, {
    threadCreated: true,
    fixedActionDispatched: true,
    nodeReplCallCompleted: true,
    desktopThreadCuaAvailable: true,
    chromeWasRunning: true,
    chromeAccessibilityAvailable: true,
    screenshotAvailable: true,
    resultValidated: true,
    cleanupCompleted: true,
  });
  assert.deepEqual(spawnCall, {
    path: '/opt/codex',
    args: ['app-server', '--stdio'],
    options: { stdio: ['pipe', 'pipe', 'pipe'] },
  });
  assert.deepEqual(fake.sent.map(message => message.method), ['initialize', 'initialized', 'thread/start', 'mcpServer/tool/call']);
  assert.equal(fake.sent.some(message => Object.hasOwn(message, 'jsonrpc')), false);
  const threadStart = fake.sent.find(message => message.method === 'thread/start');
  assert.equal(threadStart.params.ephemeral, true);
  assert.equal(threadStart.params.sandbox, 'read-only');
  assert.equal(threadStart.params.approvalPolicy, 'never');
  const action = fake.sent.find(message => message.method === 'mcpServer/tool/call');
  assert.equal(action.params.server, 'node_repl');
  assert.equal(action.params.tool, 'js');
  assert.equal(action.params.threadId, 'thread-safe');
  assert.match(action.params.arguments.code, /@oai\/sky/);
  assert.match(action.params.arguments.code, /list_apps/);
  assert.match(action.params.arguments.code, /get_app_state/);
  assert.doesNotMatch(action.params.arguments.code, /\.click\(|\.type_text\(|\.press_key\(|\.scroll\(|\.set_value\(/);
  assert.equal(JSON.stringify(result).includes('thread-safe'), false);
  assert.deepEqual(fake.signals, []);
});

test('the default readiness bridge launches the Codex binary bundled with this Studio Mac app', async () => {
  const bridge = await loadBridge();
  const appCodexPath = '/Applications/ChatGPT.app/Contents/Resources/codex';
  const fake = fakeAppServer();
  let launchedPath;

  await bridge.runDesktopCuaBridge({
    allowTestOverrides: true,
    spawnImpl(path) {
      launchedPath = path;
      return fake.child;
    },
    runId: 'f123456789abcdef',
    timeoutMs: 1_000,
    identityReader: async () => 'start-1',
  });

  assert.equal(launchedPath, appCodexPath);
});

test('matched false capability evidence returns a redacted BLOCKED record', async () => {
  const bridge = await loadBridge();
  const unavailable = { ...ALL_TRUE, screenshotAvailable: false };
  const fake = fakeAppServer({ toolResult: unavailable });
  const result = await bridge.runDesktopCuaBridge({
    codexPath: '/opt/codex',
    allowTestOverrides: true,
    spawnImpl: () => fake.child,
    now: () => '2026-08-24T03:01:00.000Z',
    runId: '1123456789abcdef',
    timeoutMs: 1_000,
    identityReader: async () => 'start-1',
  });
  assert.deepEqual(result, {
    schemaVersion: 'gate1-desktop-cua/v1',
    status: 'BLOCKED',
    checkedAt: '2026-08-24T03:01:00.000Z',
    runId: '1123456789abcdef',
    evidence: {
      threadCreated: true,
      fixedActionDispatched: true,
      nodeReplCallCompleted: true,
      desktopThreadCuaAvailable: true,
      chromeWasRunning: true,
      chromeAccessibilityAvailable: true,
      screenshotAvailable: false,
      resultValidated: true,
      cleanupCompleted: true,
    },
    errorClass: 'not_available',
  });
  assert.deepEqual(bridge.validateBridgeRecord(result), result);
  assert.equal(fake.sent.filter(message => message.method === 'mcpServer/tool/call').length, 1);
});

test('one cold-start infrastructure miss retries the same fixed action once', async () => {
  const bridge = await loadBridge();
  const coldStart = {
    desktopThreadCuaAvailable: false,
    chromeWasRunning: false,
    chromeAccessibilityAvailable: false,
    screenshotAvailable: false,
  };
  const fake = fakeAppServer({ toolResults: [coldStart, ALL_TRUE] });
  const result = await bridge.runDesktopCuaBridge({
    codexPath: '/opt/codex', allowTestOverrides: true, spawnImpl: () => fake.child,
    runId: '8123456789abcdef', timeoutMs: 1_000, identityReader: async () => 'start-1',
  });
  assert.equal(result.status, 'PASS');
  const calls = fake.sent.filter(message => message.method === 'mcpServer/tool/call');
  assert.equal(calls.length, 2);
  assert.equal(calls[0].params.arguments.code, calls[1].params.arguments.code);
});

test('the fixed action waits for matching node_repl readiness instead of racing MCP startup', async () => {
  const bridge = await loadBridge();
  const fake = fakeAppServer({ emitNodeReplReady: false });
  const resultPromise = bridge.runDesktopCuaBridge({
    codexPath: '/opt/codex', allowTestOverrides: true, spawnImpl: () => fake.child,
    runId: 'e123456789abcdef', timeoutMs: 1_000, identityReader: async () => 'start-1',
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(fake.sent.filter(message => message.method === 'mcpServer/tool/call').length, 0);
  fake.emitNodeReplStatus('ready');
  const result = await resultPromise;
  assert.equal(result.status, 'PASS');
  assert.equal(fake.sent.filter(message => message.method === 'mcpServer/tool/call').length, 1);
});

test('unknown or oversized tool evidence is BLOCKED without retaining raw content', async () => {
  const bridge = await loadBridge();
  const fake = fakeAppServer({ toolResult: { desktopThreadCuaAvailable: true } });
  const partial = await bridge.runDesktopCuaBridge({
    codexPath: '/opt/codex', allowTestOverrides: true, spawnImpl: () => fake.child,
    runId: '2123456789abcdef', timeoutMs: 1_000, identityReader: async () => 'start-1',
  });
  assert.equal(partial.status, 'BLOCKED');
  assert.equal(partial.errorClass, 'malformed_evidence');
  assert.equal(partial.evidence.resultValidated, false);
  assert.equal(JSON.stringify(partial).includes('thread-safe'), false);

  const rawMarker = 'private-page-marker';
  const malformedFake = fakeAppServer({ toolResult: { ...ALL_TRUE, extra: rawMarker } });
  const malformed = await bridge.runDesktopCuaBridge({
    codexPath: '/opt/codex', allowTestOverrides: true, spawnImpl: () => malformedFake.child,
    runId: '3123456789abcdef', timeoutMs: 1_000, identityReader: async () => 'start-1',
  });
  assert.equal(malformed.status, 'BLOCKED');
  assert.equal(malformed.errorClass, 'malformed_evidence');
  assert.equal(JSON.stringify(malformed).includes(rawMarker), false);

  const envelopeFake = fakeAppServer({ mcpResultExtra: { unexpectedRawField: rawMarker } });
  const envelope = await bridge.runDesktopCuaBridge({
    codexPath: '/opt/codex', allowTestOverrides: true, spawnImpl: () => envelopeFake.child,
    runId: 'c123456789abcdef', timeoutMs: 1_000, identityReader: async () => 'start-1',
  });
  assert.equal(envelope.status, 'BLOCKED');
  assert.equal(envelope.errorClass, 'malformed_evidence');
  assert.equal(JSON.stringify(envelope).includes(rawMarker), false);
});

test('an early child error is captured before identity lookup and returns redacted command_failed', async () => {
  const bridge = await loadBridge();
  const fake = fakeAppServer();
  const resultPromise = bridge.runDesktopCuaBridge({
    codexPath: '/opt/codex', allowTestOverrides: true,
    spawnImpl: () => {
      queueMicrotask(() => fake.child.emit('error', new Error('private raw error')));
      return fake.child;
    },
    runId: '9123456789abcdef', timeoutMs: 200, cleanupTimeoutMs: 40,
    identityReader: async () => { await new Promise(resolve => setTimeout(resolve, 10)); return 'start-1'; },
  });
  const result = await resultPromise;
  assert.equal(result.status, 'BLOCKED');
  assert.equal(result.errorClass, 'command_failed');
  assert.equal(result.evidence.cleanupCompleted, true);
  assert.equal(JSON.stringify(result).includes('private raw'), false);
});

test('asynchronous stdio errors are captured before identity lookup and cleaned without raw output', async () => {
  const bridge = await loadBridge();
  for (const streamName of ['stdin', 'stdout', 'stderr']) {
    const fake = fakeAppServer();
    if (streamName === 'stdin') {
      const original = fake.child.stdin;
      fake.child.stdin = Object.assign(new EventEmitter(), original);
    }
    const result = await bridge.runDesktopCuaBridge({
      codexPath: '/opt/codex', allowTestOverrides: true,
      spawnImpl: () => {
        queueMicrotask(() => fake.child[streamName].emit('error', new Error(`private ${streamName} error`)));
        return fake.child;
      },
      runId: 'd123456789abcdef', timeoutMs: 200, cleanupTimeoutMs: 40,
      identityReader: async () => { await new Promise(resolve => setTimeout(resolve, 10)); return 'start-1'; },
    });
    assert.equal(result.status, 'BLOCKED');
    assert.equal(result.errorClass, 'command_failed');
    assert.equal(result.evidence.cleanupCompleted, true);
    assert.equal(JSON.stringify(result).includes('private'), false);
  }
});

test('unsolicited and duplicate app-server response IDs cannot satisfy or multiply the fixed action', async () => {
  const bridge = await loadBridge();
  for (const fake of [
    fakeAppServer({ mcpResponseId: 21 }),
    fakeAppServer({ duplicateThreadStart: true }),
  ]) {
    const result = await bridge.runDesktopCuaBridge({
      codexPath: '/opt/codex', allowTestOverrides: true, spawnImpl: () => fake.child,
      runId: 'a123456789abcdef', timeoutMs: 200, identityReader: async () => 'start-1',
    });
    assert.equal(result.status, 'BLOCKED');
    assert.equal(result.errorClass, 'command_failed');
    assert.ok(fake.sent.filter(message => message.method === 'mcpServer/tool/call').length <= 1);
  }
});

test('a spawned child with incomplete stdio is cleaned instead of claiming cleanup by default', async () => {
  const bridge = await loadBridge();
  const signals = [];
  const child = new EventEmitter();
  Object.assign(child, {
    pid: 6543, spawnfile: '/opt/codex', exitCode: null, signalCode: null,
    stdin: undefined, stdout: undefined, stderr: new EventEmitter(),
  });
  child.kill = signal => {
    signals.push(signal);
    if (signal === 'SIGTERM') queueMicrotask(() => { child.signalCode = signal; child.emit('close', null, signal); });
    return true;
  };
  const result = await bridge.runDesktopCuaBridge({
    codexPath: '/opt/codex', allowTestOverrides: true, spawnImpl: () => child,
    runId: 'b123456789abcdef', timeoutMs: 100, cleanupTimeoutMs: 40,
    identityReader: async () => 'start-1',
  });
  assert.equal(result.status, 'BLOCKED');
  assert.equal(result.errorClass, 'command_failed');
  assert.equal(result.evidence.cleanupCompleted, true);
  assert.deepEqual(signals, ['SIGTERM']);
});

test('production rejects an arbitrary Codex executable path', async () => {
  const bridge = await loadBridge();
  await assert.rejects(
    () => bridge.runDesktopCuaBridge({ codexPath: '/tmp/not-codex', spawnImpl: () => { throw new Error('must not spawn'); } }),
    /not pinned/,
  );
});

test('timeout revalidates the exact child identity before TERM and reports cleanup', async () => {
  const bridge = await loadBridge();
  const fake = hungAppServer({ closeOnSignal: 'SIGTERM' });
  const result = await bridge.runDesktopCuaBridge({
    codexPath: '/opt/codex', allowTestOverrides: true, spawnImpl: () => fake.child,
    runId: '4123456789abcdef', timeoutMs: 20, cleanupTimeoutMs: 40,
    identityReader: async () => 'start-1',
  });
  assert.equal(result.status, 'BLOCKED');
  assert.equal(result.errorClass, 'timeout');
  assert.equal(result.evidence.cleanupCompleted, true);
  assert.deepEqual(fake.signals, ['SIGTERM']);
});

test('identity reuse denies signals and an unclosed child is cleanup_incomplete', async () => {
  const bridge = await loadBridge();
  const fake = hungAppServer();
  let reads = 0;
  const started = Date.now();
  const result = await bridge.runDesktopCuaBridge({
    codexPath: '/opt/codex', allowTestOverrides: true, spawnImpl: () => fake.child,
    runId: '5123456789abcdef', timeoutMs: 20, cleanupTimeoutMs: 30,
    identityReader: async () => (++reads === 1 ? 'start-1' : 'start-2'),
  });
  assert.equal(result.status, 'BLOCKED');
  assert.equal(result.errorClass, 'cleanup_incomplete');
  assert.equal(result.evidence.cleanupCompleted, false);
  assert.deepEqual(fake.signals, []);
  assert.ok(Date.now() - started < 250);
});

test('stable identity permits bounded TERM then KILL but never claims cleanup without close', async () => {
  const bridge = await loadBridge();
  const fake = hungAppServer();
  const result = await bridge.runDesktopCuaBridge({
    codexPath: '/opt/codex', allowTestOverrides: true, spawnImpl: () => fake.child,
    runId: '6123456789abcdef', timeoutMs: 20, cleanupTimeoutMs: 45,
    identityReader: async () => 'start-1',
  });
  assert.equal(result.errorClass, 'cleanup_incomplete');
  assert.equal(result.evidence.cleanupCompleted, false);
  assert.deepEqual(fake.signals, ['SIGTERM', 'SIGKILL']);
});

test('identity reuse between TERM and KILL denies escalation', async () => {
  const bridge = await loadBridge();
  const fake = hungAppServer();
  let reads = 0;
  const result = await bridge.runDesktopCuaBridge({
    codexPath: '/opt/codex', allowTestOverrides: true, spawnImpl: () => fake.child,
    runId: '7123456789abcdef', timeoutMs: 20, cleanupTimeoutMs: 45,
    identityReader: async () => (++reads < 3 ? 'start-1' : 'start-2'),
  });
  assert.equal(result.errorClass, 'cleanup_incomplete');
  assert.deepEqual(fake.signals, ['SIGTERM']);
});
