import { assertNotificationTransition } from './contracts.mjs';

const REQUEST_ERROR_PREFIX = 'Work Orchestrator Supabase request failed';
const MAX_EVENT_KEY_LENGTH = 500;
const MAX_DELIVERY_ATTEMPTS = 3;
const DELIVERY_FAILURE_CODES = new Set(['post_rejected', 'delivery_unconfirmed']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const WORK_PRIORITIES = new Set(['p0', 'urgent', 'normal', 'low']);
const AUTOMATION_STATES = new Set(['not_attempted', 'running', 'succeeded', 'failed', 'needs_human']);
const WORK_TYPES = new Set([
  'human_review', 'reply_needed', 'quote_send', 'tax_invoice', 'schedule_check',
  'reservation_review', 'price_review', 'payment_check', 'contract_document',
  'return_extension', 'damage_repair', 'sheet_duplicate_check',
  'reservation_review_timeout', 'automation_error_review'
]);
const WORK_PAYLOAD_TEXT_LIMITS = Object.freeze({
  action_family: 100,
  business_key: 500,
  business_object_key: 500,
  follow_up_route: 100,
  follow_up_task_key: 500,
  alert_level: 20,
  alert_reason: 1000,
  blocking_reason: 1000,
  due_hint: 100,
  recommended_action: 1200
});
const WORK_ACTIONS = new Set(['progress', 'snooze', 'ack_p0', 'request_resolve', 'dismiss']);
const DIGEST_INCLUSION_REASONS = new Set(['p0', 'overdue', 'urgent', 'carry_over', 'actionable', 'daily_reminder']);
const DIGEST_FAILURE_CODES = new Set(['digest_build_failed', 'digest_delivery_failed', 'delivery_unconfirmed']);
const DIGEST_CLEANUP_FAILURE_CODES = new Set(['cant_delete_message', 'rate_limited', 'cleanup_unconfirmed', 'slack_api_error']);
const WORK_STATES = new Set(['open', 'in_progress', 'snoozed', 'resolved', 'dismissed']);
const ACTIVE_WORK_STATES = new Set(['open', 'in_progress', 'snoozed']);
const DIGEST_STATES = new Set(['building', 'delivering', 'delivered', 'failed', 'replaced']);
const SLACK_MESSAGE_TS = /^[0-9]{1,20}\.[0-9]{1,20}$/;
const ACTIONABLE_WORK_SELECT = [
  'id', 'work_key', 'room_key', 'title', 'summary', 'work_type', 'priority', 'state',
  'owner_id', 'actionable_at', 'due_at', 'snoozed_until', 'first_opened_at',
  'last_activity_at', 'digest_inclusion_count', 'consecutive_unhandled_digests',
  'last_digest_at', 'next_reminder_at', 'version', 'payload'
].join(',');

function invalidInput() {
  return new Error('Work Orchestrator Supabase input is invalid');
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value, allowed) {
  if (!isRecord(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...allowed].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function sameJsonValue(left, right) {
  if (left === right) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right)
      && left.length === right.length
      && left.every((value, index) => sameJsonValue(value, right[index]));
  }
  if (!isRecord(left) || !isRecord(right)) return false;
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key, index) => key === rightKeys[index]
      && sameJsonValue(left[key], right[key]));
}

function hasCanonicalP0Acknowledgement(payload, cutoff) {
  const value = isRecord(payload) ? payload.p0_acknowledged_at : undefined;
  if (typeof value !== 'string' || !value || value.length > 40) return false;
  const parsed = new Date(value);
  const cutoffDate = new Date(cutoff);
  return !Number.isNaN(parsed.getTime())
    && parsed.toISOString() === value
    && !Number.isNaN(cutoffDate.getTime())
    && parsed.getTime() <= cutoffDate.getTime();
}

function exactText(value, maxLength) {
  if (typeof value !== 'string' || !value || value !== value.trim() || value.length > maxLength) {
    throw invalidInput();
  }
  return value;
}

function uuid(value) {
  const normalized = exactText(value, 36);
  if (!UUID.test(normalized)) throw invalidInput();
  return normalized.toLowerCase();
}

function isoTimestamp(value, { nullable = false } = {}) {
  if ((value === null || value === undefined) && nullable) return null;
  const normalized = exactText(value, 40);
  const date = new Date(normalized);
  if (Number.isNaN(date.getTime()) || date.toISOString() !== normalized) throw invalidInput();
  return normalized;
}

