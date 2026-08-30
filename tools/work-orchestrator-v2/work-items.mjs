export const WORK_ACTIONS = Object.freeze([
  'progress',
  'snooze',
  'ack_p0',
  'request_resolve',
  'dismiss'
]);

const WORK_TYPES = new Set([
  'human_review',
  'reply_needed',
  'quote_send',
  'tax_invoice',
  'schedule_check',
  'reservation_review',
  'price_review',
  'payment_check',
  'contract_document',
  'return_extension',
  'damage_repair',
  'sheet_duplicate_check',
  'completed_log',
  'reservation_review_timeout',
  'automation_error_review'
]);
const ACTIVE_STATES = new Set(['open', 'in_progress', 'snoozed']);
const TERMINAL_STATES = new Set(['resolved', 'dismissed']);
const TERMINAL_SOURCE_STATES = new Set(['done', 'completed', ...TERMINAL_STATES]);
const AUTOMATION_STATES = new Set(['not_attempted', 'running', 'succeeded', 'failed', 'needs_human']);
const PRIORITY_RANK = Object.freeze({ low: 0, normal: 1, urgent: 2, p0: 3 });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const MAX_ACTION_VALUE_LENGTH = 1000;
const PAYLOAD_STRING_LIMITS = Object.freeze({
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
const LIFECYCLE_PAYLOAD_STRING_LIMITS = Object.freeze({ p0_acknowledged_at: 40 });

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value, allowed) {
  if (!isRecord(value)) return false;
  const actual = Object.keys(value).sort();
  return actual.length === allowed.length
    && actual.every((key, index) => key === [...allowed].sort()[index]);
}

function boundedText(value, max, fallback = '') {
  const normalized = String(value ?? '').trim();
  return (normalized || fallback).slice(0, max);
}

function exactStableKey(value) {
  if (typeof value !== 'string' || !value || value !== value.trim() || value.length > 500) {
    throw new Error('typed work_key is required');
  }
  return value;
}

function stableWorkKey(row) {
  const payload = isRecord(row?.payload) ? row.payload : {};
  const supplied = [
    row?.work_key,
    row?.follow_up_key,
    payload.work_key,
    payload.follow_up_key
  ].filter((value) => value !== undefined && value !== null);
  if (!supplied.length) throw new Error('typed work_key is required');
  const normalized = supplied.map(exactStableKey);
  if (new Set(normalized).size !== 1) throw new Error('typed work_key is ambiguous');
  return normalized[0];
}

function isoDate(value, label, { nullable = false } = {}) {
  if ((value === null || value === undefined || value === '') && nullable) return null;
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`${label} is invalid`);
  return date.toISOString();
}

function candidateClock(input) {
  return isoDate(
    input?.now
      ?? input?.job?.received_at
      ?? input?.job?.receivedAt
      ?? new Date(),
    'human work clock'
  );
}

function sourceState(row) {
  const raw = boundedText(row?.state ?? row?.status, 50);
  if (!raw) return 'open';
  if (ACTIVE_STATES.has(raw) || TERMINAL_SOURCE_STATES.has(raw)) return raw;
  throw new Error('invalid human work state');
}

function humanActionRequirement(row) {
  const payload = isRecord(row?.payload) ? row.payload : {};
  const supplied = [
    row?.requires_human_action,
    row?.requiresHumanAction,
    payload.requires_human_action,
    payload.requiresHumanAction
  ].filter((value) => value !== undefined);
  if (supplied.some((value) => typeof value !== 'boolean')) {
    throw new Error('requires_human_action must be boolean');
  }
  return {
    disabled: supplied.includes(false),
    explicitHumanAction: supplied.includes(true)
  };
}

function humanWorkType(row, { explicitHumanAction = false } = {}) {
  const raw = boundedText(row?.work_type ?? row?.type, 100);
  if (!raw) {
    const payload = isRecord(row?.payload) ? row.payload : {};
    const reviewedPayloadKey = payload.work_key !== undefined || payload.follow_up_key !== undefined;
    if (explicitHumanAction && reviewedPayloadKey) return 'human_review';
    throw new Error('explicit human work type is required');
  }
  if (!WORK_TYPES.has(raw)) throw new Error('unsupported human work type');
  return raw;
}

