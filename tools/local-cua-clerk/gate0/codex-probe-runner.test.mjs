import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { parseProbeJsonl, runCodexProbe, terminateOwnedGroup, PINNED_CODEX_PATH, PROBE_PAYLOAD, PROBE_ARGS, MAX_JSONL_BYTES } from './codex-probe-runner.mjs';

function child({ output = '', code = 0, pid = 1234, spawnfile = '/opt/codex', identity = 'start-1' } = {}) {
  const c = new EventEmitter(); c.pid = pid; c.spawnfile = spawnfile; c.startIdentity = identity; c.pidStartIdentity = identity; c.exitCode = null; c.signalCode = null; c.killed = false; c.stdout = new EventEmitter(); c.stderr = new EventEmitter(); c.once = c.once.bind(c);
  queueMicrotask(() => { if (output) c.stdout.emit('data', output); c.emit('close', code); }); return c;
}

test('fixed payload and JSONL parser accept one exact designated result only', () => {
  assert.equal(PROBE_ARGS[0], 'exec'); assert.match(PROBE_PAYLOAD, /JSON only/);
  assert.match(PROBE_PAYLOAD, /If node_repl is not present/);
  assert.match(PROBE_PAYLOAD, /do not use shell or command execution as a fallback/i);
  assert.match(PROBE_PAYLOAD, /return both booleans as false/);
  assert.equal(PINNED_CODEX_PATH, '/Users/choijaehyeong/.codex/packages/standalone/releases/0.147.0-aarch64-apple-darwin/bin/codex');
  const designated = JSON.stringify({ type: 'item.completed', item: { id: 'safe-id', type: 'agent_message', text: JSON.stringify({ chromeAccessibilityAvailable: true, screenshotAvailable: false }) } });
  assert.deepEqual(parseProbeJsonl(designated), { chromeAccessibilityAvailable: true, screenshotAvailable: false });
  assert.deepEqual(parseProbeJsonl('{"chromeAccessibilityAvailable":true,"screenshotAvailable":false}'), { chromeAccessibilityAvailable: true, screenshotAvailable: false });
  assert.throws(() => parseProbeJsonl('{"chromeAccessibilityAvailable":true}'));
  assert.throws(() => parseProbeJsonl('not json'));
  assert.throws(() => parseProbeJsonl('{"chromeAccessibilityAvailable":true,"screenshotAvailable":true}\n{"chromeAccessibilityAvailable":false,"screenshotAvailable":false}'));
  assert.throws(() => parseProbeJsonl('{"chromeAccessibilityAvailable":true,"screenshotAvailable":true,"extra":false}'));
  assert.throws(() => parseProbeJsonl('{"type":"message","chromeAccessibilityAvailable":true,"screenshotAvailable":true}'));
  assert.throws(() => parseProbeJsonl(JSON.stringify({ type: 'item.completed', screenshotAvailable: true, item: { type: 'agent_message', text: '{"chromeAccessibilityAvailable":true,"screenshotAvailable":true}' } })));
  assert.throws(() => parseProbeJsonl(' '.repeat(MAX_JSONL_BYTES + 1)), /overflow/);
});

test('runner uses pinned path and emits contract without subprocess text', async () => {
  let called;
  const result = await runCodexProbe({ codexPath: '/opt/codex', allowTestOverrides: true, identityReader: async () => 'start-1', spawnImpl: (path, args, opts) => { called = { path, args, opts }; return child({ output: '{"chromeAccessibilityAvailable":true,"screenshotAvailable":true}\n' }); }, now: () => '2026-08-24T00:00:00.000Z', runId: '0123456789abcdef' });
  assert.equal(result.result, 'PASS'); assert.equal(result.probeId, 'terminal_cua'); assert.equal(called.path, '/opt/codex'); assert.equal(called.args[0], 'exec'); assert.equal(called.opts.detached, true); assert.equal(Object.hasOwn(result.evidence, 'text'), false);
});

test('runner caps retained JSONL and returns redacted malformed evidence on overflow', async () => {
  const oversized = `${'x'.repeat(MAX_JSONL_BYTES)}\n{"chromeAccessibilityAvailable":true,"screenshotAvailable":true}`;
  const result = await runCodexProbe({ codexPath: '/opt/codex', allowTestOverrides: true, identityReader: async () => 'start-1', spawnImpl: () => child({ output: oversized }), runId: '0123456789abcdef' });
  assert.equal(result.result, 'BLOCKED');
  assert.equal(result.errorClass, 'malformed_evidence');
  assert.equal(result.evidence.pointer, 'output_limit_exceeded');
  assert.equal(JSON.stringify(result).includes('xxxx'), false);
});

