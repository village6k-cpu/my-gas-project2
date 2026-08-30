import crypto from 'node:crypto';
import { decodeWorkActionValue } from '../../../tools/work-orchestrator-v2/work-items.mjs';
import { decodeWorkActionContext } from '../../../tools/work-orchestrator-v2/work-actions.mjs';

const VALID_STATUSES = new Set(['open', 'in_progress', 'waiting_customer', 'waiting_internal', 'done', 'dismissed']);
const ACTIVE_WORK_STATES = new Set(['open', 'in_progress', 'snoozed']);
const SLACK_USER_ID = /^[UW][A-Z0-9]{2,79}$/;
const UTC_MS = /^(?!0000)[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/;
const V2_ACTION_TYPES = Object.freeze({
  village_work_v2_progress: 'progress',
  village_work_v2_snooze_3h: 'snooze',
  village_work_v2_snooze_evening: 'snooze',
  village_work_v2_snooze_tomorrow: 'snooze',
  village_work_v2_ack_p0: 'ack_p0',
  village_work_v2_request_resolve: 'request_resolve',
  village_work_v2_dismiss: 'dismiss'
});
const CUSTOM_SNOOZE_ACTION_ID = 'village_work_v2_snooze_custom';
const CUSTOM_SNOOZE_CALLBACK_ID = 'village_work_v2_snooze_custom_submit';
const CUSTOM_SNOOZE_ERROR = '입력값을 처리할 수 없습니다. 최신 다이제스트에서 다시 시도해 주세요.';

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value, allowed) {
  if (!isRecord(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...allowed].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function sameJson(left, right) {
  if (left === right) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right)
      && left.length === right.length
      && left.every((value, index) => sameJson(value, right[index]));
  }
  if (!isRecord(left) || !isRecord(right)) return false;
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key, index) => key === rightKeys[index] && sameJson(left[key], right[key]));
}

function canonicalNow(value = new Date()) {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error('invalid work action request');
  return date.toISOString();
}

function canonicalFutureTimestamp(value, now) {
  if (typeof value !== 'string' || !UTC_MS.test(value)) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime()) || date.toISOString() !== value || date.getTime() <= Date.parse(now)) return null;
  return value;
}

function requestedBy(payload) {
  const id = payload?.user?.id;
  if (typeof id !== 'string' || !SLACK_USER_ID.test(id)) throw new Error('invalid work action request');
  return id;
}

function json(res, status, payload) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(payload));
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 1024 * 1024) reject(new Error('request body too large'));
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

