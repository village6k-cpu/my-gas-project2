import { spawn as nodeSpawn } from 'node:child_process';
import { execFile as nodeExecFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { makeProbe } from './probe-contract.mjs';

const execFile = promisify(nodeExecFile);
const identityEqual = (a, b) => Boolean(a && b) && ['pid', 'pgid', 'executable', 'start'].every(key => a[key] === b[key]);
const validPid = value => Number.isInteger(value) && value > 1;

function createRecoveryAuthority(identity) {
  return { authorityId: `recovery-${randomUUID()}`, identity: Object.freeze({ ...identity }), consumed: false };
}

function denyUnrelatedTarget(authority, target) {
  return !identityEqual(authority.identity, target);
}

// Pure adversarial seam. It plans decisions only and can never spawn or signal.
export function simulateOrphanRecoveryDecision({ daemonEpochRevoked = false, recoveryAuthority, target, beforeTerm, beforeKill, unrelatedTarget, reusedTarget, groupAbsentAfterTerm = false, groupAbsentAfterKill = false } = {}) {
  const authority = recoveryAuthority && { ...recoveryAuthority, identity: recoveryAuthority.identity && { ...recoveryAuthority.identity } };
  const actions = [];
  const checks = {
    daemonEpochRevoked,
    unrelatedPidProtected: Boolean(authority && denyUnrelatedTarget(authority, unrelatedTarget)),
    pidReuseBlocked: Boolean(authority && denyUnrelatedTarget(authority, reusedTarget)),
    exactIdentityVerified: false,
    recoveryAuthorityConsumed: false,
    processGroupAbsent: false,
  };
  if (!daemonEpochRevoked || !authority || authority.consumed || !validPid(target?.pid) || !validPid(target?.pgid) || !identityEqual(authority.identity, target)) return Object.freeze({ allowed: false, reason: 'authority_denied', actions, checks: Object.freeze(checks) });
  if (!checks.unrelatedPidProtected || !checks.pidReuseBlocked || !identityEqual(authority.identity, beforeTerm)) return Object.freeze({ allowed: false, reason: 'identity_mismatch', actions, checks: Object.freeze(checks) });
  checks.exactIdentityVerified = true;
  checks.recoveryAuthorityConsumed = true;
  actions.push('SIGTERM');
  if (groupAbsentAfterTerm) {
    checks.processGroupAbsent = true;
    return Object.freeze({ allowed: true, reason: 'cleaned', actions, checks: Object.freeze(checks) });
  }
  if (!identityEqual(authority.identity, beforeKill)) return Object.freeze({ allowed: false, reason: 'pid_reuse', actions, checks: Object.freeze(checks) });
  actions.push('SIGKILL');
  checks.processGroupAbsent = groupAbsentAfterKill;
  return Object.freeze({ allowed: checks.processGroupAbsent, reason: checks.processGroupAbsent ? 'cleaned' : 'cleanup_incomplete', actions, checks: Object.freeze(checks) });
}

async function defaultIdentityReader(pid) {
  const { stdout } = await execFile('/bin/ps', ['-p', String(pid), '-o', 'pid=,pgid=,comm=,lstart=']);
  const parts = String(stdout).trim().split(/\s+/);
  if (parts.length < 5) throw new Error('identity');
  return { pid: Number(parts[0]), pgid: Number(parts[1]), executable: parts[2], start: parts.slice(3).join(' ') };
}

function defaultGroupAbsent(pgid) {
  try { process.kill(-pgid, 0); return false; }
  catch (error) { return error?.code === 'ESRCH'; }
}

async function waitForGroupAbsence(pgid, deadline) {
  while (Date.now() < deadline) {
    if (defaultGroupAbsent(pgid)) return true;
    await new Promise(resolve => setTimeout(resolve, Math.min(25, Math.max(1, deadline - Date.now()))));
  }
  return defaultGroupAbsent(pgid);
}

async function cleanupExactChild(child, timeoutMs = 500) {
  if (!child || typeof child.kill !== 'function' || typeof child.once !== 'function') return 'cleanup_incomplete';
  const wait = deadline => new Promise(resolve => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve(true);
    let timer;
    const done = value => { clearTimeout(timer); child.removeListener?.('close', closed); resolve(value); };
    const closed = () => done(true);
    timer = setTimeout(() => done(false), Math.max(1, deadline - Date.now()));
    child.once('close', closed);
  });
  const deadline = Date.now() + timeoutMs;
  try { child.kill('SIGTERM'); } catch { return 'cleanup_incomplete'; }
  if (await wait(Date.now() + Math.floor(timeoutMs / 2))) return 'cleanup_attempted';
  try { child.kill('SIGKILL'); } catch { return 'cleanup_incomplete'; }
  return await wait(deadline) ? 'cleanup_attempted' : 'cleanup_incomplete';
}

