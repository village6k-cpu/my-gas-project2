import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn as nodeSpawn } from 'node:child_process';
import { PINNED_CODEX_PATH, PROBE_PAYLOAD, PROBE_ARGS } from './codex-probe-runner.mjs';
export const PINNED_RUNNER_PATH = new URL('./codex-probe-runner.mjs', import.meta.url).pathname;
export const PINNED_WORKING_DIRECTORY = dirname(PINNED_RUNNER_PATH);
export const MINIMAL_ENVIRONMENT = Object.freeze({ LANG: 'en_US.UTF-8', PATH: '/usr/bin:/bin:/usr/sbin:/sbin' });
import { makeProbe, makeRunId } from './probe-contract.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const safeLabel = label => typeof label === 'string' && /^com\.village\.gate0\.[a-f0-9-]+$/.test(label);

export function makeLaunchAgentPlist({ label, nodePath = process.execPath, runnerPath = PINNED_RUNNER_PATH, codexPath = PINNED_CODEX_PATH, outputPath, runId, workingDirectory = PINNED_WORKING_DIRECTORY, environment = MINIMAL_ENVIRONMENT, allowTestOverrides = false }) {
  if (!safeLabel(label)) throw new TypeError('invalid temporary launch agent label');
  for (const value of [nodePath, runnerPath, codexPath, outputPath, workingDirectory]) if (typeof value !== 'string' || !value.startsWith('/')) throw new TypeError('launch agent path must be absolute');
  if (!/^[a-f0-9]{16,64}$/.test(runId)) throw new TypeError('launch agent run id required');
  if (!allowTestOverrides && (runnerPath !== PINNED_RUNNER_PATH || codexPath !== PINNED_CODEX_PATH || workingDirectory !== PINNED_WORKING_DIRECTORY)) throw new TypeError('launch agent path is not pinned');
  if (!environment || Object.keys(environment).sort().join(',') !== 'LANG,PATH' || environment.LANG !== MINIMAL_ENVIRONMENT.LANG || environment.PATH !== MINIMAL_ENVIRONMENT.PATH) throw new TypeError('launch agent environment is not allowlisted');
  const args = [nodePath, runnerPath, '--codex-path', codexPath, '--output', outputPath, '--probe-id', 'launchagent_cua', '--run-id', runId];
  const xml = args.map(arg => `    <string>${String(arg).replaceAll('&', '&amp;').replaceAll('<', '&lt;')}</string>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key><string>${label}</string><key>ProgramArguments</key><array>\n${xml}\n</array><key>WorkingDirectory</key><string>${workingDirectory}</string><key>EnvironmentVariables</key><dict><key>LANG</key><string>${MINIMAL_ENVIRONMENT.LANG}</string><key>PATH</key><string>${MINIMAL_ENVIRONMENT.PATH}</string></dict><key>RunAtLoad</key><true/><key>KeepAlive</key><false/></dict></plist>\n`;
}

function commandRunner(spawnImpl) {
  return (args) => new Promise((resolve, reject) => {
    const child = spawnImpl('/bin/launchctl', args, { stdio: ['ignore', 'ignore', 'ignore'] });
    child.once('error', reject); child.once('close', code => code === 0 ? resolve() : reject(Object.assign(new Error('launchctl'), { code })));
  });
}

async function boundedCall(operation, timeoutMs) {
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('launchctl_timeout')), Math.max(1, timeoutMs)); });
  try { return await Promise.race([Promise.resolve().then(operation), timeout]); }
  finally { clearTimeout(timer); }
}

async function bootoutConfirmed(launchctl, serviceTarget, timeoutMs) {
  try { await boundedCall(() => launchctl(['bootout', serviceTarget]), timeoutMs); }
  catch { return false; }
  try {
    await boundedCall(() => launchctl(['print', serviceTarget]), timeoutMs);
    return false;
  } catch (error) {
    return error?.code === 113;
  }
}