function priorityOf(row) {
  const payload = isRecord(row?.payload) ? row.payload : {};
  const alertLevel = boundedText(row?.alert_level ?? row?.alertLevel ?? payload.alert_level ?? payload.alertLevel, 20);
  if (alertLevel === 'p0') return 'p0';
  const raw = boundedText(row?.priority, 20, 'normal');
  if (raw === 'high') return 'urgent';
  if (!(raw in PRIORITY_RANK)) throw new Error('invalid human work priority');
  return raw;
}

function boundedSourceKeys(values) {
  const normalized = [];
  for (const value of values.flat(Infinity)) {
    if (value === null || value === undefined || value === '') continue;
    if (typeof value !== 'string' || value !== value.trim() || !value || value.length > 500) {
      throw new Error('invalid source event key');
    }
    normalized.push(value);
  }
  return [...new Set(normalized)].sort().slice(0, 100);
}

function sourceEventKeys(row, job) {
  const payload = isRecord(row?.payload) ? row.payload : {};
  return boundedSourceKeys([
    Array.isArray(row?.source_event_keys) ? row.source_event_keys : [],
    row?.source_event_key,
    payload.source_event_key,
    job?.source_event_key,
    job?.event_hash,
    job?.eventHash
  ]);
}

function safePayload(row, { includeLifecycle = false } = {}) {
  const source = isRecord(row?.payload) ? row.payload : {};
  const result = { requires_human_action: true };
  const limits = includeLifecycle
    ? { ...PAYLOAD_STRING_LIMITS, ...LIFECYCLE_PAYLOAD_STRING_LIMITS }
    : PAYLOAD_STRING_LIMITS;
  for (const [key, limit] of Object.entries(limits)) {
    const directName = key === 'recommended_action' ? row?.recommended_action : row?.[key];
    const value = directName ?? source[key];
    if (value === null || value === undefined || value === '') continue;
    const bounded = boundedText(value, limit);
    if (bounded) result[key] = bounded;
  }
  return result;
}

function candidateFor(row, input, changedAt, { workKey, workType }) {
  const lastActivityAt = isoDate(
    row?.last_activity_at ?? row?.updated_at ?? row?.created_at ?? changedAt,
    'human work activity'
  );
  const automationState = boundedText(row?.automation_state, 50, 'needs_human');
  if (!AUTOMATION_STATES.has(automationState)) throw new Error('invalid human work automation state');
  const dueAt = isoDate(row?.due_at ?? row?.payload?.due_at, 'human work due date', { nullable: true });

  return {
    work_key: workKey,
    source_event_keys: sourceEventKeys(row, input?.job),
    room_key: boundedText(row?.room_key ?? row?.roomKey ?? input?.job?.room_key ?? input?.job?.roomKey, 500, 'unscoped'),
    title: boundedText(row?.title, 300, 'Human review required'),
    summary: boundedText(row?.summary, 2000),
    work_type: workType,
    priority: priorityOf(row),
    state: 'open',
    owner_id: boundedText(row?.owner_id ?? row?.ownerId, 200) || null,
    actionable_at: changedAt,
    due_at: dueAt,
    snoozed_until: null,
    first_opened_at: changedAt,
    last_activity_at: lastActivityAt,
    digest_inclusion_count: 0,
    consecutive_unhandled_digests: 0,
    last_digest_at: null,
    next_reminder_at: null,
    automation_state: automationState,
    resolution_kind: null,
    resolution_evidence: {},
    resolved_at: null,
    resolved_by: null,
    pending_action: {},
    version: 1,
    payload: safePayload(row),
    created_at: changedAt,
    updated_at: changedAt
  };
}

