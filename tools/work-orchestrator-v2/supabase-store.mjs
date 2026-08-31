import { assertNotificationTransition } from './contracts.mjs';

const REQUEST_ERROR_PREFIX = 'Work Orchestrator Supabase request failed';
const MAX_EVENT_KEY_LENGTH = 500;
const MAX_DELIVERY_ATTEMPTS = 3;
const DELIVERY_FAILURE_CODES = new Set(['post_rejected', 'delivery_unconfirmed']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const WORK_PRIORITIES = new Set(['p0', 'urgent', 'normal', 'low']);
const AUTOMATION_STATES = new Set(['not_attempted', 'running', 'succeeded', 'failed', 'needs_human']);
const AUTOMATION_RESOLUTION_KINDS = new Map([
  ['auto_reply_readback', 'succeeded'],
  ['operation_readback', 'succeeded'],
  ['authoritative_failure', 'failed'],
  ['owner_approval_required', 'needs_human'],
  ['stale_evidence', 'needs_human'],
  ['contradictory_evidence', 'needs_human'],
  ['missing_authoritative_readback', 'needs_human']
]);
const AUTOMATION_EVIDENCE_STATUSES = new Set([
  'readback_confirmed', 'completed', 'failed', 'succeeded'
]);
const AUTOMATION_NOTICE_TEXT = new Set([
  'The automated reply was confirmed by authoritative readback.',
  'The automated operation was confirmed by authoritative readback.',
  'The automated operation failed according to authoritative readback.',
  'Owner approval is required before this automation can be resolved.',
  'Human review is required because the supplied evidence is stale.',
  'Human review is required because the supplied evidence is contradictory.',
  'Human review is required because authoritative resolution is unavailable.'
]);
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
const P0_ACKNOWLEDGEMENT_TIMESTAMP = /^(?!0000)[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/;
const DIGEST_INCLUSION_REASONS = new Set(['p0', 'overdue', 'urgent', 'carry_over', 'actionable', 'daily_reminder']);
const DIGEST_FAILURE_CODES = new Set([
  'digest_build_failed', 'digest_delivery_failed', 'delivery_unconfirmed',
  'digest_eligible_overflow'
]);
const DIGEST_PART_KINDS = new Set(['ordinary', 'daily_reminder']);
const DIGEST_PART_DELIVERY_FAILURE_CODES = new Set(['post_rejected', 'rate_limited', 'delivery_unconfirmed', 'slack_api_error']);
const DIGEST_CLEANUP_FAILURE_CODES = new Set(['cant_delete_message', 'rate_limited', 'cleanup_unconfirmed', 'slack_api_error']);
const DIGEST_CLEANUP_STATES = new Set(['idle', 'deleting', 'failed', 'deleted', 'already_absent']);
const WORK_STATES = new Set(['open', 'in_progress', 'snoozed', 'resolved', 'dismissed']);
const ACTIVE_WORK_STATES = new Set(['open', 'in_progress', 'snoozed']);
const DIGEST_STATES = new Set(['building', 'delivering', 'delivered', 'failed', 'diverged', 'replaced', 'retired']);
const SLACK_CHANNEL_ID = /^[A-Z0-9][A-Z0-9_-]{0,79}$/;
const SLACK_MESSAGE_TS = /^[0-9]{1,20}\.[0-9]{1,20}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const DIGEST_PART_RESPONSE_KEYS = [
  'id', 'digest_run_id', 'part_kind', 'part_number', 'part_count', 'item_ids',
  'payload_hash', 'client_message_id', 'delivery_state', 'delivery_attempts',
  'delivery_claimed_at', 'slack_channel_id', 'slack_message_ts', 'delivered_at',
  'delivery_error', 'delivery_retry_at', 'cleanup_state', 'cleanup_attempts', 'cleanup_owner',
  'cleanup_token', 'cleanup_expires_at', 'cleanup_attempted_at', 'cleaned_at',
  'cleanup_error', 'created_at', 'updated_at'
];
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
  if (typeof value !== 'string' || !P0_ACKNOWLEDGEMENT_TIMESTAMP.test(value)) return false;
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

function normalizeAutomationEvidence(input) {
  if (!isRecord(input)) throw invalidInput();
  const allowedSections = new Set(['autoReply', 'operationReceipt', 'sheet']);
  if (Object.keys(input).some((key) => !allowedSections.has(key))) throw invalidInput();
  const evidence = {};
  for (const [section, value] of Object.entries(input)) {
    if (!isRecord(value) || !Object.keys(value).length
      || Object.keys(value).some((key) => !['id', 'timestamp', 'status'].includes(key))) throw invalidInput();
    const typed = {};
    if (value.id !== undefined) {
      const id = exactText(value.id, 100);
      if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id)) throw invalidInput();
      typed.id = id;
    }
    if (value.timestamp !== undefined) typed.timestamp = isoTimestamp(value.timestamp);
    if (value.status !== undefined) {
      const status = exactText(value.status, 30);
      if (!AUTOMATION_EVIDENCE_STATUSES.has(status)) throw invalidInput();
      typed.status = status;
    }
    if (!Object.keys(typed).length) throw invalidInput();
    evidence[section] = typed;
  }
  return evidence;
}

function normalizeAutomationResolution(input, expectedState = null) {
  if (!exactKeys(input, ['state', 'resolutionKind', 'evidence', 'noticeText'])) throw invalidInput();
  const state = exactText(input.state, 30);
  const resolutionKind = exactText(input.resolutionKind, 60);
  if (!AUTOMATION_STATES.has(state) || state === 'not_attempted' || state === 'running'
    || AUTOMATION_RESOLUTION_KINDS.get(resolutionKind) !== state
    || expectedState !== null && state !== expectedState
    || typeof input.noticeText !== 'string' || !AUTOMATION_NOTICE_TEXT.has(input.noticeText)) throw invalidInput();
  return {
    state,
    resolutionKind,
    evidence: normalizeAutomationEvidence(input.evidence),
    noticeText: input.noticeText
  };
}

function automationWorkInput(input, expectedState = null) {
  if (!exactKeys(input, ['id', 'expectedVersion', 'resolution'])) throw invalidInput();
  return {
    id: uuid(input.id),
    expectedVersion: positiveVersion(input.expectedVersion),
    resolution: normalizeAutomationResolution(input.resolution, expectedState)
  };
}

