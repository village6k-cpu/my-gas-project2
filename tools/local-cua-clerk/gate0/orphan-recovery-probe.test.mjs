import test from 'node:test';
import assert from 'node:assert/strict';
import * as orphanModule from './orphan-recovery-probe.mjs';
import { makeProbe } from './probe-contract.mjs';

const identity = { pid: 2345, pgid: 2345, executable: '/usr/bin/node', start: 'epoch-start-1' };
const authority = (overrides = {}) => ({ authorityId: 'recovery-1', identity, consumed: false, ...overrides });
const base = overrides => ({ daemonEpochRevoked: true, recoveryAuthority: authority(), target: identity, beforeTerm: identity, beforeKill: identity, unrelatedTarget: { ...identity, pid: 3456, pgid: 3456 }, reusedTarget: { ...identity, start: 'reused-start' }, groupAbsentAfterKill: true, ...overrides });

test('production export has no injection surface; simulator is the only test seam', () => {
  assert.deepEqual(Object.keys(orphanModule).sort(), ['runOrphanRecoveryProbe', 'simulateOrphanRecoveryDecision'].sort());
  assert.equal(orphanModule.registerOwnedOrphan, undefined); assert.equal(orphanModule.recoverOwnedOrphan, undefined); assert.equal(orphanModule.makeSyntheticGrant, undefined);
  assert.equal(orphanModule.runOrphanRecoveryProbe.length, 0);
});

test('pure simulator allows only exact registered identity and returns a plan without effects', () => {
  const result = orphanModule.simulateOrphanRecoveryDecision(base());
  assert.equal(result.allowed, true); assert.equal(result.reason, 'cleaned'); assert.deepEqual(result.actions, ['SIGTERM', 'SIGKILL']);
  assert.equal(result.checks.daemonEpochRevoked, true); assert.equal(result.checks.recoveryAuthorityConsumed, true); assert.equal(result.checks.processGroupAbsent, true);
});

test('daemon/helper epoch must be revoked before separate recovery authority can act', () => {
  const result = orphanModule.simulateOrphanRecoveryDecision(base({ daemonEpochRevoked: false }));
  assert.equal(result.allowed, false); assert.equal(result.reason, 'authority_denied'); assert.deepEqual(result.actions, []); assert.equal(result.checks.recoveryAuthorityConsumed, false);
});

test('one-use recovery authority replay is denied before any action', () => {
  const result = orphanModule.simulateOrphanRecoveryDecision(base({ recoveryAuthority: authority({ consumed: true }) }));
  assert.equal(result.allowed, false); assert.deepEqual(result.actions, []);
});

test('unrelated PID check is side-effect-free and denies before TERM', () => {
  const result = orphanModule.simulateOrphanRecoveryDecision(base({ unrelatedTarget: identity }));
  assert.equal(result.checks.unrelatedPidProtected, false); assert.equal(result.allowed, false); assert.deepEqual(result.actions, []);
});

test('actual PID identity reuse before KILL is denied and KILL is not planned', () => {
  const result = orphanModule.simulateOrphanRecoveryDecision(base({ beforeKill: { ...identity, start: 'reused-start' } }));
  assert.equal(result.allowed, false); assert.equal(result.reason, 'pid_reuse'); assert.deepEqual(result.actions, ['SIGTERM']); assert.equal(result.checks.pidReuseBlocked, true);
});

test('cleanup completes only after observed process-group absence', () => {
  const incomplete = orphanModule.simulateOrphanRecoveryDecision(base({ groupAbsentAfterKill: false }));
  assert.equal(incomplete.allowed, false); assert.equal(incomplete.reason, 'cleanup_incomplete'); assert.equal(incomplete.checks.processGroupAbsent, false);
  const afterTerm = orphanModule.simulateOrphanRecoveryDecision(base({ groupAbsentAfterTerm: true, groupAbsentAfterKill: false }));
  assert.equal(afterTerm.allowed, true); assert.deepEqual(afterTerm.actions, ['SIGTERM']); assert.equal(afterTerm.checks.processGroupAbsent, true);
});

test('complete orphan PASS evidence reflects every matching safety check', () => {
  assert.doesNotThrow(() => makeProbe({ probeId: 'orphan_recovery', result: 'PASS', evidence: { status: 'clean', criterion: 'identity_checked_orphan_cleanup', pointer: 'private_recovery_authority_consumed', registeredOwnedChild: true, daemonEpochRevoked: true, recoveryAuthorityConsumed: true, exactIdentityVerified: true, unrelatedPidProtected: true, pidReuseBlocked: true, termSent: true, killSent: true, processGroupAbsent: true, cleanupCompleted: true } }));
  assert.throws(() => makeProbe({ probeId: 'orphan_recovery', result: 'PASS', evidence: {} }), /unknown or missing|requires complete/);
});
