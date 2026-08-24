import test from 'node:test';
import assert from 'node:assert/strict';
import * as orphanModule from './orphan-recovery-probe.mjs';
import { makeProbe, deriveVerdict, PROBE_IDS } from './probe-contract.mjs';

const identity = { pid: 2345, pgid: 2345, executable: '/usr/bin/node', start: 'epoch-start-1' };
const valid = (overrides = {}) => ({ ...identity, ...overrides });
const reader = (...values) => { let i = 0; return async () => values[Math.min(i++, values.length - 1)]; };
const fakeChild = () => ({ pid: identity.pid, pgid: identity.pgid, spawnfile: identity.executable, exitCode: 0, signalCode: null });
const run = (options = {}) => orphanModule.runOrphanRecoveryProbe({ childFactory: async () => fakeChild(), identityReader: reader(valid()), signalImpl: () => true, runId: 'a'.repeat(16), ...options });

test('public module exposes only the runner authorization seam', () => { assert.deepEqual(Object.keys(orphanModule), ['runOrphanRecoveryProbe']); });
test('matching but unregistered targets cannot be authorized by ordinary importers', () => { assert.equal(orphanModule.registerOwnedOrphan, undefined); assert.equal(orphanModule.recoverOwnedOrphan, undefined); assert.equal(orphanModule.makeSyntheticGrant, undefined); });

test('runner proves identity-checked cleanup and private one-time replay denial', async () => {
  const signals = []; const child = { ...fakeChild(), exitCode: null };
  const result = await orphanModule.runOrphanRecoveryProbe({ childFactory: async () => child, identityReader: reader(valid()), signalImpl: (target, signal) => { signals.push([target, signal]); child.signalCode = signal === 'SIGKILL' ? 'SIGKILL' : null; return true; }, runId: 'b'.repeat(16) });
  assert.equal(result.result, 'PASS'); assert.deepEqual(signals, [[-2345, 'SIGTERM'], [-2345, 'SIGKILL']]);
});

test('same grant ID with a different epoch is denied with zero signals, while private replay stays consumed', async () => {
  const signals = []; const result = await run({ testHooks: { epoch: 'epoch-1', recoveryEpoch: 'epoch-2', replayEpoch: 'epoch-2', grantId: 'same-id' }, signalImpl: (...args) => { signals.push(args); return true; } });
  assert.equal(result.result, 'BLOCKED'); assert.deepEqual(signals, []);
  const replay = await run({ testHooks: { epoch: 'epoch-1', replayEpoch: 'epoch-1', grantId: 'same-id' }, signalImpl: (...args) => { signals.push(args); return true; } });
  assert.equal(replay.result, 'PASS');
});

test('PID reuse before TERM is blocked with no signal', async () => { const signals = []; const result = await orphanModule.runOrphanRecoveryProbe({ childFactory: async () => fakeChild(), identityReader: reader(valid(), valid({ start: 'reused' })), signalImpl: (...args) => { signals.push(args); return true; }, runId: 'c'.repeat(16) }); assert.equal(result.result, 'BLOCKED'); assert.deepEqual(signals, []); });
test('identity capture failure attempts only exact child-handle cleanup and reports incompleteness', async () => { const signals = []; const child = { ...fakeChild(), exitCode: null, kill: signal => signals.push(signal) }; const result = await orphanModule.runOrphanRecoveryProbe({ childFactory: async () => child, identityReader: async () => { throw new Error('unavailable'); }, runId: 'd'.repeat(16) }); assert.equal(result.result, 'BLOCKED'); assert.equal(result.errorClass, 'cleanup_incomplete'); assert.deepEqual(signals, ['SIGTERM']); });

test('empty orphan evidence cannot pass and global PASS needs positive orphan proof', () => {
  assert.throws(() => makeProbe({ probeId: 'orphan_recovery', result: 'PASS', evidence: {} }), /orphan recovery does not prove/);
  const rows = PROBE_IDS.map(id => id === 'orphan_recovery' ? makeProbe({ probeId: id, result: 'PASS', evidence: { registeredOwnedChild: true, exactIdentityVerified: true, activeEpochVerified: true, oneTimeGrantConsumed: true, unrelatedPidProtected: true, cleanupCompleted: true } }) : makeProbe({ probeId: id, result: 'PASS', evidence: id === 'restricted_profile' ? { assertions: { directNodeReplAllowed: false, rawInputInjectionAllowed: false, helperSocketAccessAllowed: false, ledgerWriteAllowed: false, narrowActionPathWorks: true }, normalShellPresent: true, restrictedShellPresent: false, directNodeReplDenied: true } : {} }));
  assert.equal(deriveVerdict(rows), 'PASS'); rows.find(row => row.probeId === 'orphan_recovery').evidence.cleanupCompleted = false; assert.equal(deriveVerdict(rows), 'SUPERVISED_ONLY');
});