export async function runLaunchAgentProbe({ codexPath = PINNED_CODEX_PATH, runnerPath = PINNED_RUNNER_PATH, allowTestOverrides = false, launchctl = commandRunner(nodeSpawn), resultWriter, tempRoot = tmpdir(), timeoutMs = 30_000, now = () => new Date().toISOString(), runId } = {}) {
  if (typeof codexPath !== 'string' || !codexPath.startsWith('/') || (!allowTestOverrides && codexPath !== PINNED_CODEX_PATH)) throw new TypeError('codex path is not pinned');
  if (!allowTestOverrides && runnerPath !== PINNED_RUNNER_PATH) throw new TypeError('runner path is not pinned');
  const uid = process.getuid?.();
  if (!Number.isInteger(uid)) throw new Error('uid unavailable');
  const label = `com.village.gate0.${randomUUID()}`;
  const domain = `gui/${uid}`;
  const serviceTarget = `${domain}/${label}`;
  const ownerRunId = runId ?? makeRunId();
  const dir = await mkdtemp(join(tempRoot, 'gate0-launchagent-'));
  const plistPath = join(dir, 'probe.plist');
  const outputPath = join(dir, 'result.json');
  const recoveryPath = join(dir, 'recovery.json');
  let bootstrapAttempted = false;
  let candidate;
  try {
    await writeFile(plistPath, makeLaunchAgentPlist({ label, nodePath: process.execPath, runnerPath, codexPath, outputPath, runId: ownerRunId, workingDirectory: allowTestOverrides ? dirname(runnerPath) : PINNED_WORKING_DIRECTORY, allowTestOverrides }), { mode: 0o600 });
    bootstrapAttempted = true;
    await boundedCall(() => launchctl(['bootstrap', domain, plistPath]), timeoutMs);
    if (resultWriter) await resultWriter(outputPath);
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try { const parsed = JSON.parse(await readFile(outputPath, 'utf8')); if (parsed?.probeId === 'launchagent_cua') { candidate = makeProbe(parsed); break; } } catch {}
      await sleep(Math.min(100, Math.max(1, deadline - Date.now())));
    }
    candidate ??= makeProbe({ probeId: 'launchagent_cua', result: 'BLOCKED', checkedAt: now(), runId: ownerRunId, evidence: { status: 'unknown', criterion: 'launchagent_probe_timeout', pointer: 'bounded_wait' }, errorClass: 'timeout' });
  } catch {
    candidate = makeProbe({ probeId: 'launchagent_cua', result: 'BLOCKED', checkedAt: now(), runId: ownerRunId, evidence: { status: 'unknown', criterion: 'launchagent_probe', pointer: 'launchctl_error' }, errorClass: 'command_failed' });
  }

  if (bootstrapAttempted && safeLabel(label)) {
    const confirmed = await bootoutConfirmed(launchctl, serviceTarget, Math.min(timeoutMs, 2_000));
    if (!confirmed) {
      await rm(outputPath, { force: true });
      let mappingRetained = false;
      try { await writeFile(recoveryPath, JSON.stringify({ label, serviceTarget, ownerRunId, plistPath }, null, 2) + '\n', { mode: 0o600 }); mappingRetained = true; } catch {}
      return makeProbe({ probeId: 'launchagent_cua', result: 'BLOCKED', checkedAt: now(), runId: ownerRunId, evidence: { status: 'unknown', criterion: 'temporary_launchagent_cleanup', pointer: mappingRetained ? 'cleanup_mapping_retained' : 'cleanup_incomplete' }, errorClass: 'cleanup_incomplete' });
    }
  }
  try {
    await rm(dir, { recursive: true, force: true });
  } catch {
    return makeProbe({ probeId: 'launchagent_cua', result: 'BLOCKED', checkedAt: now(), runId: ownerRunId, evidence: { status: 'unknown', criterion: 'temporary_launchagent_cleanup', pointer: 'cleanup_incomplete' }, errorClass: 'cleanup_incomplete' });
  }
  return candidate;
}

export { safeLabel };
