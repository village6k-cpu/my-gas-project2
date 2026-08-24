import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function loadConnector() {
  try { return await import('./slack-socket-connector.mjs'); }
  catch { return null; }
}

async function loadGate2() {
  try { return await import('../gate2/slack-intake-shell.mjs'); }
  catch { return null; }
}

const ROUTE = Object.freeze({
  teamId: 'T03EB8LSB18',
  channelId: 'C0B7CLP4KDY',
  appId: 'A0LOCALCUA01',
  botUserId: 'U0LOCALCUA01',
  allowedUserId: 'U03EB8L0QDR',
});

const BODY = Object.freeze({
  type: 'event_callback',
  team_id: ROUTE.teamId,
  api_app_id: ROUTE.appId,
  event_id: 'Ev0LOCALCUA0001',
  event_time: 1787623200,
  event: Object.freeze({
    type: 'app_mention',
    user: ROUTE.allowedUserId,
    text: `<@${ROUTE.botUserId}> 상태 확인`,
    ts: '1787623200.000001',
    channel: ROUTE.channelId,
    event_ts: '1787623200000001',
  }),
});

const CHECKED_AT = '2026-08-25T03:00:00.000Z';
const GATE1_PASS = Object.freeze({
  schemaVersion: 'gate1-desktop-cua/v1',
  status: 'PASS',
  checkedAt: CHECKED_AT,
  runId: '0123456789abcdef',
  evidence: {
    threadCreated: true,
    fixedActionDispatched: true,
    nodeReplCallCompleted: true,
    desktopThreadCuaAvailable: true,
    chromeWasRunning: true,
    chromeAccessibilityAvailable: true,
    screenshotAvailable: true,
    resultValidated: true,
    cleanupCompleted: true,
  },
});

const DELIVERY = Object.freeze({
  route: Object.freeze({
    teamId: ROUTE.teamId,
    channelId: ROUTE.channelId,
    threadTs: BODY.event.ts,
  }),
  result: Object.freeze({
    schemaVersion: 'gate2-slack-delivery/v1',
    employeeId: 'village-tax-document-clerk',
    requestId: '0123456789abcdef',
    action: 'desktop_readiness',
    status: 'PASS',
  }),
});

async function tempLedger(t) {
  const path = await mkdtemp(join(tmpdir(), 'village-gate3-live-test-'));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}

test('an exact owner app mention maps to the fixed live Gate 2 envelope without raw text', async () => {
  const connector = await loadConnector();
  assert.equal(typeof connector?.adaptSlackAppMention, 'function');

  const decision = connector.adaptSlackAppMention({ body: BODY, route: ROUTE });

  assert.deepEqual(decision, {
    accepted: true,
    envelope: {
      schemaVersion: 'gate2-slack-envelope/v1',
      source: 'slack_socket_mode',
      teamId: ROUTE.teamId,
      channelId: ROUTE.channelId,
      eventId: BODY.event_id,
      threadTs: BODY.event.ts,
      action: 'desktop_readiness',
    },
  });
  assert.equal(JSON.stringify(decision).includes(BODY.event.text), false);
  assert.equal(JSON.stringify(decision).includes(ROUTE.allowedUserId), false);
  assert.equal(JSON.stringify(decision).includes(ROUTE.appId), false);
  assert.equal(JSON.stringify(decision).includes(ROUTE.botUserId), false);
});

test('a mention in an existing thread preserves the parent thread timestamp', async () => {
  const connector = await loadConnector();
  const body = {
    ...BODY,
    event_id: 'Ev0LOCALCUA0002',
    event: { ...BODY.event, ts: '1787623201.000002', thread_ts: '1787620000.000009' },
  };

  const decision = connector.adaptSlackAppMention({ body, route: ROUTE });

  assert.equal(decision.accepted, true);
  assert.equal(decision.envelope.threadTs, '1787620000.000009');
});

