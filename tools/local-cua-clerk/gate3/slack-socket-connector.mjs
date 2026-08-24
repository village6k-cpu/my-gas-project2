import { createHash } from 'node:crypto';
import {
  ALLOWED_ACTION,
  DELIVERY_SCHEMA_VERSION,
  EMPLOYEE_ID,
  ENVELOPE_SCHEMA_VERSION,
  processSocketSlackEnvelope,
  SOCKET_SLACK_SOURCE,
} from '../gate2/slack-intake-shell.mjs';

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

function rejected(errorClass) {
  return Object.freeze({ accepted: false, errorClass });
}

export function adaptSlackAppMention({ body, route } = {}) {
  validateRoute(route);
  if (!body || typeof body !== 'object' || Array.isArray(body)) return rejected('invalid_event');
  const event = body.event;
  if (
    body.type !== 'event_callback'
    || typeof body.team_id !== 'string'
    || typeof body.api_app_id !== 'string'
    || typeof body.event_id !== 'string'
    || !EVENT_ID.test(body.event_id)
    || !event
    || typeof event !== 'object'
    || Array.isArray(event)
    || event.type !== 'app_mention'
    || typeof event.user !== 'string'
    || typeof event.channel !== 'string'
    || typeof event.text !== 'string'
    || Buffer.byteLength(event.text) > MAX_EVENT_TEXT_BYTES
    || typeof event.ts !== 'string'
    || !THREAD_TS.test(event.ts)
    || (event.thread_ts !== undefined && (typeof event.thread_ts !== 'string' || !THREAD_TS.test(event.thread_ts)))
    || event.bot_id !== undefined
    || event.subtype !== undefined
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
  if (event.user !== route.allowedUserId) return rejected('unauthorized_actor');

  const normalizedText = event.text.normalize('NFKC').replace(/\s+/g, ' ').trim();
  if (normalizedText !== `<@${route.botUserId}> 상태 확인`) {
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
    return `✅ 세무·서류 담당 준비 상태: 정상\n요청 ID: ${result.requestId}`;
  }
  return `⚠️ 세무·서류 담당 준비 상태: 확인 필요\n오류 분류: ${result.errorClass}\n요청 ID: ${result.requestId}`;
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
  ledgerDir,
  client,
  actionRunner,
  allowTestOverrides = false,
  now,
  deliveryTimeoutMs,
} = {}) {
  const decision = adaptSlackAppMention({ body, route });
  if (!decision.accepted) return connectorRejection(decision.errorClass);

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