test('timeout only kills an owned child group; unrelated identity is denied', async () => {
  const signals = []; const c = new EventEmitter(); c.pid = 4321; c.spawnfile = '/opt/codex'; c.startIdentity = 'start-1'; c.pidStartIdentity = 'start-1'; c.exitCode = null; c.signalCode = null; c.killed = false; c.stdout = new EventEmitter(); c.stderr = new EventEmitter();
  const resultPromise = runCodexProbe({ codexPath: '/opt/codex', allowTestOverrides: true, timeoutMs: 100, identityReader: async () => 'start-1', spawnImpl: () => c, killImpl: (pid, signal) => signals.push([pid, signal]), now: () => '2026-08-24T00:00:00.000Z', runId: '0123456789abcdef' });
  const result = await resultPromise; assert.equal(result.result, 'BLOCKED'); assert.equal(result.errorClass, 'timeout'); assert.deepEqual(signals, [[-4321, 'SIGTERM'], [-4321, 'SIGKILL']]);
  assert.equal(terminateOwnedGroup({ pid: 99, spawnfile: '/other' }, '/opt/codex', () => { throw new Error('must not kill'); }, 'x', 'x'), false);
  assert.equal(terminateOwnedGroup({ pid: 99, spawnfile: '/opt/codex' }, '/opt/codex', () => { throw new Error('must not kill'); }, 'x', undefined), false);
});

test('a close caused by the timeout TERM remains a timeout instead of command_failed', async () => {
  const signals = [];
  const c = new EventEmitter();
  Object.assign(c, { pid: 4323, spawnfile: '/opt/codex', exitCode: null, signalCode: null, killed: false, stdout: new EventEmitter(), stderr: new EventEmitter() });
  const result = await runCodexProbe({
    codexPath: '/opt/codex',
    allowTestOverrides: true,
    timeoutMs: 60,
    identityReader: async () => 'start-1',
    spawnImpl: () => c,
    killImpl: (pid, signal) => {
      signals.push([pid, signal]);
      if (signal === 'SIGTERM') queueMicrotask(() => { c.signalCode = 'SIGTERM'; c.emit('close', null, 'SIGTERM'); });
    },
    runId: '0123456789abcdef',
  });
  assert.equal(result.result, 'BLOCKED');
  assert.equal(result.errorClass, 'timeout');
  assert.equal(result.evidence.criterion, 'codex_probe_timeout');
  assert.equal(result.evidence.pointer, 'child_group_not_terminated');
  assert.deepEqual(signals, [[-4323, 'SIGTERM']]);
});

test('nonzero exit and false capabilities never pass; production path is pinned', async () => {
  await assert.rejects(() => runCodexProbe({ codexPath: '/tmp/fake', spawnImpl: () => child() }));
  const result = await runCodexProbe({ codexPath: '/opt/codex', allowTestOverrides: true, identityReader: async () => 'start-1', spawnImpl: () => child({ code: 7, output: '{"chromeAccessibilityAvailable":true,"screenshotAvailable":true}\n' }), runId: '0123456789abcdef' });
  assert.equal(result.result, 'BLOCKED');
  const falseResult = await runCodexProbe({ codexPath: '/opt/codex', allowTestOverrides: true, identityReader: async () => 'start-1', spawnImpl: () => child({ output: '{"chromeAccessibilityAvailable":true,"screenshotAvailable":false}\n' }), runId: '0123456789abcdef' });
  assert.equal(falseResult.result, 'FAIL'); assert.equal(falseResult.errorClass, 'not_available');
});

test('LaunchAgent command outcomes return schema-valid LaunchAgent failure evidence', async () => {
  const cases = [
    { output: '{"chromeAccessibilityAvailable":true,"screenshotAvailable":false}\n', code: 0, result: 'FAIL', errorClass: 'not_available', pointer: 'capability_unavailable' },
    { output: '{"chromeAccessibilityAvailable":true,"screenshotAvailable":true}\n', code: 7, result: 'BLOCKED', errorClass: 'command_failed', pointer: 'command_failed' },
    { output: 'not-json\n', code: 0, result: 'BLOCKED', errorClass: 'malformed_evidence', pointer: 'malformed_jsonl' },
    { output: `${'x'.repeat(MAX_JSONL_BYTES)}\n`, code: 0, result: 'BLOCKED', errorClass: 'malformed_evidence', pointer: 'output_limit_exceeded' },
  ];

  for (const example of cases) {
    const result = await runCodexProbe({
      codexPath: '/opt/codex',
      allowTestOverrides: true,
      probeId: 'launchagent_cua',
      identityReader: async () => 'start-1',
      spawnImpl: () => child(example),
      runId: '0123456789abcdef',
    });
    assert.equal(result.probeId, 'launchagent_cua');
    assert.equal(result.result, example.result);
    assert.equal(result.errorClass, example.errorClass);
    assert.equal(result.evidence.criterion, 'launchagent_probe');
    assert.equal(result.evidence.pointer, example.pointer);
  }
});

