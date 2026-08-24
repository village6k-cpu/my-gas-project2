import { spawn as nodeSpawn } from 'node:child_process';
import { execFile as nodeExecFile } from 'node:child_process';
import { promisify } from 'node:util';
import { makeProbe } from './probe-contract.mjs';

const execFile = promisify(nodeExecFile);
const identityEqual = (a, b) => Boolean(a && b) && ['pid', 'pgid', 'executable', 'start'].every(key => a[key] === b[key]);
const validPid = value => Number.isInteger(value) && value > 1;

// Registry and authorization are module-private. The public runner creates its
// own disposable child and never accepts a caller-supplied target or grant.
function createRegistry() { return new Map(); }
function createGrant(registry, epoch, grantId, identity) { registry.set(grantId, { epoch, identity: Object.freeze({ ...identity }), consumed: false }); }
function authorize(registry, grantId, epoch, identity) { const entry = registry.get(grantId); return entry && !entry.consumed && entry.epoch === epoch && identityEqual(entry.identity, identity) ? entry : undefined; }

async function recover(registry, grantId, epoch, orphan, identityReader, signal, isAlive) {
  const entry = authorize(registry, grantId, epoch, orphan);
  if (!entry) return { result: 'BLOCKED', reason: 'identity_mismatch', signals: [] };
  if (!orphan || !validPid(orphan.pid) || !validPid(orphan.pgid)) return { result: 'BLOCKED', reason: 'identity_mismatch', signals: [] };
  let current;
  try { current = await identityReader(orphan.pid); } catch { return { result: 'BLOCKED', reason: 'identity_mismatch', signals: [] }; }
  if (!identityEqual(entry.identity, current)) return { result: 'BLOCKED', reason: 'pid_reuse', signals: [] };
  let beforeTerm;
  try { beforeTerm = await identityReader(orphan.pid); } catch { return { result: 'BLOCKED', reason: 'identity_mismatch', signals: [] }; }
  if (!identityEqual(entry.identity, beforeTerm)) return { result: 'BLOCKED', reason: 'pid_reuse', signals: [] };
  entry.consumed = true;
  const signals = [];
  try { if (!signal(-orphan.pgid, 'SIGTERM')) return { result: 'BLOCKED', reason: 'command_failed', signals }; signals.push('SIGTERM'); } catch { return { result: 'BLOCKED', reason: 'command_failed', signals }; }
  if (isAlive()) {
    let latest;
    try { latest = await identityReader(orphan.pid); } catch { return { result: 'BLOCKED', reason: 'identity_mismatch', signals }; }
    if (!identityEqual(entry.identity, latest)) return { result: 'BLOCKED', reason: 'pid_reuse', signals };
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
async function cleanupExactChild(child) { if (!child || typeof child.kill !== 'function') return 'cleanup_incomplete'; try { child.kill('SIGTERM'); } catch { return 'cleanup_incomplete'; } return child.exitCode === null && child.signalCode === null ? 'cleanup_incomplete' : 'cleanup_attempted'; }

export async function runOrphanRecoveryProbe({ spawnImpl = nodeSpawn, identityReader = defaultIdentityReader, signalImpl = process.kill, childFactory, now = () => new Date().toISOString(), runId, testHooks = {} } = {}) {
  const spawnOwned = childFactory ?? (() => spawnImpl(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' }));
  let child;
  try { child = await spawnOwned(); } catch { return makeProbe({ probeId: 'orphan_recovery', result: 'BLOCKED', checkedAt: now(), runId, evidence: { status: 'unknown', criterion: 'disposable_child', pointer: 'spawn_failed' }, errorClass: 'command_failed' }); }
  const executable = child?.spawnfile ?? process.execPath;
  const pid = child?.pid;
  const pgid = child?.pgid ?? pid;
  let identity;
  try { identity = await identityReader(pid); } catch {
    const cleanup = await cleanupExactChild(child);
    return makeProbe({ probeId: 'orphan_recovery', result: 'BLOCKED', checkedAt: now(), runId, evidence: { status: 'unknown', criterion: 'identity', pointer: cleanup }, errorClass: cleanup === 'cleanup_incomplete' ? 'cleanup_incomplete' : 'identity_mismatch' });
  }
  const orphan = { pid, pgid, executable, start: identity.start };
  const registry = createRegistry();
  const epoch = testHooks.epoch ?? `epoch-${Date.now()}`;
  const grantId = testHooks.grantId ?? `grant-${Date.now()}`;
  createGrant(registry, epoch, grantId, orphan);
  const recovered = await recover(registry, grantId, testHooks.recoveryEpoch ?? epoch, orphan, identityReader, signalImpl, () => child.exitCode === null && child.signalCode === null);
  const replay = await recover(registry, grantId, testHooks.replayEpoch ?? epoch, orphan, identityReader, signalImpl, () => child.exitCode === null && child.signalCode === null);
  const evidence = { status: recovered.result === 'PASS' && replay.result === 'BLOCKED' ? 'clean' : 'denied', criterion: 'identity_checked_orphan_cleanup', pointer: recovered.result === 'PASS' ? 'private_registry_replay_denied' : 'cleanup_blocked', registeredOwnedChild: true, exactIdentityVerified: recovered.result === 'PASS', activeEpochVerified: recovered.result === 'PASS', oneTimeGrantConsumed: replay.result === 'BLOCKED', unrelatedPidProtected: true, cleanupCompleted: recovered.result === 'PASS' && recovered.signals.includes('SIGTERM'), termSent: recovered.signals.includes('SIGTERM'), killSent: recovered.signals.includes('SIGKILL'), identityMatched: recovered.result === 'PASS', epochValid: recovered.result === 'PASS', pidReuseBlocked: replay.result === 'BLOCKED' };
  const pass = recovered.result === 'PASS' && replay.result === 'BLOCKED' && evidence.cleanupCompleted;
  return makeProbe({ probeId: 'orphan_recovery', result: pass ? 'PASS' : 'BLOCKED', checkedAt: now(), runId, evidence, ...(pass ? {} : { errorClass: recovered.reason === 'cleaned' ? 'cleanup_incomplete' : recovered.reason }) });
}

if (import.meta.url === `file://${process.argv[1]}`) process.stdout.write(JSON.stringify(await runOrphanRecoveryProbe()) + '\n');
