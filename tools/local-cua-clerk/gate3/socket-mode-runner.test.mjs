import test from 'node:test';
import assert from 'node:assert/strict';

async function loadRunner() {
  try { return await import('./socket-mode-runner.mjs'); }
  catch { return null; }
}

const ENV = Object.freeze({
  LOCAL_CUA_SLACK_APP_TOKEN: 'xapp-1-test-local-cua-app-token',
  LOCAL_CUA_SLACK_BOT_TOKEN: 'xoxb-test-local-cua-bot-token',
  LOCAL_CUA_SLACK_TEAM_ID: 'T03EB8LSB18',
  LOCAL_CUA_SLACK_CHANNEL_ID: 'C0B7CLP4KDY',
  LOCAL_CUA_SLACK_APP_ID: 'A0LOCALCUA01',
  LOCAL_CUA_SLACK_BOT_USER_ID: 'U0LOCALCUA01',
  LOCAL_CUA_SLACK_ALLOWED_USER_ID: 'U03EB8L0QDR',
  LOCAL_CUA_LEDGER_DIR: '/tmp/village-local-cua-clerk/ledger',
});

const AUTH_PASS = Object.freeze({
  ok: true,
  url: 'https://village.example.slack.com/',
  team: '빌리지',
  user: '세무서류담당',
  team_id: ENV.LOCAL_CUA_SLACK_TEAM_ID,
  user_id: ENV.LOCAL_CUA_SLACK_BOT_USER_ID,
  bot_id: 'B0LOCALCUA01',
});

test('runtime configuration requires a separate complete bot identity and never falls back to Hermes variables', async () => {
  const runner = await loadRunner();
  assert.equal(typeof runner?.loadSocketModeConfig, 'function');
  const config = runner.loadSocketModeConfig(ENV);

  assert.deepEqual(config, {
    appToken: ENV.LOCAL_CUA_SLACK_APP_TOKEN,
    botToken: ENV.LOCAL_CUA_SLACK_BOT_TOKEN,
    ledgerDir: ENV.LOCAL_CUA_LEDGER_DIR,
    route: {
      teamId: ENV.LOCAL_CUA_SLACK_TEAM_ID,
      channelId: ENV.LOCAL_CUA_SLACK_CHANNEL_ID,
      appId: ENV.LOCAL_CUA_SLACK_APP_ID,
      botUserId: ENV.LOCAL_CUA_SLACK_BOT_USER_ID,
      allowedUserId: ENV.LOCAL_CUA_SLACK_ALLOWED_USER_ID,
    },
  });

  assert.throws(
    () => runner.loadSocketModeConfig({
      SLACK_APP_TOKEN: ENV.LOCAL_CUA_SLACK_APP_TOKEN,
      SLACK_BOT_TOKEN: ENV.LOCAL_CUA_SLACK_BOT_TOKEN,
      ...Object.fromEntries(Object.entries(ENV).filter(([key]) => !key.endsWith('_TOKEN'))),
    }),
    /missing LOCAL_CUA_SLACK_APP_TOKEN/,
  );
  for (const key of Object.keys(ENV)) {
    assert.throws(
      () => runner.loadSocketModeConfig(Object.fromEntries(Object.entries(ENV).filter(([name]) => name !== key))),
      new RegExp(`missing ${key}`),
    );
  }
  assert.throws(
    () => runner.loadSocketModeConfig({ ...ENV, LOCAL_CUA_SLACK_APP_TOKEN: 'xoxb-wrong-kind' }),
    /invalid LOCAL_CUA_SLACK_APP_TOKEN/,
  );
  assert.throws(
    () => runner.loadSocketModeConfig({ ...ENV, LOCAL_CUA_LEDGER_DIR: 'relative/ledger' }),
    /absolute/,
  );
  for (const broadPath of [
    '/',
    '/tmp',
    '/private/tmp',
    '/Users/choijaehyeong',
    '/tmp/village-local-cua-clerk',
    '/tmp/not-the-clerk/ledger',
  ]) {
    assert.throws(
      () => runner.loadSocketModeConfig({ ...ENV, LOCAL_CUA_LEDGER_DIR: broadPath }),
      /dedicated village-local-cua-clerk ledger leaf/,
    );
  }
});

test('auth.test must prove the configured workspace and distinct bot identity before startup', async () => {
  const runner = await loadRunner();
  assert.equal(typeof runner?.verifySlackIdentity, 'function');
  const config = runner.loadSocketModeConfig(ENV);
  const pass = await runner.verifySlackIdentity({
    config,
    client: { auth: { test: async () => AUTH_PASS } },
  });
  assert.deepEqual(pass, {
    schemaVersion: 'gate3-slack-identity/v1',
    status: 'PASS',
    evidence: {
      authenticated: true,
      teamMatched: true,
      botUserMatched: true,
      botIdentityPresent: true,
    },
  });
  assert.equal(JSON.stringify(pass).includes(ENV.LOCAL_CUA_SLACK_BOT_TOKEN), false);

  const mismatch = await runner.verifySlackIdentity({
    config,
    client: { auth: { test: async () => ({ ...AUTH_PASS, user_id: 'U_OTHER' }) } },
  });
  assert.equal(mismatch.status, 'BLOCKED');
  assert.equal(mismatch.errorClass, 'identity_mismatch');
  assert.equal(mismatch.evidence.authenticated, true);
  assert.equal(mismatch.evidence.botUserMatched, false);

  const rawMarker = 'private-auth-failure';
  const failed = await runner.verifySlackIdentity({
    config,
    client: { auth: { test: async () => { throw new Error(rawMarker); } } },
  });
  assert.equal(failed.status, 'BLOCKED');
  assert.equal(failed.errorClass, 'auth_failed');
  assert.equal(JSON.stringify(failed).includes(rawMarker), false);
});

