#!/usr/bin/env node

import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  access,
  chmod,
  constants as fsConstants,
  lstat,
  mkdir,
  open,
  rename,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { promisify, parseEnv } from 'node:util';
import { fileURLToPath } from 'node:url';
import { loadSocketModeConfig } from './socket-mode-runner.mjs';

export const MAC_AGENT_LABEL = 'com.village.mac-agent';

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = resolve(MODULE_DIR, '../../..');
const USER_HOME = homedir();
const runFile = promisify(execFile);
const ABSENCE_ATTEMPTS = 40;
const ABSENCE_INTERVAL_MS = 50;
const READINESS_TIMEOUT_MS = 15_000;
const READINESS_POLL_MS = 50;
const RUN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export const MAC_AGENT_READY_SCHEMA = 'mac-agent-runtime-ready/v1';

export const MAC_AGENT_PATHS = Object.freeze({
  nodePath: join(USER_HOME, '.local/bin/node'),
  entrypointPath: join(MODULE_DIR, 'mac-agent-service-entrypoint.mjs'),
  runnerPath: join(MODULE_DIR, 'socket-mode-runner.mjs'),
  envFile: join(USER_HOME, 'Library/Application Support/village-local-cua-clerk/slack.env'),
  readyPath: join(USER_HOME, 'Library/Application Support/village-local-cua-clerk/runtime-ready.json'),
  workingDirectory: REPOSITORY_ROOT,
  stdoutPath: join(USER_HOME, 'Library/Logs/Village/MacAgent/stdout.log'),
  stderrPath: join(USER_HOME, 'Library/Logs/Village/MacAgent/stderr.log'),
  plistPath: join(USER_HOME, `Library/LaunchAgents/${MAC_AGENT_LABEL}.plist`),
});

function xmlEscape(value) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function validateAbsolutePaths(paths) {
  for (const [key, value] of Object.entries(paths)) {
    if (typeof value !== 'string' || !isAbsolute(value) || resolve(value) !== value) {
      throw new TypeError(`${key} must be an absolute normalized path`);
    }
  }
}