async function recoverWithPrivateAuthority({ authority, daemonEpochRevoked, registeredOwnedChild, target, identityReader, deadline }) {
  const unrelated = { ...target, pid: target.pid + 1, pgid: target.pgid + 1 };
  const reused = { ...target, start: `${target.start}-reused` };
  const state = {
    registeredOwnedChild: registeredOwnedChild && validPid(target.pid) && validPid(target.pgid) && identityEqual(authority.identity, target),
    daemonEpochRevoked,
    recoveryAuthorityConsumed: false,
    exactIdentityVerified: false,
    unrelatedPidProtected: denyUnrelatedTarget(authority, unrelated),
    pidReuseBlocked: denyUnrelatedTarget(authority, reused),
    termSent: false,
    killSent: false,
    processGroupAbsent: false,
    cleanupCompleted: false,
  };
  if (!state.registeredOwnedChild || !state.daemonEpochRevoked || authority.consumed || !state.unrelatedPidProtected || !state.pidReuseBlocked) return { reason: 'identity_mismatch', state };
  let beforeTerm;
  try { beforeTerm = await identityReader(target.pid); } catch { return { reason: 'identity_mismatch', state }; }
  if (!identityEqual(authority.identity, beforeTerm)) return { reason: 'pid_reuse', state };
  state.exactIdentityVerified = true;
  authority.consumed = true;
  state.recoveryAuthorityConsumed = true;
  try { process.kill(-target.pgid, 'SIGTERM'); state.termSent = true; } catch { return { reason: 'command_failed', state }; }
  const termDeadline = Math.min(deadline, Date.now() + Math.max(1, Math.floor((deadline - Date.now()) / 2)));
  state.processGroupAbsent = await waitForGroupAbsence(target.pgid, termDeadline);
  if (!state.processGroupAbsent) {
    let beforeKill;
    try { beforeKill = await identityReader(target.pid); } catch { return { reason: 'identity_mismatch', state }; }
    if (!identityEqual(authority.identity, beforeKill)) return { reason: 'pid_reuse', state };
    try { process.kill(-target.pgid, 'SIGKILL'); state.killSent = true; } catch { return { reason: 'command_failed', state }; }
    state.processGroupAbsent = await waitForGroupAbsence(target.pgid, deadline);
  }
  state.cleanupCompleted = state.processGroupAbsent;
  return { reason: state.cleanupCompleted ? 'cleaned' : 'cleanup_incomplete', state };
}

export async function runOrphanRecoveryProbe() {
  const spawnOwned = () => nodeSpawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
  const identityReader = defaultIdentityReader, now = () => new Date().toISOString(), runId = undefined;
  const deadline = Date.now() + 2_000;
  let child;
  try { child = await spawnOwned(); } catch { return makeProbe({ probeId: 'orphan_recovery', result: 'BLOCKED', checkedAt: now(), runId, evidence: { status: 'unknown', criterion: 'disposable_child', pointer: 'spawn_failed' }, errorClass: 'command_failed' }); }
  const pid = child?.pid;
  let identity;
  try { identity = await identityReader(pid); } catch {
    const cleanup = await cleanupExactChild(child);
    return makeProbe({ probeId: 'orphan_recovery', result: 'BLOCKED', checkedAt: now(), runId, evidence: { status: 'unknown', criterion: 'identity', pointer: cleanup }, errorClass: cleanup === 'cleanup_incomplete' ? 'cleanup_incomplete' : 'identity_mismatch' });
  }
  const target = { pid, pgid: identity.pgid, executable: identity.executable, start: identity.start };
  const registeredOwnedChild = validPid(pid) && validPid(identity.pgid) && identity.pid === pid && identity.executable === child.spawnfile && identityEqual(target, identity);
  if (!registeredOwnedChild) {
    const cleanup = await cleanupExactChild(child);
    return makeProbe({ probeId: 'orphan_recovery', result: 'BLOCKED', checkedAt: now(), runId, evidence: { status: 'unknown', criterion: 'identity', pointer: cleanup }, errorClass: cleanup === 'cleanup_incomplete' ? 'cleanup_incomplete' : 'identity_mismatch' });
  }
  const daemonEpoch = { id: `daemon-${randomUUID()}`, revoked: false };
  const authority = createRecoveryAuthority(target);
  daemonEpoch.revoked = true; // Revoke helper/daemon authority before recovery begins.
  const recovered = await recoverWithPrivateAuthority({ authority, daemonEpochRevoked: daemonEpoch.revoked, registeredOwnedChild, target, identityReader, deadline });
  const pass = recovered.reason === 'cleaned' && recovered.state.cleanupCompleted;
  const evidence = { status: pass ? 'clean' : 'denied', criterion: 'identity_checked_orphan_cleanup', pointer: pass ? 'private_recovery_authority_consumed' : (recovered.reason === 'cleanup_incomplete' ? 'cleanup_incomplete' : 'cleanup_blocked'), ...recovered.state };
  const errorClass = recovered.reason === 'cleaned' ? undefined : (['pid_reuse', 'identity_mismatch', 'command_failed', 'cleanup_incomplete'].includes(recovered.reason) ? recovered.reason : 'cleanup_incomplete');
  return makeProbe({ probeId: 'orphan_recovery', result: pass ? 'PASS' : 'BLOCKED', checkedAt: now(), runId, evidence, ...(errorClass ? { errorClass } : {}) });
}

if (import.meta.url === `file://${process.argv[1]}`) process.stdout.write(JSON.stringify(await runOrphanRecoveryProbe()) + '\n');