export function verifySlackSignature({ rawBody = '', timestamp = '', signature = '', signingSecret = '', nowMs = Date.now() } = {}) {
  if (!signingSecret) return false;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return false;
  if (Math.abs(nowMs / 1000 - ts) > 60 * 5) return false;
  const base = `v0:${timestamp}:${rawBody}`;
  const digest = `v0=${crypto.createHmac('sha256', signingSecret).update(base).digest('hex')}`;
  const expected = Buffer.from(digest);
  const actual = Buffer.from(String(signature || ''));
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

export function parseSlackPayload(rawBody = '') {
  const params = new URLSearchParams(rawBody);
  const payload = params.get('payload');
  if (!payload) throw new Error('missing slack payload');
  return JSON.parse(payload);
}

async function supabaseFetch(pathAndQuery, init = {}) {
  const url = requireEnv('SUPABASE_URL').replace(/\/$/, '');
  const key = requireEnv('SUPABASE_SERVICE_ROLE_KEY');
  const response = await fetch(`${url}/rest/v1/${pathAndQuery}`, {
    ...init,
    headers: {
      apikey: key,
      authorization: `Bearer ${key}`,
      'content-type': 'application/json',
      ...(init.headers || {})
    }
  });
  const text = await response.text();
  let data = null;
  if (text) {
    try { data = JSON.parse(text); } catch { data = text; }
  }
  if (!response.ok) {
    const err = new Error(`Supabase ${response.status}`);
    err.detail = data;
    throw err;
  }
  return data;
}

export function parseV2ActionIntent(action = {}, now = new Date()) {
  try {
    if (!isRecord(action) || typeof action.action_id !== 'string' || typeof action.value !== 'string') {
      throw new Error('invalid');
    }
    const changedAt = canonicalNow(now);
    if (action.action_id === CUSTOM_SNOOZE_ACTION_ID) {
      const context = decodeWorkActionContext(action.value);
      return { kind: 'custom_snooze', id: context.id, expectedVersion: context.version, context: action.value };
    }
    const expectedType = V2_ACTION_TYPES[action.action_id];
    if (!expectedType) throw new Error('invalid');
    const decoded = decodeWorkActionValue(action.value);
    if (decoded.action.type !== expectedType) throw new Error('invalid');
    if (expectedType === 'snooze' && canonicalFutureTimestamp(decoded.action.snoozedUntil, changedAt) === null) {
      throw new Error('invalid');
    }
    return {
      kind: 'request', id: decoded.id, expectedVersion: decoded.version, action: decoded.action
    };
  } catch {
    throw new Error('invalid work action request');
  }
}

function validateRequestedAction(input) {
  if (!isRecord(input) || typeof input.id !== 'string'
    || !Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1
    || typeof input.requestedBy !== 'string' || !SLACK_USER_ID.test(input.requestedBy)) {
    throw new Error('work action request failed');
  }
  let decoded;
  try {
    const value = Buffer.from(JSON.stringify({
      id: input.id,
      version: input.expectedVersion,
      action: input.action
    }), 'utf8').toString('base64url');
    decoded = decodeWorkActionValue(value);
  } catch {
    throw new Error('work action request failed');
  }
  return {
    id: decoded.id,
    expectedVersion: decoded.version,
    action: decoded.action,
    requestedBy: input.requestedBy
  };
}

function validateWorkActionRpcResponse(data, input) {
  if (!exactKeys(data, ['applied', 'row']) || typeof data.applied !== 'boolean') {
    throw new Error('work action request failed');
  }
  if (!data.applied) {
    if (data.row !== null) throw new Error('work action request failed');
    return { applied: false };
  }
  const row = data.row;
  const pending = row?.pending_action;
  if (!isRecord(row) || row.id !== input.id || row.version !== input.expectedVersion + 1
    || !ACTIVE_WORK_STATES.has(row.state)
    || !exactKeys(pending, ['action', 'expected_version', 'requested_at', 'requested_by', 'status', 'type'])
    || pending.type !== input.action.type || pending.status !== 'pending'
    || pending.expected_version !== input.expectedVersion || pending.requested_by !== input.requestedBy
    || !sameJson(pending.action, input.action)
    || !Number.isFinite(Date.parse(pending.requested_at))) {
    throw new Error('work action request failed');
  }
  return { applied: true };
}

export async function requestWorkItemActionV2(input, {
  env = process.env,
  fetchImpl = fetch
} = {}) {
  try {
    const normalized = validateRequestedAction(input);
    const baseUrl = String(env.SUPABASE_URL || '').trim().replace(/\/$/, '');
    const key = String(env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
    if (!baseUrl || !key || typeof fetchImpl !== 'function') throw new Error('invalid');
    const response = await fetchImpl(`${baseUrl}/rest/v1/rpc/request_work_item_action_v2`, {
      method: 'POST',
      headers: {
        apikey: key,
        authorization: `Bearer ${key}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        p_id: normalized.id,
        p_expected_version: normalized.expectedVersion,
        p_action: normalized.action,
        p_requested_by: normalized.requestedBy
      })
    });
    const text = await response.text();
    if (!response.ok) throw new Error('invalid');
    return validateWorkActionRpcResponse(JSON.parse(text), normalized);
  } catch {
    throw new Error('work action request failed');
  }
}

function tableName() {
  return encodeURIComponent(process.env.SUPABASE_FOLLOW_UP_TABLE || 'ai_follow_up_items');
}

async function fetchFollowUp(id) {
  const rows = await supabaseFetch(`${tableName()}?select=*&id=eq.${encodeURIComponent(id)}&limit=1`);
  return Array.isArray(rows) ? rows[0] : null;
}

async function patchFollowUp(id, patch) {
  const rows = await supabaseFetch(`${tableName()}?id=eq.${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { prefer: 'return=representation' },
    body: JSON.stringify(patch)
  });
  return Array.isArray(rows) ? rows[0] : rows;
}

async function mergeFollowUpPayload(id, payloadPatch = {}, extraPatch = {}) {
  const current = await fetchFollowUp(id);
  if (!current) return null;
  const currentPayload = current.payload && typeof current.payload === 'object' ? current.payload : {};
  return patchFollowUp(id, {
    ...extraPatch,
    payload: {
      ...currentPayload,
      ...payloadPatch
    }
  });
}

export function parseActionIntent(action = {}) {
  const actionId = String(action.action_id || '');
  const followUpId = String(action.value || '').trim();
  if (!followUpId) return { kind: 'invalid', reason: 'missing_follow_up_id' };
  if (actionId === 'village_followup_send') return { kind: 'send', followUpId };
  if (actionId === 'village_followup_edit_send') return { kind: 'edit_send', followUpId };
  const statusMatch = actionId.match(/^village_followup_status_(.+)$/);
  if (statusMatch) {
    const status = statusMatch[1];
    if (VALID_STATUSES.has(status)) return { kind: 'status', followUpId, status };
  }
  return { kind: 'invalid', followUpId, reason: `unsupported action ${actionId}` };
}

export function buildEditSendModal(item = {}) {
  const initial = String(item.payload?.slack_draft_override || item.slack_draft_override || item.suggested_reply_draft || '').slice(0, 2900);
  return {
    type: 'modal',
    callback_id: 'village_followup_edit_send_submit',
    private_metadata: String(item.id || ''),
    title: { type: 'plain_text', text: '초안 수정' },
    submit: { type: 'plain_text', text: '전송 요청' },
    close: { type: 'plain_text', text: '취소' },
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*${String(item.customer_name || '고객명 미확인')}* / ${String(item.title || '후속처리')}`
        }
      },
      {
        type: 'input',
        block_id: 'draft_block',
        label: { type: 'plain_text', text: '카카오 전송 문구' },
        element: {
          type: 'plain_text_input',
          action_id: 'draft_text',
          multiline: true,
          initial_value: initial || '확인 후 바로 안내드리겠습니다.'
        }
      }
    ]
  };
}

export function buildWorkSnoozeModal(context) {
  decodeWorkActionContext(context);
  return {
    type: 'modal',
    callback_id: CUSTOM_SNOOZE_CALLBACK_ID,
    private_metadata: context,
    title: { type: 'plain_text', text: '날짜 지정 미루기' },
    submit: { type: 'plain_text', text: '미루기' },
    close: { type: 'plain_text', text: '취소' },
    blocks: [{
      type: 'input',
      block_id: 'snooze_until_block',
      label: { type: 'plain_text', text: 'UTC 일시' },
      hint: { type: 'plain_text', text: '예: 2026-08-31T00:00:00.000Z' },
      element: {
        type: 'plain_text_input',
        action_id: 'snoozed_until_iso',
        placeholder: { type: 'plain_text', text: 'YYYY-MM-DDTHH:mm:ss.sssZ' },
        max_length: 40
      }
    }]
  };
}

async function slackApi(method, payload = {}) {
  const token = requireEnv('SLACK_BOT_TOKEN');
  const response = await fetch(`https://slack.com/api/${method}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json; charset=utf-8'
    },
    body: JSON.stringify(payload)
  });
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!response.ok || data?.ok === false) throw new Error(`Slack ${method} failed: ${data?.error || text}`);
  return data;
}

async function markSendPending(followUpId, draftOverride = null) {
  const payloadPatch = {
    slack_action: {
      type: 'send',
      status: 'pending',
      requested_at: new Date().toISOString(),
      error: null
    }
  };
  if (draftOverride !== null) payloadPatch.slack_draft_override = draftOverride;
  return mergeFollowUpPayload(followUpId, payloadPatch, { status: 'in_progress' });
}

function viewSubmissionDraft(payload = {}) {
  const values = payload.view?.state?.values || {};
  for (const block of Object.values(values)) {
    if (block?.draft_text?.value !== undefined) return String(block.draft_text.value || '').trim();
  }
  return '';
}

async function handleBlockAction(payload) {
  const action = Array.isArray(payload.actions) ? payload.actions[0] : null;
  if (String(action?.action_id || '').startsWith('village_work_v2_')) {
    return handleV2BlockAction(payload);
  }
  const intent = parseActionIntent(action);
  if (intent.kind === 'invalid') return { text: `처리할 수 없는 버튼입니다: ${intent.reason}` };

  if (intent.kind === 'status') {
    await patchFollowUp(intent.followUpId, {
      status: intent.status,
      completed_at: intent.status === 'open' ? null : undefined
    });
    return { text: `상태를 ${intent.status}로 변경했습니다.` };
  }

  if (intent.kind === 'send') {
    await markSendPending(intent.followUpId);
    return { text: '카카오 전송 요청을 접수했습니다. 로컬 브릿지가 처리합니다.' };
  }

  const item = await fetchFollowUp(intent.followUpId);
  if (!item) return { text: '후속처리 항목을 찾지 못했습니다.' };
  await slackApi('views.open', {
    trigger_id: payload.trigger_id,
    view: buildEditSendModal(item)
  });
  return { text: '수정 모달을 열었습니다.' };
}

export async function handleV2BlockAction(payload, {
  now = new Date(),
  requestAction = requestWorkItemActionV2,
  openView = (viewPayload) => slackApi('views.open', viewPayload)
} = {}) {
  try {
    if (!Array.isArray(payload?.actions) || payload.actions.length !== 1) throw new Error('invalid');
    const changedAt = canonicalNow(now);
    const actor = requestedBy(payload);
    const intent = parseV2ActionIntent(payload.actions[0], changedAt);
    if (intent.kind === 'custom_snooze') {
      const triggerId = payload.trigger_id;
      if (typeof triggerId !== 'string' || !triggerId || triggerId.length > 200) throw new Error('invalid');
      await openView({ trigger_id: triggerId, view: buildWorkSnoozeModal(intent.context) });
      return { text: '날짜 지정 미루기 창을 열었습니다.' };
    }
    const result = await requestAction({
      id: intent.id,
      expectedVersion: intent.expectedVersion,
      action: intent.action,
      requestedBy: actor,
      now: changedAt
    });
    if (!exactKeys(result, ['applied']) || typeof result.applied !== 'boolean') throw new Error('invalid');
    if (!result.applied) {
      return {
        response_type: 'ephemeral',
        replace_original: false,
        text: '이미 변경된 항목입니다. 최신 다이제스트에서 다시 시도해 주세요.'
      };
    }
    return { text: '요청을 접수했습니다. 로컬 처리 결과 전까지 완료로 간주하지 않습니다.' };
  } catch {
    throw new Error('invalid work action request');
  }
}

async function handleViewSubmission(payload) {
  if (payload?.view?.callback_id === CUSTOM_SNOOZE_CALLBACK_ID) {
    return handleV2ViewSubmission(payload);
  }
  const followUpId = String(payload.view?.private_metadata || '').trim();
  const draft = viewSubmissionDraft(payload);
  if (!followUpId || !draft) {
    return { response_action: 'errors', errors: { draft_block: '전송 문구를 입력하세요.' } };
  }
  await markSendPending(followUpId, draft);
  return { response_action: 'clear' };
}

function customSnoozeError() {
  return { response_action: 'errors', errors: { snooze_until_block: CUSTOM_SNOOZE_ERROR } };
}

export async function handleV2ViewSubmission(payload, {
  now = new Date(),
  requestAction = requestWorkItemActionV2
} = {}) {
  try {
    if (payload?.view?.callback_id !== CUSTOM_SNOOZE_CALLBACK_ID) throw new Error('invalid');
    const changedAt = canonicalNow(now);
    const actor = requestedBy(payload);
    const context = decodeWorkActionContext(payload.view.private_metadata);
    const values = payload.view?.state?.values;
    if (!exactKeys(values, ['snooze_until_block'])) throw new Error('invalid');
    const block = values.snooze_until_block;
    if (!exactKeys(block, ['snoozed_until_iso'])) throw new Error('invalid');
    const input = block.snoozed_until_iso;
    if (!exactKeys(input, ['type', 'value']) || input.type !== 'plain_text_input') throw new Error('invalid');
    const snoozedUntil = canonicalFutureTimestamp(input.value, changedAt);
    if (snoozedUntil === null) throw new Error('invalid');
    const result = await requestAction({
      id: context.id,
      expectedVersion: context.version,
      action: { type: 'snooze', snoozedUntil },
      requestedBy: actor,
      now: changedAt
    });
    if (!exactKeys(result, ['applied']) || result.applied !== true) throw new Error('invalid');
    return { response_action: 'clear' };
  } catch {
    return customSnoozeError();
  }
}

export default async function handler(req, res) {
  let v2Interaction = false;
  try {
    if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' });
    const rawBody = await readRawBody(req);
    const ok = verifySlackSignature({
      rawBody,
      timestamp: req.headers['x-slack-request-timestamp'],
      signature: req.headers['x-slack-signature'],
      signingSecret: requireEnv('SLACK_SIGNING_SECRET')
    });
    if (!ok) return json(res, 401, { error: 'invalid slack signature' });

    const payload = parseSlackPayload(rawBody);
    v2Interaction = payload?.view?.callback_id === CUSTOM_SNOOZE_CALLBACK_ID
      || (Array.isArray(payload?.actions)
        && payload.actions.some((action) => String(action?.action_id || '').startsWith('village_work_v2_')));
    if (payload.type === 'view_submission') return json(res, 200, await handleViewSubmission(payload));
    if (payload.type === 'block_actions') return json(res, 200, await handleBlockAction(payload));
    return json(res, 200, { text: '지원하지 않는 Slack interaction입니다.' });
  } catch (error) {
    if (v2Interaction) return json(res, 500, { error: 'work action request failed' });
    return json(res, 500, { error: error.message, detail: error.detail || null });
  }
}