function validNoticeUpdateRow(row, { pendingOnly = false } = {}) {
  if (!isRecord(row) || typeof row.id !== 'string' || !UUID.test(row.id)
    || typeof row.source_event_key !== 'string' || !row.source_event_key
    || row.source_event_key.length > MAX_EVENT_KEY_LENGTH
    || typeof row.slack_channel_id !== 'string' || !SLACK_CHANNEL_ID.test(row.slack_channel_id)
    || typeof row.slack_message_ts !== 'string' || !SLACK_MESSAGE_TS.test(row.slack_message_ts)
    || typeof row.updated_at !== 'string' || Number.isNaN(Date.parse(row.updated_at))
    || !isRecord(row.payload)) throw responseInvalid();
  const update = row.payload.automation_notice_update;
  if (pendingOnly && (!isRecord(update) || update.status !== 'pending'
    || !AUTOMATION_RESOLUTION_KINDS.has(update.resolution_kind)
    || typeof update.notice_text !== 'string' || !AUTOMATION_NOTICE_TEXT.has(update.notice_text))) throw responseInvalid();
  return row;
}

function exactNoticeMutationResponse(updated, observed, expected) {
  validNoticeUpdateRow(updated);
  if (updated.id !== observed.id
    || updated.source_event_key !== observed.source_event_key
    || updated.slack_channel_id !== observed.slack_channel_id
    || updated.slack_message_ts !== observed.slack_message_ts
    || updated.notification_state !== 'cleanup_pending'
    || updated.cleanup_after !== expected.cleanupAfter
    || !sameJsonValue(updated.payload, expected.payload)) throw responseInvalid();
  const update = updated.payload.automation_notice_update;
  if (!isRecord(update) || update.status !== expected.status) throw responseInvalid();
  if (expected.status === 'pending') {
    if (!exactKeys(update, ['status', 'resolution_kind', 'evidence', 'notice_text'])) throw responseInvalid();
    try {
      normalizeAutomationResolution({
        state: 'succeeded', resolutionKind: update.resolution_kind,
        evidence: update.evidence, noticeText: update.notice_text
      }, 'succeeded');
    } catch {
      throw responseInvalid();
    }
  } else {
    if (!exactKeys(update, ['status', 'resolution_kind', 'evidence', 'notice_text', 'readback'])
      || !isRecord(update.readback)
      || !exactKeys(update.readback, ['channel_id', 'message_ts', 'updated_at', 'content_sha256'])
      || update.readback.channel_id !== observed.slack_channel_id
      || update.readback.message_ts !== observed.slack_message_ts
      || update.readback.updated_at !== expected.readbackAt
      || update.readback.content_sha256 !== expected.contentHash) throw responseInvalid();
  }
  return updated;
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
  if (!Array.isArray(input) || input.length > 500) throw invalidInput();
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

function normalizeDigestParts(input, snapshot) {
  if (!Array.isArray(input) || input.length > 50) throw invalidInput();
  const normalized = input.map((part) => {
    if (!exactKeys(part, ['kind', 'partNumber', 'partCount', 'itemIds', 'payloadHash'])) throw invalidInput();
    const kind = exactText(part.kind, 30);
    if (!DIGEST_PART_KINDS.has(kind)
      || !Number.isSafeInteger(part.partNumber) || part.partNumber < 1 || part.partNumber > 50
      || !Number.isSafeInteger(part.partCount) || part.partCount < 1 || part.partCount > 50
      || part.partNumber > part.partCount
      || !Array.isArray(part.itemIds) || part.itemIds.length < 1 || part.itemIds.length > 24
      || typeof part.payloadHash !== 'string' || !SHA256.test(part.payloadHash)) throw invalidInput();
    const itemIds = part.itemIds.map(uuid);
    if (new Set(itemIds).size !== itemIds.length) throw invalidInput();
    return {
      kind, partNumber: part.partNumber, partCount: part.partCount,
      itemIds, payloadHash: part.payloadHash
    };
  });
  for (const kind of DIGEST_PART_KINDS) {
    const kindParts = normalized.filter((part) => part.kind === kind)
      .sort((left, right) => left.partNumber - right.partNumber);
    if (kindParts.some((part, index) => part.partNumber !== index + 1 || part.partCount !== kindParts.length)) {
      throw invalidInput();
    }
  }
  const ordinaryIds = normalized.filter((part) => part.kind === 'ordinary')
    .sort((left, right) => left.partNumber - right.partNumber).flatMap((part) => part.itemIds);
  const reminderIds = normalized.filter((part) => part.kind === 'daily_reminder')
    .sort((left, right) => left.partNumber - right.partNumber).flatMap((part) => part.itemIds);
  const snapshotIds = snapshot.map((entry) => entry.id);
  const expectedReminderIds = snapshot.filter((entry) => entry.inclusionReason === 'daily_reminder')
    .map((entry) => entry.id);
  if (!sameJsonValue(ordinaryIds, snapshotIds) || !sameJsonValue(reminderIds, expectedReminderIds)) {
    throw invalidInput();
  }
  return normalized;
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
  if (!exactKeys(value, ['id', 'parts', 'state']) || !Array.isArray(value.parts)
    || value.parts.length > 50 || value.parts.length < (value.state === 'diverged' ? 0 : 1)
    || !['delivered', 'diverged', 'replaced'].includes(value.state)) {
    throw responseInvalid();
  }
  const id = responseUuid(value.id);
  if (id !== previousDigestId) throw responseInvalid();
  let priorOrder = -1;
  const seen = new Set();
  const kindParts = new Map([['ordinary', []], ['daily_reminder', []]]);
  for (const part of value.parts) {
    if (!exactKeys(part, ['id', 'part_kind', 'part_number', 'part_count', 'slack_channel_id', 'slack_message_ts'])) {
      throw responseInvalid();
    }
    const partId = responseUuid(part.id);
    if (seen.has(partId) || !DIGEST_PART_KINDS.has(part.part_kind)
      || !Number.isSafeInteger(part.part_number) || part.part_number < 1
      || !Number.isSafeInteger(part.part_count) || part.part_count < part.part_number || part.part_count > 50) {
      throw responseInvalid();
    }
    seen.add(partId);
    kindParts.get(part.part_kind).push(part);
    responseText(part.slack_channel_id, 500);
    if (typeof part.slack_message_ts !== 'string' || !SLACK_MESSAGE_TS.test(part.slack_message_ts)) throw responseInvalid();
    const order = (part.part_kind === 'ordinary' ? 0 : 100) + part.part_number;
    if (order <= priorOrder) throw responseInvalid();
    priorOrder = order;
  }
  for (const parts of kindParts.values()) {
    if (value.state !== 'diverged'
      && parts.some((part, index) => part.part_number !== index + 1 || part.part_count !== parts.length)) {
      throw responseInvalid();
    }
  }
  return value;
}

function responseDigestRow(row) {
  if (!isRecord(row)) throw responseInvalid();
  responseUuid(row.id);
  responseText(row.destination_key, 500);
  responseTimestamp(row.scheduled_at);
  if (!DIGEST_STATES.has(row.state)) throw responseInvalid();
  if (!Number.isSafeInteger(row.generation) || row.generation < 1) throw responseInvalid();
  const previousDigestId = responseUuid(row.previous_digest_id, { nullable: true });
  let snapshot;
  try {
    snapshot = normalizeDigestSnapshot(row.item_snapshot);
  } catch {
    throw responseInvalid();
  }
  const manifestPreparedAt = responseTimestamp(row.manifest_prepared_at, { nullable: true });
  if (row.state === 'building' || row.state === 'delivering' || row.state === 'failed') {
    responseText(row.lease_owner, 200);
    responseUuid(row.lease_token);
    responseTimestamp(row.lease_expires_at);
    if (row.delivered_at !== null || row.slack_channel_id !== null || row.slack_message_ts !== null) {
      throw responseInvalid();
    }
    if (row.state === 'delivering' && manifestPreparedAt === null) throw responseInvalid();
  }
  if (row.state === 'delivered' || row.state === 'replaced') {
    if (row.lease_owner !== null || row.lease_token !== null || row.lease_expires_at !== null) throw responseInvalid();
    responseTimestamp(row.delivered_at);
    if (manifestPreparedAt === null) throw responseInvalid();
    if (snapshot.length === 0) {
      if (row.slack_channel_id !== null || row.slack_message_ts !== null) throw responseInvalid();
    } else {
      responseText(row.slack_channel_id, 500);
      if (typeof row.slack_message_ts !== 'string' || !SLACK_MESSAGE_TS.test(row.slack_message_ts)) {
        throw responseInvalid();
      }
    }
  }
  if (row.state === 'diverged' || row.state === 'retired') {
    if (row.lease_owner !== null || row.lease_token !== null || row.lease_expires_at !== null
      || row.delivered_at !== null || row.slack_channel_id !== null || row.slack_message_ts !== null
      || manifestPreparedAt === null || row.error !== 'digest_generation_diverged') {
      throw responseInvalid();
    }
  }
  return { row, previousDigestId };
}

function responseDigestPartRow(row) {
  if (!exactKeys(row, DIGEST_PART_RESPONSE_KEYS)) throw responseInvalid();
  responseUuid(row.id);
  responseUuid(row.digest_run_id);
  responseUuid(row.client_message_id);
  if (!DIGEST_PART_KINDS.has(row.part_kind)
    || !Number.isSafeInteger(row.part_number) || row.part_number < 1 || row.part_number > 50
    || !Number.isSafeInteger(row.part_count) || row.part_count < row.part_number || row.part_count > 50
    || !Array.isArray(row.item_ids) || row.item_ids.length < 1 || row.item_ids.length > 24
    || typeof row.payload_hash !== 'string' || !SHA256.test(row.payload_hash)
    || !Number.isSafeInteger(row.delivery_attempts) || row.delivery_attempts < 0 || row.delivery_attempts > 3
    || !Number.isSafeInteger(row.cleanup_attempts) || row.cleanup_attempts < 0) throw responseInvalid();
  const itemIds = row.item_ids.map(responseUuid);
  if (new Set(itemIds).size !== itemIds.length) throw responseInvalid();
  responseTimestamp(row.created_at);
  responseTimestamp(row.updated_at);
  const claimedAt = responseTimestamp(row.delivery_claimed_at, { nullable: true });
  const deliveredAt = responseTimestamp(row.delivered_at, { nullable: true });
  const retryAt = responseTimestamp(row.delivery_retry_at, { nullable: true });
  if (row.delivery_state === 'planned') {
    if (row.delivery_attempts !== 0 || claimedAt !== null || deliveredAt !== null
      || retryAt !== null || row.slack_channel_id !== null || row.slack_message_ts !== null
      || row.delivery_error !== null) throw responseInvalid();
  } else if (row.delivery_state === 'delivering') {
    if (row.delivery_attempts < 1 || claimedAt === null || deliveredAt !== null
      || retryAt !== null || row.slack_channel_id !== null || row.slack_message_ts !== null
      || row.delivery_error !== null) throw responseInvalid();
  } else if (row.delivery_state === 'failed') {
    if (row.delivery_attempts < 1 || claimedAt === null || deliveredAt !== null
      || row.slack_channel_id !== null || row.slack_message_ts !== null
      || !DIGEST_PART_DELIVERY_FAILURE_CODES.has(row.delivery_error)
      || row.delivery_error === 'rate_limited' && retryAt === null
      || row.delivery_error !== 'rate_limited' && retryAt !== null) throw responseInvalid();
  } else if (row.delivery_state === 'delivered') {
    if (row.delivery_attempts < 1 || claimedAt === null || deliveredAt === null
      || retryAt !== null || row.delivery_error !== null) throw responseInvalid();
    responseText(row.slack_channel_id, 500);
    if (typeof row.slack_message_ts !== 'string' || !SLACK_MESSAGE_TS.test(row.slack_message_ts)) throw responseInvalid();
  } else {
    throw responseInvalid();
  }
  const cleanupAttemptedAt = responseTimestamp(row.cleanup_attempted_at, { nullable: true });
  const cleanupExpiresAt = responseTimestamp(row.cleanup_expires_at, { nullable: true });
  const cleanedAt = responseTimestamp(row.cleaned_at, { nullable: true });
  if (row.cleanup_state === 'idle') {
    if (row.cleanup_attempts !== 0 || cleanupAttemptedAt !== null || cleanupExpiresAt !== null
      || cleanedAt !== null || row.cleanup_owner !== null || row.cleanup_token !== null || row.cleanup_error !== null) throw responseInvalid();
  } else if (row.cleanup_state === 'deleting') {
    if (row.cleanup_attempts < 1 || cleanupAttemptedAt === null || cleanupExpiresAt === null || cleanedAt !== null
      || row.cleanup_error !== null) throw responseInvalid();
    responseText(row.cleanup_owner, 200);
    responseUuid(row.cleanup_token);
  } else if (row.cleanup_state === 'failed') {
    if (row.cleanup_attempts < 1 || cleanupAttemptedAt === null || cleanupExpiresAt !== null || cleanedAt !== null
      || row.cleanup_owner !== null || row.cleanup_token !== null || !DIGEST_CLEANUP_FAILURE_CODES.has(row.cleanup_error)) {
      throw responseInvalid();
    }
  } else if (row.cleanup_state === 'deleted' || row.cleanup_state === 'already_absent') {
    if (row.cleanup_attempts < 1 || cleanupAttemptedAt === null || cleanupExpiresAt !== null || cleanedAt === null
      || row.cleanup_owner !== null || row.cleanup_token !== null || row.cleanup_error !== null) throw responseInvalid();
  } else {
    throw responseInvalid();
  }
  return row;
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
  if (data.claimed && (!['building', 'delivering'].includes(row.state) || row.lease_owner !== input.leaseOwner)) {
    throw responseInvalid();
  }
  responsePreviousDigest(data.previous_digest, previousDigestId);
  return data;
}

function divergentClaimResponse(data, input) {
  if (!exactKeys(data, ['claimed', 'created', 'previous_digest', 'row'])
    || typeof data.claimed !== 'boolean' || typeof data.created !== 'boolean'
    || data.created && !data.claimed || !data.claimed && data.created) throw responseInvalid();
  if (data.row === null) {
    if (data.claimed || data.created || data.previous_digest !== null) throw responseInvalid();
    return data;
  }
  const result = claimResponse(data, {
    destinationKey: input.destinationKey,
    scheduledAt: data.row.scheduled_at,
    leaseOwner: input.leaseOwner
  });
  const windowStartedAt = responseTimestamp(result.row.window_started_at);
  const windowEndedAt = responseTimestamp(result.row.window_ended_at);
  if (Date.parse(result.row.scheduled_at) >= Date.parse(input.beforeScheduledAt)
    || Date.parse(windowStartedAt) > Date.parse(windowEndedAt)
    || Date.parse(windowEndedAt) !== Date.parse(result.row.scheduled_at)
    || result.row.previous_digest_id === null) throw responseInvalid();
  return result;
}

function prepareResponse(data, input, snapshot, intent) {
  const mismatch = exactKeys(data, ['applied', 'created', 'parts', 'reason', 'row'])
    && data.reason === 'manifest_mismatch';
  if (!mismatch && !exactKeys(data, ['applied', 'created', 'parts', 'row'])) throw responseInvalid();
  if (typeof data.applied !== 'boolean' || typeof data.created !== 'boolean'
    || data.created && !data.applied || !Array.isArray(data.parts)) throw responseInvalid();
  if (mismatch) {
    if (data.applied || data.created || data.parts.length > 50) throw responseInvalid();
    const { row } = responseDigestRow(data.row);
    if (row.id !== input.id || row.state !== 'delivering'
      || row.lease_owner !== input.leaseOwner || row.lease_token !== input.leaseToken
      || row.manifest_prepared_at === null) throw responseInvalid();
    const persistedIntent = data.parts.map((part) => {
      responseDigestPartRow(part);
      if (part.digest_run_id !== input.id) throw responseInvalid();
      return {
        kind: part.part_kind,
        partNumber: part.part_number,
        partCount: part.part_count,
        itemIds: part.item_ids,
        payloadHash: part.payload_hash
      };
    });
    let persistedSnapshot;
    try {
      persistedSnapshot = normalizeDigestSnapshot(row.item_snapshot);
      normalizeDigestParts(persistedIntent, persistedSnapshot);
    } catch {
      throw responseInvalid();
    }
    if (sameJsonValue(persistedSnapshot, snapshot) && sameJsonValue(persistedIntent, intent)) {
      throw responseInvalid();
    }
    return data;
  }
  if (!data.applied) {
    if (data.created || data.row !== null || data.parts.length !== 0) throw responseInvalid();
    return data;
  }
  const { row } = responseDigestRow(data.row);
  if (row.id !== input.id || row.state !== 'delivering'
    || row.lease_owner !== input.leaseOwner || row.lease_token !== input.leaseToken
    || !sameJsonValue(row.item_snapshot, snapshot) || data.parts.length !== intent.length) throw responseInvalid();
  data.parts.forEach((part, index) => {
    responseDigestPartRow(part);
    const expected = intent[index];
    if (part.digest_run_id !== input.id || part.part_kind !== expected.kind
      || part.part_number !== expected.partNumber || part.part_count !== expected.partCount
      || !sameJsonValue(part.item_ids, expected.itemIds) || part.payload_hash !== expected.payloadHash) {
      throw responseInvalid();
    }
  });
  return data;
}

function partClaimResponse(data, input) {
  if (!exactKeys(data, ['claimed', 'row']) || typeof data.claimed !== 'boolean') throw responseInvalid();
  if (data.row === null) {
    if (data.claimed) throw responseInvalid();
    return data;
  }
  const row = responseDigestPartRow(data.row);
  if (row.id !== input.partId || row.digest_run_id !== input.id) throw responseInvalid();
  if (data.claimed && row.delivery_state !== 'delivering') throw responseInvalid();
  return data;
}

function partTerminalResponse(data, input, expectedState) {
  if (!exactKeys(data, ['applied', 'row']) || typeof data.applied !== 'boolean') throw responseInvalid();
  if (!data.applied) {
    if (data.row !== null) throw responseInvalid();
    return data;
  }
  const row = responseDigestPartRow(data.row);
  if (row.id !== input.partId || row.digest_run_id !== input.id
    || row.delivery_state !== expectedState || row.delivery_attempts !== input.expectedDeliveryAttempts) {
    throw responseInvalid();
  }
  if (expectedState === 'delivered' && (row.slack_channel_id !== input.channelId
    || row.slack_message_ts !== input.messageTs
    || Date.parse(row.delivered_at) !== Date.parse(input.deliveredAt))) throw responseInvalid();
  if (expectedState === 'failed' && (row.delivery_error !== input.error
    || (input.retryAt === null
      ? row.delivery_retry_at !== null
      : Date.parse(row.delivery_retry_at) !== Date.parse(input.retryAt)))) throw responseInvalid();
  return data;
}

function finalizeResponse(data, input) {
  if (!exactKeys(data, ['applied', 'row', 'updated_count'])
    || typeof data.applied !== 'boolean'
    || !Number.isSafeInteger(data.updated_count) || data.updated_count < 0 || data.updated_count > 500) {
    throw responseInvalid();
  }
  if (!data.applied) {
    if (data.row !== null || data.updated_count !== 0) throw responseInvalid();
    return data;
  }
  const { row } = responseDigestRow(data.row);
  if (row.id !== input.id || row.state !== 'delivered'
    || Date.parse(responseTimestamp(row.delivered_at)) !== Date.parse(input.deliveredAt)
    || data.updated_count > row.item_snapshot.length) throw responseInvalid();
  if (row.item_snapshot.length === 0) {
    if (row.slack_channel_id !== null || row.slack_message_ts !== null) throw responseInvalid();
  }
  return data;
}

function divergenceResponse(data, input) {
  if (!exactKeys(data, ['applied', 'row']) || typeof data.applied !== 'boolean') throw responseInvalid();
  if (!data.applied) {
    if (data.row !== null) throw responseInvalid();
    return data;
  }
  const { row } = responseDigestRow(data.row);
  if (row.id !== input.id || row.state !== 'diverged'
    || row.lease_owner !== null || row.lease_token !== null || row.lease_expires_at !== null
    || row.error !== input.error) throw responseInvalid();
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

function responseCleanupAggregate(row) {
  if (!Object.hasOwn(row, 'previous_cleanup_state')
    || !Object.hasOwn(row, 'previous_cleanup_error')
    || !Object.hasOwn(row, 'previous_deleted_at')) throw responseInvalid();
  const state = row.previous_cleanup_state;
  if (!DIGEST_CLEANUP_STATES.has(state)) throw responseInvalid();
  const deletedAt = responseTimestamp(row.previous_deleted_at, { nullable: true });
  if (state === 'failed') {
    if (!DIGEST_CLEANUP_FAILURE_CODES.has(row.previous_cleanup_error) || deletedAt !== null) {
      throw responseInvalid();
    }
  } else if (state === 'deleted' || state === 'already_absent') {
    if (row.previous_cleanup_error !== null || deletedAt === null) throw responseInvalid();
  } else if (row.previous_cleanup_error !== null || deletedAt !== null) {
    throw responseInvalid();
  }
  return state;
}

function cleanupBacklogResponse(data, limit) {
  if (!Array.isArray(data) || data.length > limit) throw responseInvalid();
  const entryKeys = [
    'successor_digest_id', 'previous_digest_id', 'previous_cleanup_state', 'parts'
  ];
  const partKeys = [
    'previous_part_id', 'part_kind', 'part_number', 'part_count',
    'slack_channel_id', 'slack_message_ts', 'cleanup_state'
  ];
  const seenEntries = new Set();
  for (const entry of data) {
    if (!exactKeys(entry, entryKeys) || !Array.isArray(entry.parts)
      || entry.parts.length < 1 || entry.parts.length > 50) throw responseInvalid();
    const successorId = responseUuid(entry.successor_digest_id);
    const previousId = responseUuid(entry.previous_digest_id);
    const identity = `${successorId}:${previousId}`;
    if (successorId === previousId || seenEntries.has(identity)
      || !DIGEST_CLEANUP_STATES.has(entry.previous_cleanup_state)) {
      throw responseInvalid();
    }
    seenEntries.add(identity);
    const seenParts = new Set();
    for (const part of entry.parts) {
      if (!exactKeys(part, partKeys)) throw responseInvalid();
      const partId = responseUuid(part.previous_part_id);
      if (seenParts.has(partId) || !DIGEST_CLEANUP_STATES.has(part.cleanup_state)
        || !DIGEST_PART_KINDS.has(part.part_kind)
        || !Number.isSafeInteger(part.part_number) || part.part_number < 1
        || !Number.isSafeInteger(part.part_count) || part.part_count < part.part_number
        || part.part_count > 50
        || typeof part.slack_channel_id !== 'string' || !SLACK_CHANNEL_ID.test(part.slack_channel_id)
        || typeof part.slack_message_ts !== 'string' || !SLACK_MESSAGE_TS.test(part.slack_message_ts)) {
        throw responseInvalid();
      }
      seenParts.add(partId);
    }
  }
  return data;
}

function cleanupClaimResponse(data, input) {
  if (!exactKeys(data, ['claimed', 'part', 'row']) || typeof data.claimed !== 'boolean') throw responseInvalid();
  if (data.row === null || data.part === null) {
    if (data.claimed || data.row !== null || data.part !== null) throw responseInvalid();
    return data;
  }
  const { row } = responseDigestRow(data.row);
  const part = responseDigestPartRow(data.part);
  if (row.id !== input.id || !['delivered', 'replaced'].includes(row.state)
    || part.id !== input.previousPartId || part.digest_run_id !== input.previousDigestId) throw responseInvalid();
  const aggregateState = row.previous_digest_id === input.previousDigestId
    ? responseCleanupAggregate(row) : null;
  if (data.claimed && (part.cleanup_state !== 'deleting' || part.cleanup_owner !== input.cleanupOwner)) {
    throw responseInvalid();
  }
  if (data.claimed && aggregateState !== null && aggregateState !== 'deleting') throw responseInvalid();
  if (!data.claimed && (part.cleanup_state === 'idle' || part.cleanup_state === 'failed')) throw responseInvalid();
  if (!data.claimed && part.cleanup_state === 'deleting'
    && aggregateState !== null && aggregateState !== 'deleting') throw responseInvalid();
  if (!data.claimed && part.cleanup_state === 'deleted' && aggregateState === 'already_absent') throw responseInvalid();
  return data;
}

function cleanupTerminalResponse(data, input) {
  if (!exactKeys(data, ['applied', 'part', 'row']) || typeof data.applied !== 'boolean') throw responseInvalid();
  if (data.row === null || data.part === null) {
    if (data.applied || data.row !== null || data.part !== null) throw responseInvalid();
    return data;
  }
  const { row } = responseDigestRow(data.row);
  const part = responseDigestPartRow(data.part);
  if (row.id !== input.id || !['delivered', 'replaced'].includes(row.state)
    || part.id !== input.previousPartId || part.digest_run_id !== input.previousDigestId
    || part.cleanup_attempts !== input.expectedCleanupAttempts || part.cleanup_state !== input.outcome) {
    throw responseInvalid();
  }
  const aggregateState = row.previous_digest_id === input.previousDigestId
    ? responseCleanupAggregate(row) : null;
  if (input.outcome === 'failed') {
    if (part.cleanup_error !== input.error
      || aggregateState !== null && !['deleting', 'failed'].includes(aggregateState)) {
      throw responseInvalid();
    }
  } else if (part.cleanup_error !== null
    || input.outcome === 'deleted' && aggregateState === 'already_absent') {
    throw responseInvalid();
  }
  return data;
}

function actionableResponse(data, now, limit) {
  if (!exactKeys(data, ['eligible_count', 'rows']) || !Array.isArray(data.rows)
    || !Number.isSafeInteger(data.eligible_count) || data.eligible_count < 0
    || data.rows.length !== Math.min(data.eligible_count, limit)) throw responseInvalid();
  const rows = data.rows;
  const expectedKeys = ACTIONABLE_WORK_SELECT.split(',');
  for (const row of rows) {
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
  Object.defineProperty(rows, 'eligibleCount', { value: data.eligible_count, enumerable: false });
  return rows;
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

  const transitionWorkAutomation = async (input, { resolve = false } = {}) => {
    let normalized;
    try {
      normalized = automationWorkInput(input, resolve ? 'succeeded' : null);
      if (!resolve && normalized.resolution.state === 'succeeded') throw invalidInput();
    } catch {
      throw invalidInput();
    }
    const resolvedAt = new Date().toISOString();
    const patch = {
      automation_state: normalized.resolution.state,
      resolution_kind: normalized.resolution.resolutionKind,
      resolution_evidence: normalized.resolution.evidence,
      version: normalized.expectedVersion + 1,
      ...(resolve ? {
        state: 'resolved', snoozed_until: null, resolved_at: resolvedAt,
        resolved_by: 'automation', pending_action: {}
      } : {})
    };
    const query = new URLSearchParams({
      id: `eq.${normalized.id}`,
      version: `eq.${normalized.expectedVersion}`,
      state: 'in.(open,in_progress,snoozed)',
      select: '*'
    });
    const { data } = await request(`work_items_v2?${query}`, {
      method: 'PATCH', body: safeJson(patch)
    });
    const row = Array.isArray(data) ? data[0] || null : null;
    if (!row) return { applied: false, row: null };
    responseWorkRow(row, { activeOnly: !resolve });
    if (row.id !== normalized.id || row.version !== normalized.expectedVersion + 1
      || row.automation_state !== normalized.resolution.state
      || row.resolution_kind !== normalized.resolution.resolutionKind
      || !sameJsonValue(row.resolution_evidence, normalized.resolution.evidence)
      || resolve && (row.state !== 'resolved' || row.resolved_by !== 'automation')) throw responseInvalid();
    return { applied: true, row };
  };

  const patchNoticeByObservedReceipt = async (row, patch) => {
    validNoticeUpdateRow(row);
    const query = new URLSearchParams({
      id: `eq.${row.id}`,
      source_event_key: `eq.${row.source_event_key}`,
      notification_state: `eq.${row.notification_state}`,
      updated_at: `eq.${row.updated_at}`,
      slack_channel_id: `eq.${row.slack_channel_id}`,
      slack_message_ts: `eq.${row.slack_message_ts}`,
      select: '*'
    });
    const { data } = await request(`message_notification_receipts?${query}`, {
      method: 'PATCH', body: safeJson(patch)
    });
    const updated = Array.isArray(data) ? data[0] || null : null;
    return { applied: Boolean(updated), row: updated };
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
    resolveWorkItem: async (input = {}) => transitionWorkAutomation(input, { resolve: true }),
    markAutomationState: async (input = {}) => transitionWorkAutomation(input),
    requestImmediateNoticeUpdate: async (input = {}) => {
      let sourceEventKey;
      let cleanupAfter;
      let resolution;
      try {
        if (!exactKeys(input, ['sourceEventKey', 'resolution', 'cleanupAfter'])) throw invalidInput();
        sourceEventKey = notificationEventKey(input.sourceEventKey);
        cleanupAfter = isoTimestamp(input.cleanupAfter);
        resolution = normalizeAutomationResolution(input.resolution, 'succeeded');
      } catch {
        throw invalidInput();
      }
      const receiptQuery = new URLSearchParams({ select: '*', source_event_key: `eq.${sourceEventKey}`, limit: '1' });
      const receiptData = (await request(`message_notification_receipts?${receiptQuery}`)).data?.[0] || null;
      if (!receiptData) return { applied: false, row: null };
      validNoticeUpdateRow(receiptData);
      if (receiptData.source_event_key !== sourceEventKey || receiptData.notification_state !== 'delivered') {
        return { applied: false, row: null };
      }
      const payload = {
        ...receiptData.payload,
        automation_notice_update: {
          status: 'pending', resolution_kind: resolution.resolutionKind,
          evidence: resolution.evidence, notice_text: resolution.noticeText
        }
      };
      const result = await patchNoticeByObservedReceipt(receiptData, {
        notification_state: 'cleanup_pending', cleanup_after: cleanupAfter, payload
      });
      if (result.applied) exactNoticeMutationResponse(result.row, receiptData, {
        cleanupAfter, payload, status: 'pending'
      });
      return result;
    },
    listImmediateNoticeUpdateRequests: async (input = {}) => {
      if (!exactKeys(input, ['limit']) || !Number.isSafeInteger(input.limit)
        || input.limit < 1 || input.limit > 25) throw invalidInput();
      const query = new URLSearchParams({
        select: 'id,source_event_key,notification_state,slack_channel_id,slack_message_ts,updated_at,payload',
        notification_state: 'eq.cleanup_pending',
        'payload->automation_notice_update->>status': 'eq.pending',
        order: 'updated_at.asc', limit: String(input.limit)
      });
      const { data } = await request(`message_notification_receipts?${query}`);
      if (!Array.isArray(data) || data.length > input.limit) throw responseInvalid();
      return data.map((row) => validNoticeUpdateRow(row, { pendingOnly: true }));
    },
    markImmediateNoticeUpdated: async (input = {}) => {
      let sourceEventKey;
      let expectedUpdatedAt;
      let channelId;
      let messageTs;
      let updatedAt;
      let contentHash;
      try {
        if (!exactKeys(input, [
          'sourceEventKey', 'expectedUpdatedAt', 'channelId', 'messageTs', 'updatedAt', 'contentHash'
        ])) throw invalidInput();
        sourceEventKey = notificationEventKey(input.sourceEventKey);
        expectedUpdatedAt = isoTimestamp(input.expectedUpdatedAt);
        channelId = exactText(input.channelId, 80);
        messageTs = exactText(input.messageTs, 100);
        updatedAt = isoTimestamp(input.updatedAt);
        contentHash = exactText(input.contentHash, 64);
        if (!SLACK_CHANNEL_ID.test(channelId) || !SLACK_MESSAGE_TS.test(messageTs)
          || !SHA256.test(contentHash)) throw invalidInput();
      } catch {
        throw invalidInput();
      }
      const query = new URLSearchParams({ select: '*', source_event_key: `eq.${sourceEventKey}`, limit: '1' });
      const { data } = await request(`message_notification_receipts?${query}`);
      const receipt = Array.isArray(data) ? data[0] || null : null;
      if (!receipt || receipt.updated_at !== expectedUpdatedAt
        || receipt.notification_state !== 'cleanup_pending'
        || receipt.slack_channel_id !== channelId || receipt.slack_message_ts !== messageTs) {
        return { applied: false, row: null };
      }
      validNoticeUpdateRow(receipt, { pendingOnly: true });
      const payload = {
        ...receipt.payload,
        automation_notice_update: {
          ...receipt.payload.automation_notice_update,
          status: 'updated',
          readback: {
            channel_id: channelId, message_ts: messageTs,
            updated_at: updatedAt, content_sha256: contentHash
          }
        }
      };
      const result = await patchNoticeByObservedReceipt(receipt, { payload });
      if (result.applied) exactNoticeMutationResponse(result.row, receipt, {
        cleanupAfter: receipt.cleanup_after, payload, status: 'updated',
        readbackAt: updatedAt, contentHash
      });
      return result;
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
      return actionableResponse(data, now, limit);
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
    claimDivergentDigestRun: async (input = {}) => {
      let body;
      try {
        if (!exactKeys(input, [
          'destinationKey', 'beforeScheduledAt', 'leaseOwner', 'leaseSeconds'
        ]) || !Number.isSafeInteger(input.leaseSeconds)
          || input.leaseSeconds < 1 || input.leaseSeconds > 900) throw invalidInput();
        body = {
          p_destination_key: exactText(input.destinationKey, 500),
          p_before_scheduled_at: isoTimestamp(input.beforeScheduledAt),
          p_lease_owner: exactText(input.leaseOwner, 200),
          p_lease_seconds: input.leaseSeconds
        };
      } catch {
        throw invalidInput();
      }
      const { data } = await request('rpc/claim_divergent_digest_run_v2', {
        method: 'POST', body: safeJson(body)
      });
      return divergentClaimResponse(data, {
        destinationKey: body.p_destination_key,
        beforeScheduledAt: body.p_before_scheduled_at,
        leaseOwner: body.p_lease_owner
      });
    },
    prepareDigestParts: async (input = {}) => {
      let body;
      let snapshot;
      let parts;
      try {
        if (!exactKeys(input, ['id', 'leaseOwner', 'leaseToken', 'itemSnapshot', 'parts'])) throw invalidInput();
        snapshot = normalizeDigestSnapshot(input.itemSnapshot);
        parts = normalizeDigestParts(input.parts, snapshot);
        body = {
          p_id: uuid(input.id),
          p_lease_owner: exactText(input.leaseOwner, 200),
          p_lease_token: uuid(input.leaseToken),
          p_item_snapshot: snapshot,
          p_parts: parts
        };
      } catch {
        throw invalidInput();
      }
      const { data } = await request('rpc/prepare_digest_parts_v2', {
        method: 'POST', body: safeJson(body)
      });
      return prepareResponse(data, {
        id: body.p_id, leaseOwner: body.p_lease_owner, leaseToken: body.p_lease_token
      }, snapshot, parts);
    },
    markDigestGenerationDiverged: async (input = {}) => {
      let body;
      try {
        if (!exactKeys(input, ['id', 'leaseOwner', 'leaseToken', 'error'])
          || input.error !== 'digest_generation_diverged') throw invalidInput();
        body = {
          p_id: uuid(input.id), p_lease_owner: exactText(input.leaseOwner, 200),
          p_lease_token: uuid(input.leaseToken), p_error: input.error
        };
      } catch {
        throw invalidInput();
      }
      const { data } = await request('rpc/mark_digest_generation_diverged_v2', {
        method: 'POST', body: safeJson(body)
      });
      return divergenceResponse(data, { id: body.p_id, error: body.p_error });
    },
    claimDigestPartDelivery: async (input = {}) => {
      let body;
      try {
        if (!exactKeys(input, ['id', 'partId', 'leaseOwner', 'leaseToken'])) throw invalidInput();
        body = {
          p_id: uuid(input.id), p_part_id: uuid(input.partId),
          p_lease_owner: exactText(input.leaseOwner, 200), p_lease_token: uuid(input.leaseToken)
        };
      } catch {
        throw invalidInput();
      }
      const { data } = await request('rpc/claim_digest_part_delivery_v2', {
        method: 'POST', body: safeJson(body)
      });
      return partClaimResponse(data, { id: body.p_id, partId: body.p_part_id });
    },
    markDigestPartDelivered: async (input = {}) => {
      let body;
      try {
        if (!exactKeys(input, [
          'id', 'partId', 'leaseOwner', 'leaseToken', 'expectedDeliveryAttempts',
          'channelId', 'messageTs', 'deliveredAt'
        ])) throw invalidInput();
        const messageTs = exactText(input.messageTs, 100);
        if (!SLACK_MESSAGE_TS.test(messageTs)) throw invalidInput();
        const expectedAttempts = positiveVersion(input.expectedDeliveryAttempts);
        if (expectedAttempts > 3) throw invalidInput();
        body = {
          p_id: uuid(input.id), p_part_id: uuid(input.partId),
          p_lease_owner: exactText(input.leaseOwner, 200), p_lease_token: uuid(input.leaseToken),
          p_expected_delivery_attempts: expectedAttempts,
          p_slack_channel_id: exactText(input.channelId, 500), p_slack_message_ts: messageTs,
          p_delivered_at: isoTimestamp(input.deliveredAt)
        };
      } catch {
        throw invalidInput();
      }
      const { data } = await request('rpc/mark_digest_part_delivered_v2', {
        method: 'POST', body: safeJson(body)
      });
      return partTerminalResponse(data, {
        id: body.p_id, partId: body.p_part_id,
        expectedDeliveryAttempts: body.p_expected_delivery_attempts,
        channelId: body.p_slack_channel_id, messageTs: body.p_slack_message_ts,
        deliveredAt: body.p_delivered_at
      }, 'delivered');
    },
    markDigestPartFailed: async (input = {}) => {
      let body;
      try {
        if (!exactKeys(input, [
          'id', 'partId', 'leaseOwner', 'leaseToken', 'expectedDeliveryAttempts', 'error',
          'failedAt', 'retryAt'
        ])) throw invalidInput();
        const error = exactText(input.error, 50);
        const expectedAttempts = positiveVersion(input.expectedDeliveryAttempts);
        if (expectedAttempts > 3 || !DIGEST_PART_DELIVERY_FAILURE_CODES.has(error)) throw invalidInput();
        const failedAt = isoTimestamp(input.failedAt);
        if (error !== 'rate_limited' && input.retryAt !== null) throw invalidInput();
        const retryAt = isoTimestamp(input.retryAt, { nullable: true });
        if (error === 'rate_limited') {
          const retryDelayMs = Date.parse(retryAt) - Date.parse(failedAt);
          if (!Number.isFinite(retryDelayMs) || retryDelayMs < 0 || retryDelayMs > 86_400_000) {
            throw invalidInput();
          }
        }
        body = {
          p_id: uuid(input.id), p_part_id: uuid(input.partId),
          p_lease_owner: exactText(input.leaseOwner, 200), p_lease_token: uuid(input.leaseToken),
          p_expected_delivery_attempts: expectedAttempts, p_error: error,
          p_failed_at: failedAt, p_retry_at: retryAt
        };
      } catch {
        throw invalidInput();
      }
      const { data } = await request('rpc/mark_digest_part_failed_v2', {
        method: 'POST', body: safeJson(body)
      });
      return partTerminalResponse(data, {
        id: body.p_id, partId: body.p_part_id,
        expectedDeliveryAttempts: body.p_expected_delivery_attempts,
        error: body.p_error, retryAt: body.p_retry_at
      }, 'failed');
    },
    finalizeDigestRun: async (input = {}) => {
      let body;
      try {
        if (!exactKeys(input, ['id', 'leaseOwner', 'leaseToken', 'deliveredAt'])) throw invalidInput();
        body = {
          p_id: uuid(input.id),
          p_lease_owner: exactText(input.leaseOwner, 200),
          p_lease_token: uuid(input.leaseToken),
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
        deliveredAt: body.p_delivered_at
      });
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
    listDigestCleanupBacklog: async (input = {}) => {
      let body;
      try {
        if (!exactKeys(input, ['destinationKey', 'limit'])
          || !Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 10) throw invalidInput();
        body = {
          p_destination_key: exactText(input.destinationKey, 500),
          p_limit: input.limit
        };
      } catch {
        throw invalidInput();
      }
      const { data } = await request('rpc/list_digest_cleanup_backlog_v2', {
        method: 'POST', body: safeJson(body)
      });
      return cleanupBacklogResponse(data, body.p_limit);
    },
    claimDigestPartCleanup: async (input = {}) => {
      let body;
      try {
        if (!exactKeys(input, [
          'id', 'previousDigestId', 'previousPartId', 'cleanupOwner', 'leaseSeconds'
        ])) throw invalidInput();
        if (!Number.isSafeInteger(input.leaseSeconds) || input.leaseSeconds < 1 || input.leaseSeconds > 900) {
          throw invalidInput();
        }
        body = {
          p_id: uuid(input.id),
          p_previous_digest_id: uuid(input.previousDigestId),
          p_previous_part_id: uuid(input.previousPartId),
          p_cleanup_owner: exactText(input.cleanupOwner, 200), p_lease_seconds: input.leaseSeconds
        };
        if (body.p_id === body.p_previous_digest_id) throw invalidInput();
      } catch {
        throw invalidInput();
      }
      const { data } = await request('rpc/claim_digest_part_cleanup_v2', {
        method: 'POST', body: safeJson(body)
      });
      return cleanupClaimResponse(data, {
        id: body.p_id,
        previousDigestId: body.p_previous_digest_id,
        previousPartId: body.p_previous_part_id, cleanupOwner: body.p_cleanup_owner
      });
    },
    recordDigestPartCleanup: async (input = {}) => {
      let body;
      try {
        if (!exactKeys(input, [
          'id', 'previousDigestId', 'previousPartId', 'cleanupOwner', 'cleanupToken',
          'expectedCleanupAttempts', 'outcome', 'error'
        ]) && !exactKeys(input, [
          'id', 'previousDigestId', 'previousPartId', 'cleanupOwner', 'cleanupToken',
          'expectedCleanupAttempts', 'outcome'
        ])) throw invalidInput();
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
          p_previous_part_id: uuid(input.previousPartId),
          p_cleanup_owner: exactText(input.cleanupOwner, 200),
          p_cleanup_token: uuid(input.cleanupToken),
          p_expected_cleanup_attempts: positiveVersion(input.expectedCleanupAttempts),
          p_outcome: outcome,
          p_error: error
        };
        if (body.p_id === body.p_previous_digest_id) throw invalidInput();
      } catch {
        throw invalidInput();
      }
      const { data } = await request('rpc/record_digest_part_cleanup_v2', {
        method: 'POST', body: safeJson(body)
      });
      return cleanupTerminalResponse(data, {
        id: body.p_id,
        previousDigestId: body.p_previous_digest_id,
        previousPartId: body.p_previous_part_id,
        expectedCleanupAttempts: body.p_expected_cleanup_attempts,
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
        count('digest_runs', { state: 'in.(building,delivering,failed,diverged)' })
      ]);
      return { pendingNotifications, activeWorkItems, unfinishedDigests };
    }
  };
}