test('identity, route, actor, bot-generated, and command mutations reject before an envelope exists', async () => {
  const connector = await loadConnector();
  const cases = [
    [{ ...BODY, type: 'url_verification' }, 'invalid_event'],
    [{ ...BODY, event_id: '' }, 'invalid_event'],
    [{ ...BODY, team_id: 'T_OTHER' }, 'unauthorized_identity'],
    [{ ...BODY, context_team_id: 'T_OTHER' }, 'unauthorized_identity'],
    [{ ...BODY, api_app_id: 'A_OTHER' }, 'unauthorized_identity'],
    [{ ...BODY, event: { ...BODY.event, channel: 'C_OTHER' } }, 'unauthorized_route'],
    [{ ...BODY, event: { ...BODY.event, user: 'U_OTHER' } }, 'unauthorized_actor'],
    [{ ...BODY, event: { ...BODY.event, bot_id: 'B_OTHER' } }, 'invalid_event'],
    [{ ...BODY, event: { ...BODY.event, subtype: 'bot_message' } }, 'invalid_event'],
    [{ ...BODY, event: { ...BODY.event, text: `<@U_OTHER> 상태 확인` } }, 'command_not_allowed'],
    [{ ...BODY, event: { ...BODY.event, text: `<@${ROUTE.botUserId}> 홈택스 발급` } }, 'command_not_allowed'],
    [{ ...BODY, event: { ...BODY.event, text: `<@${ROUTE.botUserId}> 상태 확인 ${'x'.repeat(300)}` } }, 'invalid_event'],
  ];

  for (const [body, errorClass] of cases) {
    assert.deepEqual(
      connector.adaptSlackAppMention({ body, route: ROUTE }),
      { accepted: false, errorClass },
    );
  }
});

test('route configuration is complete and exact before any event can be considered', async () => {
  const connector = await loadConnector();
  assert.throws(
    () => connector.adaptSlackAppMention({ body: BODY, route: { ...ROUTE, allowedUserId: '' } }),
    /invalid Slack route/,
  );
  assert.throws(
    () => connector.adaptSlackAppMention({ body: BODY, route: { ...ROUTE, extra: 'not-allowed' } }),
    /unknown or missing keys/,
  );
});

test('the fixed live processor executes one allowed Socket Mode envelope and durably suppresses its retry', async t => {
  const connector = await loadConnector();
  const gate2 = await loadGate2();
  assert.equal(typeof gate2?.processSocketSlackEnvelope, 'function');
  const ledgerDir = await tempLedger(t);
  const { envelope } = connector.adaptSlackAppMention({ body: BODY, route: ROUTE });
  let executions = 0;
  let posts = 0;
  const options = {
    envelope,
    allowedRoute: { teamId: ROUTE.teamId, channelId: ROUTE.channelId },
    ledgerDir,
    resultSink: async () => { posts += 1; return { delivered: true }; },
    actionRunner: async () => { executions += 1; return GATE1_PASS; },
    allowTestOverrides: true,
    now: () => CHECKED_AT,
  };

  const first = await gate2.processSocketSlackEnvelope(options);
  const retry = await gate2.processSocketSlackEnvelope(options);

  assert.equal(first.status, 'PASS');
  assert.equal(retry.status, 'DUPLICATE');
  assert.equal(executions, 1);
  assert.equal(posts, 1);
  const rawLedger = await readFile(join(ledgerDir, `${first.requestId}.json`), 'utf8');
  assert.equal(rawLedger.includes(BODY.event.text), false);
  assert.equal(rawLedger.includes(BODY.event_id), false);
});

test('synthetic and live processors reject each other source instead of relabeling it', async t => {
  const connector = await loadConnector();
  const gate2 = await loadGate2();
  const ledgerDir = await tempLedger(t);
  const { envelope } = connector.adaptSlackAppMention({ body: BODY, route: ROUTE });
  const common = {
    allowedRoute: { teamId: ROUTE.teamId, channelId: ROUTE.channelId },
    ledgerDir,
    resultSink: async () => ({ delivered: true }),
    actionRunner: async () => GATE1_PASS,
    allowTestOverrides: true,
    now: () => CHECKED_AT,
  };

  const liveThroughSynthetic = await gate2.processSyntheticSlackEnvelope({ ...common, envelope });
  const syntheticThroughLive = await gate2.processSocketSlackEnvelope({
    ...common,
    envelope: { ...envelope, source: 'synthetic_local' },
  });

  assert.equal(liveThroughSynthetic.status, 'REJECTED');
  assert.equal(liveThroughSynthetic.errorClass, 'invalid_envelope');
  assert.equal(syntheticThroughLive.status, 'REJECTED');
  assert.equal(syntheticThroughLive.errorClass, 'invalid_envelope');
});

