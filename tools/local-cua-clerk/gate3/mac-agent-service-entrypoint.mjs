#!/usr/bin/env node

import { randomUUID } from 'node:crypto';
import { chmod, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  loadPrivateMacAgentEnvironment,
  MAC_AGENT_PATHS,
  MAC_AGENT_READY_SCHEMA,
  requirePrivateMacAgentDirectory,
} from './mac-agent-launcher.mjs';
import { loadSocketModeConfig, startSocketModeConnector } from './socket-mode-runner.mjs';

const RUN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function validatePath(path, expected, name, allowTestOverrides) {
  if (typeof path !== 'string' || !isAbsolute(path) || resolve(path) !== path) {
    throw new TypeError(`${name} must be an absolute normalized path`);
  }
  if (!allowTestOverrides && path !== expected) throw new TypeError(`${name} is not pinned`);
}

async function removeExactReadiness(path) {
  try {
    await unlink(path);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

function makeReadiness(identity, runId) {
  if (
    identity?.schemaVersion !== 'gate3-slack-identity/v1'
    || identity.status !== 'PASS'
    || !identity.evidence
    || identity.evidence.authenticated !== true
    || identity.evidence.teamMatched !== true
    || identity.evidence.botUserMatched !== true
    || identity.evidence.botIdentityPresent !== true
  ) {
    throw new TypeError('Slack runtime did not provide valid readiness evidence');
  }
  return Object.freeze({
    schemaVersion: MAC_AGENT_READY_SCHEMA,
    runId,
    status: 'PASS',
    evidence: Object.freeze({
      authenticated: true,
      teamMatched: true,
      botUserMatched: true,
      botIdentityPresent: true,
    }),
  });
}

async function writePrivateReadiness(path, value, uid) {
  await requirePrivateMacAgentDirectory(dirname(path), uid, 'runtime directory');
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    });
    await rename(temporary, path);
    await chmod(path, 0o600);
  } finally {
    await unlink(temporary).catch(() => {});
  }
}

export async function startMacAgentService({
  envFile = MAC_AGENT_PATHS.envFile,
  readyFile = MAC_AGENT_PATHS.readyPath,
  runId,
  uid = process.getuid(),
  connectorStarter = startSocketModeConnector,
  allowTestOverrides = false,
} = {}) {
  if (!Number.isInteger(uid) || uid < 1) throw new TypeError('invalid user id');
  if (!allowTestOverrides && uid !== process.getuid()) throw new TypeError('user id is not current');
  validatePath(envFile, MAC_AGENT_PATHS.envFile, 'environment file', allowTestOverrides);
  validatePath(readyFile, MAC_AGENT_PATHS.readyPath, 'runtime readiness file', allowTestOverrides);
  if (!RUN_ID.test(runId ?? '')) throw new TypeError('invalid MacAgent run id');
  if (typeof connectorStarter !== 'function') throw new TypeError('invalid connector starter');
  if (!allowTestOverrides && connectorStarter !== startSocketModeConnector) {
    throw new TypeError('custom connector starter requires the explicit test override');
  }

  await removeExactReadiness(readyFile);
  const environment = await loadPrivateMacAgentEnvironment(envFile, uid);
  const config = loadSocketModeConfig(environment);
  await requirePrivateMacAgentDirectory(dirname(envFile), uid, 'runtime directory');
  await requirePrivateMacAgentDirectory(config.ledgerDir, uid, 'ledger');

  let runtime;
  try {
    runtime = await connectorStarter({ env: environment });
    const readiness = makeReadiness(runtime?.identity, runId);
    await writePrivateReadiness(readyFile, readiness, uid);
  } catch (error) {
    try {
      await runtime?.stop?.();
    } finally {
      await removeExactReadiness(readyFile).catch(() => {});
    }
    throw error;
  }

  let stopped = false;
  return Object.freeze({
    status: 'PASS',
    runId,
    stop: async () => {
      if (stopped) return;
      stopped = true;
      try {
        await runtime.stop();
      } finally {
        await removeExactReadiness(readyFile).catch(() => {});
      }
    },
  });
}

function parseArguments(argv) {
  if (!Array.isArray(argv) || argv.length !== 3) throw new TypeError('invalid service arguments');
  const expected = ['--env-file=', '--ready-file=', '--run-id='];
  if (argv.some((value, index) => typeof value !== 'string' || !value.startsWith(expected[index]))) {
    throw new TypeError('invalid service arguments');
  }
  return Object.freeze({
    envFile: argv[0].slice(expected[0].length),
    readyFile: argv[1].slice(expected[1].length),
    runId: argv[2].slice(expected[2].length),
  });
}

async function main() {
  let service;
  try {
    service = await startMacAgentService(parseArguments(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify({
      schemaVersion: MAC_AGENT_READY_SCHEMA,
      status: service.status,
      runId: service.runId,
    })}\n`);
  } catch {
    process.stdout.write(`${JSON.stringify({
      schemaVersion: MAC_AGENT_READY_SCHEMA,
      status: 'BLOCKED',
      errorClass: 'startup_failed',
    })}\n`);
    process.exitCode = 1;
    return;
  }

  let stopping;
  const stop = () => {
    if (stopping) return stopping;
    stopping = service.stop()
      .then(() => process.exit(0))
      .catch(() => process.exit(1));
    return stopping;
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

const isMain = Boolean(process.argv[1])
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) await main();