test('the Socket Mode runtime preflights identity, registers only app_mention, and then starts', async () => {
  const runner = await loadRunner();
  assert.equal(typeof runner?.startSocketModeConnector, 'function');
  const instances = [];
  const handlerCalls = [];
  const lifecycle = [];
  class FakeApp {
    constructor(options) {
      this.options = options;
      this.listeners = [];
      this.startCalls = 0;
      this.stopCalls = 0;
      this.client = { auth: { test: async () => { lifecycle.push('auth.test'); return AUTH_PASS; } } };
      instances.push(this);
    }
    async init() { lifecycle.push('init'); }
    event(name, callback) { lifecycle.push(`event:${name}`); this.listeners.push({ name, callback }); }
    async start() { lifecycle.push('start'); this.startCalls += 1; }
    async stop() { this.stopCalls += 1; }
  }
  const handler = async options => {
    handlerCalls.push(options);
    return { status: 'PASS' };
  };

  const runtime = await runner.startSocketModeConnector({
    env: ENV,
    AppClass: FakeApp,
    handler,
    allowTestOverrides: true,
  });

  assert.equal(runtime.identity.status, 'PASS');
  assert.equal(instances.length, 1);
  assert.deepEqual(instances[0].options, {
    token: ENV.LOCAL_CUA_SLACK_BOT_TOKEN,
    appToken: ENV.LOCAL_CUA_SLACK_APP_TOKEN,
    socketMode: true,
    developerMode: false,
    deferInitialization: true,
  });
  assert.deepEqual(lifecycle, ['auth.test', 'init', 'event:app_mention', 'start']);
  assert.deepEqual(instances[0].listeners.map(({ name }) => name), ['app_mention']);
  assert.equal(instances[0].startCalls, 1);

  const body = { type: 'event_callback', event: { type: 'app_mention' } };
  const eventClient = { marker: 'event-client' };
  assert.deepEqual(
    await instances[0].listeners[0].callback({ body, client: eventClient }),
    { status: 'PASS' },
  );
  assert.equal(handlerCalls.length, 1);
  assert.equal(handlerCalls[0].body, body);
  assert.equal(handlerCalls[0].client, eventClient);
  assert.deepEqual(handlerCalls[0].route, runtime.route);
  assert.equal(handlerCalls[0].ledgerDir, ENV.LOCAL_CUA_LEDGER_DIR);
  assert.equal(JSON.stringify(runtime).includes(ENV.LOCAL_CUA_SLACK_APP_TOKEN), false);
  assert.equal(JSON.stringify(runtime).includes(ENV.LOCAL_CUA_SLACK_BOT_TOKEN), false);

  await runtime.stop();
  assert.equal(instances[0].stopCalls, 1);
});

test('test injection and identity mismatch fail closed before listener registration or startup', async () => {
  const runner = await loadRunner();
  let constructed = 0;
  let lastInstance;
  class FakeApp {
    constructor() {
      constructed += 1;
      this.client = { auth: { test: async () => ({ ...AUTH_PASS, team_id: 'T_OTHER' }) } };
      this.listeners = [];
      this.startCalls = 0;
      lastInstance = this;
    }
    async init() {}
    event(name, callback) { this.listeners.push({ name, callback }); }
    async start() { this.startCalls += 1; }
  }

  await assert.rejects(
    runner.startSocketModeConnector({ env: ENV, AppClass: FakeApp }),
    /explicit test override/,
  );
  assert.equal(constructed, 0);

  await assert.rejects(
    runner.startSocketModeConnector({
      env: ENV,
      AppClass: FakeApp,
      handler: async () => ({ status: 'PASS' }),
      allowTestOverrides: true,
    }),
    /Slack identity preflight failed/,
  );
  assert.equal(constructed, 1);
  assert.deepEqual(lastInstance.listeners, []);
  assert.equal(lastInstance.startCalls, 0);
});

test('listener exceptions are reduced to a fixed runtime failure without raw event or error output', async () => {
  const runner = await loadRunner();
  let listener;
  class FakeApp {
    constructor() { this.client = { auth: { test: async () => AUTH_PASS } }; }
    async init() {}
    event(_name, callback) { listener = callback; }
    async start() {}
    async stop() {}
  }
  const runtime = await runner.startSocketModeConnector({
    env: ENV,
    AppClass: FakeApp,
    handler: async () => { throw new Error('private-handler-marker'); },
    allowTestOverrides: true,
  });

  const result = await listener({
    body: { private: 'private-event-marker' },
    client: {},
  });
  assert.deepEqual(result, {
    schemaVersion: 'gate3-slack-runtime/v1',
    status: 'BLOCKED',
    errorClass: 'handler_failed',
  });
  assert.equal(JSON.stringify(result).includes('private'), false);
  await runtime.stop();
});