function positiveVersion(value) {
  if (!Number.isSafeInteger(value) || value < 1) throw invalidInput();
  return value;
}

function normalizeWorkPayload(payload) {
  if (!isRecord(payload) || payload.requires_human_action !== true) throw invalidInput();
  const allowed = new Set(['requires_human_action', ...Object.keys(WORK_PAYLOAD_TEXT_LIMITS)]);
  if (Object.keys(payload).some((key) => !allowed.has(key))) throw invalidInput();
  const result = { requires_human_action: true };
  for (const [key, limit] of Object.entries(WORK_PAYLOAD_TEXT_LIMITS)) {
    if (payload[key] === undefined) continue;
    result[key] = exactText(payload[key], limit);
  }
  return result;
}

function normalizeWorkCandidate(input) {
  if (!isRecord(input)) throw invalidInput();
  const sourceEventKeys = input.source_event_keys;
  if (!Array.isArray(sourceEventKeys) || sourceEventKeys.length > 100) throw invalidInput();
  const normalizedSourceKeys = sourceEventKeys.map((value) => exactText(value, 500));
  if (new Set(normalizedSourceKeys).size !== normalizedSourceKeys.length) throw invalidInput();
  const priority = exactText(input.priority, 20);
  const workType = exactText(input.work_type, 100);
  const automationState = exactText(input.automation_state, 50);
  if (!WORK_PRIORITIES.has(priority) || !WORK_TYPES.has(workType) || !AUTOMATION_STATES.has(automationState)) {
    throw invalidInput();
  }
  if (input.state !== 'open') throw invalidInput();

  if (typeof input.summary !== 'string' || input.summary.length > 2000) throw invalidInput();
  return {
    work_key: exactText(input.work_key, 500),
    source_event_keys: normalizedSourceKeys,
    room_key: exactText(input.room_key, 500),
    title: exactText(input.title, 300),
    summary: input.summary,
    work_type: workType,
    priority,
    state: 'open',
    owner_id: input.owner_id === null || input.owner_id === undefined ? null : exactText(input.owner_id, 200),
    actionable_at: isoTimestamp(input.actionable_at),
    due_at: isoTimestamp(input.due_at, { nullable: true }),
    snoozed_until: isoTimestamp(input.snoozed_until, { nullable: true }),
    first_opened_at: isoTimestamp(input.first_opened_at),
    last_activity_at: isoTimestamp(input.last_activity_at),
    automation_state: automationState,
    payload: normalizeWorkPayload(input.payload)
  };
}

function normalizeWorkAction(input, now = new Date()) {
  if (!isRecord(input)) throw invalidInput();
  const type = exactText(input.type, 30);
  if (!WORK_ACTIONS.has(type)) throw invalidInput();
  const expected = type === 'snooze' ? ['snoozedUntil', 'type'] : ['type'];
  if (!exactKeys(input, expected)) throw invalidInput();
  if (type === 'snooze') {
    const snoozedUntil = isoTimestamp(input.snoozedUntil);
    if (Date.parse(snoozedUntil) <= now.getTime()) throw invalidInput();
    return { type, snoozedUntil };
  }
  return { type };
}

function normalizeDigestSnapshot(input) {
  if (!Array.isArray(input) || input.length > 1000) throw invalidInput();
  const seen = new Set();
  return input.map((entry) => {
    if (!exactKeys(entry, ['id', 'version', 'inclusionReason', 'priority'])) throw invalidInput();
    const id = uuid(entry.id);
    if (seen.has(id)) throw invalidInput();
    seen.add(id);
    const inclusionReason = exactText(entry.inclusionReason, 30);
    const priority = exactText(entry.priority, 20);
    if (!DIGEST_INCLUSION_REASONS.has(inclusionReason) || !WORK_PRIORITIES.has(priority)) throw invalidInput();
    return { id, version: positiveVersion(entry.version), inclusionReason, priority };
  });
}

function responseInvalid() {
  return new Error(`${REQUEST_ERROR_PREFIX}: response invalid`);
}

function responseTimestamp(value, { nullable = false } = {}) {
  if ((value === null || value === undefined) && nullable) return null;
  if (typeof value !== 'string' || !value || value.length > 100 || !Number.isFinite(Date.parse(value))) {
    throw responseInvalid();
  }
  return value;
}

