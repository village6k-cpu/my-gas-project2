import { createHash } from 'node:crypto';
import {
  ALLOWED_ACTION,
  DELIVERY_SCHEMA_VERSION,
  EMPLOYEE_ID,
  ENVELOPE_SCHEMA_VERSION,
  processSocketSlackEnvelope,
  SOCKET_SLACK_SOURCE,
} from '../gate2/slack-intake-shell.mjs';
import { processHeyBillyHandoff } from '../gate2/heybilly-handoff-shell.mjs';

export const LIVE_SLACK_SOURCE = SOCKET_SLACK_SOURCE;

const ROUTE_KEYS = Object.freeze([
  'teamId',
  'channelId',
  'appId',
  'botUserId',
  'allowedUserId',
]);
const TEAM_ID = /^T[A-Z0-9]{8,63}$/;
const CHANNEL_ID = /^[CG][A-Z0-9]{8,63}$/;
const APP_ID = /^A[A-Z0-9]{8,63}$/;
const USER_ID = /^[UW][A-Z0-9]{8,63}$/;
const EVENT_ID = /^Ev[A-Za-z0-9_-]{8,126}$/;
const THREAD_TS = /^\d{10,16}\.\d{6}$/;
const REQUEST_ID = /^[a-f0-9]{16}$/;
const MAX_EVENT_TEXT_BYTES = 256;
const MAX_HANDOFF_TEXT_BYTES = 8 * 1024;
const HANDOFF_SOURCE_KEYS = Object.freeze(['userId', 'botId']);
const BOT_ID = /^B[A-Z0-9]{8,63}$/;
const HEYBILLY_TASK_SCHEMA_VERSION = 'gate1-studio-mac-task/v1';
const HEYBILLY_ENVELOPE_SCHEMA_VERSION = 'gate2-heybilly-envelope/v1';
const HEYBILLY_ACTION = 'studio_mac_cua_handoff';
const HEYBILLY_TASK_TYPE = 'hometax_cash_receipt_issue';
const HANDOFF_MAX_AGE_SECONDS = 600;
const HANDOFF_MAX_FUTURE_SKEW_SECONDS = 60;
const HANDOFF_KEYS = Object.freeze([
  'handoff_id',
  'task_type',
  'authorization',
  'customer_name',
  'transaction_id',
  'transaction_date',
  'amount_krw',
  'purpose',
  'phone',
  'item',
]);
const DELIVERY_ERRORS = new Set(['action_blocked', 'malformed_action_result']);

function exactKeys(value, expected, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new TypeError(`${name} has unknown or missing keys`);
  }
}

function validateRoute(route) {
  exactKeys(route, ROUTE_KEYS, 'Slack route');
  if (
    !TEAM_ID.test(route.teamId)
    || !CHANNEL_ID.test(route.channelId)
    || !APP_ID.test(route.appId)
    || !USER_ID.test(route.botUserId)
    || !USER_ID.test(route.allowedUserId)
    || route.botUserId === route.allowedUserId
  ) {
    throw new TypeError('invalid Slack route');
  }
  return route;
}

function validateHandoffSource(source) {
  if (source === undefined) return undefined;
  exactKeys(source, HANDOFF_SOURCE_KEYS, 'Slack handoff source');
  if (!USER_ID.test(source.userId) || !BOT_ID.test(source.botId)) {
    throw new TypeError('invalid Slack handoff source');
  }
  return source;
}

function rejected(errorClass) {
  return Object.freeze({ accepted: false, errorClass });
}

