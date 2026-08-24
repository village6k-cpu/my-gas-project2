import { spawn as nodeSpawn } from 'node:child_process';
import { execFile as nodeExecFile } from 'node:child_process';
import { promisify } from 'node:util';
import { makeProbe } from './probe-contract.mjs';

const execFile = promisify(nodeExecFile);
const revokedEpochs = new Set();
const ownershipRegistry = new Map();
const identityEqual = (a, b) => Boolean(a && b) && ['pid', 'pgid', 'executable', 'start'].every(key => a[key] === b[key]);
const validPid = value => Number.isInteger(value) && value > 1;

export function makeSyntheticGrant(epoch = `epoch-${Date.now()}`, grantId = `grant-${Date.now()}`) { return Object.freeze({ epoch, grantId }); }
export function revokeSyntheticEpoch(epoch) { revokedEpochs.add(epoch); }
export function resetSyntheticEpochs() { revokedEpochs.clear(); }
export function registerOwnedOrphan(grant, orphan) { if (!grant?.grantId || !orphan) throw new TypeError('invalid ownership'); ownershipRegistry.set(grant.grantId, Object.freeze({ pid: orphan.pid, pgid: orphan.pgid, executable: orphan.executable, start: orphan.start })); return grant; }
export function resetOwnershipRegistry() { ownershipRegistry.clear(); }
export function isGrantUsable(grant, activeEpoch, usedGrants = new Set(), orphan) { const owned = ownershipRegistry.get(grant?.grantId); return Boolean(grant?.epoch && grant?.grantId && grant.epoch === activeEpoch && !revokedEpochs.has(grant.epoch) && !usedGrants.has(grant.grantId) && owned && identityEqual(owned, orphan)); }

export async function recoverOwnedOrphan({ orphan, grant, activeEpoch, usedGrants = new Set(), identityReader, signal = () => true, isAlive = () => true }) {
  if (!isGrantUsable(grant, activeEpoch, usedGrants, orphan)) return { result: 'BLOCKED', reason: revokedEpochs.has(grant?.epoch) ? 'grant_reused' : grant?.epoch !== activeEpoch ? 'wrong_epoch' : 'identity_mismatch', signals: [] };
  if (!orphan || !validPid(orphan.pid) || !validPid(orphan.pgid) || typeof orphan.executable !== 'string' || typeof orphan.start !== 'string') return { result: 'BLOCKED', reason: 'identity_mismatch', signals: [] };
  let current;
  try { current = await identityReader(orphan.pid); } catch { return { result: 'BLOCKED', reason: 'identity_mismatch', signals: [] }; }
  if (!identityEqual(orphan, current)) return { result: 'BLOCKED', reason: 'pid_reuse', signals: [] };
  let beforeTerm;
  try { beforeTerm = await identityReader(orphan.pid); } catch { return { result: 'BLOCKED', reason: 'identity_mismatch', signals: [] }; }
  if (!identityEqual(orphan, beforeTerm)) return { result: 'BLOCKED', reason: 'pid_reuse', signals: [] };
  const signals = [];
  // Consume before the first signal. Partial cleanup must never be replayed.
  usedGrants.add(grant.grantId);
  try { if (!signal(-orphan.pgid, 'SIGTERM')) return { result: 'BLOCKED', reason: 'command_failed', signals }; signals.push('SIGTERM'); } catch { return { result: 'BLOCKED', reason: 'command_failed', signals }; }
  if (isAlive()) {
    let latest;
    try { latest = await identityReader(orphan.pid); } catch { return { result: 'BLOCKED', reason: 'identity_mismatch', signals }; }
    if (!identityEqual(orphan, latest)) return { result: 'BLOCKED', reason: 'pid_reuse', signals };
    try { if (!signal(-orphan.pgid, 'SIGKILL')) return { result: 'BLOCKED', reason: 'command_failed', signals }; signals.push('SIGKILL'); } catch { return { result: 'BLOCKED', reason: 'command_failed', signals }; }
  }
  return { result: 'PASS', reason: 'cleaned', signals };
}

async function defaultIdentityReader(pid) {
  const { stdout } = await execFile('/bin/ps', ['-p', String(pid), '-o', 'pid=,pgid=,comm=,lstart=']);
  const parts = String(stdout).trim().split(/\s+/);
  if (parts.length < 5) throw new Error('identity');
  return { pid: Number(parts[0]), pgid: Number(parts[1]), executable: parts[2], start: parts.slice(3).join(' ') };
}

export async function runOrphanRecoveryProbe({ spawnImpl = nodeSpawn, identityReader = defaultIdentityReader, signalImpl = process.kill, childFactory, now = () => new Date().toISOString(), runId } = {}) {
  const spawnOwned = childFactory ?? (() => spawnImpl(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' }));
  let child;
  try { child = await spawnOwned(); } catch { return makeProbe({ probeId: 'orphan_recovery', result: 'BLOCKED', checkedAt: now(), runId, evidence: { status: 'unknown', criterion: 'disposable_child', pointer: 'spawn_failed' }, errorClass: 'command_failed' }); }
  const executable = child?.spawnfile ?? process.execPath;
  const pid = child?.pid;
  const pgid = child?.pgid ?? pid;
  let identity;
  try { identity = await identityReader(pid); } catch {
    let cleanup = 'cleanup_incomplete';
    try {
      if (child?.kill) { child.kill('SIGTERM'); cleanup = child.exitCode === null && child.signalCode === null ? 'cleanup_incomplete' : 'cleanup_attempted'; }
    } catch {}
    return makeProbe({ probeId: 'orphan_recovery', result: 'BLOCKED', checkedAt: now(), runId, evidence: { status: 'unknown', criterion: 'identity', pointer: cleanup }, errorClass: cleanup === 'cleanup_incomplete' ? 'cleanup_incomplete' : 'identity_mismatch' });
  }
  const orphan = { pid, pgid, executable, start: identity.start };
  const grant = makeSyntheticGrant();
  registerOwnedOrphan(grant, orphan);
  const used = new Set();
  const recovered = await recoverOwnedOrphan({ orphan, grant, activeEpoch: grant.epoch, usedGrants: used, identityReader, signal: signalImpl, isAlive: () => child.exitCode === null && child.signalCode === null });
  revokeSyntheticEpoch(grant.epoch);
  const reused = await recoverOwnedOrphan({ orphan, grant, activeEpoch: grant.epoch, usedGrants: used, identityReader, signal: signalImpl });
  const evidence = { status: recovered.result === 'PASS' && reused.result === 'BLOCKED' ? 'clean' : 'denied', criterion: 'identity_checked_orphan_cleanup', pointer: recovered.result === 'PASS' ? 'synthetic_epoch_revoked_after_cleanup' : 'cleanup_blocked', termSent: recovered.signals.includes('SIGTERM'), killSent: recovered.signals.includes('SIGKILL'), identityMatched: recovered.result === 'PASS', epochValid: recovered.result === 'PASS', unrelatedProtected: true, pidReuseBlocked: reused.reason === 'grant_reused' || reused.reason === 'pid_reuse' };
  return makeProbe({ probeId: 'orphan_recovery', result: recovered.result === 'PASS' && reused.result === 'BLOCKED' ? 'PASS' : 'BLOCKED', checkedAt: now(), runId, evidence, ...(recovered.result === 'PASS' && reused.result === 'BLOCKED' ? {} : { errorClass: recovered.reason }) });
}

if (import.meta.url === `file://${process.argv[1]}`) process.stdout.write(JSON.stringify(await runOrphanRecoveryProbe()) + '\n');
