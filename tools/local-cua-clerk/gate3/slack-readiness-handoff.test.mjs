import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  adaptSlackAppMention,
  handleSlackAppMention,
} from './slack-socket-connector.mjs';

const ROUTE = Object.freeze({
  teamId: 'T03EB8LSB18',
  channelId: 'C0B7CLP4KDY',
  appId: 'A0LOCALCUA01',
  botUserId: 'U0LOCALCUA01',
  allowedUserId: 'U03EB8L0QDR',
});

const HEYBILLY_SOURCE = Object.freeze({
  userId: 'U0B66DNKXRU',
  botId: 'B0B68FQLVS6',
});

const HANDOFF_ID = 'hb-9b617f7e-30c7-45e5-82d0-8a2a4799de31';
const READINESS_BLOCK = `<@${ROUTE.botUserId}> 작업 요청 (스튜디오맥 CUA 상태 확인)
[MAC_AGENT_READINESS_V1]
handoff_id: ${HANDOFF_ID}
task_type: studio_mac_cua_readiness
authorization: read_only
[/MAC_AGENT_READINESS_V1]`;
const READINESS_TEXT = `\`\`\`text\n${READINESS_BLOCK}\n\`\`\``;
const RENDERED_READINESS_BLOCK = READINESS_BLOCK.replace(
  `<@${ROUTE.botUserId}>`,
  `@${ROUTE.botUserId}`,
);
const RENDERED_READINESS_TEXT = `\`\`\`\n${RENDERED_READINESS_BLOCK}\n\`\`\``;
const OBSERVED_HEYBILLY_READINESS_TEXT = `\`\`\`${RENDERED_READINESS_BLOCK.replace(
  '[/MAC_AGENT_READINESS_V1]',
  '[/MAC_..._V1]',
)}\n\`\`\``;

const BODY = Object.freeze({
  type: 'event_callback',
  team_id: ROUTE.teamId,
  api_app_id: ROUTE.appId,
  event_id: 'Ev0HEYBILLYREADY1',
  event_time: 1787796000,
  event: Object.freeze({
    type: 'message',
    user: HEYBILLY_SOURCE.userId,
    bot_id: HEYBILLY_SOURCE.botId,
    subtype: 'bot_message',
    text: READINESS_TEXT,
    channel: ROUTE.channelId,
    ts: '1787796000.000001',
    thread_ts: '1787795900.000009',
  }),
});