function parseHeyBillyHandoff(text, botUserId) {
  const normalized = text.normalize('NFKC');
  const escapedBotUserId = botUserId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(
    `^\\*?<@${escapedBotUserId}>\\s+작업\\s*요청\\s*\\(홈택스\\s+CUA\\)\\*?\\n`
      + '\\[MAC_AGENT_HANDOFF_V1\\]\\n([\\s\\S]+)\\n\\[/MAC_AGENT_HANDOFF_V1\\]$',
    'u',
  );
  const match = pattern.exec(normalized);
  if (!match) return undefined;

  const values = Object.create(null);
  for (const line of match[1].split('\n')) {
    const separator = line.indexOf(':');
    if (separator < 1) return undefined;
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (!HANDOFF_KEYS.includes(key) || Object.hasOwn(values, key) || value.length === 0) {
      return undefined;
    }
    values[key] = value;
  }
  if (HANDOFF_KEYS.some(key => !Object.hasOwn(values, key))) return undefined;

  const amountKrw = Number(values.amount_krw);
  const date = new Date(`${values.transaction_date}T00:00:00.000Z`);
  if (
    !/^hb-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(values.handoff_id)
    || values.task_type !== HEYBILLY_TASK_TYPE
    || values.authorization !== 'owner_explicit'
    || !/^[가-힣A-Za-z0-9 .()_-]{2,40}$/u.test(values.customer_name)
    || !/^\d{6}-\d{3}$/.test(values.transaction_id)
    || !/^\d{4}-\d{2}-\d{2}$/.test(values.transaction_date)
    || Number.isNaN(date.getTime())
    || date.toISOString().slice(0, 10) !== values.transaction_date
    || !Number.isSafeInteger(amountKrw)
    || amountKrw < 1
    || amountKrw > 100_000_000
    || values.purpose !== 'income_deduction'
    || !/^01[016789]-\d{3,4}-\d{4}$/.test(values.phone)
    || Buffer.byteLength(values.item, 'utf8') > 180
    || /[\r\n]/u.test(values.item)
  ) {
    return undefined;
  }

  return Object.freeze({
    schemaVersion: HEYBILLY_TASK_SCHEMA_VERSION,
    action: HEYBILLY_TASK_TYPE,
    handoffId: values.handoff_id,
    authorization: values.authorization,
    customerName: values.customer_name,
    transactionId: values.transaction_id,
    transactionDate: values.transaction_date,
    amountKrw,
    purpose: values.purpose,
    phone: values.phone,
    item: values.item,
  });
}