test('LaunchAgent identity preflight returns schema-valid blocked evidence', async () => {
  let spawned = 0;
  const result = await runCodexProbe({
    codexPath: '/opt/codex',
    allowTestOverrides: true,
    probeId: 'launchagent_cua',
    timeoutMs: 20,
    identityReader: () => new Promise(() => {}),
    spawnImpl: () => { spawned += 1; return child(); },
    runId: '0123456789abcdef',
  });
  assert.equal(result.result, 'BLOCKED');
  assert.equal(result.errorClass, 'timeout');
  assert.equal(result.evidence.criterion, 'launchagent_probe_identity');
  assert.equal(result.evidence.pointer, 'preflight_unavailable');
  assert.equal(spawned, 0);
});

test('LaunchAgent identity preflight rejection returns schema-valid blocked evidence', async () => {
  const result = await runCodexProbe({
    codexPath: '/opt/codex',
    allowTestOverrides: true,
    probeId: 'launchagent_cua',
    identityReader: async () => { throw new Error('unavailable'); },
    spawnImpl: () => { throw new Error('must not spawn'); },
    runId: '0123456789abcdef',
  });
  assert.equal(result.result, 'BLOCKED');
  assert.equal(result.errorClass, 'timeout');
  assert.equal(result.evidence.criterion, 'launchagent_probe_identity');
  assert.equal(result.evidence.pointer, 'preflight_unavailable');
});

test('LaunchAgent synchronous spawn failure returns schema-valid blocked evidence', async () => {
  const result = await runCodexProbe({
    codexPath: '/opt/codex',
    allowTestOverrides: true,
    probeId: 'launchagent_cua',
    identityReader: async () => 'start-1',
    spawnImpl: () => { throw new Error('spawn failed'); },
    runId: '0123456789abcdef',
  });
  assert.equal(result.result, 'BLOCKED');
  assert.equal(result.errorClass, 'command_failed');
  assert.equal(result.evidence.criterion, 'launchagent_probe');
  assert.equal(result.evidence.pointer, 'spawn_error');
});

test('LaunchAgent early child error returns schema-valid blocked evidence', async () => {
  let reads = 0;
  const c = new EventEmitter();
  Object.assign(c, { pid: 4322, spawnfile: '/opt/codex', exitCode: null, signalCode: null, killed: false, stdout: new EventEmitter(), stderr: new EventEmitter() });
  const result = await runCodexProbe({
    codexPath: '/opt/codex',
    allowTestOverrides: true,
    probeId: 'launchagent_cua',
    identityReader: async () => { reads += 1; if (reads === 2) await new Promise(resolve => setTimeout(resolve, 10)); return 'start-1'; },
    spawnImpl: () => { queueMicrotask(() => c.emit('error', new Error('early spawn error'))); return c; },
    runId: '0123456789abcdef',
  });
  assert.equal(result.result, 'BLOCKED');
  assert.equal(result.errorClass, 'command_failed');
  assert.equal(result.evidence.criterion, 'launchagent_probe');
  assert.equal(result.evidence.pointer, 'spawn_error');
});

test('LaunchAgent timeout returns schema-valid blocked evidence', async () => {
  const signals = [];
  const c = new EventEmitter();
  Object.assign(c, { pid: 4321, spawnfile: '/opt/codex', exitCode: null, signalCode: null, killed: false, stdout: new EventEmitter(), stderr: new EventEmitter() });
  const result = await runCodexProbe({
    codexPath: '/opt/codex',
    allowTestOverrides: true,
    probeId: 'launchagent_cua',
    timeoutMs: 100,
    identityReader: async () => 'start-1',
    spawnImpl: () => c,
    killImpl: (pid, signal) => signals.push([pid, signal]),
    runId: '0123456789abcdef',
  });
  assert.equal(result.result, 'BLOCKED');
  assert.equal(result.errorClass, 'timeout');
  assert.equal(result.evidence.criterion, 'launchagent_probe_timeout');
  assert.equal(result.evidence.pointer, 'child_group_escalated');
  assert.deepEqual(signals, [[-4321, 'SIGTERM'], [-4321, 'SIGKILL']]);
});

