#!/usr/bin/env node

import { basename, dirname, isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { handleSlackAppMention } from './slack-socket-connector.mjs';

const REQUIRED_ENV = Object.freeze([
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
const TEAM_ID = /^T[A-Z0-9]{8,63}$/;
const CHANNEL_ID = /^[CG][A-Z0-9]{8,63}$/;
const APP_ID = /^A[A-Z0-9]{8,63}$/;
const USER_ID = /^[UW][A-Z0-9]{8,63}$/;
const BOT_ID = /^B[A-Z0-9]{8,63}$/;
const APP_TOKEN = /^xapp-[A-Za-z0-9-]{10,}$/;
const BOT_TOKEN = /^xoxb-[A-Za-z0-9-]{10,}$/;
const IDENTITY_TIMEOUT_MS = 10_000;

function required(env, key) {
  const value = typeof env?.[key] === 'string' ? env[key].trim() : '';
  if (!value) throw new TypeError(`missing ${key}`);
  return value;
}

export function loadSocketModeConfig(env = process.env) {
  const values = Object.fromEntries(REQUIRED_ENV.map(key => [key, required(env, key)]));
  if (!APP_TOKEN.test(values.LOCAL_CUA_SLACK_APP_TOKEN)) {
    throw new TypeError('invalid LOCAL_CUA_SLACK_APP_TOKEN');
  }
  if (!BOT_TOKEN.test(values.LOCAL_CUA_SLACK_BOT_TOKEN)) {
    throw new TypeError('invalid LOCAL_CUA_SLACK_BOT_TOKEN');
  }
  const route = {
    teamId: values.LOCAL_CUA_SLACK_TEAM_ID,
    channelId: values.LOCAL_CUA_SLACK_CHANNEL_ID,
    appId: values.LOCAL_CUA_SLACK_APP_ID,
    botUserId: values.LOCAL_CUA_SLACK_BOT_USER_ID,
    allowedUserId: values.LOCAL_CUA_SLACK_ALLOWED_USER_ID,
  };
  if (
    !TEAM_ID.test(route.teamId)
    || !CHANNEL_ID.test(route.channelId)
    || !APP_ID.test(route.appId)
    || !USER_ID.test(route.botUserId)
    || !USER_ID.test(route.allowedUserId)
    || route.botUserId === route.allowedUserId
  ) {
    throw new TypeError('invalid LOCAL_CUA Slack route identity');
  }
  const handoffSource = {
    userId: values.LOCAL_CUA_SLACK_HEYBILLY_USER_ID,
    botId: values.LOCAL_CUA_SLACK_HEYBILLY_BOT_ID,
  };
  if (
    !USER_ID.test(handoffSource.userId)
    || !BOT_ID.test(handoffSource.botId)
    || handoffSource.userId === route.botUserId
    || handoffSource.userId === route.allowedUserId
  ) {
    throw new TypeError('invalid LOCAL_CUA HeyBilly identity');
  }
  if (!isAbsolute(values.LOCAL_CUA_LEDGER_DIR)) {
    throw new TypeError('LOCAL_CUA_LEDGER_DIR must be absolute');
  }
  if (
    resolve(values.LOCAL_CUA_LEDGER_DIR) !== values.LOCAL_CUA_LEDGER_DIR
    || basename(values.LOCAL_CUA_LEDGER_DIR) !== 'ledger'
    || basename(dirname(values.LOCAL_CUA_LEDGER_DIR)) !== 'village-local-cua-clerk'
  ) {
    throw new TypeError('LOCAL_CUA_LEDGER_DIR must be a dedicated village-local-cua-clerk ledger leaf');
  }
  return Object.freeze({
    appToken: values.LOCAL_CUA_SLACK_APP_TOKEN,
    botToken: values.LOCAL_CUA_SLACK_BOT_TOKEN,
    ledgerDir: values.LOCAL_CUA_LEDGER_DIR,
    route: Object.freeze(route),
    handoffSource: Object.freeze(handoffSource),
  });
}

function identityResult({ status, errorClass, evidence }) {
  return Object.freeze({
    schemaVersion: 'gate3-slack-identity/v1',
    status,
    evidence: Object.freeze(evidence),
    ...(errorClass === undefined ? {} : { errorClass }),
  });
}

export async function verifySlackIdentity({ client, config } = {}) {
  if (typeof client?.auth?.test !== 'function') throw new TypeError('invalid Slack auth client');
  if (!config?.route) throw new TypeError('invalid Socket Mode config');
  let auth;
  let timer;
  try {
    auth = await Promise.race([
      client.auth.test(),
      new Promise((resolvePromise, rejectPromise) => {
        timer = setTimeout(() => rejectPromise(new Error('identity timeout')), IDENTITY_TIMEOUT_MS);
      }),
    ]);
  } catch {
    return identityResult({
      status: 'BLOCKED',
      errorClass: 'auth_failed',
      evidence: {
        authenticated: false,
        teamMatched: false,
        botUserMatched: false,
        botIdentityPresent: false,
      },
    });
  } finally {
    clearTimeout(timer);
  }
  if (auth?.ok !== true) {
    return identityResult({
      status: 'BLOCKED',
      errorClass: 'auth_failed',
      evidence: {
        authenticated: false,
        teamMatched: false,
        botUserMatched: false,
        botIdentityPresent: false,
      },
    });
  }
  const evidence = {
    authenticated: true,
    teamMatched: auth.team_id === config.route.teamId,
    botUserMatched: auth.user_id === config.route.botUserId,
    botIdentityPresent: typeof auth.bot_id === 'string' && BOT_ID.test(auth.bot_id),
  };
  const matched = Object.values(evidence).every(Boolean);
  return identityResult({
    status: matched ? 'PASS' : 'BLOCKED',
    ...(matched ? {} : { errorClass: 'identity_mismatch' }),
    evidence,
  });
}

function handlerFailure() {
  return Object.freeze({
    schemaVersion: 'gate3-slack-runtime/v1',
    status: 'BLOCKED',
    errorClass: 'handler_failed',
  });
}

export async function startSocketModeConnector({
  env = process.env,
  AppClass,
  handler = handleSlackAppMention,
  allowTestOverrides = false,
} = {}) {
  if (AppClass !== undefined && !allowTestOverrides) {
    throw new TypeError('custom AppClass requires the explicit test override');
  }
  if (handler !== handleSlackAppMention && !allowTestOverrides) {
    throw new TypeError('custom handler requires the explicit test override');
  }
  if (typeof handler !== 'function') throw new TypeError('invalid Slack event handler');
  const config = loadSocketModeConfig(env);
  let RuntimeApp = AppClass;
  if (RuntimeApp === undefined) {
    ({ App: RuntimeApp } = await import('@slack/bolt'));
  }
  if (typeof RuntimeApp !== 'function') throw new TypeError('invalid Slack App class');

  const app = new RuntimeApp({
    token: config.botToken,
    appToken: config.appToken,
    socketMode: true,
    developerMode: false,
    deferInitialization: true,
  });
  const identity = await verifySlackIdentity({ client: app.client, config });
  if (identity.status !== 'PASS') throw new Error('Slack identity preflight failed');
  if (
    typeof app.init !== 'function'
    || typeof app.event !== 'function'
    || typeof app.start !== 'function'
    || typeof app.stop !== 'function'
  ) {
    throw new TypeError('invalid Slack App runtime');
  }

  await app.init();
  const eventHandler = async ({ body, client }) => {
    try {
      return await handler({
        body,
        client,
        route: config.route,
        handoffSource: config.handoffSource,
        ledgerDir: config.ledgerDir,
      });
    } catch {
      return handlerFailure();
    }
  };
  app.event('app_mention', eventHandler);
  app.event('message', eventHandler);
  await app.start();
  let stopped = false;
  return Object.freeze({
    identity,
    route: config.route,
    handoffSource: config.handoffSource,
    ledgerDir: config.ledgerDir,
    stop: async () => {
      if (stopped) return;
      stopped = true;
      await app.stop();
    },
  });
}

async function main() {
  try {
    const runtime = await startSocketModeConnector();
    process.stdout.write(`${JSON.stringify(runtime.identity)}\n`);
    const stop = async () => {
      try { await runtime.stop(); }
      finally { process.exit(0); }
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  } catch {
    process.stdout.write(`${JSON.stringify({
      schemaVersion: 'gate3-slack-runtime/v1',
      status: 'BLOCKED',
      errorClass: 'startup_failed',
    })}\n`);
    process.exitCode = 1;
  }
}

const isMain = Boolean(process.argv[1])
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) await main();