function responseUuid(value, { nullable = false } = {}) {
  if ((value === null || value === undefined) && nullable) return null;
  if (typeof value !== 'string' || !UUID.test(value) || value !== value.toLowerCase()) throw responseInvalid();
  return value;
}

function responseText(value, maxLength, { nullable = false, allowEmpty = false } = {}) {
  if ((value === null || value === undefined) && nullable) return null;
  if (typeof value !== 'string' || value.length > maxLength || (!allowEmpty && (!value || value !== value.trim()))) {
    throw responseInvalid();
  }
  return value;
}

function responseWorkRow(row, { activeOnly = false } = {}) {
  if (!isRecord(row)) throw responseInvalid();
  responseUuid(row.id);
  responseText(row.work_key, 500);
  responseText(row.room_key, 500);
  responseText(row.title, 300);
  responseText(row.summary, 2000, { allowEmpty: true });
  if (!WORK_TYPES.has(row.work_type) || !WORK_PRIORITIES.has(row.priority) || !WORK_STATES.has(row.state)) {
    throw responseInvalid();
  }
  if (activeOnly && !ACTIVE_WORK_STATES.has(row.state)) throw responseInvalid();
  if (!Number.isSafeInteger(row.version) || row.version < 1) throw responseInvalid();
  responseTimestamp(row.actionable_at);
  responseTimestamp(row.first_opened_at);
  responseTimestamp(row.last_activity_at);
  responseTimestamp(row.due_at, { nullable: true });
  responseTimestamp(row.snoozed_until, { nullable: true });
  if (row.owner_id !== null && row.owner_id !== undefined) responseText(row.owner_id, 200);
  if (!isRecord(row.payload)) throw responseInvalid();
  return row;
}

function responsePreviousDigest(value, previousDigestId) {
  if (value === null) {
    if (previousDigestId !== null && previousDigestId !== undefined) throw responseInvalid();
    return null;
  }
  if (!exactKeys(value, ['id', 'slack_channel_id', 'slack_message_ts'])) throw responseInvalid();
  const id = responseUuid(value.id);
  if (id !== previousDigestId) throw responseInvalid();
  responseText(value.slack_channel_id, 500);
  if (typeof value.slack_message_ts !== 'string' || !SLACK_MESSAGE_TS.test(value.slack_message_ts)) throw responseInvalid();
  return value;
}

function responseDigestRow(row) {
  if (!isRecord(row)) throw responseInvalid();
  responseUuid(row.id);
  responseText(row.destination_key, 500);
  responseTimestamp(row.scheduled_at);
  if (!DIGEST_STATES.has(row.state)) throw responseInvalid();
  const previousDigestId = responseUuid(row.previous_digest_id, { nullable: true });
  if (!Array.isArray(row.item_snapshot)) throw responseInvalid();
  if (row.state === 'building' || row.state === 'delivering' || row.state === 'failed') {
    responseText(row.lease_owner, 200);
    responseUuid(row.lease_token);
    responseTimestamp(row.lease_expires_at);
    if (row.delivered_at !== null || row.slack_channel_id !== null || row.slack_message_ts !== null) {
      throw responseInvalid();
    }
  }
  if (row.state === 'delivered' || row.state === 'replaced') {
    if (row.lease_owner !== null || row.lease_token !== null || row.lease_expires_at !== null) throw responseInvalid();
    responseTimestamp(row.delivered_at);
    if (row.item_snapshot.length === 0) {
      if (row.slack_channel_id !== null || row.slack_message_ts !== null) throw responseInvalid();
    } else {
      responseText(row.slack_channel_id, 500);
      if (typeof row.slack_message_ts !== 'string' || !SLACK_MESSAGE_TS.test(row.slack_message_ts)) {
        throw responseInvalid();
      }
    }
  }
  return { row, previousDigestId };
}

function upsertResponse(data, candidate) {
  if (!exactKeys(data, ['applied', 'created', 'row'])
    || typeof data.applied !== 'boolean' || typeof data.created !== 'boolean'
    || data.created && !data.applied) throw responseInvalid();
  const row = responseWorkRow(data.row);
  if (row.work_key !== candidate.work_key
    || data.created && row.version !== 1
    || data.applied && !data.created && row.version < 2) throw responseInvalid();
  if (data.applied && !ACTIVE_WORK_STATES.has(row.state)) throw responseInvalid();
  if (!data.applied && !['resolved', 'dismissed'].includes(row.state)) throw responseInvalid();
  return data;
}