export function buildHumanWorkCandidates(input = {}) {
  const rows = Array.isArray(input.followUpRows) ? input.followUpRows : [];
  const changedAt = candidateClock(input);
  const eligible = [];

  for (const row of rows) {
    if (!isRecord(row)) continue;
    const requirement = humanActionRequirement(row);
    if (requirement.disabled) continue;
    const state = sourceState(row);
    if (TERMINAL_SOURCE_STATES.has(state)) continue;
    const type = humanWorkType(row, requirement);
    if (type === 'completed_log') continue;
    eligible.push({ row, type, workType: type, workKey: stableWorkKey(row) });
  }

  const autoReplyResult = isRecord(input.autoReplyResult) ? input.autoReplyResult : {};
  const verifiedReason = boundedText(autoReplyResult?.sendResult?.reason, 100);
  const verifiedReply = autoReplyResult.sent === true
    && (autoReplyResult.readbackConfirmed === true
      || autoReplyResult.readback_confirmed === true
      || (autoReplyResult?.sendResult?.sent === true
        && /^sent_via_(?:chrome|devtools)_verified(?:_|$)/.test(verifiedReason)));
  const completedKeyValues = verifiedReply
    ? [
        autoReplyResult.completed_work_key,
        autoReplyResult.completedWorkKey,
        autoReplyResult.completed_follow_up_key,
        autoReplyResult.completedFollowUpKey,
        autoReplyResult.work_key,
        autoReplyResult.workKey,
        autoReplyResult.follow_up_key,
        autoReplyResult.followUpKey
      ].filter((value) => value !== undefined && value !== null)
    : [];
  const completedKeys = completedKeyValues.map(exactStableKey);
  if (new Set(completedKeys).size > 1) throw new Error('verified auto reply work_key is ambiguous');
  const completedKey = completedKeys[0] || null;
  const replyKeys = [...new Set(eligible
    .filter((entry) => entry.type === 'reply_needed')
    .map((entry) => entry.workKey))];
  const suppressReplyKey = verifiedReply
    ? (completedKey && replyKeys.includes(completedKey)
        ? completedKey
        : (!completedKey && replyKeys.length === 1 ? replyKeys[0] : null))
    : null;

  return eligible
    .filter((entry) => !(entry.type === 'reply_needed' && entry.workKey === suppressReplyKey))
    .map((entry) => candidateFor(entry.row, input, changedAt, entry));
}

function validateWorkState(state) {
  if (!ACTIVE_STATES.has(state) && !TERMINAL_STATES.has(state)) {
    throw new Error('invalid work item state');
  }
  return state;
}

function normalizedPriority(value) {
  if (!(value in PRIORITY_RANK)) throw new Error('invalid work item priority');
  return value;
}

function earlierDate(left, right) {
  if (!left) return right || null;
  if (!right) return left;
  return new Date(left).getTime() <= new Date(right).getTime() ? left : right;
}

function latestDate(left, right) {
  return new Date(left).getTime() >= new Date(right).getTime() ? left : right;
}

function mergePayload(existing, incoming, mayRefresh) {
  const current = safePayload({ payload: existing }, { includeLifecycle: true });
  if (!mayRefresh) return current;
  const fresh = safePayload({ payload: incoming });
  for (const [key, value] of Object.entries(fresh)) {
    if (value !== null && value !== undefined && value !== '') current[key] = value;
  }
  return current;
}