test('the Slack result sink posts once in the original thread and requires an exact bot readback', async () => {
  const connector = await loadConnector();
  assert.equal(typeof connector?.createSlackResultSink, 'function');
  const postCalls = [];
  const replyCalls = [];
  const postedTs = '1787623202.000003';
  const expectedText = '✅ 세무·서류 담당 준비 상태: 정상\n요청 ID: 0123456789abcdef';
  const client = {
    chat: {
      postMessage: async payload => {
        postCalls.push(payload);
        return {
          ok: true,
          channel: ROUTE.channelId,
          ts: postedTs,
          message: {
            type: 'message',
            user: ROUTE.botUserId,
            text: expectedText,
            ts: postedTs,
            thread_ts: BODY.event.ts,
          },
        };
      },
    },
    conversations: {
      replies: async payload => {
        replyCalls.push(payload);
        return {
          ok: true,
          messages: [
            { type: 'message', user: ROUTE.allowedUserId, text: 'request', ts: BODY.event.ts },
            {
              type: 'message',
              user: ROUTE.botUserId,
              text: expectedText,
              ts: postedTs,
              thread_ts: BODY.event.ts,
            },
          ],
          has_more: false,
          response_metadata: { next_cursor: '' },
        };
      },
    },
  };
  const sink = connector.createSlackResultSink({ client, botUserId: ROUTE.botUserId });

  assert.deepEqual(await sink(DELIVERY), { delivered: true });
  assert.deepEqual(postCalls, [{
    channel: ROUTE.channelId,
    thread_ts: BODY.event.ts,
    text: expectedText,
    client_msg_id: 'ec98eb31-8dee-546c-bd5d-dfcd95a8a6f8',
    reply_broadcast: false,
    unfurl_links: false,
    unfurl_media: false,
  }]);
  assert.deepEqual(replyCalls, [{
    channel: ROUTE.channelId,
    ts: BODY.event.ts,
    oldest: postedTs,
    inclusive: true,
    limit: 1,
  }]);
});

test('readback targets the just-posted timestamp even when a thread already has more than fifteen replies', async () => {
  const connector = await loadConnector();
  const postedTs = '1787623299.000099';
  const text = '✅ 세무·서류 담당 준비 상태: 정상\n요청 ID: 0123456789abcdef';
  const olderReplies = Array.from({ length: 15 }, (_, index) => ({
    type: 'message',
    user: ROUTE.allowedUserId,
    text: `older-${index}`,
    ts: `17876232${String(index).padStart(2, '0')}.000001`,
    thread_ts: BODY.event.ts,
  }));
  const sink = connector.createSlackResultSink({
    botUserId: ROUTE.botUserId,
    client: {
      chat: {
        postMessage: async () => ({ ok: true, channel: ROUTE.channelId, ts: postedTs }),
      },
      conversations: {
        replies: async query => ({
          ok: true,
          messages: query.oldest === postedTs && query.inclusive === true && query.limit === 1
            ? [{
              type: 'message',
              user: ROUTE.botUserId,
              text,
              ts: postedTs,
              thread_ts: BODY.event.ts,
            }]
            : olderReplies,
        }),
      },
    },
  });

  assert.deepEqual(await sink(DELIVERY), { delivered: true });
});

test('a Slack explicit non-delivery is retryable, while exceptions and unverifiable posts stay ambiguous', async () => {
  const connector = await loadConnector();
  let reads = 0;
  const noDelivery = connector.createSlackResultSink({
    botUserId: ROUTE.botUserId,
    client: {
      chat: { postMessage: async () => ({ ok: false, error: 'channel_not_found' }) },
      conversations: { replies: async () => { reads += 1; return { ok: true, messages: [] }; } },
    },
  });
  assert.deepEqual(await noDelivery(DELIVERY), { delivered: false });
  assert.equal(reads, 0);

  const rawMarker = 'private-network-marker';
  const ambiguousWrite = connector.createSlackResultSink({
    botUserId: ROUTE.botUserId,
    client: {
      chat: { postMessage: async () => { throw new Error(rawMarker); } },
      conversations: { replies: async () => ({ ok: true, messages: [] }) },
    },
  });
  await assert.rejects(
    ambiguousWrite(DELIVERY),
    error => error.message === 'Slack delivery is ambiguous' && !error.message.includes(rawMarker),
  );

  const missingReadback = connector.createSlackResultSink({
    botUserId: ROUTE.botUserId,
    client: {
      chat: {
        postMessage: async () => ({
          ok: true,
          channel: ROUTE.channelId,
          ts: '1787623202.000003',
        }),
      },
      conversations: {
        replies: async () => ({
          ok: true,
          messages: [{
            type: 'message',
            user: 'U_OTHER',
            text: '✅ 세무·서류 담당 준비 상태: 정상\n요청 ID: 0123456789abcdef',
            ts: '1787623202.000003',
            thread_ts: BODY.event.ts,
          }],
        }),
      },
    },
  });
  await assert.rejects(missingReadback(DELIVERY), /Slack delivery is ambiguous/);
});

