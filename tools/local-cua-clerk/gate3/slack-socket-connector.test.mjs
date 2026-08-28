import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
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

const KOREAN_BODY = Object.freeze({
  ...BODY,
  event_id: 'Ev0LOCALCUA0003',
  event: Object.freeze({
    ...BODY.event,
    type: 'message',
    text: '맥에이전트 상태 확인',
    ts: '1787623203.000004',
    event_ts: '1787623203000004',
  }),
});

const HEYBILLY_SOURCE = Object.freeze({
  userId: 'U0B66DNKXRU',
  botId: 'B0B68FQLVS6',
});

const HEYBILLY_HANDOFF_TEXT = `<@${ROUTE.botUserId}> 작업 요청 (홈택스 CUA)
[MAC_AGENT_HANDOFF_V1]
handoff_id: hb-7af43b0c-4b65-4bb4-a04a-b249cc9cf360
task_type: hometax_cash_receipt_issue
authorization: owner_explicit
customer_name: 박민경
transaction_id: 260530-012
transaction_date: 2026-06-27
amount_krw: 464310
purpose: income_deduction
phone: 010-4045-7379
item: 2026-06-27 렌탈 (260530-012)
[/MAC_AGENT_HANDOFF_V1]`;

const HEYBILLY_HANDOFF_BODY = Object.freeze({
  ...BODY,
  event_id: 'Ev0HEYBILLY0001',
  event: Object.freeze({
    ...BODY.event,
    user: HEYBILLY_SOURCE.userId,
    bot_id: HEYBILLY_SOURCE.botId,
    subtype: 'bot_message',
    text: HEYBILLY_HANDOFF_TEXT,
    ts: '1787621822.559059',
    thread_ts: '1787621371.680329',
  }),
});

const HEYBILLY_PLAIN_RELAY_TEXT = `*결론*
Popbill 발행 권한이 없어 홈택스 CUA로 넘깁니다.

*확인된 건*
- 고객: *테스트고객*
- 거래ID: *260530-012*
- 기간: *2026-06-27~29 렌탈*
- 금액: *₩464,310* (VAT포함)
- 연락처: <tel:010-4045-7379|010-4045-7379>
- 입금자: 테스트 / 입금완료 / 계좌이체

<@${ROUTE.botUserId}> *작업 요청 (홈택스 CUA)*
- 종류: *현금영수증*
- 용도: *소득공제용*
- 식별: 휴대폰 <tel:010-4045-7379|010-4045-7379>
- 거래일: *2026-06-27* (또는 실제 입금/거래일 기준)
- 금액: *₩464,310*
- 품목: *2026-06-27 렌탈 (260530-012)*`;

const HEYBILLY_PLAIN_RELAY_BODY = Object.freeze({
  ...HEYBILLY_HANDOFF_BODY,
  event_id: 'Ev0HEYBILLYPLAIN1',
  event: Object.freeze({
    ...HEYBILLY_HANDOFF_BODY.event,
    text: HEYBILLY_PLAIN_RELAY_TEXT,
    ts: '1787621823.559060',
  }),
});

const HEYBILLY_OBSERVED_REISSUE_TEXT = `<@${ROUTE.botUserId}> 작업 요청 (홈택스 CUA) — 테스트고객 현금영수증 재지시

\`\`\`text
[MAC_AGENT_HANDOFF_V1]
handoff_id: hb-7af43b0c4b654bb4a04ab249cc9cf360
task_type: hometax_cash_receipt_issue
priority: high
authorization: owner_explicit
status_check: NOT_ISSUED
customer_name: 테스트고객
kakao_room: 테스트방
room_key: chat:1234567890
transaction_id: 260530-012
transaction_date: 2026-06-27
rental_period: 2026-06-27 ~ 2026-06-29
amount_krw: 464310
purpose: income_deduction
id_type: phone
phone_for_cash_receipt: <tel:010-5164-8069|010-5164-8069>
booking_phone_on_ledger: <tel:010-4045-7379|010-4045-7379>
depositor: 테스트
payment_method: 계좌이체(VAT포함)
deposit_status: 입금완료
ledger_live_readback:
  K=미발행
  L=과거발행
  O=관리키없음
  N=현금영수증 실적 아님
why_hermes_stopped: Popbill 권한 없음
duplicate_guard: search Hometax same date+amount+phone before issue
post_issue_backfill:
  K=발행완료
  L=발행완료
  O=승인번호
  N=고객 자동 발송 안 함
customer_kakao_send: do_not_auto_send
item: 2026-06-27 렌탈 (260530-012)
[/MAC_AGENT_HANDOFF_V1]
\`\`\`

승인번호 확인까지 같은 스레드에 보고합니다.
`;

const HEYBILLY_OBSERVED_REISSUE_BODY = Object.freeze({
  ...HEYBILLY_HANDOFF_BODY,
  event_id: 'Ev0HEYBILLYLIVE01',
  event: Object.freeze({
    ...HEYBILLY_HANDOFF_BODY.event,
    text: HEYBILLY_OBSERVED_REISSUE_TEXT,
    ts: '1787835183.617639',
  }),
});

const HEYBILLY_GENERAL_TEXT = `<@${ROUTE.botUserId}> 작업 요청
Chrome에서 현재 열려 있는 문서의 발급 상태를 확인하고 결과만 보고해.`;

const HEYBILLY_GENERAL_BODY = Object.freeze({
  ...HEYBILLY_HANDOFF_BODY,
  event_id: 'Ev0HEYBILLYGENERAL1',
  event: Object.freeze({
    ...HEYBILLY_HANDOFF_BODY.event,
    text: HEYBILLY_GENERAL_TEXT,
    ts: '1787835200.617640',
  }),
});