test('identity reuse between TERM and escalation denies SIGKILL', async () => {
  const signals = []; let reads = 0; const c = new EventEmitter(); c.pid = 55; c.spawnfile = '/opt/codex'; c.exitCode = null; c.signalCode = null; c.killed = false; c.stdout = new EventEmitter(); c.stderr = new EventEmitter();
  const result = await runCodexProbe({ codexPath: '/opt/codex', allowTestOverrides: true, timeoutMs: 100, identityReader: async () => (++reads < 4 ? { start: 'same', pgid: '1' } : { start: 'same', pgid: '2' }), spawnImpl: () => c, killImpl: (pid, signal) => signals.push([pid, signal]), runId: '0123456789abcdef' });
  assert.equal(result.result, 'BLOCKED'); assert.deepEqual(signals, [[-55, 'SIGTERM']]);
});

test('hung identity reader is bounded and fails closed without signaling', async () => {
  let spawned = 0; const signals = [];
  const result = await runCodexProbe({ codexPath: '/opt/codex', allowTestOverrides: true, timeoutMs: 20, identityReader: () => new Promise(() => {}), spawnImpl: () => { spawned += 1; return child({ pid: 77 }); }, killImpl: (pid, signal) => signals.push([pid, signal]), runId: '0123456789abcdef' });
  assert.equal(result.result, 'BLOCKED'); assert.equal(result.errorClass, 'timeout'); assert.equal(spawned, 0); assert.deepEqual(signals, []);
});

test('delayed identity capture preserves cleanup reserve and total bound', async () => {
  const signals = []; let reads = 0;
  const c = new EventEmitter(); c.pid = 79; c.spawnfile = '/opt/codex'; c.exitCode = null; c.signalCode = null; c.killed = false; c.stdout = new EventEmitter(); c.stderr = new EventEmitter();
  const started = Date.now();
  const result = await runCodexProbe({ codexPath: '/opt/codex', allowTestOverrides: true, timeoutMs: 100, identityReader: async () => { reads += 1; if (reads === 2) await new Promise(resolve => setTimeout(resolve, 10)); return 'start-1'; }, spawnImpl: () => c, killImpl: (pid, signal) => signals.push([pid, signal]), runId: '0123456789abcdef' });
  assert.equal(result.result, 'BLOCKED'); assert.deepEqual(signals, [[-79, 'SIGTERM'], [-79, 'SIGKILL']]); assert.ok(Date.now() - started < 200);
});

test('post-spawn identity failure reaps the exact child handle', async () => {
  let reads = 0; const directSignals = [];
  const c = new EventEmitter(); c.pid = 80; c.spawnfile = '/opt/codex'; c.exitCode = null; c.signalCode = null; c.killed = false; c.stdout = new EventEmitter(); c.stderr = new EventEmitter();
  c.kill = signal => { directSignals.push(signal); setTimeout(() => { c.exitCode = 0; c.emit('close', 0); }, 2); return true; };
  const result = await runCodexProbe({ codexPath: '/opt/codex', allowTestOverrides: true, timeoutMs: 80, identityReader: () => { reads += 1; return reads === 1 ? Promise.resolve('preflight') : new Promise(() => {}); }, spawnImpl: () => c, killImpl: () => { throw new Error('group signal forbidden'); }, runId: '0123456789abcdef' });
  assert.equal(result.result, 'BLOCKED'); assert.equal(result.evidence.pointer, 'identity_capture_failed_child_reaped'); assert.deepEqual(directSignals, ['SIGTERM']);
});

test('post-spawn identity failure reports incomplete cleanup when child never closes', async () => {
  let reads = 0; const directSignals = [];
  const c = new EventEmitter(); c.pid = 81; c.spawnfile = '/opt/codex'; c.exitCode = null; c.signalCode = null; c.killed = false; c.stdout = new EventEmitter(); c.stderr = new EventEmitter(); c.kill = signal => { directSignals.push(signal); return true; };
  const started = Date.now();
  const result = await runCodexProbe({ codexPath: '/opt/codex', allowTestOverrides: true, timeoutMs: 60, identityReader: () => { reads += 1; return reads === 1 ? Promise.resolve('preflight') : new Promise(() => {}); }, spawnImpl: () => c, killImpl: () => { throw new Error('group signal forbidden'); }, runId: '0123456789abcdef' });
  assert.equal(result.result, 'BLOCKED'); assert.equal(result.evidence.pointer, 'cleanup_incomplete'); assert.deepEqual(directSignals, ['SIGTERM', 'SIGKILL']); assert.ok(Date.now() - started < 150);
});

test('reaped child denies both TERM and KILL even with matching identity', () => {
  const signals = []; const c = child({ pid: 78 }); c.exitCode = 0;
  assert.equal(terminateOwnedGroup(c, '/opt/codex', (pid, signal) => signals.push([pid, signal]), 'start-1', 'start-1'), false); assert.deepEqual(signals, []);
});
