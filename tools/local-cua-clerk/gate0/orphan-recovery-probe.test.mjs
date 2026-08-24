import test from 'node:test';
import assert from 'node:assert/strict';
import * as orphanModule from './orphan-recovery-probe.mjs';
import { makeProbe, deriveVerdict, PROBE_IDS } from './probe-contract.mjs';

const identity = { pid: 2345, pgid: 2345, executable: '/usr/bin/node', start: 'epoch-start-1' };
const entry = (overrides = {}) => ({ grantId: 'grant-1', epoch: 'epoch-1', identity, consumed: false, ...overrides });
const observations = (last = identity) => [identity, identity, last];

test('production export has no injection surface; simulator is the only test seam', () => {
  assert.deepEqual(Object.keys(orphanModule).sort(), ['runOrphanRecoveryProbe', 'simulateOrphanRecoveryDecision'].sort());
  assert.equal(orphanModule.registerOwnedOrphan, undefined); assert.equal(orphanModule.recoverOwnedOrphan, undefined); assert.equal(orphanModule.makeSyntheticGrant, undefined);
  assert.equal(orphanModule.runOrphanRecoveryProbe.length, 0);
});

test('pure simulator allows only exact registered identity and returns a plan without effects', () => {
  const result = orphanModule.simulateOrphanRecoveryDecision({ registryEntry: entry(), activeEpoch: 'epoch-1', orphan: identity, observations: observations() });
  assert.deepEqual(result, { allowed: true, reason: 'cleaned', actions: ['SIGTERM', 'SIGKILL'] });
});

test('wrong or revoked epoch denies before any action', () => {
  const wrong = orphanModule.simulateOrphanRecoveryDecision({ registryEntry: entry(), activeEpoch: 'epoch-2', orphan: identity, observations: observations() });
  const revoked = orphanModule.simulateOrphanRecoveryDecision({ registryEntry: entry(), activeEpoch: 'epoch-1', revokedEpochs: ['epoch-1'], orphan: identity, observations: observations() });
  assert.deepEqual(wrong.actions, []); assert.deepEqual(revoked.actions, []); assert.equal(wrong.allowed, false); assert.equal(revoked.allowed, false);
});

test('same grant replay and caller-state reset cannot produce a second plan', () => {
  const consumed = entry({ consumed: true });
  const replay = orphanModule.simulateOrphanRecoveryDecision({ registryEntry: consumed, activeEpoch: 'epoch-1', orphan: identity, observations: observations() });
  const freshCallerState = orphanModule.simulateOrphanRecoveryDecision({ registryEntry: entry(), activeEpoch: 'epoch-1', revokedEpochs: ['epoch-1'], orphan: identity, observations: observations() });
  assert.deepEqual(replay.actions, []); assert.deepEqual(freshCallerState.actions, []);
});

test('PID reuse and unregistered/mismatched targets are denied without actions', () => {
  const reused = orphanModule.simulateOrphanRecoveryDecision({ registryEntry: entry(), activeEpoch: 'epoch-1', orphan: identity, observations: observations({ ...identity, start: 'reused' }) });
  const mismatched = orphanModule.simulateOrphanRecoveryDecision({ registryEntry: entry({ identity: { ...identity, pid: 9999 } }), activeEpoch: 'epoch-1', orphan: identity, observations: observations() });
  assert.deepEqual(reused.actions, ['SIGTERM']); assert.equal(reused.allowed, false); assert.deepEqual(mismatched.actions, []);
});

test('empty orphan evidence cannot pass and global PASS needs positive orphan proof', () => {
  assert.throws(() => makeProbe({ probeId: 'orphan_recovery', result: 'PASS', evidence: {} }), /orphan recovery does not prove/);
  const rows = PROBE_IDS.map(id => id === 'orphan_recovery' ? makeProbe({ probeId: id, result: 'PASS', evidence: { registeredOwnedChild: true, exactIdentityVerified: true, activeEpochVerified: true, oneTimeGrantConsumed: true, unrelatedPidProtected: true, cleanupCompleted: true } }) : makeProbe({ probeId: id, result: 'PASS', evidence: id === 'restricted_profile' ? { assertions: { directNodeReplAllowed: false, rawInputInjectionAllowed: false, helperSocketAccessAllowed: false, ledgerWriteAllowed: false, narrowActionPathWorks: true }, normalShellPresent: true, restrictedShellPresent: false, directNodeReplDenied: true } : {} }));
  assert.equal(deriveVerdict(rows), 'PASS'); rows.find(row => row.probeId === 'orphan_recovery').evidence.cleanupCompleted = false; assert.equal(deriveVerdict(rows), 'SUPERVISED_ONLY');
});