export function makeMacAgentLaunchAgentPlist({
  nodePath = MAC_AGENT_PATHS.nodePath,
  entrypointPath = MAC_AGENT_PATHS.entrypointPath,
  runnerPath = MAC_AGENT_PATHS.runnerPath,
  envFile = MAC_AGENT_PATHS.envFile,
  readyPath = MAC_AGENT_PATHS.readyPath,
  workingDirectory = MAC_AGENT_PATHS.workingDirectory,
  stdoutPath = MAC_AGENT_PATHS.stdoutPath,
  stderrPath = MAC_AGENT_PATHS.stderrPath,
  runId,
  allowTestOverrides = false,
} = {}) {
  const paths = {
    nodePath,
    entrypointPath,
    runnerPath,
    envFile,
    readyPath,
    workingDirectory,
    stdoutPath,
    stderrPath,
  };
  validateAbsolutePaths(paths);
  if (!allowTestOverrides) {
    for (const [key, value] of Object.entries(paths)) {
      if (value !== MAC_AGENT_PATHS[key]) throw new TypeError(`${key} is not pinned`);
    }
  }
  if (!RUN_ID.test(runId ?? '')) throw new TypeError('invalid MacAgent run id');

  const [node, entrypoint, env, ready, runtimeRunId, workdir, stdout, stderr, home] = [
    nodePath,
    entrypointPath,
    `--env-file=${envFile}`,
    `--ready-file=${readyPath}`,
    `--run-id=${runId}`,
    workingDirectory,
    stdoutPath,
    stderrPath,
    USER_HOME,
  ].map(xmlEscape);

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${MAC_AGENT_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${node}</string>
    <string>${entrypoint}</string>
    <string>${env}</string>
    <string>${ready}</string>
    <string>${runtimeRunId}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${workdir}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key>
    <string>${home}</string>
    <key>LANG</key>
    <string>en_US.UTF-8</string>
    <key>PATH</key>
    <string>/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
  <key>StandardOutPath</key>
  <string>${stdout}</string>
  <key>StandardErrorPath</key>
  <string>${stderr}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>30</integer>
  <key>LimitLoadToSessionType</key>
  <string>Aqua</string>
  <key>ProcessType</key>
  <string>Background</string>
  <key>Umask</key>
  <integer>63</integer>
</dict>
</plist>
`;
}

async function defaultCommandRunner(file, args) {
  await runFile(file, args, { timeout: 10_000, windowsHide: true });
}

function pinnedPaths(paths, allowTestOverrides) {
  const candidate = { ...MAC_AGENT_PATHS, ...(paths ?? {}) };
  validateAbsolutePaths(candidate);
  if (!allowTestOverrides) {
    for (const [key, value] of Object.entries(candidate)) {
      if (value !== MAC_AGENT_PATHS[key]) throw new TypeError(`${key} is not pinned`);
    }
  }
  return Object.freeze(candidate);
}

async function readPrivateRegularFile(path, uid, name) {
  let stat;
  try {
    stat = await lstat(path);
  } catch (error) {
    const failure = new TypeError(`${name} must be a private regular file`);
    failure.code = error?.code;
    throw failure;
  }
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o600 || stat.uid !== uid) {
    throw new TypeError(`${name} must be a private regular file`);
  }
  if (typeof fsConstants.O_NOFOLLOW !== 'number') {
    throw new TypeError(`${name} no-follow protection is unavailable`);
  }
  let handle;
  try {
    handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const opened = await handle.stat();
    if (!opened.isFile() || (opened.mode & 0o777) !== 0o600 || opened.uid !== uid) {
      throw new TypeError(`${name} must be a private regular file`);
    }
    return await handle.readFile({ encoding: 'utf8' });
  } catch (error) {
    if (error instanceof TypeError) throw error;
    throw new TypeError(`${name} must be a private regular file`);
  } finally {
    await handle?.close();
  }
}

export async function loadPrivateMacAgentEnvironment(path, uid) {
  const text = await readPrivateRegularFile(path, uid, 'environment file');
  try {
    return Object.freeze(parseEnv(text));
  } catch {
    throw new TypeError('environment file failed the MacAgent contract');
  }
}

export async function requirePrivateMacAgentDirectory(path, uid, name) {
  let stat;
  try {
    stat = await lstat(path);
  } catch {
    throw new TypeError(`${name} must be a private directory`);
  }
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o700 || stat.uid !== uid) {
    throw new TypeError(`${name} must be a private directory`);
  }
}

function exactKeys(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index]);
}

function validateRuntimeReadiness(value, expectedRunId) {
  if (
    !exactKeys(value, ['schemaVersion', 'runId', 'status', 'evidence'])
    || value.schemaVersion !== MAC_AGENT_READY_SCHEMA
    || value.runId !== expectedRunId
    || value.status !== 'PASS'
    || !exactKeys(value.evidence, [
      'authenticated',
      'teamMatched',
      'botUserMatched',
      'botIdentityPresent',
    ])
    || Object.values(value.evidence).some(item => item !== true)
  ) {
    throw new TypeError('MacAgent runtime readiness is invalid');
  }
  return value;
}

async function readRuntimeReadiness(path, uid, expectedRunId) {
  const text = await readPrivateRegularFile(path, uid, 'runtime readiness file');
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new TypeError('MacAgent runtime readiness is invalid');
  }
  return validateRuntimeReadiness(parsed, expectedRunId);
}

async function waitForRuntimeReadiness({ path, uid, runId, timeoutMs, pollMs }) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    try {
      return await readRuntimeReadiness(path, uid, runId);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await new Promise(resolvePromise => setTimeout(resolvePromise, Math.min(pollMs, remaining)));
  }
  throw new Error('MacAgent runtime readiness was not confirmed');
}

async function removeExactFile(path) {
  try {
    await unlink(path);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

async function writePrivatePlist(path, contents) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, contents, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await rename(temporary, path);
    await chmod(path, 0o600);
  } finally {
    await unlink(temporary).catch(() => {});
  }
}

export async function installMacAgentLaunchAgent({
  paths,
  uid = process.getuid(),
  commandRunner = defaultCommandRunner,
  readinessTimeoutMs = READINESS_TIMEOUT_MS,
  readinessPollMs = READINESS_POLL_MS,
  allowTestOverrides = false,
} = {}) {
  if (!Number.isInteger(uid) || uid < 1) throw new TypeError('invalid user id');
  if (!allowTestOverrides && uid !== process.getuid()) throw new TypeError('user id is not current');
  if (typeof commandRunner !== 'function') throw new TypeError('invalid command runner');
  if (
    !Number.isInteger(readinessTimeoutMs)
    || readinessTimeoutMs < 1
    || !Number.isInteger(readinessPollMs)
    || readinessPollMs < 1
  ) {
    throw new TypeError('invalid readiness timing');
  }
  if (
    !allowTestOverrides
    && (readinessTimeoutMs !== READINESS_TIMEOUT_MS || readinessPollMs !== READINESS_POLL_MS)
  ) {
    throw new TypeError('readiness timing is pinned');
  }
  const resolvedPaths = pinnedPaths(paths, allowTestOverrides);

  const environment = await loadPrivateMacAgentEnvironment(resolvedPaths.envFile, uid);
  let runtimeConfig;
  try {
    runtimeConfig = loadSocketModeConfig(environment);
  } catch {
    throw new TypeError('environment file failed the MacAgent contract');
  }
  await requirePrivateMacAgentDirectory(dirname(resolvedPaths.envFile), uid, 'runtime directory');
  await requirePrivateMacAgentDirectory(runtimeConfig.ledgerDir, uid, 'ledger');
  await access(resolvedPaths.nodePath, fsConstants.X_OK);
  await access(resolvedPaths.entrypointPath, fsConstants.R_OK);
  await access(resolvedPaths.runnerPath, fsConstants.R_OK);

  const logsDirectory = dirname(resolvedPaths.stdoutPath);
  if (dirname(resolvedPaths.stderrPath) !== logsDirectory) {
    throw new TypeError('log paths must share one private directory');
  }
  await mkdir(logsDirectory, { recursive: true, mode: 0o700 });
  await requirePrivateMacAgentDirectory(logsDirectory, uid, 'log directory');
  await mkdir(dirname(resolvedPaths.plistPath), { recursive: true });

  const runId = randomUUID();
  const plist = makeMacAgentLaunchAgentPlist({
    nodePath: resolvedPaths.nodePath,
    entrypointPath: resolvedPaths.entrypointPath,
    runnerPath: resolvedPaths.runnerPath,
    envFile: resolvedPaths.envFile,
    readyPath: resolvedPaths.readyPath,
    workingDirectory: resolvedPaths.workingDirectory,
    stdoutPath: resolvedPaths.stdoutPath,
    stderrPath: resolvedPaths.stderrPath,
    runId,
    allowTestOverrides,
  });
  await writePrivatePlist(resolvedPaths.plistPath, plist);
  await commandRunner('/usr/bin/plutil', ['-lint', resolvedPaths.plistPath]);

  const domain = `gui/${uid}`;
  const serviceTarget = `${domain}/${MAC_AGENT_LABEL}`;
  try {
    await commandRunner('/bin/launchctl', ['bootout', serviceTarget]);
  } catch {
    // Absence is verified independently below; never target a PID or another label.
  }
  let absenceConfirmed = false;
  for (let attempt = 0; attempt < ABSENCE_ATTEMPTS; attempt += 1) {
    try {
      await commandRunner('/bin/launchctl', ['print', serviceTarget]);
    } catch (error) {
      if (Number(error?.code) !== 113) throw new Error('MacAgent service state could not be read');
      absenceConfirmed = true;
      break;
    }
    if (attempt + 1 < ABSENCE_ATTEMPTS) {
      await new Promise(resolvePromise => setTimeout(resolvePromise, ABSENCE_INTERVAL_MS));
    }
  }
  if (!absenceConfirmed) {
    throw new Error('existing MacAgent service absence could not be confirmed');
  }

  await removeExactFile(resolvedPaths.readyPath);
  let bootstrapAttempted = false;
  try {
    bootstrapAttempted = true;
    await commandRunner('/bin/launchctl', ['bootstrap', domain, resolvedPaths.plistPath]);
    await waitForRuntimeReadiness({
      path: resolvedPaths.readyPath,
      uid,
      runId,
      timeoutMs: readinessTimeoutMs,
      pollMs: readinessPollMs,
    });
    await commandRunner('/bin/launchctl', ['print', serviceTarget]);
    return Object.freeze({ label: MAC_AGENT_LABEL, serviceTarget, status: 'RUNNING' });
  } catch (error) {
    if (bootstrapAttempted) {
      try {
        await commandRunner('/bin/launchctl', ['bootout', serviceTarget]);
      } catch {
        // The exact owned label is the only cleanup target; failure remains fail-closed.
      }
    }
    await removeExactFile(resolvedPaths.readyPath).catch(() => {});
    throw error;
  }
}

async function main() {
  if (process.argv[2] !== 'install') {
    process.stdout.write(`${JSON.stringify({ status: 'BLOCKED', errorClass: 'invalid_command' })}\n`);
    process.exitCode = 2;
    return;
  }
  try {
    const result = await installMacAgentLaunchAgent();
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch {
    process.stdout.write(`${JSON.stringify({ status: 'BLOCKED', errorClass: 'install_failed' })}\n`);
    process.exitCode = 1;
  }
}

const isMain = Boolean(process.argv[1])
  && import.meta.url === new URL(`file://${resolve(process.argv[1])}`).href;
if (isMain) await main();