export function mergeWorkItem(existing, incoming, now = new Date()) {
  if (!isRecord(existing) || !isRecord(incoming)) throw new Error('work items are required');
  const existingKey = exactStableKey(existing.work_key);
  const incomingKey = exactStableKey(incoming.work_key);
  if (existingKey !== incomingKey) throw new Error('merge requires exact work_key');
  const state = validateWorkState(existing.state);
  if (TERMINAL_STATES.has(state)) throw new Error('terminal work item cannot be reopened');
  if (!Number.isSafeInteger(existing.version) || existing.version < 1) throw new Error('invalid work version');

  const changedAt = isoDate(now, 'work item clock');
  const existingActivity = isoDate(existing.last_activity_at, 'work item activity');
  const incomingActivity = isoDate(incoming.last_activity_at, 'work item activity');
  const existingPriority = normalizedPriority(existing.priority);
  const incomingPriority = normalizedPriority(incoming.priority);
  const stale = new Date(incomingActivity).getTime() < new Date(existingActivity).getTime();
  const mayRefreshAction = !stale && PRIORITY_RANK[incomingPriority] >= PRIORITY_RANK[existingPriority];
  const expiredSnooze = state === 'snoozed'
    && existing.snoozed_until
    && new Date(existing.snoozed_until).getTime() <= new Date(changedAt).getTime();
  const p0Escalation = !stale && existingPriority !== 'p0' && incomingPriority === 'p0';
  const unacknowledgedP0 = existingPriority === 'p0' && !p0Acknowledged(existing);
  const wakeSnooze = expiredSnooze
    || (state === 'snoozed' && (p0Escalation || unacknowledgedP0));
  const priority = !stale && PRIORITY_RANK[incomingPriority] > PRIORITY_RANK[existingPriority]
    ? incomingPriority
    : existingPriority;

  return {
    ...existing,
    work_key: existingKey,
    source_event_keys: boundedSourceKeys([
      Array.isArray(existing.source_event_keys) ? existing.source_event_keys : [],
      Array.isArray(incoming.source_event_keys) ? incoming.source_event_keys : []
    ]),
    title: !stale && boundedText(incoming.title, 300) ? boundedText(incoming.title, 300) : boundedText(existing.title, 300),
    summary: !stale && boundedText(incoming.summary, 2000) ? boundedText(incoming.summary, 2000) : boundedText(existing.summary, 2000),
    priority,
    state: wakeSnooze ? 'open' : state,
    owner_id: boundedText(existing.owner_id, 200) || boundedText(incoming.owner_id, 200) || null,
    actionable_at: wakeSnooze ? changedAt : isoDate(existing.actionable_at, 'work item actionable date'),
    due_at: earlierDate(
      isoDate(existing.due_at, 'work item due date', { nullable: true }),
      isoDate(incoming.due_at, 'work item due date', { nullable: true })
    ),
    snoozed_until: wakeSnooze
      ? null
      : isoDate(existing.snoozed_until, 'work item snooze date', { nullable: true }),
    first_opened_at: isoDate(existing.first_opened_at, 'work item opened date'),
    last_activity_at: latestDate(existingActivity, incomingActivity),
    pending_action: isRecord(existing.pending_action) ? { ...existing.pending_action } : {},
    version: existing.version + 1,
    payload: mergePayload(existing.payload, incoming.payload, mayRefreshAction),
    created_at: isoDate(existing.created_at, 'work item created date'),
    updated_at: changedAt
  };
}

function actionType(action) {
  const type = action?.type;
  if (!WORK_ACTIONS.includes(type)) throw new Error('invalid work action');
  return type;
}

function p0Acknowledged(item) {
  const value = isRecord(item?.payload) ? item.payload.p0_acknowledged_at : null;
  if (typeof value !== 'string' || !value || value.length > 40) return false;
  const date = new Date(value);
  return !Number.isNaN(date.getTime()) && date.toISOString() === value;
}