const GENERAL_RESULT = Object.freeze({
  schemaVersion: 'studio-mac-general-result/v1',
  status: 'COMPLETED',
  summary: '발급 상태 확인을 완료했습니다.',
  mutationObserved: false,
  readbackVerified: true,
  need: null,
  errorClass: null,
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

test('a simple natural-language HeyBilly relay maps to one general Studio Mac Codex handoff', async () => {
  const connector = await loadConnector();
  const decision = connector.adaptSlackAppMention({
    body: HEYBILLY_GENERAL_BODY,
    route: ROUTE,
    handoffSource: HEYBILLY_SOURCE,
    nowEpochSeconds: HEYBILLY_GENERAL_BODY.event_time,
  });

  assert.deepEqual(decision, {
    accepted: true,
    kind: 'heybilly_general',
    envelope: {
      schemaVersion: 'gate2-heybilly-general-envelope/v1',
      source: 'slack_socket_mode',
      teamId: ROUTE.teamId,
      channelId: ROUTE.channelId,
      eventId: HEYBILLY_GENERAL_BODY.event_id,
      threadTs: HEYBILLY_GENERAL_BODY.event.thread_ts,
      action: 'studio_mac_general_handoff',
      handoffId: 'hb-ca981da7-b71d-47ea-afba-952f4931709b',
    },
    task: {
      schemaVersion: 'gate1-studio-mac-general-task/v1',
      action: 'general_local_cua',
      handoffId: 'hb-ca981da7-b71d-47ea-afba-952f4931709b',
      authorization: 'owner_explicit',
      instruction: 'Chrome에서 현재 열려 있는 문서의 발급 상태를 확인하고 결과만 보고해.',
    },
  });
});

test('general relays accept only the exact fresh HeyBilly activation and a non-empty bounded instruction', async () => {
  const connector = await loadConnector();
  const rendered = connector.adaptSlackAppMention({
    body: {
      ...HEYBILLY_GENERAL_BODY,
      event: {
        ...HEYBILLY_GENERAL_BODY.event,
        text: HEYBILLY_GENERAL_TEXT.replace(`<@${ROUTE.botUserId}>`, `@${ROUTE.botUserId}`),
      },
    },
    route: ROUTE,
    handoffSource: HEYBILLY_SOURCE,
    nowEpochSeconds: HEYBILLY_GENERAL_BODY.event_time,
  });
  assert.equal(rendered.accepted, true);
  assert.equal(rendered.kind, 'heybilly_general');

  const cases = [
    [HEYBILLY_GENERAL_TEXT.replace('\nChrome', ' Chrome'), 'command_not_allowed'],
    [`<@${ROUTE.botUserId}> 작업 요청\n`, 'command_not_allowed'],
    [`<@${ROUTE.botUserId}> 작업 요청\n\`\`\`text\n상태 확인\n\`\`\``, 'command_not_allowed'],
    [`<@${ROUTE.botUserId}> 작업 요청\n[MAC_AGENT_HANDOFF_V1]`, 'command_not_allowed'],
    [`<@${ROUTE.botUserId}>  작업 요청\n상태 확인`, 'command_not_allowed'],
  ];
  for (const [text, errorClass] of cases) {
    const decision = connector.adaptSlackAppMention({
      body: { ...HEYBILLY_GENERAL_BODY, event: { ...HEYBILLY_GENERAL_BODY.event, text } },
      route: ROUTE,
      handoffSource: HEYBILLY_SOURCE,
      nowEpochSeconds: HEYBILLY_GENERAL_BODY.event_time,
    });
    assert.deepEqual(decision, { accepted: false, errorClass });
  }

  const wrongBot = connector.adaptSlackAppMention({
    body: {
      ...HEYBILLY_GENERAL_BODY,
      event: { ...HEYBILLY_GENERAL_BODY.event, bot_id: 'B0WRONGBOT01' },
    },
    route: ROUTE,
    handoffSource: HEYBILLY_SOURCE,
    nowEpochSeconds: HEYBILLY_GENERAL_BODY.event_time,
  });
  assert.deepEqual(wrongBot, { accepted: false, errorClass: 'invalid_event' });

  const stale = connector.adaptSlackAppMention({
    body: HEYBILLY_GENERAL_BODY,
    route: ROUTE,
    handoffSource: HEYBILLY_SOURCE,
    nowEpochSeconds: HEYBILLY_GENERAL_BODY.event_time + 601,
  });
  assert.deepEqual(stale, { accepted: false, errorClass: 'stale_event' });
});

test('an exact Korean employee command maps to the same fixed envelope without an English mention', async () => {
  const connector = await loadConnector();
  const decision = connector.adaptSlackAppMention({ body: KOREAN_BODY, route: ROUTE });

  assert.deepEqual(decision, {
    accepted: true,
    envelope: {
      schemaVersion: 'gate2-slack-envelope/v1',
      source: 'slack_socket_mode',
      teamId: ROUTE.teamId,
      channelId: ROUTE.channelId,
      eventId: KOREAN_BODY.event_id,
      threadTs: KOREAN_BODY.event.ts,
      action: 'desktop_readiness',
    },
  });
  assert.equal(JSON.stringify(decision).includes(KOREAN_BODY.event.text), false);
});

test('an exact HeyBilly bot handoff creates one transient Studio Mac task without persisting the brief in its envelope', async () => {
  const connector = await loadConnector();

  const decision = connector.adaptSlackAppMention({
    body: HEYBILLY_HANDOFF_BODY,
    route: ROUTE,
    handoffSource: HEYBILLY_SOURCE,
    nowEpochSeconds: HEYBILLY_HANDOFF_BODY.event_time,
  });

  assert.equal(decision.accepted, true);
  assert.equal(decision.kind, 'heybilly_handoff');
  assert.deepEqual(decision.task, {
    schemaVersion: 'gate1-studio-mac-task/v1',
    action: 'hometax_cash_receipt_issue',
    handoffId: 'hb-7af43b0c-4b65-4bb4-a04a-b249cc9cf360',
    authorization: 'owner_explicit',
    customerName: '박민경',
    transactionId: '260530-012',
    transactionDate: '2026-06-27',
    amountKrw: 464310,
    purpose: 'income_deduction',
    phone: '010-4045-7379',
    item: '2026-06-27 렌탈 (260530-012)',
  });
  assert.deepEqual(decision.envelope, {
    schemaVersion: 'gate2-heybilly-envelope/v1',
    source: 'slack_socket_mode',
    teamId: ROUTE.teamId,
    channelId: ROUTE.channelId,
    eventId: HEYBILLY_HANDOFF_BODY.event_id,
    threadTs: HEYBILLY_HANDOFF_BODY.event.thread_ts,
    action: 'studio_mac_cua_handoff',
    taskType: 'hometax_cash_receipt_issue',
    handoffId: 'hb-7af43b0c-4b65-4bb4-a04a-b249cc9cf360',
  });
  assert.equal(JSON.stringify(decision.envelope).includes(HEYBILLY_HANDOFF_TEXT), false);
  assert.equal(JSON.stringify(decision.envelope).includes('010-4045-7379'), false);
  assert.equal(JSON.stringify(decision.envelope).includes('박민경'), false);
  assert.equal(JSON.stringify(decision.envelope).includes('464310'), false);
  assert.equal(JSON.stringify(decision.envelope).includes(HEYBILLY_SOURCE.userId), false);
  assert.equal(JSON.stringify(decision.envelope).includes(HEYBILLY_SOURCE.botId), false);
});

test('a plain HeyBilly relay is structured locally on Studio Mac without a Hermes-side contract', async () => {
  const connector = await loadConnector();

  const decision = connector.adaptSlackAppMention({
    body: HEYBILLY_PLAIN_RELAY_BODY,
    route: ROUTE,
    handoffSource: HEYBILLY_SOURCE,
    nowEpochSeconds: HEYBILLY_PLAIN_RELAY_BODY.event_time,
  });

  assert.equal(decision.accepted, true);
  assert.equal(decision.kind, 'heybilly_handoff');
  assert.match(decision.task.handoffId, /^hb-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.deepEqual({ ...decision.task, handoffId: '<derived>' }, {
    schemaVersion: 'gate1-studio-mac-task/v1',
    action: 'hometax_cash_receipt_issue',
    handoffId: '<derived>',
    authorization: 'owner_explicit',
    customerName: '테스트고객',
    transactionId: '260530-012',
    transactionDate: '2026-06-27',
    amountKrw: 464310,
    purpose: 'income_deduction',
    phone: '010-4045-7379',
    item: '2026-06-27 렌탈 (260530-012)',
  });
  assert.equal(decision.envelope.handoffId, decision.task.handoffId);
  assert.equal(decision.envelope.threadTs, HEYBILLY_PLAIN_RELAY_BODY.event.thread_ts);
  assert.equal(JSON.stringify(decision.envelope).includes(HEYBILLY_PLAIN_RELAY_TEXT), false);
  assert.equal(JSON.stringify(decision.envelope).includes('010-4045-7379'), false);
  assert.equal(JSON.stringify(decision.envelope).includes('테스트고객'), false);
});

test('the exact 42-line HeyBilly reissue rendering observed in Slack is normalized locally', async () => {
  const connector = await loadConnector();

  const decision = connector.adaptSlackAppMention({
    body: HEYBILLY_OBSERVED_REISSUE_BODY,
    route: ROUTE,
    handoffSource: HEYBILLY_SOURCE,
    nowEpochSeconds: HEYBILLY_OBSERVED_REISSUE_BODY.event_time,
  });

  assert.equal(decision.accepted, true);
  assert.equal(decision.kind, 'heybilly_handoff');
  assert.deepEqual(decision.task, {
    schemaVersion: 'gate1-studio-mac-task/v1',
    action: 'hometax_cash_receipt_issue',
    handoffId: 'hb-7af43b0c-4b65-4bb4-a04a-b249cc9cf360',
    authorization: 'owner_explicit',
    customerName: '테스트고객',
    transactionId: '260530-012',
    transactionDate: '2026-06-27',
    amountKrw: 464310,
    purpose: 'income_deduction',
    phone: '010-5164-8069',
    item: '2026-06-27 렌탈 (260530-012)',
  });
  assert.equal(decision.envelope.handoffId, decision.task.handoffId);
  assert.equal(JSON.stringify(decision.envelope).includes('010-5164-8069'), false);
  assert.equal(JSON.stringify(decision.envelope).includes('010-4045-7379'), false);
  assert.equal(JSON.stringify(decision.envelope).includes('테스트고객'), false);
  assert.equal(JSON.stringify(decision.envelope).includes('464310'), false);
});

test('the observed reissue rendering rejects identity, phone, date, and field-order mutations', async () => {
  const connector = await loadConnector();
  const mutations = [
    HEYBILLY_OBSERVED_REISSUE_TEXT.replace(
      'hb-7af43b0c4b654bb4a04ab249cc9cf360',
      'hb-7af43b0c4b655bb4a04ab249cc9cf360',
    ),
    HEYBILLY_OBSERVED_REISSUE_TEXT.replace(
      '<tel:010-5164-8069|010-5164-8069>',
      '<tel:010-5164-8069|010-0000-0000>',
    ),
    HEYBILLY_OBSERVED_REISSUE_TEXT.replace(
      'item: 2026-06-27 렌탈 (260530-012)',
      'item: 2026-06-28 렌탈 (260530-012)',
    ),
    HEYBILLY_OBSERVED_REISSUE_TEXT.replace(
      'priority: high\nauthorization: owner_explicit',
      'authorization: owner_explicit\npriority: high',
    ),
    HEYBILLY_OBSERVED_REISSUE_TEXT.replace('  K=미발행\n  L=과거발행', '  L=과거발행\n  K=미발행'),
    HEYBILLY_OBSERVED_REISSUE_TEXT.replace('— 테스트고객 현금영수증 재지시', '— 다른고객 현금영수증 재지시'),
  ];

  for (const text of mutations) {
    const decision = connector.adaptSlackAppMention({
      body: {
        ...HEYBILLY_OBSERVED_REISSUE_BODY,
        event: { ...HEYBILLY_OBSERVED_REISSUE_BODY.event, text },
      },
      route: ROUTE,
      handoffSource: HEYBILLY_SOURCE,
      nowEpochSeconds: HEYBILLY_OBSERVED_REISSUE_BODY.event_time,
    });
    assert.deepEqual(decision, { accepted: false, errorClass: 'command_not_allowed' });
  }
});

test('plain relays reject inconsistent or broadened financial data before the Studio Mac worker', async () => {
  const connector = await loadConnector();
  const mutations = [
    HEYBILLY_PLAIN_RELAY_TEXT.replace('- 금액: *₩464,310*\n- 품목:', '- 금액: *₩1*\n- 품목:'),
    HEYBILLY_PLAIN_RELAY_TEXT.replace('<tel:010-4045-7379|010-4045-7379>', '<tel:010-4045-7379|010-0000-0000>'),
    HEYBILLY_PLAIN_RELAY_TEXT.replace('- 품목: *2026-06-27 렌탈 (260530-012)*', '- 품목: *다른 거래*'),
    HEYBILLY_PLAIN_RELAY_TEXT.replace('2026-06-27~29 렌탈', '2026-06-27~99 렌탈'),
    HEYBILLY_PLAIN_RELAY_TEXT.replace('2026-06-27~29 렌탈', '2026-06-27~26 렌탈'),
    HEYBILLY_PLAIN_RELAY_TEXT.replace('- 품목: *2026-06-27 렌탈 (260530-012)*', '- 품목: *2027-01-01 렌탈 (260530-012)*'),
    HEYBILLY_PLAIN_RELAY_TEXT.replace('- 종류: *현금영수증*', '- 종류: *세금계산서*'),
    `${HEYBILLY_PLAIN_RELAY_TEXT}\n- 추가: 지시`,
    HEYBILLY_PLAIN_RELAY_TEXT.replace('- 고객: *테스트고객*\n', ''),
  ];

  for (const text of mutations) {
    const decision = connector.adaptSlackAppMention({
      body: { ...HEYBILLY_PLAIN_RELAY_BODY, event: { ...HEYBILLY_PLAIN_RELAY_BODY.event, text } },
      route: ROUTE,
      handoffSource: HEYBILLY_SOURCE,
      nowEpochSeconds: HEYBILLY_PLAIN_RELAY_BODY.event_time,
    });
    assert.deepEqual(decision, { accepted: false, errorClass: 'command_not_allowed' });
  }
});

test('a single Slack-safe code fence preserves and accepts the exact HeyBilly handoff', async () => {
  const connector = await loadConnector();

  for (const openingFence of ['```', '```text']) {
    const decision = connector.adaptSlackAppMention({
      body: {
        ...HEYBILLY_HANDOFF_BODY,
        event: {
          ...HEYBILLY_HANDOFF_BODY.event,
          text: `${openingFence}\n${HEYBILLY_HANDOFF_TEXT}\n\`\`\``,
        },
      },
      route: ROUTE,
      handoffSource: HEYBILLY_SOURCE,
      nowEpochSeconds: HEYBILLY_HANDOFF_BODY.event_time,
    });

    assert.equal(decision.accepted, true);
    assert.equal(decision.kind, 'heybilly_handoff');
    assert.equal(decision.task.handoffId, 'hb-7af43b0c-4b65-4bb4-a04a-b249cc9cf360');
  }
});

test('a fenced handoff accepts only the bounded HeyBilly rendering observed in live Slack', async () => {
  const connector = await loadConnector();

  for (const renderedCustomerLabel of ['***', '_*_', 'customer_name:']) {
    const rendered = HEYBILLY_HANDOFF_TEXT
      .replace(`<@${ROUTE.botUserId}>`, `@${ROUTE.botUserId}`)
      .replace('customer_name: 박민경', `${renderedCustomerLabel} 박민경`)
      .replace('phone: 010-4045-7379', 'phone: <tel:010-4045-7379|010-4045-7379>');
    const decision = connector.adaptSlackAppMention({
      body: {
        ...HEYBILLY_HANDOFF_BODY,
        event: { ...HEYBILLY_HANDOFF_BODY.event, text: `\`\`\`\n${rendered}\n\`\`\`` },
      },
      route: ROUTE,
      handoffSource: HEYBILLY_SOURCE,
      nowEpochSeconds: HEYBILLY_HANDOFF_BODY.event_time,
    });

    assert.equal(decision.accepted, true);
    assert.equal(decision.kind, 'heybilly_handoff');
    assert.equal(decision.task.customerName, '박민경');
    assert.equal(decision.task.phone, '010-4045-7379');
  }

  const collapsed = HEYBILLY_HANDOFF_TEXT
    .replace(`<@${ROUTE.botUserId}>`, `@${ROUTE.botUserId}`)
    .replace('phone: 010-4045-7379', 'phone: <tel:010-4045-7379|010-4045-7379>')
    .replaceAll('\n', ' ');
  const collapsedDecision = connector.adaptSlackAppMention({
    body: {
      ...HEYBILLY_HANDOFF_BODY,
      event: { ...HEYBILLY_HANDOFF_BODY.event, text: `\`\`\`text ${collapsed} \`\`\`` },
    },
    route: ROUTE,
    handoffSource: HEYBILLY_SOURCE,
    nowEpochSeconds: HEYBILLY_HANDOFF_BODY.event_time,
  });
  assert.equal(collapsedDecision.accepted, true);
  assert.equal(collapsedDecision.task.handoffId, 'hb-7af43b0c-4b65-4bb4-a04a-b249cc9cf360');
  assert.equal(collapsedDecision.task.customerName, '박민경');
  assert.equal(collapsedDecision.task.phone, '010-4045-7379');
});

test('HeyBilly handoffs reject stale, edited, mismatched, and malformed events before creating a task', async () => {
  const connector = await loadConnector();
  const renderedObservedBase = HEYBILLY_HANDOFF_TEXT
    .replace(`<@${ROUTE.botUserId}>`, `@${ROUTE.botUserId}`)
    .replace('customer_name: 박민경', '*** 박민경')
    .replace('phone: 010-4045-7379', 'phone: <tel:010-4045-7379|010-4045-7379>');
  const accepted = connector.adaptSlackAppMention({
    body: HEYBILLY_HANDOFF_BODY,
    route: ROUTE,
    handoffSource: HEYBILLY_SOURCE,
    nowEpochSeconds: HEYBILLY_HANDOFF_BODY.event_time + 60,
  });
  assert.equal(accepted.accepted, true);

  const cases = [
    [{ ...HEYBILLY_HANDOFF_BODY, event: { ...HEYBILLY_HANDOFF_BODY.event, text: '```\n' + renderedObservedBase.replace('task_type: hometax_cash_receipt_issue\nauthorization: owner_explicit', 'authorization: owner_explicit\ntask_type: hometax_cash_receipt_issue') + '\n```' } }, HEYBILLY_SOURCE, 'command_not_allowed'],
    [{ ...HEYBILLY_HANDOFF_BODY, event: { ...HEYBILLY_HANDOFF_BODY.event, text: '```text ' + renderedObservedBase.replaceAll('\n', ' ').replace('task_type:', 'unknown_key: injected task_type:') + ' ```' } }, HEYBILLY_SOURCE, 'command_not_allowed'],
    [{ ...HEYBILLY_HANDOFF_BODY, event: { ...HEYBILLY_HANDOFF_BODY.event, text: '```\n' + renderedObservedBase.replace(`@${ROUTE.botUserId} 작업 요청`, `@${ROUTE.botUserId}\t작업   요청`) + '\n```' } }, HEYBILLY_SOURCE, 'command_not_allowed'],
    [{ ...HEYBILLY_HANDOFF_BODY, event: { ...HEYBILLY_HANDOFF_BODY.event, text: '```\n' + renderedObservedBase.replace('*** 박민경', '***     박민경   ') + '\n```' } }, HEYBILLY_SOURCE, 'command_not_allowed'],
    [{ ...HEYBILLY_HANDOFF_BODY, event: { ...HEYBILLY_HANDOFF_BODY.event, text: '```\n' + renderedObservedBase.replace('tel:010-4045-7379|', 'tel:call-me-at-010-4045-7379|') + '\n```' } }, HEYBILLY_SOURCE, 'command_not_allowed'],
    [{ ...HEYBILLY_HANDOFF_BODY, event: { ...HEYBILLY_HANDOFF_BODY.event, text: '```\n' + renderedObservedBase.replace('tel:010-4045-7379|', 'tel:٠10-4045-7379|') + '\n```' } }, HEYBILLY_SOURCE, 'command_not_allowed'],
    [{ ...HEYBILLY_HANDOFF_BODY, event_time: HEYBILLY_HANDOFF_BODY.event_time - 601 }, HEYBILLY_SOURCE, 'stale_event'],
    [{ ...HEYBILLY_HANDOFF_BODY, event: { ...HEYBILLY_HANDOFF_BODY.event, subtype: 'message_changed' } }, HEYBILLY_SOURCE, 'invalid_event'],
    [{ ...HEYBILLY_HANDOFF_BODY, event: { ...HEYBILLY_HANDOFF_BODY.event, bot_id: 'B0OTHERBOT01' } }, HEYBILLY_SOURCE, 'invalid_event'],
    [{ ...HEYBILLY_HANDOFF_BODY, event: { ...HEYBILLY_HANDOFF_BODY.event, user: 'U0OTHERBOT01' } }, HEYBILLY_SOURCE, 'invalid_event'],
    [{ ...HEYBILLY_HANDOFF_BODY, event: { ...HEYBILLY_HANDOFF_BODY.event, text: HEYBILLY_HANDOFF_TEXT.replace('amount_krw: 464310', 'amount_krw: 464310\namount_krw: 1') } }, HEYBILLY_SOURCE, 'command_not_allowed'],
    [{ ...HEYBILLY_HANDOFF_BODY, event: { ...HEYBILLY_HANDOFF_BODY.event, text: HEYBILLY_HANDOFF_TEXT.replace('hb-7af43b0c-4b65-4bb4-a04a-b249cc9cf360', 'hb-010-4045-7379') } }, HEYBILLY_SOURCE, 'command_not_allowed'],
    [{ ...HEYBILLY_HANDOFF_BODY, event: { ...HEYBILLY_HANDOFF_BODY.event, text: HEYBILLY_HANDOFF_TEXT.replace('purpose: income_deduction', 'purpose: expense_proof') } }, HEYBILLY_SOURCE, 'command_not_allowed'],
    [{ ...HEYBILLY_HANDOFF_BODY, event: { ...HEYBILLY_HANDOFF_BODY.event, text: HEYBILLY_HANDOFF_TEXT.replace('item:', 'unknown_key: injected\nitem:') } }, HEYBILLY_SOURCE, 'command_not_allowed'],
    [{ ...HEYBILLY_HANDOFF_BODY, event: { ...HEYBILLY_HANDOFF_BODY.event, text: `앞 설명\n\`\`\`text\n${HEYBILLY_HANDOFF_TEXT}\n\`\`\`` } }, HEYBILLY_SOURCE, 'command_not_allowed'],
    [{ ...HEYBILLY_HANDOFF_BODY, event: { ...HEYBILLY_HANDOFF_BODY.event, text: `\`\`\`json\n${HEYBILLY_HANDOFF_TEXT}\n\`\`\`` } }, HEYBILLY_SOURCE, 'command_not_allowed'],
    [{ ...HEYBILLY_HANDOFF_BODY, event: { ...HEYBILLY_HANDOFF_BODY.event, text: `\`\`\`text\n${HEYBILLY_HANDOFF_TEXT}\n\`\`\`\n뒤 설명` } }, HEYBILLY_SOURCE, 'command_not_allowed'],
    [{ ...HEYBILLY_HANDOFF_BODY, event: { ...HEYBILLY_HANDOFF_BODY.event, text: `｀｀｀ｔｅｘｔ\n${HEYBILLY_HANDOFF_TEXT}\n｀｀｀` } }, HEYBILLY_SOURCE, 'command_not_allowed'],
    [{ ...HEYBILLY_HANDOFF_BODY, event: { ...HEYBILLY_HANDOFF_BODY.event, text: `\`\`\`text\n${HEYBILLY_HANDOFF_TEXT.replace('item: 2026-06-27 렌탈 (260530-012)', 'item: 렌탈```내용')}\n\`\`\`` } }, HEYBILLY_SOURCE, 'command_not_allowed'],
    [{ ...HEYBILLY_HANDOFF_BODY, event: { ...HEYBILLY_HANDOFF_BODY.event, text: `\`\`\`\n${HEYBILLY_HANDOFF_TEXT.replace(`<@${ROUTE.botUserId}>`, `@${ROUTE.botUserId}`).replace('customer_name: 박민경', '*** 박민경').replace('phone: 010-4045-7379', 'phone: <tel:010-4045-7379|010-0000-0000>')}\n\`\`\`` } }, HEYBILLY_SOURCE, 'command_not_allowed'],
  ];

  for (const [body, handoffSource, errorClass] of cases) {
    const decision = connector.adaptSlackAppMention({
      body,
      route: ROUTE,
      handoffSource,
      nowEpochSeconds: HEYBILLY_HANDOFF_BODY.event_time,
    });
    assert.deepEqual(decision, { accepted: false, errorClass });
    assert.equal('task' in decision, false);
    assert.equal('envelope' in decision, false);
  }
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
    [{ ...KOREAN_BODY, event: { ...KOREAN_BODY.event, text: '맥에이전트 홈택스 발급' } }, 'command_not_allowed'],
    [{ ...KOREAN_BODY, event: { ...KOREAN_BODY.event, user: 'U_OTHER' } }, 'unauthorized_actor'],
    [{ ...KOREAN_BODY, event: { ...KOREAN_BODY.event, bot_id: 'B_OTHER' } }, 'invalid_event'],
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
  const expectedText = ':white_check_mark: 맥에이전트 준비 상태: 정상\n요청 ID: 0123456789abcdef';
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

test('the Studio Mac status sink posts fixed Korean ACK and final messages with exact same-thread readback', async () => {
  const connector = await loadConnector();
  assert.equal(typeof connector?.createStudioMacStatusSink, 'function');
  const posted = [];
  const client = {
    chat: {
      postMessage: async payload => {
        const ts = `1787623300.00000${posted.length + 1}`;
        posted.push({ ...payload, ts });
        return { ok: true, channel: payload.channel, ts };
      },
    },
    conversations: {
      replies: async ({ oldest }) => ({
        ok: true,
        messages: posted
          .filter(message => message.ts === oldest)
          .map(message => ({
            type: 'message',
            user: ROUTE.botUserId,
            text: message.text
              .replace('🟡', ':large_yellow_circle:')
              .replace('✅', ':white_check_mark:')
              .replace('⚠️', ':warning:'),
            ts: message.ts,
            thread_ts: message.thread_ts,
          })),
      }),
    },
  };
  const sink = connector.createStudioMacStatusSink({ client, botUserId: ROUTE.botUserId });
  const base = {
    schemaVersion: 'gate2-studio-mac-status/v1',
    requestId: '0123456789abcdef',
    route: { teamId: ROUTE.teamId, channelId: ROUTE.channelId, threadTs: BODY.event.ts },
  };

  assert.deepEqual(await sink({ ...base, phase: 'ACK' }), { delivered: true });
  assert.deepEqual(await sink({
    ...base,
    phase: 'FINAL',
    result: {
      status: 'COMPLETED',
      resultCode: 'cash_receipt_issued',
      authorizationNumber: 'Z56524383',
    },
  }), { delivered: true });
  assert.deepEqual(await sink({
    ...base,
    phase: 'FINAL',
    result: {
      status: 'NEEDS_USER',
      resultCode: 'user_action_required',
      need: 'captcha_required',
    },
  }), { delivered: true });

  assert.equal(posted[0].text, ':large_yellow_circle: 스튜디오맥에서 접수했습니다\n요청 ID: 0123456789abcdef');
  assert.equal(posted[1].text, ':white_check_mark: 스튜디오맥 작업 완료\n현금영수증 승인번호: Z56524383\n요청 ID: 0123456789abcdef');
  assert.equal(posted[2].text, ':warning: 스튜디오맥에서 사용자 확인이 필요합니다\n필요 조치: CAPTCHA 확인\n요청 ID: 0123456789abcdef');
  assert.equal(JSON.stringify(posted).includes('맥북'), false);
  assert.deepEqual(posted.map(message => message.thread_ts), [BODY.event.ts, BODY.event.ts, BODY.event.ts]);
  assert.notEqual(posted[0].client_msg_id, posted[1].client_msg_id);
});

test('the general Studio Mac sink escapes Slack metacharacters and requires exact same-thread bot readback', async () => {
  const connector = await loadConnector();
  const postedTs = '1787623300.000099';
  const summary = '완료 <!channel> <@U0OTHERUSER> & 확인';
  let postedText;
  const payload = {
    schemaVersion: 'gate2-studio-mac-general-status/v1',
    phase: 'FINAL',
    requestId: '0123456789abcdef',
    route: { teamId: ROUTE.teamId, channelId: ROUTE.channelId, threadTs: BODY.event.ts },
    result: { ...GENERAL_RESULT, summary },
  };
  const sink = connector.createGeneralStudioMacStatusSink({
    botUserId: ROUTE.botUserId,
    client: {
      chat: {
        postMessage: async message => {
          postedText = message.text;
          return { ok: true, channel: ROUTE.channelId, ts: postedTs };
        },
      },
      conversations: {
        replies: async () => ({
          ok: true,
          messages: [{
            type: 'message',
            user: ROUTE.botUserId,
            text: postedText,
            ts: postedTs,
            thread_ts: BODY.event.ts,
          }],
        }),
      },
    },
  });

  assert.deepEqual(await sink(payload), { delivered: true });
  assert.match(postedText, /&lt;!channel&gt;/);
  assert.match(postedText, /&lt;@U0OTHERUSER&gt;/);
  assert.match(postedText, /&amp; 확인/);
  assert.equal(postedText.includes('<!channel>'), false);
  assert.equal(postedText.includes('<@U0OTHERUSER>'), false);
});

test('the general Studio Mac sink rejects wrong bot, text, timestamp, thread, and missing readback', async () => {
  const connector = await loadConnector();
  const postedTs = '1787623300.000099';
  const payload = {
    schemaVersion: 'gate2-studio-mac-general-status/v1',
    phase: 'FINAL',
    requestId: '0123456789abcdef',
    route: { teamId: ROUTE.teamId, channelId: ROUTE.channelId, threadTs: BODY.event.ts },
    result: GENERAL_RESULT,
  };
  const cases = [
    message => ({ ...message, user: 'U0WRONGBOT' }),
    message => ({ ...message, text: `${message.text} 변조` }),
    message => ({ ...message, ts: '1787623300.000100' }),
    message => ({ ...message, thread_ts: '1787623300.000101' }),
    () => null,
  ];

  for (const mutate of cases) {
    let postedText;
    const sink = connector.createGeneralStudioMacStatusSink({
      botUserId: ROUTE.botUserId,
      client: {
        chat: {
          postMessage: async message => {
            postedText = message.text;
            return { ok: true, channel: ROUTE.channelId, ts: postedTs };
          },
        },
        conversations: {
          replies: async () => {
            const exact = {
              type: 'message',
              user: ROUTE.botUserId,
              text: postedText,
              ts: postedTs,
              thread_ts: BODY.event.ts,
            };
            const candidate = mutate(exact);
            return { ok: true, messages: candidate === null ? [] : [candidate] };
          },
        },
      },
    });
    await assert.rejects(sink(payload), /Slack delivery is ambiguous/);
  }

  let reads = 0;
  const explicitFailure = connector.createGeneralStudioMacStatusSink({
    botUserId: ROUTE.botUserId,
    client: {
      chat: { postMessage: async () => ({ ok: false }) },
      conversations: { replies: async () => { reads += 1; return { ok: true, messages: [] }; } },
    },
  });
  assert.deepEqual(await explicitFailure(payload), { delivered: false });
  assert.equal(reads, 0);
});

test('readback targets the just-posted timestamp even when a thread already has more than fifteen replies', async () => {
  const connector = await loadConnector();
  const postedTs = '1787623299.000099';
  const text = ':white_check_mark: 맥에이전트 준비 상태: 정상\n요청 ID: 0123456789abcdef';
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
            text: ':white_check_mark: 맥에이전트 준비 상태: 정상\n요청 ID: 0123456789abcdef',
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
  const expectedText = ':warning: 맥에이전트 준비 상태: 확인 필요\n오류 분류: action_blocked\n요청 ID: 0123456789abcdef';
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

test('the connector handler routes one plain HeyBilly relay to the local Studio Mac worker and suppresses its retry', async t => {
  const connector = await loadConnector();
  const ledgerDir = await tempLedger(t);
  let executions = 0;
  const posted = [];
  const client = {
    chat: {
      postMessage: async payload => {
        const ts = `1787623400.00000${posted.length + 1}`;
        posted.push({ ...payload, ts });
        return { ok: true, channel: payload.channel, ts };
      },
    },
    conversations: {
      replies: async ({ oldest, latest }) => {
        if (latest === HEYBILLY_PLAIN_RELAY_BODY.event.thread_ts) {
          return {
            ok: true,
            messages: [{
              type: 'message',
              user: ROUTE.allowedUserId,
              ts: HEYBILLY_PLAIN_RELAY_BODY.event.thread_ts,
            }],
          };
        }
        return {
          ok: true,
          messages: posted
            .filter(message => message.ts === oldest)
            .map(message => ({
              type: 'message',
              user: ROUTE.botUserId,
              text: message.text,
              ts: message.ts,
              thread_ts: message.thread_ts,
            })),
        };
      },
    },
  };
  const options = {
    body: HEYBILLY_PLAIN_RELAY_BODY,
    route: ROUTE,
    handoffSource: HEYBILLY_SOURCE,
    ledgerDir,
    client,
    handoffActionRunner: async ({ task }) => {
      executions += 1;
      assert.deepEqual(task, connector.adaptSlackAppMention({
        body: HEYBILLY_PLAIN_RELAY_BODY,
        route: ROUTE,
        handoffSource: HEYBILLY_SOURCE,
        nowEpochSeconds: HEYBILLY_PLAIN_RELAY_BODY.event_time,
      }).task);
      return {
        schemaVersion: 'studio-mac-cua-result/v1',
        status: 'COMPLETED',
        resultCode: 'cash_receipt_issued',
        authorizationNumber: 'Z56524383',
        duplicateFound: false,
        readbackVerified: true,
        mutationObserved: true,
        need: null,
        errorClass: null,
      };
    },
    allowTestOverrides: true,
    now: () => CHECKED_AT,
    eventNowEpochSeconds: HEYBILLY_PLAIN_RELAY_BODY.event_time,
  };

  const first = await connector.handleSlackAppMention(options);
  const retry = await connector.handleSlackAppMention(options);
  assert.equal(first.status, 'PASS');
  assert.equal(retry.status, 'DUPLICATE');
  assert.equal(executions, 1);
  assert.deepEqual(posted.map(message => message.text.split('\n')[0]), [
    ':large_yellow_circle: 스튜디오맥에서 접수했습니다',
    ':white_check_mark: 스튜디오맥 작업 완료',
  ]);
  const raw = (await Promise.all((await readdir(ledgerDir)).map(name => readFile(join(ledgerDir, name), 'utf8')))).join('\n');
  assert.equal(raw.includes('테스트고객'), false);
  assert.equal(raw.includes('010-4045-7379'), false);
  assert.equal(raw.includes('464310'), false);
});

test('the connector handler creates one general Codex task and reports its result in the owner thread', async t => {
  const connector = await loadConnector();
  const ledgerDir = await tempLedger(t);
  let executions = 0;
  const posted = [];
  const client = {
    chat: {
      postMessage: async payload => {
        const ts = `1787835300.00000${posted.length + 1}`;
        posted.push({ ...payload, ts });
        return { ok: true, channel: payload.channel, ts };
      },
    },
    conversations: {
      replies: async ({ oldest, latest }) => {
        if (latest === HEYBILLY_GENERAL_BODY.event.thread_ts) {
          return {
            ok: true,
            messages: [{
              type: 'message',
              user: ROUTE.allowedUserId,
              ts: HEYBILLY_GENERAL_BODY.event.thread_ts,
            }],
          };
        }
        return {
          ok: true,
          messages: posted
            .filter(message => message.ts === oldest)
            .map(message => ({
              type: 'message',
              user: ROUTE.botUserId,
              text: message.text,
              ts: message.ts,
              thread_ts: message.thread_ts,
            })),
        };
      },
    },
  };
  const decision = connector.adaptSlackAppMention({
    body: HEYBILLY_GENERAL_BODY,
    route: ROUTE,
    handoffSource: HEYBILLY_SOURCE,
    nowEpochSeconds: HEYBILLY_GENERAL_BODY.event_time,
  });
  const options = {
    body: HEYBILLY_GENERAL_BODY,
    route: ROUTE,
    handoffSource: HEYBILLY_SOURCE,
    ledgerDir,
    client,
    generalHandoffActionRunner: async input => {
      executions += 1;
      assert.deepEqual(input.task, decision.task);
      return GENERAL_RESULT;
    },
    allowTestOverrides: true,
    now: () => CHECKED_AT,
    eventNowEpochSeconds: HEYBILLY_GENERAL_BODY.event_time,
  };

  const first = await connector.handleSlackAppMention(options);
  const retry = await connector.handleSlackAppMention(options);
  assert.equal(first.status, 'PASS');
  assert.equal(retry.status, 'DUPLICATE');
  assert.equal(executions, 1);
  assert.deepEqual(posted.map(message => message.thread_ts), [
    HEYBILLY_GENERAL_BODY.event.thread_ts,
    HEYBILLY_GENERAL_BODY.event.thread_ts,
  ]);
  assert.deepEqual(posted.map(message => message.text.split('\n')[0]), [
    ':large_yellow_circle: 스튜디오맥에서 새 Codex 작업을 접수했습니다',
    ':white_check_mark: 스튜디오맥 작업 완료',
  ]);
  assert.match(posted[1].text, /발급 상태 확인을 완료했습니다/);
  const raw = (await Promise.all((await readdir(ledgerDir)).map(name => readFile(join(ledgerDir, name), 'utf8')))).join('\n');
  assert.equal(raw.includes(decision.task.instruction), false);
  assert.equal(raw.includes(GENERAL_RESULT.summary), false);
});

test('a general relay rejects a non-owner parent before ledger, Slack post, or Codex execution', async t => {
  const connector = await loadConnector();
  const ledgerDir = await tempLedger(t);
  let posts = 0;
  let executions = 0;
  const result = await connector.handleSlackAppMention({
    body: HEYBILLY_GENERAL_BODY,
    route: ROUTE,
    handoffSource: HEYBILLY_SOURCE,
    ledgerDir,
    client: {
      chat: { postMessage: async () => { posts += 1; return { ok: false }; } },
      conversations: {
        replies: async () => ({
          ok: true,
          messages: [{
            type: 'message',
            user: 'U0NOTTHEOWNER',
            ts: HEYBILLY_GENERAL_BODY.event.thread_ts,
          }],
        }),
      },
    },
    generalHandoffActionRunner: async () => { executions += 1; return GENERAL_RESULT; },
    allowTestOverrides: true,
    now: () => CHECKED_AT,
    eventNowEpochSeconds: HEYBILLY_GENERAL_BODY.event_time,
  });

  assert.equal(result.status, 'REJECTED');
  assert.equal(result.errorClass, 'unauthorized_actor');
  assert.equal(posts, 0);
  assert.equal(executions, 0);
  assert.deepEqual(await readdir(ledgerDir), []);
});

test('a HeyBilly financial relay requires the configured owner on the parent Slack thread', async t => {
  const connector = await loadConnector();
  const ledgerDir = await tempLedger(t);
  let executions = 0;
  let posts = 0;
  const result = await connector.handleSlackAppMention({
    body: HEYBILLY_PLAIN_RELAY_BODY,
    route: ROUTE,
    handoffSource: HEYBILLY_SOURCE,
    ledgerDir,
    client: {
      chat: { postMessage: async () => { posts += 1; return { ok: false }; } },
      conversations: {
        replies: async () => ({
          ok: true,
          messages: [{
            type: 'message',
            user: 'U0OTHERUSER01',
            ts: HEYBILLY_PLAIN_RELAY_BODY.event.thread_ts,
          }],
        }),
      },
    },
    handoffActionRunner: async () => { executions += 1; throw new Error('must not execute'); },
    allowTestOverrides: true,
    now: () => CHECKED_AT,
    eventNowEpochSeconds: HEYBILLY_PLAIN_RELAY_BODY.event_time,
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