export function adaptSlackAppMention({
  body,
  route,
  handoffSource,
  nowEpochSeconds = Math.floor(Date.now() / 1000),
} = {}) {
  validateRoute(route);
  validateHandoffSource(handoffSource);
  if (!Number.isInteger(nowEpochSeconds) || nowEpochSeconds < 1) {
    throw new TypeError('invalid current time');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return rejected('invalid_event');
  const event = body.event;
  const isConfiguredHandoff = Boolean(
    handoffSource
    && event
    && typeof event === 'object'
    && !Array.isArray(event)
    && event.user === handoffSource.userId
    && event.bot_id === handoffSource.botId
    && (event.subtype === undefined || event.subtype === 'bot_message')
  );
  if (
    body.type !== 'event_callback'
    || typeof body.team_id !== 'string'
    || typeof body.api_app_id !== 'string'
    || typeof body.event_id !== 'string'
    || !EVENT_ID.test(body.event_id)
    || !event
    || typeof event !== 'object'
    || Array.isArray(event)
    || !['app_mention', 'message'].includes(event.type)
    || typeof event.user !== 'string'
    || typeof event.channel !== 'string'
    || typeof event.text !== 'string'
    || Buffer.byteLength(event.text) > (isConfiguredHandoff ? MAX_HANDOFF_TEXT_BYTES : MAX_EVENT_TEXT_BYTES)
    || typeof event.ts !== 'string'
    || !THREAD_TS.test(event.ts)
    || (event.thread_ts !== undefined && (typeof event.thread_ts !== 'string' || !THREAD_TS.test(event.thread_ts)))
    || (!isConfiguredHandoff && event.bot_id !== undefined)
    || (!isConfiguredHandoff && event.subtype !== undefined)
  ) {
    return rejected('invalid_event');
  }
  if (
    body.team_id !== route.teamId
    || body.api_app_id !== route.appId
    || (body.context_team_id !== undefined && body.context_team_id !== route.teamId)
  ) {
    return rejected('unauthorized_identity');
  }
  if (event.channel !== route.channelId) return rejected('unauthorized_route');

  if (isConfiguredHandoff) {
    if (event.thread_ts === undefined) return rejected('invalid_event');
    if (!Number.isInteger(body.event_time) || body.event_time < 1) return rejected('invalid_event');
    const ageSeconds = nowEpochSeconds - body.event_time;
    if (ageSeconds > HANDOFF_MAX_AGE_SECONDS || ageSeconds < -HANDOFF_MAX_FUTURE_SKEW_SECONDS) {
      return rejected('stale_event');
    }
    const task = parseHeyBillyHandoff(event.text, route.botUserId);
    if (!task) return rejected('command_not_allowed');
    return Object.freeze({
      accepted: true,
      kind: 'heybilly_handoff',
      envelope: Object.freeze({
        schemaVersion: HEYBILLY_ENVELOPE_SCHEMA_VERSION,
        source: LIVE_SLACK_SOURCE,
        teamId: route.teamId,
        channelId: route.channelId,
        eventId: body.event_id,
        threadTs: event.thread_ts,
        action: HEYBILLY_ACTION,
        taskType: task.action,
        handoffId: task.handoffId,
      }),
      task,
    });
  }

  if (event.user !== route.allowedUserId) return rejected('unauthorized_actor');

  const normalizedText = event.text.normalize('NFKC').replace(/\s+/g, ' ').trim();
  const commandMatched = event.type === 'app_mention'
    ? normalizedText === `<@${route.botUserId}> 상태 확인`
    : normalizedText === '맥에이전트 상태 확인';
  if (!commandMatched) {
    return rejected('command_not_allowed');
  }

  return Object.freeze({
    accepted: true,
    envelope: Object.freeze({
      schemaVersion: ENVELOPE_SCHEMA_VERSION,
      source: LIVE_SLACK_SOURCE,
      teamId: route.teamId,
      channelId: route.channelId,
      eventId: body.event_id,
      threadTs: event.thread_ts ?? event.ts,
      action: ALLOWED_ACTION,
    }),
  });
}

function validateDeliveryPayload(payload) {
  exactKeys(payload, ['route', 'result'], 'Slack delivery payload');
  exactKeys(payload.route, ['teamId', 'channelId', 'threadTs'], 'Slack delivery route');
  if (
    !TEAM_ID.test(payload.route.teamId)
    || !CHANNEL_ID.test(payload.route.channelId)
    || !THREAD_TS.test(payload.route.threadTs)
  ) {
    throw new TypeError('invalid Slack delivery route');
  }
  const resultKeys = [
    'schemaVersion',
    'employeeId',
    'requestId',
    'action',
    'status',
    ...(payload.result?.errorClass === undefined ? [] : ['errorClass']),
  ];
  exactKeys(payload.result, resultKeys, 'Slack delivery result');
  if (
    payload.result.schemaVersion !== DELIVERY_SCHEMA_VERSION
    || payload.result.employeeId !== EMPLOYEE_ID
    || !REQUEST_ID.test(payload.result.requestId)
    || payload.result.action !== ALLOWED_ACTION
    || !['PASS', 'BLOCKED'].includes(payload.result.status)
  ) {
    throw new TypeError('invalid Slack delivery result');
  }
  if (payload.result.status === 'PASS' && payload.result.errorClass !== undefined) {
    throw new TypeError('PASS delivery cannot include errorClass');
  }
  if (payload.result.status === 'BLOCKED' && !DELIVERY_ERRORS.has(payload.result.errorClass)) {
    throw new TypeError('BLOCKED delivery requires a fixed errorClass');
  }
  return payload;
}

export function deterministicSlackMessageId(requestId) {
  if (!REQUEST_ID.test(requestId)) throw new TypeError('invalid requestId');
  const chars = createHash('sha256')
    .update(`village-local-cua-slack:${requestId}`)
    .digest('hex')
    .slice(0, 32)
    .split('');
  chars[12] = '5';
  chars[16] = ['8', '9', 'a', 'b'][Number.parseInt(chars[16], 16) % 4];
  const hex = chars.join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function formatSlackResult(result) {
  if (result.status === 'PASS') {
    return `:white_check_mark: 맥에이전트 준비 상태: 정상\n요청 ID: ${result.requestId}`;
  }
  return `:warning: 맥에이전트 준비 상태: 확인 필요\n오류 분류: ${result.errorClass}\n요청 ID: ${result.requestId}`;
}

function ambiguousDelivery() {
  return new Error('Slack delivery is ambiguous');
}

export function createSlackResultSink({ client, botUserId } = {}) {
  if (
    !client
    || typeof client !== 'object'
    || typeof client.chat?.postMessage !== 'function'
    || typeof client.conversations?.replies !== 'function'
  ) {
    throw new TypeError('invalid Slack client');
  }
  if (!USER_ID.test(botUserId)) throw new TypeError('invalid Slack bot user');

  return async payload => {
    const validated = validateDeliveryPayload(payload);
    const text = formatSlackResult(validated.result);
    const postPayload = {
      channel: validated.route.channelId,
      thread_ts: validated.route.threadTs,
      text,
      client_msg_id: deterministicSlackMessageId(validated.result.requestId),
      reply_broadcast: false,
      unfurl_links: false,
      unfurl_media: false,
    };

    let posted;
    try {
      posted = await client.chat.postMessage(postPayload);
    } catch {
      throw ambiguousDelivery();
    }
    if (posted?.ok === false) return Object.freeze({ delivered: false });
    if (
      posted?.ok !== true
      || posted.channel !== validated.route.channelId
      || typeof posted.ts !== 'string'
      || !THREAD_TS.test(posted.ts)
    ) {
      throw ambiguousDelivery();
    }

    let thread;
    try {
      thread = await client.conversations.replies({
        channel: validated.route.channelId,
        ts: validated.route.threadTs,
        oldest: posted.ts,
        inclusive: true,
        limit: 1,
      });
    } catch {
      throw ambiguousDelivery();
    }
    if (thread?.ok !== true || !Array.isArray(thread.messages)) throw ambiguousDelivery();
    const confirmed = thread.messages.some(message => (
      message
      && message.type === 'message'
      && message.user === botUserId
      && message.text === text
      && message.ts === posted.ts
      && message.thread_ts === validated.route.threadTs
    ));
    if (!confirmed) throw ambiguousDelivery();
    return Object.freeze({ delivered: true });
  };
}

function deterministicStudioMacMessageId(requestId, phase) {
  const chars = createHash('sha256')
    .update(`village-studio-mac:${requestId}:${phase}`)
    .digest('hex')
    .slice(0, 32)
    .split('');
  chars[12] = '5';
  chars[16] = ['8', '9', 'a', 'b'][Number.parseInt(chars[16], 16) % 4];
  const hex = chars.join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function validateStudioMacStatus(payload) {
  const keys = ['schemaVersion', 'phase', 'requestId', 'route', ...(payload?.phase === 'FINAL' ? ['result'] : [])];
  exactKeys(payload, keys, 'Studio Mac status');
  exactKeys(payload.route, ['teamId', 'channelId', 'threadTs'], 'Studio Mac status route');
  if (
    payload.schemaVersion !== 'gate2-studio-mac-status/v1'
    || !['ACK', 'FINAL'].includes(payload.phase)
    || !REQUEST_ID.test(payload.requestId)
    || !TEAM_ID.test(payload.route.teamId)
    || !CHANNEL_ID.test(payload.route.channelId)
    || !THREAD_TS.test(payload.route.threadTs)
  ) throw new TypeError('invalid Studio Mac status');
  if (payload.phase === 'FINAL') {
    if (payload.result?.status === 'COMPLETED') {
      exactKeys(payload.result, ['status', 'resultCode', 'authorizationNumber'], 'Studio Mac final result');
      if (
        !['cash_receipt_issued', 'cash_receipt_already_issued'].includes(payload.result.resultCode)
        || typeof payload.result.authorizationNumber !== 'string'
        || !/^[A-Za-z0-9-]{6,32}$/.test(payload.result.authorizationNumber)
      ) throw new TypeError('invalid Studio Mac final result');
    } else if (payload.result?.status === 'NEEDS_USER') {
      exactKeys(payload.result, ['status', 'resultCode', 'need'], 'Studio Mac final result');
      if (
        payload.result.resultCode !== 'user_action_required'
        || ![
          'studio_mac_locked',
          'certificate_autofill_unavailable',
          'captcha_required',
          'hometax_reauthentication_required',
        ].includes(payload.result.need)
      ) throw new TypeError('invalid Studio Mac final result');
    } else if (payload.result?.status === 'BLOCKED') {
      exactKeys(payload.result, ['status', 'resultCode', 'errorClass'], 'Studio Mac final result');
      if (
        payload.result.resultCode !== 'execution_blocked'
        || !['command_failed', 'timeout', 'malformed_result', 'cleanup_incomplete', 'outcome_unknown'].includes(payload.result.errorClass)
      ) throw new TypeError('invalid Studio Mac final result');
    } else {
      throw new TypeError('invalid Studio Mac final result');
    }
  }
  return payload;
}

function formatStudioMacStatus(status) {
  if (status.phase === 'ACK') {
    return `🟡 스튜디오맥에서 접수했습니다\n요청 ID: ${status.requestId}`;
  }
  if (status.result.status === 'COMPLETED') {
    const title = status.result.resultCode === 'cash_receipt_issued'
      ? '✅ 스튜디오맥 작업 완료\n현금영수증 승인번호'
      : '✅ 스튜디오맥 중복 확인 완료\n기존 현금영수증 승인번호';
    return `${title}: ${status.result.authorizationNumber}\n요청 ID: ${status.requestId}`;
  }
  if (status.result.status === 'NEEDS_USER') {
    const needs = {
      studio_mac_locked: '스튜디오맥 잠금 해제',
      certificate_autofill_unavailable: '공동인증서 비밀번호 자동완성 확인',
      captcha_required: 'CAPTCHA 확인',
      hometax_reauthentication_required: '홈택스 재로그인',
    };
    return `⚠️ 스튜디오맥에서 사용자 확인이 필요합니다\n필요 조치: ${needs[status.result.need]}\n요청 ID: ${status.requestId}`;
  }
  return `⚠️ 스튜디오맥 작업 결과를 확인해야 합니다\n오류 분류: ${status.result.errorClass}\n요청 ID: ${status.requestId}`;
}

export function createStudioMacStatusSink({ client, botUserId } = {}) {
  if (
    !client
    || typeof client !== 'object'
    || typeof client.chat?.postMessage !== 'function'
    || typeof client.conversations?.replies !== 'function'
  ) throw new TypeError('invalid Slack client');
  if (!USER_ID.test(botUserId)) throw new TypeError('invalid Slack bot user');

  return async payload => {
    const status = validateStudioMacStatus(payload);
    const text = formatStudioMacStatus(status);
    let posted;
    try {
      posted = await client.chat.postMessage({
        channel: status.route.channelId,
        thread_ts: status.route.threadTs,
        text,
        client_msg_id: deterministicStudioMacMessageId(status.requestId, status.phase),
        reply_broadcast: false,
        unfurl_links: false,
        unfurl_media: false,
      });
    } catch {
      throw ambiguousDelivery();
    }
    if (posted?.ok === false) return Object.freeze({ delivered: false });
    if (
      posted?.ok !== true
      || posted.channel !== status.route.channelId
      || typeof posted.ts !== 'string'
      || !THREAD_TS.test(posted.ts)
    ) throw ambiguousDelivery();

    let thread;
    try {
      thread = await client.conversations.replies({
        channel: status.route.channelId,
        ts: status.route.threadTs,
        oldest: posted.ts,
        inclusive: true,
        limit: 1,
      });
    } catch {
      throw ambiguousDelivery();
    }
    if (thread?.ok !== true || !Array.isArray(thread.messages)) throw ambiguousDelivery();
    const confirmed = thread.messages.some(message => (
      message
      && message.type === 'message'
      && message.user === botUserId
      && message.text === text
      && message.ts === posted.ts
      && message.thread_ts === status.route.threadTs
    ));
    if (!confirmed) throw ambiguousDelivery();
    return Object.freeze({ delivered: true });
  };
}

function connectorRejection(errorClass) {
  return Object.freeze({
    schemaVersion: 'gate3-slack-decision/v1',
    status: 'REJECTED',
    employeeId: EMPLOYEE_ID,
    action: ALLOWED_ACTION,
    errorClass,
  });
}

export async function handleSlackAppMention({
  body,
  route,
  handoffSource,
  ledgerDir,
  client,
  actionRunner,
  handoffActionRunner,
  allowTestOverrides = false,
  now,
  eventNowEpochSeconds,
  deliveryTimeoutMs,
} = {}) {
  const decision = adaptSlackAppMention({
    body,
    route,
    handoffSource,
    ...(eventNowEpochSeconds === undefined ? {} : { nowEpochSeconds: eventNowEpochSeconds }),
  });
  if (!decision.accepted) return connectorRejection(decision.errorClass);

  if (decision.kind === 'heybilly_handoff') {
    return processHeyBillyHandoff({
      envelope: decision.envelope,
      task: decision.task,
      allowedRoute: { teamId: route.teamId, channelId: route.channelId },
      ledgerDir,
      statusSink: createStudioMacStatusSink({ client, botUserId: route.botUserId }),
      ...(handoffActionRunner === undefined ? {} : { actionRunner: handoffActionRunner }),
      allowTestOverrides,
      ...(now === undefined ? {} : { now }),
      ...(deliveryTimeoutMs === undefined ? {} : { deliveryTimeoutMs }),
    });
  }

  return processSocketSlackEnvelope({
    envelope: decision.envelope,
    allowedRoute: { teamId: route.teamId, channelId: route.channelId },
    ledgerDir,
    resultSink: createSlackResultSink({ client, botUserId: route.botUserId }),
    ...(actionRunner === undefined ? {} : { actionRunner }),
    allowTestOverrides,
    ...(now === undefined ? {} : { now }),
    ...(deliveryTimeoutMs === undefined ? {} : { deliveryTimeoutMs }),
  });
}