export function applyWorkAction(item, action, now = new Date()) {
  if (!isRecord(item) || !isRecord(action)) throw new Error('invalid work action');
  const type = actionType(action);
  if (!Number.isSafeInteger(action.expectedVersion) || action.expectedVersion !== item.version) {
    throw new Error('stale work version');
  }
  const originalState = validateWorkState(item.state);
  if (TERMINAL_STATES.has(originalState)) throw new Error('terminal work item');
  const changedAt = isoDate(now, 'work action clock');
  const priority = normalizedPriority(item.priority);
  if (type === 'ack_p0' && priority !== 'p0') throw new Error('acknowledgement requires a P0 work item');
  if (priority === 'p0' && !p0Acknowledged(item) && (type === 'snooze' || type === 'dismiss')) {
    throw new Error('acknowledge P0 before hiding work');
  }

  const expiredSnooze = originalState === 'snoozed'
    && item.snoozed_until
    && new Date(item.snoozed_until).getTime() <= new Date(changedAt).getTime();
  const next = {
    ...item,
    state: expiredSnooze ? 'open' : originalState,
    snoozed_until: expiredSnooze ? null : item.snoozed_until,
    actionable_at: expiredSnooze ? changedAt : item.actionable_at,
    payload: safePayload({ payload: item.payload }, { includeLifecycle: true }),
    version: item.version + 1,
    updated_at: changedAt
  };
  let requestedLocalOperation = null;

  if (type === 'progress') {
    next.state = 'in_progress';
    next.snoozed_until = null;
    next.actionable_at = changedAt;
  }
  if (type === 'snooze') {
    const snoozedUntil = new Date(action.snoozedUntil);
    if (Number.isNaN(snoozedUntil.getTime()) || snoozedUntil.getTime() <= new Date(changedAt).getTime()) {
      throw new Error('snooze must end in the future');
    }
    next.state = 'snoozed';
    next.snoozed_until = snoozedUntil.toISOString();
    next.actionable_at = snoozedUntil.toISOString();
  }
  if (type === 'ack_p0') {
    if (!p0Acknowledged(item)) next.payload.p0_acknowledged_at = changedAt;
  }
  if (type === 'request_resolve') {
    const requestedBy = boundedText(action.requestedBy, 200) || null;
    next.pending_action = {
      type: 'resolve',
      status: 'pending',
      requested_at: changedAt,
      requested_by: requestedBy
    };
    requestedLocalOperation = {
      type: 'resolve',
      workItemId: item.id,
      expectedVersion: next.version
    };
  }
  if (type === 'dismiss') {
    next.state = 'dismissed';
    next.resolution_kind = 'dismissed';
    next.resolved_at = changedAt;
    next.resolved_by = boundedText(action.requestedBy, 200) || null;
    next.pending_action = {};
  }

  return { item: next, requestedLocalOperation };
}

function validateActionValuePayload(value) {
  if (!exactKeys(value, ['action', 'id', 'version'])) throw new Error('invalid');
  if (typeof value.id !== 'string' || !UUID.test(value.id)) throw new Error('invalid');
  if (!Number.isSafeInteger(value.version) || value.version < 1) throw new Error('invalid');
  if (!isRecord(value.action) || !WORK_ACTIONS.includes(value.action.type)) throw new Error('invalid');
  const allowedActionKeys = value.action.type === 'snooze'
    ? ['snoozedUntil', 'type']
    : ['type'];
  if (!exactKeys(value.action, allowedActionKeys)) throw new Error('invalid');
  if (value.action.type === 'snooze') {
    if (typeof value.action.snoozedUntil !== 'string' || value.action.snoozedUntil.length > 40) throw new Error('invalid');
    const date = new Date(value.action.snoozedUntil);
    if (Number.isNaN(date.getTime()) || date.toISOString() !== value.action.snoozedUntil) throw new Error('invalid');
  }
  return {
    id: value.id,
    version: value.version,
    action: { ...value.action }
  };
}

function invalidActionValue() {
  return new Error('invalid work action value');
}

export function encodeWorkActionValue(value) {
  try {
    const validated = validateActionValuePayload(value);
    const encoded = Buffer.from(JSON.stringify(validated), 'utf8').toString('base64url');
    if (!encoded || encoded.length > MAX_ACTION_VALUE_LENGTH) throw new Error('invalid');
    return encoded;
  } catch {
    throw invalidActionValue();
  }
}

export function decodeWorkActionValue(value) {
  try {
    if (typeof value !== 'string'
      || !value
      || value.length > MAX_ACTION_VALUE_LENGTH
      || !BASE64URL.test(value)) {
      throw new Error('invalid');
    }
    const bytes = Buffer.from(value, 'base64url');
    if (bytes.toString('base64url') !== value || bytes.length > 750) throw new Error('invalid');
    return validateActionValuePayload(JSON.parse(bytes.toString('utf8')));
  } catch {
    throw invalidActionValue();
  }
}
