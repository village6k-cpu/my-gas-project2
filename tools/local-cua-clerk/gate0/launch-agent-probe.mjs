import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn as nodeSpawn } from 'node:child_process';
import { PINNED_CODEX_PATH, PROBE_PAYLOAD, PROBE_ARGS } from './codex-probe-runner.mjs';
export const PINNED_RUNNER_PATH = new URL('./codex-probe-runner.mjs', import.meta.url).pathname;
import { makeProbe } from './probe-contract.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const safeLabel = label => typeof label === 'string' && /^com\.village\.gate0\.[a-f0-9-]+$/.test(label);

export function makeLaunchAgentPlist({ label, nodePath = process.execPath, runnerPath = PINNED_RUNNER_PATH, codexPath = PINNED_CODEX_PATH, outputPath, allowTestOverrides = false }) {
  if (!safeLabel(label)) throw new TypeError('invalid temporary launch agent label');
  for (const value of [nodePath, runnerPath, codexPath, outputPath]) if (typeof value !== 'string' || !value.startsWith('/')) throw new TypeError('launch agent path must be absolute');
  if (!allowTestOverrides && (runnerPath !== PINNED_RUNNER_PATH || codexPath !== PINNED_CODEX_PATH)) throw new TypeError('launch agent path is not pinned');
  const args = [nodePath, runnerPath, '--codex-path', codexPath, '--output', outputPath, '--probe-id', 'launchagent_cua'];
  const xml = args.map(arg => `    <string>${String(arg).replaceAll('&', '&amp;').replaceAll('<', '&lt;')}</string>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key><string>${label}</string><key>ProgramArguments</key><array>\n${xml}\n</array><key>RunAtLoad</key><true/><key>KeepAlive</key><false/></dict></plist>\n`;
}

function commandRunner(spawnImpl) {
  return (args) => new Promise((resolve, reject) => {
    const child = spawnImpl('/bin/launchctl', args, { stdio: ['ignore', 'ignore', 'ignore'] });
    child.once('error', reject); child.once('close', code => code === 0 ? resolve() : reject(Object.assign(new Error('launchctl'), { code })));
  });
}

export async function runLaunchAgentProbe({ codexPath = PINNED_CODEX_PATH, runnerPath = PINNED_RUNNER_PATH, allowTestOverrides = false, launchctl = commandRunner(nodeSpawn), resultWriter, tempRoot = tmpdir(), timeoutMs = 30_000, now = () => new Date().toISOString(), runId } = {}) {
  if (typeof codexPath !== 'string' || !codexPath.startsWith('/') || (!allowTestOverrides && codexPath !== PINNED_CODEX_PATH)) throw new TypeError('codex path is not pinned');
  if (!allowTestOverrides && runnerPath !== PINNED_RUNNER_PATH) throw new TypeError('runner path is not pinned');
  const uid = process.getuid?.();
  if (!Number.isInteger(uid)) throw new Error('uid unavailable');
  const label = `com.village.gate0.${randomUUID()}`;
  const domain = `gui/${uid}`;
  const dir = await mkdtemp(join(tempRoot, 'gate0-launchagent-'));
  const plistPath = join(dir, 'probe.plist');
  const outputPath = join(dir, 'result.json');
  let bootstrapAttempted = false;
  try {
    await writeFile(plistPath, makeLaunchAgentPlist({ label, nodePath: process.execPath, runnerPath, codexPath, outputPath, allowTestOverrides }), { mode: 0o600 });
    bootstrapAttempted = true;
    await launchctl(['bootstrap', domain, plistPath]);
    if (resultWriter) await resultWriter(outputPath);
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try { const parsed = JSON.parse(await readFile(outputPath, 'utf8')); if (parsed?.probeId === 'launchagent_cua') return makeProbe(parsed); } catch {}
      await sleep(Math.min(100, Math.max(1, deadline - Date.now())));
    }
    return makeProbe({ probeId: 'launchagent_cua', result: 'BLOCKED', checkedAt: now(), runId, evidence: { status: 'unknown', criterion: 'launchagent_probe_timeout', pointer: 'bounded_wait' }, errorClass: 'timeout' });
  } catch {
    return makeProbe({ probeId: 'launchagent_cua', result: 'BLOCKED', checkedAt: now(), runId, evidence: { status: 'unknown', criterion: 'launchagent_probe', pointer: 'launchctl_error' }, errorClass: 'command_failed' });
  } finally {
    if (bootstrapAttempted && safeLabel(label)) { try { await launchctl(['bootout', domain, `${domain}/${label}`]); } catch {} }
    await rm(dir, { recursive: true, force: true });
  }
}

export { safeLabel };