const GATE1_PASS = Object.freeze({
  schemaVersion: 'gate1-desktop-cua/v1',
  status: 'PASS',
  checkedAt: '2026-08-27T03:00:00.000Z',
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

async function tempLedger(t) {
  const path = await mkdtemp(join(tmpdir(), 'village-gate3-readiness-test-'));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}

test('an exact fenced HeyBilly readiness handoff maps to the existing read-only Gate 2 envelope', () => {
  const decision = adaptSlackAppMention({
    body: BODY,
    route: ROUTE,
    handoffSource: HEYBILLY_SOURCE,
    nowEpochSeconds: BODY.event_time,
  });

  assert.deepEqual(decision, {
    accepted: true,
    kind: 'heybilly_readiness',
    envelope: {
      schemaVersion: 'gate2-slack-envelope/v1',
      source: 'slack_socket_mode',
      teamId: ROUTE.teamId,
      channelId: ROUTE.channelId,
      eventId: HANDOFF_ID,
      threadTs: BODY.event.thread_ts,
      action: 'desktop_readiness',
    },
  });
  assert.equal(JSON.stringify(decision).includes(READINESS_TEXT), false);
  assert.equal(JSON.stringify(decision).includes('customerName'), false);
  assert.equal(JSON.stringify(decision).includes('amountKrw'), false);
  assert.equal(JSON.stringify(decision).includes('phone'), false);
});

test('the one exact live Slack @user rendering canonicalizes to the same readiness envelope', () => {
  const decision = adaptSlackAppMention({
    body: { ...BODY, event: { ...BODY.event, text: RENDERED_READINESS_TEXT } },
    route: ROUTE,
    handoffSource: HEYBILLY_SOURCE,
    nowEpochSeconds: BODY.event_time,
  });

  assert.equal(decision.accepted, true);
  assert.equal(decision.kind, 'heybilly_readiness');
  assert.equal(decision.envelope.eventId, HANDOFF_ID);
});

test('the exact observed HeyBilly code-block rendering canonicalizes only for readiness', () => {
  const decision = adaptSlackAppMention({
    body: { ...BODY, event: { ...BODY.event, text: OBSERVED_HEYBILLY_READINESS_TEXT } },
    route: ROUTE,
    handoffSource: HEYBILLY_SOURCE,
    nowEpochSeconds: BODY.event_time,
  });

  assert.equal(decision.accepted, true);
  assert.equal(decision.kind, 'heybilly_readiness');
  assert.equal(decision.envelope.eventId, HANDOFF_ID);
});

test('readiness handoffs reject mutation authority, PII fields, extra fields, and non-fenced transport', () => {
  const mutations = [
    READINESS_TEXT.replace('authorization: read_only', 'authorization: owner_explicit'),
    READINESS_TEXT.replace('authorization: read_only', 'customer_name: 테스트\nauthorization: read_only'),
    READINESS_TEXT.replace('authorization: read_only', 'amount_krw: 1\nauthorization: read_only'),
    READINESS_TEXT.replace('authorization: read_only', 'unknown_key: injected\nauthorization: read_only'),
    READINESS_BLOCK,
    RENDERED_READINESS_TEXT.replace(`@${ROUTE.botUserId} 작업 요청`, `@${ROUTE.botUserId}\t작업 요청`),
    RENDERED_READINESS_TEXT.replace(`@${ROUTE.botUserId} 작업 요청`, `@${ROUTE.botUserId}  작업 요청`),
    RENDERED_READINESS_TEXT.replace(`@${ROUTE.botUserId} 작업 요청`, `@${ROUTE.botUserId}|맥에이전트 작업 요청`),
    `앞 설명\n${RENDERED_READINESS_TEXT}`,
    `${RENDERED_READINESS_TEXT}\n뒤 설명`,
    RENDERED_READINESS_TEXT.replace(
      'task_type: studio_mac_cua_readiness\nauthorization: read_only',
      'authorization: read_only\ntask_type: studio_mac_cua_readiness',
    ),
    RENDERED_READINESS_TEXT.replace('[/MAC_AGENT_READINESS_V1]', '[/MAC_..._V1]'),
    `\`\`\`${RENDERED_READINESS_BLOCK}\n\`\`\``,
    `\`\`\`${READINESS_BLOCK}\n\`\`\``,
    OBSERVED_HEYBILLY_READINESS_TEXT.replace(
      `@${ROUTE.botUserId}`,
      `<@${ROUTE.botUserId}>`,
    ),
    OBSERVED_HEYBILLY_READINESS_TEXT.replace('[/MAC_..._V1]', '[/MAC_..._V2]'),
    OBSERVED_HEYBILLY_READINESS_TEXT.replace(
      'task_type: studio_mac_cua_readiness',
      'task_type: hometax_cash_receipt_issue',
    ),
  ];

  for (const text of mutations) {
    assert.deepEqual(adaptSlackAppMention({
      body: { ...BODY, event: { ...BODY.event, text } },
      route: ROUTE,
      handoffSource: HEYBILLY_SOURCE,
      nowEpochSeconds: BODY.event_time,
    }), { accepted: false, errorClass: 'command_not_allowed' });
  }
});

test('the connector sends HeyBilly readiness through Gate 2 desktop readiness once and replies in the same thread', async t => {
  const ledgerDir = await tempLedger(t);
  let readinessExecutions = 0;
  let financialExecutions = 0;
  const posted = [];
  const client = {
    chat: {
      postMessage: async payload => {
        const message = {
          ...payload,
          type: 'message',
          user: ROUTE.botUserId,
          ts: '1787796001.000002',
        };
        posted.push(message);
        return { ok: true, channel: payload.channel, ts: message.ts, message };
      },
    },
    conversations: {
      replies: async () => ({ ok: true, messages: [...posted] }),
    },
  };
  const options = {
    body: BODY,
    route: ROUTE,
    handoffSource: HEYBILLY_SOURCE,
    ledgerDir,
    client,
    actionRunner: async () => {
      readinessExecutions += 1;
      return GATE1_PASS;
    },
    handoffActionRunner: async () => {
      financialExecutions += 1;
      throw new Error('financial worker must not run for readiness');
    },
    allowTestOverrides: true,
    now: () => GATE1_PASS.checkedAt,
    eventNowEpochSeconds: BODY.event_time,
  };

  const first = await handleSlackAppMention(options);
  const retry = await handleSlackAppMention(options);

  assert.equal(first.status, 'PASS');
  assert.equal(retry.status, 'DUPLICATE');
  assert.equal(readinessExecutions, 1);
  assert.equal(financialExecutions, 0);
  assert.equal(posted.length, 1);
  assert.equal(posted[0].thread_ts, BODY.event.thread_ts);
  assert.match(posted[0].text, /맥에이전트 준비 상태: 정상/);
  const ledger = (await Promise.all(
    (await readdir(ledgerDir)).map(name => readFile(join(ledgerDir, name), 'utf8')),
  )).join('\n');
  assert.equal(ledger.includes(READINESS_TEXT), false);
  assert.equal(ledger.includes(BODY.event_id), false);
  assert.equal(ledger.includes('hometax_cash_receipt_issue'), false);
});