test('BLOCKED delivery text is fixed and raw or malformed payloads never reach Slack', async () => {
  const connector = await loadConnector();
  const posted = [];
  const blocked = {
    route: DELIVERY.route,
    result: {
      ...DELIVERY.result,
      status: 'BLOCKED',
      errorClass: 'action_blocked',
    },
  };
  const expectedText = '⚠️ 세무·서류 담당 준비 상태: 확인 필요\n오류 분류: action_blocked\n요청 ID: 0123456789abcdef';
  const sink = connector.createSlackResultSink({
    botUserId: ROUTE.botUserId,
    client: {
      chat: {
        postMessage: async payload => {
          posted.push(payload);
          return { ok: true, channel: ROUTE.channelId, ts: '1787623202.000004' };
        },
      },
      conversations: {
        replies: async () => ({
          ok: true,
          messages: [{
            type: 'message',
            user: ROUTE.botUserId,
            text: expectedText,
            ts: '1787623202.000004',
            thread_ts: BODY.event.ts,
          }],
        }),
      },
    },
  });
  assert.deepEqual(await sink(blocked), { delivered: true });
  assert.equal(posted[0].text, expectedText);
  assert.equal(JSON.stringify(posted).includes(BODY.event.text), false);

  await assert.rejects(
    sink({ ...DELIVERY, rawEvent: BODY }),
    /unknown or missing keys/,
  );
  assert.equal(posted.length, 1);
});

test('the connector handler runs Gate 1 once, verifies one Slack reply, and suppresses the event retry', async t => {
  const connector = await loadConnector();
  assert.equal(typeof connector?.handleSlackAppMention, 'function');
  const ledgerDir = await tempLedger(t);
  let executions = 0;
  const posted = [];
  const client = {
    chat: {
      postMessage: async payload => {
        const response = { ...payload, user: ROUTE.botUserId, type: 'message', ts: '1787623202.000005' };
        posted.push(response);
        return { ok: true, channel: payload.channel, ts: response.ts, message: response };
      },
    },
    conversations: {
      replies: async () => ({ ok: true, messages: [...posted] }),
    },
  };
  const options = {
    body: BODY,
    route: ROUTE,
    ledgerDir,
    client,
    actionRunner: async () => { executions += 1; return GATE1_PASS; },
    allowTestOverrides: true,
    now: () => CHECKED_AT,
  };

  const first = await connector.handleSlackAppMention(options);
  const retry = await connector.handleSlackAppMention(options);

  assert.equal(first.status, 'PASS');
  assert.equal(retry.status, 'DUPLICATE');
  assert.equal(executions, 1);
  assert.equal(posted.length, 1);
});

test('the connector handler rejects unauthorized actors before disk, execution, or Slack calls', async t => {
  const connector = await loadConnector();
  const parent = await tempLedger(t);
  const ledgerDir = join(parent, 'never-created');
  let executions = 0;
  let posts = 0;
  const result = await connector.handleSlackAppMention({
    body: { ...BODY, event: { ...BODY.event, user: 'U_OTHER' } },
    route: ROUTE,
    ledgerDir,
    client: {
      chat: { postMessage: async () => { posts += 1; return { ok: true }; } },
      conversations: { replies: async () => ({ ok: true, messages: [] }) },
    },
    actionRunner: async () => { executions += 1; return GATE1_PASS; },
    allowTestOverrides: true,
    now: () => CHECKED_AT,
  });

  assert.deepEqual(result, {
    schemaVersion: 'gate3-slack-decision/v1',
    status: 'REJECTED',
    employeeId: 'village-tax-document-clerk',
    action: 'desktop_readiness',
    errorClass: 'unauthorized_actor',
  });
  assert.equal(executions, 0);
  assert.equal(posts, 0);
  await assert.rejects(readFile(ledgerDir), error => error.code === 'ENOENT');
});

test('a posted-but-unverified reply becomes delivery_unknown and is not posted again', async t => {
  const connector = await loadConnector();
  const ledgerDir = await tempLedger(t);
  let executions = 0;
  let posts = 0;
  const options = {
    body: BODY,
    route: ROUTE,
    ledgerDir,
    client: {
      chat: {
        postMessage: async payload => {
          posts += 1;
          return { ok: true, channel: payload.channel, ts: '1787623202.000006' };
        },
      },
      conversations: { replies: async () => ({ ok: true, messages: [] }) },
    },
    actionRunner: async () => { executions += 1; return GATE1_PASS; },
    allowTestOverrides: true,
    now: () => CHECKED_AT,
  };

  const first = await connector.handleSlackAppMention(options);
  const retry = await connector.handleSlackAppMention(options);

  assert.equal(first.status, 'BLOCKED');
  assert.equal(first.errorClass, 'delivery_unknown');
  assert.equal(retry.status, 'BLOCKED');
  assert.equal(retry.errorClass, 'delivery_unknown');
  assert.equal(executions, 1);
  assert.equal(posts, 1);
});
