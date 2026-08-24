import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { parseProbeJsonl, runCodexProbe, terminateOwnedGroup, PINNED_CODEX_PATH, PROBE_PAYLOAD, PROBE_ARGS } from './codex-probe-runner.mjs';

function child({ output = '', code = 0, pid = 1234, spawnfile = '/opt/codex', identity = 'start-1' } = {}) {
  const c = new EventEmitter(); c.pid = pid; c.spawnfile = spawnfile; c.startIdentity = identity; c.pidStartIdentity = identity; c.exitCode = null; c.signalCode = null; c.killed = false; c.stdout = new EventEmitter(); c.stderr = new EventEmitter(); c.once = c.once.bind(c);
  queueMicrotask(() => { if (output) c.stdout.emit('data', output); c.emit('close', code); }); return c;
}

test('fixed payload and JSONL parser retain only the two booleans', () => {
  assert.equal(PROBE_ARGS[0], 'exec'); assert.match(PROBE_PAYLOAD, /JSON only/);
  assert.equal(PINNED_CODEX_PATH, '/Users/choijaehyeong/.codex/packages/standalone/releases/0.147.0-aarch64-apple-darwin/bin/codex');
  assert.deepEqual(parseProbeJsonl('{"type":"message","result":{"chromeAccessibilityAvailable":true,"screenshotAvailable":false,"text":"redacted"}}'), { chromeAccessibilityAvailable: true, screenshotAvailable: false });
  assert.throws(() => parseProbeJsonl('{"chromeAccessibilityAvailable":true}'));
  assert.throws(() => parseProbeJsonl('not json'));
});

test('runner uses pinned path and emits contract without subprocess text', async () => {
  let called;
  const result = await runCodexProbe({ codexPath: '/opt/codex', allowTestOverrides: true, identityReader: async () => 'start-1', spawnImpl: (path, args, opts) => { called = { path, args, opts }; return child({ output: '{"chromeAccessibilityAvailable":true,"screenshotAvailable":true}\n' }); }, now: () => '2026-08-24T00:00:00.000Z', runId: '0123456789abcdef' });
  assert.equal(result.result, 'PASS'); assert.equal(result.probeId, 'terminal_cua'); assert.equal(called.path, '/opt/codex'); assert.equal(called.args[0], 'exec'); assert.equal(called.opts.detached, true); assert.equal(Object.hasOwn(result.evidence, 'text'), false);
});

test('timeout only kills an owned child group; unrelated identity is denied', async () => {
  const signals = []; const c = new EventEmitter(); c.pid = 4321; c.spawnfile = '/opt/codex'; c.startIdentity = 'start-1'; c.pidStartIdentity = 'start-1'; c.exitCode = null; c.signalCode = null; c.killed = false; c.stdout = new EventEmitter(); c.stderr = new EventEmitter();
  const resultPromise = runCodexProbe({ codexPath: '/opt/codex', allowTestOverrides: true, timeoutMs: 100, identityReader: async () => 'start-1', spawnImpl: () => c, killImpl: (pid, signal) => signals.push([pid, signal]), now: () => '2026-08-24T00:00:00.000Z', runId: '0123456789abcdef' });
  const result = await resultPromise; assert.equal(result.result, 'BLOCKED'); assert.equal(result.errorClass, 'timeout'); assert.deepEqual(signals, [[-4321, 'SIGTERM'], [-4321, 'SIGKILL']]);
  assert.equal(terminateOwnedGroup({ pid: 99, spawnfile: '/other' }, '/opt/codex', () => { throw new Error('must not kill'); }, 'x', 'x'), false);
  assert.equal(terminateOwnedGroup({ pid: 99, spawnfile: '/opt/codex' }, '/opt/codex', () => { throw new Error('must not kill'); }, 'x', undefined), false);
});

test('nonzero exit and false capabilities never pass; production path is pinned', async () => {
  await assert.rejects(() => runCodexProbe({ codexPath: '/tmp/fake', spawnImpl: () => child() }));
  const result = await runCodexProbe({ codexPath: '/opt/codex', allowTestOverrides: true, identityReader: async () => 'start-1', spawnImpl: () => child({ code: 7, output: '{"chromeAccessibilityAvailable":true,"screenshotAvailable":true}\n' }), runId: '0123456789abcdef' });
  assert.equal(result.result, 'BLOCKED');
  const falseResult = await runCodexProbe({ codexPath: '/opt/codex', allowTestOverrides: true, identityReader: async () => 'start-1', spawnImpl: () => child({ output: '{"chromeAccessibilityAvailable":true,"screenshotAvailable":false}\n' }), runId: '0123456789abcdef' });
  assert.equal(falseResult.result, 'FAIL'); assert.equal(falseResult.errorClass, 'not_available');
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