function actionResponse(data, input) {
  if (!exactKeys(data, ['applied', 'row']) || typeof data.applied !== 'boolean') throw responseInvalid();
  if (!data.applied) {
    if (data.row !== null) throw responseInvalid();
    return data;
  }
  const row = responseWorkRow(data.row, { activeOnly: true });
  if (row.id !== input.id || row.version !== input.expectedVersion + 1
    || !isRecord(row.pending_action) || row.pending_action.status !== 'pending'
    || row.pending_action.type !== input.action.type
    || !sameJsonValue(row.pending_action.action, input.action)
    || row.pending_action.requested_by !== input.requestedBy
    || row.pending_action.expected_version !== input.expectedVersion) throw responseInvalid();
  responseTimestamp(row.pending_action.requested_at);
  return data;
}

function claimResponse(data, input) {
  if (!exactKeys(data, ['claimed', 'created', 'previous_digest', 'row'])
    || typeof data.claimed !== 'boolean' || typeof data.created !== 'boolean'
    || data.created && !data.claimed || !data.claimed && data.created) throw responseInvalid();
  const { row, previousDigestId } = responseDigestRow(data.row);
  if (row.destination_key !== input.destinationKey
    || Date.parse(row.scheduled_at) !== Date.parse(input.scheduledAt)) throw responseInvalid();
  if (data.claimed && (row.state !== 'building' || row.lease_owner !== input.leaseOwner)) throw responseInvalid();
  responsePreviousDigest(data.previous_digest, previousDigestId);
  return data;
}

function finalizeResponse(data, input, snapshot) {
  if (!exactKeys(data, ['applied', 'row', 'updated_count'])
    || typeof data.applied !== 'boolean'
    || !Number.isSafeInteger(data.updated_count) || data.updated_count < 0 || data.updated_count > snapshot.length) {
    throw responseInvalid();
  }
  if (!data.applied) {
    if (data.row !== null || data.updated_count !== 0) throw responseInvalid();
    return data;
  }
  const { row } = responseDigestRow(data.row);
  if (row.id !== input.id || row.state !== 'delivered'
    || Date.parse(responseTimestamp(row.delivered_at)) !== Date.parse(input.deliveredAt)
    || !sameJsonValue(row.item_snapshot, snapshot)) throw responseInvalid();
  if (snapshot.length === 0) {
    if (row.slack_channel_id !== null || row.slack_message_ts !== null) throw responseInvalid();
  } else if (row.slack_channel_id !== input.channelId || row.slack_message_ts !== input.messageTs) {
    throw responseInvalid();
  }
  return data;
}

function failResponse(data, input) {
  if (!exactKeys(data, ['applied', 'row']) || typeof data.applied !== 'boolean') throw responseInvalid();
  if (!data.applied) {
    if (data.row !== null) throw responseInvalid();
    return data;
  }
  const { row } = responseDigestRow(data.row);
  if (row.id !== input.id || row.state !== 'failed'
    || row.lease_owner !== input.leaseOwner || row.lease_token !== input.leaseToken
    || row.error !== input.error) throw responseInvalid();
  return data;
}

function cleanupResponse(data, input) {
  if (!exactKeys(data, ['applied', 'row']) || typeof data.applied !== 'boolean') throw responseInvalid();
  if (!data.applied) {
    if (data.row !== null) {
      const { row } = responseDigestRow(data.row);
      if (row.id !== input.id || row.previous_digest_id !== input.previousDigestId) throw responseInvalid();
    }
    return data;
  }
  const { row } = responseDigestRow(data.row);
  if (row.id !== input.id || row.state !== 'delivered'
    || row.previous_digest_id !== input.previousDigestId
    || row.previous_cleanup_state !== input.outcome) throw responseInvalid();
  if (input.outcome === 'failed') {
    if (row.previous_cleanup_error !== input.error) throw responseInvalid();
  } else {
    if (row.previous_cleanup_error !== null) throw responseInvalid();
    responseTimestamp(row.previous_deleted_at);
  }
  return data;
}

