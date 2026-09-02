#!/usr/bin/env node

import { randomUUID } from 'node:crypto';
import { chmod, open, rename, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  loadPrivateMacAgentEnvironment,
  MAC_AGENT_PATHS,
  requirePrivateMacAgentDirectory,
} from './mac-agent-launcher.mjs';
import { loadSocketModeConfig } from './socket-mode-runner.mjs';

const FIXED_SOURCE = Object.freeze({ userId: 'U0B66DNKXRU', botId: 'B0B68FQLVS6' });
const SOURCE_KEYS = Object.freeze([
  'LOCAL_CUA_SLACK_APP_TOKEN',
  'LOCAL_CUA_SLACK_BOT_TOKEN',
  'LOCAL_CUA_SLACK_TEAM_ID',
  'LOCAL_CUA_SLACK_CHANNEL_ID',
  'LOCAL_CUA_SLACK_APP_ID',
  'LOCAL_CUA_SLACK_BOT_USER_ID',
  'LOCAL_CUA_SLACK_ALLOWED_USER_ID',
  'LOCAL_CUA_SLACK_HEYBILLY_USER_ID',
  'LOCAL_CUA_SLACK_HEYBILLY_BOT_ID',
  'LOCAL_CUA_LEDGER_DIR',
]);
const LEGACY_KEYS = new Set(SOURCE_KEYS.filter(key => !key.includes('HEYBILLY')));
const USER_ID = /^[UW][A-Z0-9]{8,63}$/;
const BOT_ID = /^B[A-Z0-9]{8,63}$/;

function validateSource(source) {
  const keys = source && typeof source === 'object' && !Array.isArray(source)
    ? Object.keys(source).sort()
    : [];
  if (
    keys.length !== 2
    || keys[0] !== 'botId'
    || keys[1] !== 'userId'
    || !USER_ID.test(source.userId)
    || !BOT_ID.test(source.botId)
  ) throw new TypeError('invalid HeyBilly identity');
}

function serializeEnvironment(environment) {
  return `${SOURCE_KEYS.map(key => `${key}=${JSON.stringify(environment[key])}`).join('\n')}\n`;
}

async function writePrivateEnvironment(path, contents) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(contents, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, path);
    await chmod(path, 0o600);
  } finally {
    try { await handle?.close(); } catch {}
    await unlink(temporary).catch(() => {});
  }
}

export async function configureHeyBillySource({
  envFile = MAC_AGENT_PATHS.envFile,
  uid = process.getuid(),
  source = FIXED_SOURCE,
  allowTestOverrides = false,
} = {}) {
  if (!Number.isInteger(uid) || uid < 1) throw new TypeError('invalid user id');
  if (typeof envFile !== 'string' || !isAbsolute(envFile) || resolve(envFile) !== envFile) {
    throw new TypeError('environment file must be an absolute normalized path');
  }
  if (!allowTestOverrides && envFile !== MAC_AGENT_PATHS.envFile) {
    throw new TypeError('environment file is not pinned');
  }
  validateSource(source);
  if (
    !allowTestOverrides
    && (source.userId !== FIXED_SOURCE.userId || source.botId !== FIXED_SOURCE.botId)
  ) throw new TypeError('HeyBilly identity is not pinned');

  await requirePrivateMacAgentDirectory(dirname(envFile), uid, 'runtime directory');
  const existing = await loadPrivateMacAgentEnvironment(envFile, uid);
  const existingKeys = Object.keys(existing);
  const allowed = new Set(SOURCE_KEYS);
  if (existingKeys.some(key => !allowed.has(key))) throw new TypeError('environment has unknown keys');
  if ([...LEGACY_KEYS].some(key => typeof existing[key] !== 'string' || existing[key].length === 0)) {
    throw new TypeError('environment is incomplete');
  }

  const currentUser = existing.LOCAL_CUA_SLACK_HEYBILLY_USER_ID;
  const currentBot = existing.LOCAL_CUA_SLACK_HEYBILLY_BOT_ID;
  if (currentUser !== undefined || currentBot !== undefined) {
    if (currentUser !== source.userId || currentBot !== source.botId) {
      throw new TypeError('existing HeyBilly identity does not match');
    }
    loadSocketModeConfig(existing);
    return Object.freeze({ status: 'UNCHANGED' });
  }

  const updated = Object.freeze({
    ...existing,
    LOCAL_CUA_SLACK_HEYBILLY_USER_ID: source.userId,
    LOCAL_CUA_SLACK_HEYBILLY_BOT_ID: source.botId,
  });
  loadSocketModeConfig(updated);
  await writePrivateEnvironment(envFile, serializeEnvironment(updated));
  loadSocketModeConfig(await loadPrivateMacAgentEnvironment(envFile, uid));
  return Object.freeze({ status: 'UPDATED' });
}

async function main() {
  try {
    const result = await configureHeyBillySource();
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch {
    process.stdout.write(`${JSON.stringify({ status: 'BLOCKED', errorClass: 'configuration_failed' })}\n`);
    process.exitCode = 1;
  }
}

const isMain = Boolean(process.argv[1])
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) await main();
