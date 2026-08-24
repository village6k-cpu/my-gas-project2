import test from 'node:test';
import assert from 'node:assert/strict';
import { makeProbe } from './probe-contract.mjs';
import { makeSyntheticGrant, revokeSyntheticEpoch, resetSyntheticEpochs, recoverOwnedOrphan } from './orphan-recovery-probe.mjs';

const identity = { pid: 2345, pgid: 2345, executable: '/usr/bin/node', start: 'epoch-start-1' };
const valid = (overrides = {}) => ({ ...identity, ...overrides });
const reader = (...values) => { let i = 0; return async () => values[Math.min(i++, values.length - 1)]; };
const grant = () => makeSyntheticGrant('daemon-1', 'grant-1');
test.beforeEach(() => resetSyntheticEpochs());

test('identity-checked recovery sends TERM then KILL only to the owned group', async () => {
  const signals = [];
  const result = await recoverOwnedOrphan({ orphan: identity, grant: grant(), activeEpoch: 'daemon-1', identityReader: reader(valid()), signal: (target, name) => { signals.push([target, name]); return true; }, isAlive: () => true });
  assert.equal(result.result, 'PASS');
  assert.deepEqual(signals, [[-2345, 'SIGTERM'], [-2345, 'SIGKILL']]);
});

test('wrong epoch and reused grant fail closed without signaling', async () => {
  const signals = [];
  const g = grant();
  const wrong = await recoverOwnedOrphan({ orphan: identity, grant: g, activeEpoch: 'daemon-2', identityReader: reader(valid()), signal: (...args) => { signals.push(args); return true; } });
  assert.equal(wrong.result, 'BLOCKED');
  revokeSyntheticEpoch('daemon-1');
  const revoked = await recoverOwnedOrphan({ orphan: identity, grant: g, activeEpoch: 'daemon-1', identityReader: reader(valid()), signal: (...args) => { signals.push(args); return true; } });
  assert.equal(revoked.result, 'BLOCKED');
  assert.deepEqual(signals, []);
});

test('wrong executable/start identity and PID reuse are blocked', async () => {
  const signals = [];
  const mismatch = await recoverOwnedOrphan({ orphan: identity, grant: grant(), activeEpoch: 'daemon-1', identityReader: reader(valid({ executable: '/usr/bin/other' })), signal: (...args) => { signals.push(args); return true; } });
  assert.equal(mismatch.reason, 'pid_reuse');
  const reused = await recoverOwnedOrphan({ orphan: identity, grant: makeSyntheticGrant('daemon-1', 'grant-2'), activeEpoch: 'daemon-1', identityReader: reader(valid(), valid({ start: 'new-process' })), signal: (...args) => { signals.push(args); return true; }, isAlive: () => true });
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