function actionableResponse(data, now) {
  if (!Array.isArray(data)) throw responseInvalid();
  const expectedKeys = ACTIONABLE_WORK_SELECT.split(',');
  for (const row of data) {
    if (!exactKeys(row, expectedKeys)) throw responseInvalid();
    responseWorkRow(row, { activeOnly: true });
    for (const counter of ['digest_inclusion_count', 'consecutive_unhandled_digests']) {
      if (!Number.isSafeInteger(row[counter]) || row[counter] < 0) throw responseInvalid();
    }
    responseTimestamp(row.last_digest_at, { nullable: true });
    responseTimestamp(row.next_reminder_at, { nullable: true });
    const due = Date.parse(row.actionable_at) <= Date.parse(now);
    const unacknowledgedP0 = row.priority === 'p0' && !hasCanonicalP0Acknowledgement(row.payload, now);
    if (!due && !unacknowledgedP0) throw responseInvalid();
  }
  return data;
}

function requiredText(value, maxLength) {
  if (typeof value !== 'string') throw invalidInput();
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength) throw invalidInput();
  return normalized;
}

function optionalText(value, maxLength) {
  if (value === null || value === undefined) return null;
  return requiredText(value, maxLength);
}

function safeJson(value) {
  try {
    return JSON.stringify(value);
  } catch {
    throw invalidInput();
  }
}

function safeResponseCode(raw, serviceRoleKey) {
  try {
    const code = JSON.parse(raw)?.code;
    const normalizedCode = typeof code === 'string' ? code.toUpperCase() : '';
    if (
      /^(?:PGRST\d{3}|[0-9A-Z]{5})$/.test(normalizedCode)
      && !normalizedCode.includes(serviceRoleKey.toUpperCase())
    ) {
      return normalizedCode;
    }
  } catch {
    // A non-JSON response cannot safely contribute to an error message.
  }
  return 'unknown';
}

function normalizeReceipt(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw invalidInput();
  if (!input.payload || typeof input.payload !== 'object' || Array.isArray(input.payload)) throw invalidInput();

  const receivedAt = requiredText(input.receivedAt, 100);
  if (Number.isNaN(new Date(receivedAt).getTime())) throw invalidInput();

  return {
    source: requiredText(input.source, 100),
    sourceEventKey: requiredText(input.sourceEventKey, MAX_EVENT_KEY_LENGTH),
    sourceMessageId: optionalText(input.sourceMessageId, 500),
    clientMessageId: requiredText(input.clientMessageId, 100),
    roomKey: requiredText(input.roomKey, 500),
    receivedAt,
    payload: input.payload
  };
}

function normalizeTransition(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw invalidInput();
  if (!Array.isArray(input.fromStates) || input.fromStates.length === 0) throw invalidInput();
  const patch = input.patch === undefined ? {} : input.patch;
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw invalidInput();

  return {
    id: requiredText(input.id, 200),
    fromStates: input.fromStates.map((state) => requiredText(state, 100)),
    toState: requiredText(input.toState, 100),
    patch
  };
}

function notificationEventKey(sourceEventKey) {
  return requiredText(sourceEventKey, MAX_EVENT_KEY_LENGTH);
}

function expectedDeliveryAttempts(value) {
  if (!Number.isInteger(value) || value < 0) throw invalidInput();
  return value;
}

function expectedTerminalDeliveryAttempts(value) {
  const attempts = expectedDeliveryAttempts(value);
  if (attempts < 1) throw invalidInput();
  return attempts;
}

function deliveredPatch(input = {}) {
  const deliveredAt = requiredText(input.deliveredAt, 100);
  if (Number.isNaN(new Date(deliveredAt).getTime())) throw invalidInput();
  return {
    slack_channel_id: requiredText(input.channelId, 500),
    slack_message_ts: requiredText(input.messageTs, 100),
    delivered_at: deliveredAt,
    last_delivery_error: null
  };
}

function failurePatch(input = {}) {
  if (!DELIVERY_FAILURE_CODES.has(input.failureCode)) throw invalidInput();
  return { last_delivery_error: input.failureCode };
}

export function toRpcReceipt(input) {
  try {
    const receipt = normalizeReceipt(input);
    return {
      p_source: receipt.source,
      p_source_event_key: receipt.sourceEventKey,
      p_source_message_id: receipt.sourceMessageId,
      p_room_key: receipt.roomKey,
      p_received_at: receipt.receivedAt,
      p_client_message_id: receipt.clientMessageId,
      p_payload: receipt.payload
    };
  } catch {
    throw invalidInput();
  }
}

