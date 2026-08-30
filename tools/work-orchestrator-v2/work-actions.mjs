import { applyWorkAction, decodeWorkActionValue, encodeWorkActionValue } from './work-items.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const UTC_MS = /^(?!0000)[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/;
const POSTGRES_TIMESTAMP = /^(?!0000)([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})(?:\.([0-9]{1,6}))?(?:Z|([+-])([0-9]{2}):([0-9]{2}))$/;
const SLACK_USER_ID = /^[UW][A-Z0-9]{2,79}$/;
const ACTIVE_STATES = new Set(['open', 'in_progress', 'snoozed']);
const MAX_CONTEXT_LENGTH = 1000;

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value, allowed) {
  if (!isRecord(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...allowed].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function canonicalTimestamp(value) {
  if (typeof value !== 'string' || !UTC_MS.test(value)) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) || parsed.toISOString() !== value ? null : value;
}

function canonicalPendingTimestamp(value) {
  if (typeof value !== 'string' || value.length > 40) return null;
  const match = value.match(POSTGRES_TIMESTAMP);
  if (!match) return null;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, , , offsetHourText, offsetMinuteText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12 || day < 1 || day > days[month - 1]
    || Number(hourText) > 23 || Number(minuteText) > 59 || Number(secondText) > 59
    || (offsetHourText !== undefined && (Number(offsetHourText) > 23 || Number(offsetMinuteText) > 59))) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function canonicalNow(value) {
  const source = value instanceof Date ? value.toISOString() : value;
  const timestamp = canonicalTimestamp(source);
  if (timestamp === null) throw new Error('invalid pending work action');
  return timestamp;
}

function invalidContext() {
  return new Error('invalid work action context');
}

function validateContext(value) {
  if (!exactKeys(value, ['id', 'version'])
    || typeof value.id !== 'string' || !UUID.test(value.id)
    || !Number.isSafeInteger(value.version) || value.version < 1) throw invalidContext();
  return { id: value.id.toLowerCase(), version: value.version };
}

export function encodeWorkActionContext(value) {
  try {
    const encoded = Buffer.from(JSON.stringify(validateContext(value)), 'utf8').toString('base64url');
    if (!encoded || encoded.length > MAX_CONTEXT_LENGTH) throw invalidContext();
    return encoded;
  } catch {
    throw invalidContext();
  }
}

export function decodeWorkActionContext(value) {
  try {
    if (typeof value !== 'string' || !value || value.length > MAX_CONTEXT_LENGTH || !BASE64URL.test(value)) {
      throw invalidContext();
    }
    const bytes = Buffer.from(value, 'base64url');
    if (bytes.length > 750 || bytes.toString('base64url') !== value) throw invalidContext();
    return validateContext(JSON.parse(bytes.toString('utf8')));
  } catch {
    throw invalidContext();
  }
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

function validatePendingAction(row, pending, now) {
  if (!isRecord(row) || typeof row.id !== 'string' || !UUID.test(row.id)
    || !Number.isSafeInteger(row.version) || row.version < 2
    || !ACTIVE_STATES.has(row.state)
    || !exactKeys(pending, ['action', 'expected_version', 'requested_at', 'requested_by', 'status', 'type'])
    || pending.status !== 'pending'
    || !Number.isSafeInteger(pending.expected_version) || pending.expected_version < 1
    || row.version !== pending.expected_version + 1
    || typeof pending.requested_by !== 'string' || !SLACK_USER_ID.test(pending.requested_by)) {
    throw new Error('invalid pending work action');
  }
  const requestedAt = canonicalPendingTimestamp(pending.requested_at);
  if (requestedAt === null || Date.parse(requestedAt) > Date.parse(now)) {
    throw new Error('invalid pending work action');
  }
  let decoded;
  try {
    decoded = decodeWorkActionValue(encodeWorkActionValue({
      id: row.id,
      version: pending.expected_version,
      action: pending.action
    }));
  } catch {
    throw new Error('invalid pending work action');
  }
  if (pending.type !== decoded.action.type) throw new Error('invalid pending work action');
  if (decoded.action.type === 'snooze' && Date.parse(decoded.action.snoozedUntil) <= Date.parse(now)) {
    throw new Error('invalid pending work action');
  }
  return {
    type: decoded.action.type,
    action: decoded.action,
    requestedAt,
    requestedBy: pending.requested_by,
    expectedVersion: pending.expected_version
  };
}

export function parsePendingWorkAction(row, now = new Date()) {
  try {
    return validatePendingAction(row, row?.pending_action, canonicalNow(now));
  } catch {
    throw new Error('invalid pending work action');
  }
}

function exactPatch(row, next) {
  const patch = {};
  const conditionalFields = [
    'state', 'snoozed_until', 'actionable_at', 'payload', 'resolution_kind',
    'resolution_evidence', 'resolved_at', 'resolved_by'
  ];
  for (const field of conditionalFields) {
    if (!sameJson(row[field], next[field])) patch[field] = structuredClone(next[field]);
  }
  patch.pending_action = {};
  patch.version = next.version;
  patch.updated_at = next.updated_at;
  return patch;
}

export function processPendingWorkAction({ row, action, now = new Date() } = {}) {
  const changedAt = canonicalNow(now);
  let pending;
  try {
    pending = validatePendingAction(row, row?.pending_action, changedAt);
    const supplied = validatePendingAction(row, action, changedAt);
    if (!sameJson(pending, supplied)) throw new Error('invalid');
  } catch {
    throw new Error('invalid pending work action');
  }

  if (pending.type === 'request_resolve') {
    return {
      status: 'awaiting_authoritative_resolution',
      expectedVersion: row.version,
      expectedPendingStatus: 'pending',
      patch: null
    };
  }

  try {
    const transition = applyWorkAction(row, {
      ...pending.action,
      expectedVersion: row.version,
      requestedBy: pending.requestedBy
    }, changedAt);
    return {
      status: 'ready',
      expectedVersion: row.version,
      expectedPendingStatus: 'pending',
      patch: exactPatch(row, transition.item)
    };
  } catch {
    throw new Error('invalid pending work action');
  }
}
