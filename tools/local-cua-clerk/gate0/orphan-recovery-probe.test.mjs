import test from 'node:test';
import assert from 'node:assert/strict';
import { makeProbe } from './probe-contract.mjs';
import { makeSyntheticGrant, revokeSyntheticEpoch, resetSyntheticEpochs, resetOwnershipRegistry, registerOwnedOrphan, recoverOwnedOrphan, runOrphanRecoveryProbe } from './orphan-recovery-probe.mjs';

const identity = { pid: 2345, pgid: 2345, executable: '/usr/bin/node', start: 'epoch-start-1' };
const valid = (overrides = {}) => ({ ...identity, ...overrides });
const reader = (...values) => { let i = 0; return async () => values[Math.min(i++, values.length - 1)]; };
const grant = () => makeSyntheticGrant('daemon-1', 'grant-1');
test.beforeEach(() => { resetSyntheticEpochs(); resetOwnershipRegistry(); });

test('identity-checked recovery sends TERM then KILL only to the owned group', async () => {
  const signals = [];
  const g = grant(); registerOwnedOrphan(g, identity);
  const result = await recoverOwnedOrphan({ orphan: identity, grant: g, activeEpoch: 'daemon-1', identityReader: reader(valid()), signal: (target, name) => { signals.push([target, name]); return true; }, isAlive: () => true });
  assert.equal(result.result, 'PASS');
  assert.deepEqual(signals, [[-2345, 'SIGTERM'], [-2345, 'SIGKILL']]);
});

test('wrong epoch and reused grant fail closed without signaling', async () => {
  const signals = [];
  const g = grant();
  registerOwnedOrphan(g, identity);
  const wrong = await recoverOwnedOrphan({ orphan: identity, grant: g, activeEpoch: 'daemon-2', identityReader: reader(valid()), signal: (...args) => { signals.push(args); return true; } });
  assert.equal(wrong.result, 'BLOCKED');
  revokeSyntheticEpoch('daemon-1');
  const revoked = await recoverOwnedOrphan({ orphan: identity, grant: g, activeEpoch: 'daemon-1', identityReader: reader(valid()), signal: (...args) => { signals.push(args); return true; } });
  assert.equal(revoked.result, 'BLOCKED');
  assert.deepEqual(signals, []);
});

test('wrong executable/start identity and PID reuse are blocked', async () => {
  const signals = [];
  const gm = grant(); registerOwnedOrphan(gm, identity);
  const mismatch = await recoverOwnedOrphan({ orphan: identity, grant: gm, activeEpoch: 'daemon-1', identityReader: reader(valid({ executable: '/usr/bin/other' })), signal: (...args) => { signals.push(args); return true; } });
  assert.equal(mismatch.reason, 'pid_reuse');
  const gr = makeSyntheticGrant('daemon-1', 'grant-2'); registerOwnedOrphan(gr, identity);
  const reused = await recoverOwnedOrphan({ orphan: identity, grant: gr, activeEpoch: 'daemon-1', identityReader: reader(valid(), valid({ start: 'new-process' })), signal: (...args) => { signals.push(args); return true; }, isAlive: () => true });
  assert.equal(reused.reason, 'pid_reuse');
  assert.deepEqual(signals, []);
});

test('forged evidence and unrelated PID targets are denied by the contract and identity check', async () => {
  assert.throws(() => makeProbe({ probeId: 'orphan_recovery', result: 'PASS', evidence: { status: 'clean', forged: true } }), /unknown orphan/);
  const signals = [];
  const unrelated = await recoverOwnedOrphan({ orphan: valid({ pid: 9999, pgid: 9999 }), grant: makeSyntheticGrant('daemon-1', 'grant-3'), activeEpoch: 'daemon-1', identityReader: reader(identity), signal: (...args) => { signals.push(args); return true; } });
  assert.equal(unrelated.result, 'BLOCKED');
  assert.deepEqual(signals, []);
});

test('matching but unregistered target is denied and partial cleanup cannot replay TERM', async () => {
  const signals = [];
  const unregistered = await recoverOwnedOrphan({ orphan: identity, grant: grant(), activeEpoch: 'daemon-1', identityReader: reader(valid()), signal: (...args) => { signals.push(args); return true; } });
  assert.equal(unregistered.result, 'BLOCKED');
  const g = makeSyntheticGrant('daemon-1', 'grant-partial'); registerOwnedOrphan(g, identity);
  const used = new Set();
  let call = 0;
  const first = await recoverOwnedOrphan({ orphan: identity, grant: g, activeEpoch: 'daemon-1', usedGrants: used, identityReader: reader(valid(), valid(), valid({ start: 'reused' })), signal: (...args) => { signals.push(args); return true; }, isAlive: () => true });
  assert.equal(first.reason, 'pid_reuse');
  // A second attempt is denied by the consumed grant, so it cannot send TERM again.
  const second = await recoverOwnedOrphan({ orphan: identity, grant: g, activeEpoch: 'daemon-1', usedGrants: used, identityReader: reader(valid()), signal: (...args) => { call++; return true; } });
  assert.equal(second.result, 'BLOCKED');
  assert.equal(call, 0);
});

test('identity capture failure attempts only exact child-handle cleanup and reports incompleteness', async () => {
  const signals = [];
  const child = { pid: 3456, spawnfile: '/usr/bin/node', exitCode: null, signalCode: null, kill: signal => { signals.push(signal); } };
  const result = await runOrphanRecoveryProbe({ childFactory: async () => child, identityReader: async () => { throw new Error('unavailable'); }, runId: 'e'.repeat(16) });
  assert.equal(result.result, 'BLOCKED');
  assert.equal(result.errorClass, 'cleanup_incomplete');
  assert.deepEqual(signals, ['SIGTERM']);
});