export function createWorkOrchestratorStore({ supabaseUrl, serviceRoleKey, fetchImpl = fetch } = {}) {
  if (typeof supabaseUrl !== 'string' || !supabaseUrl.trim() || typeof serviceRoleKey !== 'string' || !serviceRoleKey.trim()) {
    throw new Error('Work Orchestrator Supabase configuration is missing');
  }
  if (typeof fetchImpl !== 'function') throw new Error('Work Orchestrator Supabase configuration is missing');

  let origin;
  try {
    const parsedUrl = new URL(supabaseUrl.trim());
    if (!['http:', 'https:'].includes(parsedUrl.protocol)) throw new Error('invalid protocol');
    origin = supabaseUrl.trim().replace(/\/$/, '');
  } catch {
    throw new Error('Work Orchestrator Supabase configuration is missing');
  }

  const baseUrl = `${origin}/rest/v1/`;
  const request = async (pathAndQuery, init = {}) => {
    let response;
    try {
      response = await fetchImpl(`${baseUrl}${pathAndQuery}`, {
        ...init,
        headers: {
          apikey: serviceRoleKey,
          authorization: `Bearer ${serviceRoleKey}`,
          accept: 'application/json',
          'content-type': 'application/json',
          prefer: init.prefer || 'return=representation',
          ...init.headers
        },
        signal: init.signal || AbortSignal.timeout(7000)
      });
    } catch {
      throw new Error(`${REQUEST_ERROR_PREFIX}: network error`);
    }

    let raw;
    try {
      raw = await response.text();
    } catch {
      throw new Error(`${REQUEST_ERROR_PREFIX}: response unreadable`);
    }

    let ok;
    let status;
    try {
      ok = response.ok;
      status = Number(response.status) || 0;
    } catch {
      throw new Error(`${REQUEST_ERROR_PREFIX}: response invalid`);
    }
    if (!ok) {
      throw new Error(`${REQUEST_ERROR_PREFIX}: HTTP ${status}, code ${safeResponseCode(raw, serviceRoleKey)}`);
    }

    let data = null;
    if (raw) {
      try {
        data = JSON.parse(raw);
      } catch {
        throw new Error(`${REQUEST_ERROR_PREFIX}: response invalid`);
      }
    }

    let contentRange = '';
    try {
      contentRange = response.headers?.get('content-range') || '';
    } catch {
      throw new Error(`${REQUEST_ERROR_PREFIX}: response metadata unreadable`);
    }
    const countMatch = contentRange.match(/\/(\d+)$/);
    return { data, count: countMatch ? Number(countMatch[1]) : null };
  };

  const transitionNotification = async (input, compare = {}) => {
    let transition;
    try {
      transition = normalizeTransition(input);
      for (const fromState of transition.fromStates) {
        assertNotificationTransition(fromState, transition.toState);
      }
    } catch {
      throw new Error('Work Orchestrator Supabase transition input is invalid');
    }
    const query = new URLSearchParams({
      id: `eq.${transition.id}`,
      notification_state: `in.(${transition.fromStates.join(',')})`,
      ...compare,
      select: '*'
    });
    let body;
    try {
      body = safeJson({ ...transition.patch, notification_state: transition.toState });
    } catch {
      throw new Error('Work Orchestrator Supabase transition input is invalid');
    }
    const { data } = await request(`message_notification_receipts?${query}`, { method: 'PATCH', body });
    const row = Array.isArray(data) ? data[0] || null : null;
    return { applied: Boolean(row), row };
  };

  return {
    claimNotificationReceipt: async (input) => {
      const { data } = await request('rpc/claim_message_notification_receipt', {
        method: 'POST',
        body: safeJson(toRpcReceipt(input))
      });
      return data;
    },
    getNotificationByEventKey: async (sourceEventKey) => {
      const query = new URLSearchParams({
        select: '*',
        source_event_key: `eq.${notificationEventKey(sourceEventKey)}`,
        limit: '1'
      });
      const { data } = await request(`message_notification_receipts?${query}`);
      return Array.isArray(data) ? data[0] || null : null;
    },
    getOldestPendingNotificationCreatedAt: async () => {
      const query = new URLSearchParams({
        select: 'created_at',
        notification_state: 'in.(pending,delivering,failed)',
        order: 'created_at.asc',
        limit: '1'
      });
      const { data } = await request(`message_notification_receipts?${query}`);
      const row = Array.isArray(data) ? data[0] || null : null;
      if (!row) return null;
      const createdAt = typeof row.created_at === 'string' ? row.created_at.trim() : '';
      if (!createdAt || Number.isNaN(Date.parse(createdAt))) {
        throw new Error(`${REQUEST_ERROR_PREFIX}: response invalid`);
      }
      return new Date(createdAt).toISOString();
    },
    transitionNotification,
    claimNotificationDelivery: async (input = {}) => {
      let id;
      let attempts;
      try {
        id = requiredText(input.id, 200);
        attempts = expectedDeliveryAttempts(input.expectedDeliveryAttempts);
      } catch {
        throw new Error('Work Orchestrator Supabase transition input is invalid');
      }
      if (attempts >= MAX_DELIVERY_ATTEMPTS) return { applied: false, row: null };
      return transitionNotification({
        id,
        fromStates: ['pending', 'failed'],
        toState: 'delivering',
        patch: {
          delivery_attempts: attempts + 1,
          last_delivery_error: null
        }
      }, {
        delivery_attempts: `eq.${attempts}`
      });
    },
    markNotificationDelivered: async (input = {}) => {
      let id;
      let attempts;
      let patch;
      try {
        id = requiredText(input.id, 200);
        attempts = expectedTerminalDeliveryAttempts(input.expectedDeliveryAttempts);
        patch = deliveredPatch(input);
      } catch {
        throw new Error('Work Orchestrator Supabase transition input is invalid');
      }
      return transitionNotification({
        id,
        fromStates: ['delivering'],
        toState: 'delivered',
        patch
      }, {
        delivery_attempts: `eq.${attempts}`
      });
    },
    markNotificationFailed: async (input = {}) => {
      let id;
      let attempts;
      let patch;
      try {
        id = requiredText(input.id, 200);
        attempts = expectedTerminalDeliveryAttempts(input.expectedDeliveryAttempts);
        patch = failurePatch(input);
      } catch {
        throw new Error('Work Orchestrator Supabase transition input is invalid');
      }
      return transitionNotification({
        id,
        fromStates: ['delivering'],
        toState: 'failed',
        patch
      }, {
        delivery_attempts: `eq.${attempts}`
      });
    },
    upsertWorkItem: async (input) => {
      let candidate;
      try {
        candidate = normalizeWorkCandidate(input);
      } catch {
        throw invalidInput();
      }
      const { data } = await request('rpc/upsert_work_item_v2', {
        method: 'POST',
        body: safeJson({ p_candidate: candidate })
      });
      return upsertResponse(data, candidate);
    },
    requestWorkAction: async (input = {}) => {
      let body;
      let validationNow;
      try {
        validationNow = input.now === undefined ? new Date() : new Date(isoTimestamp(input.now));
        body = {
          p_id: uuid(input.id),
          p_expected_version: positiveVersion(input.expectedVersion),
          p_action: normalizeWorkAction(input.action, validationNow),
          p_requested_by: exactText(input.requestedBy, 200)
        };
      } catch {
        throw invalidInput();
      }
      const { data } = await request('rpc/request_work_item_action_v2', {
        method: 'POST', body: safeJson(body)
      });
      return actionResponse(data, {
        id: body.p_id,
        expectedVersion: body.p_expected_version,
        action: body.p_action,
        requestedBy: body.p_requested_by
      });
    },
    listActionableWork: async (input = {}) => {
      let now;
      let limit;
      try {
        now = isoTimestamp(input.now);
        if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 500) throw invalidInput();
        limit = input.limit;
      } catch {
        throw invalidInput();
      }
      const { data } = await request('rpc/list_actionable_work_v2', {
        method: 'POST', body: safeJson({ p_now: now, p_limit: limit })
      });
      return actionableResponse(data, now);
    },
    claimDigestRun: async (input = {}) => {
      let body;
      try {
        const windowStartedAt = isoTimestamp(input.windowStartedAt);
        const windowEndedAt = isoTimestamp(input.windowEndedAt);
        if (Date.parse(windowStartedAt) > Date.parse(windowEndedAt)) throw invalidInput();
        if (!Number.isSafeInteger(input.leaseSeconds) || input.leaseSeconds < 1 || input.leaseSeconds > 900) {
          throw invalidInput();
        }
        body = {
          p_destination_key: exactText(input.destinationKey, 500),
          p_scheduled_at: isoTimestamp(input.scheduledAt),
          p_window_started_at: windowStartedAt,
          p_window_ended_at: windowEndedAt,
          p_lease_owner: exactText(input.leaseOwner, 200),
          p_lease_seconds: input.leaseSeconds
        };
      } catch {
        throw invalidInput();
      }
      const { data } = await request('rpc/claim_digest_run_v2', {
        method: 'POST', body: safeJson(body)
      });
      return claimResponse(data, {
        destinationKey: body.p_destination_key,
        scheduledAt: body.p_scheduled_at,
        leaseOwner: body.p_lease_owner
      });
    },
    finalizeDigestRun: async (input = {}) => {
      let body;
      try {
        const snapshot = normalizeDigestSnapshot(input.itemSnapshot);
        const empty = snapshot.length === 0;
        let channelId = null;
        let messageTs = null;
        if (empty) {
          if (input.channelId !== null && input.channelId !== undefined) throw invalidInput();
          if (input.messageTs !== null && input.messageTs !== undefined) throw invalidInput();
        } else {
          channelId = exactText(input.channelId, 500);
          messageTs = exactText(input.messageTs, 100);
          if (!SLACK_MESSAGE_TS.test(messageTs)) throw invalidInput();
        }
        body = {
          p_id: uuid(input.id),
          p_lease_owner: exactText(input.leaseOwner, 200),
          p_lease_token: uuid(input.leaseToken),
          p_item_snapshot: snapshot,
          p_slack_channel_id: channelId,
          p_slack_message_ts: messageTs,
          p_delivered_at: isoTimestamp(input.deliveredAt)
        };
      } catch {
        throw invalidInput();
      }
      const { data } = await request('rpc/finalize_digest_run_v2', {
        method: 'POST', body: safeJson(body)
      });
      return finalizeResponse(data, {
        id: body.p_id,
        channelId: body.p_slack_channel_id,
        messageTs: body.p_slack_message_ts,
        deliveredAt: body.p_delivered_at
      }, body.p_item_snapshot);
    },
    failDigestRun: async (input = {}) => {
      let body;
      try {
        const error = exactText(input.error, 50);
        if (!DIGEST_FAILURE_CODES.has(error)) throw invalidInput();
        body = {
          p_id: uuid(input.id),
          p_lease_owner: exactText(input.leaseOwner, 200),
          p_lease_token: uuid(input.leaseToken),
          p_error: error
        };
      } catch {
        throw invalidInput();
      }
      const { data } = await request('rpc/fail_digest_run_v2', {
        method: 'POST', body: safeJson(body)
      });
      return failResponse(data, {
        id: body.p_id, leaseOwner: body.p_lease_owner, leaseToken: body.p_lease_token,
        error: body.p_error
      });
    },
    recordDigestCleanup: async (input = {}) => {
      let body;
      try {
        const outcome = exactText(input.outcome, 30);
        if (!['deleted', 'already_absent', 'failed'].includes(outcome)) throw invalidInput();
        let error = null;
        if (outcome === 'failed') {
          error = exactText(input.error, 50);
          if (!DIGEST_CLEANUP_FAILURE_CODES.has(error)) throw invalidInput();
        } else if (input.error !== null && input.error !== undefined) {
          throw invalidInput();
        }
        body = {
          p_id: uuid(input.id),
          p_previous_digest_id: uuid(input.previousDigestId),
          p_outcome: outcome,
          p_error: error
        };
        if (body.p_id === body.p_previous_digest_id) throw invalidInput();
      } catch {
        throw invalidInput();
      }
      const { data } = await request('rpc/record_digest_cleanup_v2', {
        method: 'POST', body: safeJson(body)
      });
      return cleanupResponse(data, {
        id: body.p_id,
        previousDigestId: body.p_previous_digest_id,
        outcome: body.p_outcome,
        error: body.p_error
      });
    },
    counts: async () => {
      const count = async (table, filters) => {
        const query = new URLSearchParams({ select: 'id', ...filters });
        const result = await request(`${table}?${query}`, {
          method: 'HEAD',
          headers: { range: '0-0' },
          prefer: 'count=exact'
        });
        return result.count ?? 0;
      };
      const [pendingNotifications, activeWorkItems, unfinishedDigests] = await Promise.all([
        count('message_notification_receipts', { notification_state: 'in.(pending,delivering,failed,cleanup_pending)' }),
        count('work_items_v2', { state: 'in.(open,in_progress,snoozed)' }),
        count('digest_runs', { state: 'in.(building,failed)' })
      ]);
      return { pendingNotifications, activeWorkItems, unfinishedDigests };
    }
  };
}
