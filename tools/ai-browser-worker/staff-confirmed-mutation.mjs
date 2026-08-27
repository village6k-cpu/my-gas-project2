import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { CorrectionStageError, runRegisteredTradeCorrection } = require('../../scripts/windows/village-registered-trade-correction.js');

const TOP_LEVEL_FIELDS = new Set([
  'confirmed', 'kind', 'target_scope', 'request_id', 'trade_id', 'source_evidence',
  'expected_period', 'expected_before', 'desired_after', 'date_change'
]);
const KINDS = new Set([
  'equipment_add', 'equipment_remove', 'equipment_replace', 'equipment_quantity_change', 'date_time_change'
]);
const TRADE_ID = /^\d{6}-\d{3}$/;
const REQUEST_ID = /^RQ-\d{6}-\d{3}$/;
const SCHEDULE_ID = /^(\d{6}-\d{3})-\d{2,}$/;
const TIME = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

function isRecord(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function exactKeys(value, fields, label, errors) {
  if (!isRecord(value)) {
    errors.push(`${label} must be an object`);
    return false;
  }
  for (const key of Object.keys(value)) {
    if (!fields.has(key)) errors.push(`${label}.${key} is unsupported`);
  }
  return true;
}

function exactDate(value) {
  if (!DATE.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const candidate = new Date(Date.UTC(year, month - 1, day));
  return candidate.getUTCFullYear() === year && candidate.getUTCMonth() === month - 1 && candidate.getUTCDate() === day;
}

function validateRows(rows, { registered, tradeId, label, errors }) {
  if (!Array.isArray(rows)) {
    errors.push(`${label} must be an array`);
    return;
  }
  const seenScheduleIds = new Set();
  for (const [index, row] of rows.entries()) {
    const rowLabel = `${label}[${index}]`;
    const rowFields = new Set(registered && label === 'expected_before'
      ? ['schedule_id', 'name', 'quantity']
      : ['name', 'quantity']);
    if (!exactKeys(row, rowFields, rowLabel, errors)) continue;
    if (!text(row.name)) errors.push(`${rowLabel}.name is required`);
    if (!Number.isInteger(row.quantity) || row.quantity <= 0) errors.push(`${rowLabel}.quantity must be a positive integer`);
    if (registered && label === 'expected_before') {
      const scheduleId = text(row.schedule_id);
      const match = SCHEDULE_ID.exec(scheduleId);
      if (!match) {
        errors.push(`${rowLabel}.schedule_id is invalid`);
      } else if (match[1] !== tradeId) {
        errors.push(`${rowLabel}.schedule_id does not belong to trade_id`);
      } else if (seenScheduleIds.has(scheduleId)) {
        errors.push(`${rowLabel}.schedule_id must be unique`);
      } else {
        seenScheduleIds.add(scheduleId);
      }
    }
  }
}

function validatePeriod(period, label, errors) {
  if (!exactKeys(period, new Set(['start_date', 'start_time', 'end_date', 'end_time']), label, errors)) return;
  for (const field of ['start_date', 'end_date']) {
    if (!exactDate(text(period[field]))) errors.push(`${label}.${field} must be an exact date`);
  }
  for (const field of ['start_time', 'end_time']) {
    if (!TIME.test(text(period[field]))) errors.push(`${label}.${field} must be a 24-hour time`);
  }
}

function validateDateChange(dateChange, errors) {
  if (!exactKeys(dateChange, new Set(['new_start_date', 'new_start_time', 'new_end_date', 'new_end_time']), 'date_change', errors)) return;
  for (const field of ['new_start_date', 'new_end_date']) {
    if (!exactDate(text(dateChange[field]))) errors.push(`date_change.${field} must be an exact date`);
  }
  for (const field of ['new_start_time', 'new_end_time']) {
    if (!TIME.test(text(dateChange[field]))) errors.push(`date_change.${field} must be a 24-hour time`);
  }
}

function periodInstant(period, prefix = '') {
  const startDate = text(period?.[`${prefix}start_date`]);
  const startTime = text(period?.[`${prefix}start_time`]);
  const endDate = text(period?.[`${prefix}end_date`]);
  const endTime = text(period?.[`${prefix}end_time`]);
  if (!exactDate(startDate) || !TIME.test(startTime) || !exactDate(endDate) || !TIME.test(endTime)) return null;
  const start = Date.parse(`${startDate}T${startTime}:00Z`);
  const end = Date.parse(`${endDate}T${endTime}:00Z`);
  return Number.isFinite(start) && Number.isFinite(end) ? { start, end } : null;
}

function rowQuantitiesByName(rows) {
  const quantities = new Map();
  for (const row of rows) {
    const name = text(row?.name);
    const quantity = Number(row?.quantity);
    if (!name || !Number.isInteger(quantity) || quantity <= 0) return null;
    quantities.set(name, (quantities.get(name) || 0) + quantity);
  }
  return quantities;
}

function validateRegisteredKindShape(mutation, errors) {
  const before = Array.isArray(mutation.expected_before) ? mutation.expected_before : [];
  const after = Array.isArray(mutation.desired_after) ? mutation.desired_after : [];
  const hasDateChange = mutation.date_change !== null;
  const shapeError = () => errors.push(`${mutation.kind} has an invalid affected-row delta shape`);
  if (mutation.kind === 'equipment_add') {
    if (before.length !== 0 || after.length === 0 || hasDateChange) shapeError();
  } else if (mutation.kind === 'equipment_remove') {
    if (before.length === 0 || after.length !== 0 || hasDateChange) shapeError();
  } else if (mutation.kind === 'equipment_replace') {
    if (before.length === 0 || after.length === 0 || hasDateChange) shapeError();
  } else if (mutation.kind === 'equipment_quantity_change') {
    const beforeQuantities = rowQuantitiesByName(before);
    const afterQuantities = rowQuantitiesByName(after);
    const beforeNames = beforeQuantities ? [...beforeQuantities.keys()].sort() : [];
    const afterNames = afterQuantities ? [...afterQuantities.keys()].sort() : [];
    const namesMatch = JSON.stringify(beforeNames) === JSON.stringify(afterNames);
    const quantityDiffers = namesMatch && beforeNames.some((name) => beforeQuantities.get(name) !== afterQuantities.get(name));
    if (!before.length || !after.length || hasDateChange || !namesMatch || !quantityDiffers) shapeError();
  } else if (mutation.kind === 'date_time_change') {
    const expected = periodInstant(mutation.expected_period);
    const desired = periodInstant(mutation.date_change, 'new_');
    if (before.length !== 0 || after.length !== 0 || !hasDateChange
      || !expected || !desired || desired.end <= desired.start
      || (expected.start === desired.start && expected.end === desired.end)) shapeError();
  }
}

function mutationError(code, message, details = null) {
  return { code, message, ...(details === null ? {} : { details }) };
}

export function validateStaffConfirmedMutation(mutation, { roomRevision } = {}) {
  const errors = [];
  if (!exactKeys(mutation, TOP_LEVEL_FIELDS, 'mutation', errors)) return { valid: false, errors };
  if (mutation.confirmed !== true) errors.push('confirmed must be true');
  if (!KINDS.has(mutation.kind)) errors.push('kind is unsupported');
  const scope = mutation.target_scope;
  if (scope !== 'pending_request' && scope !== 'registered_trade') errors.push('target_scope is unsupported');

  if (exactKeys(mutation.source_evidence, new Set(['customer_request', 'staff_confirmation', 'conversation_revision']), 'source_evidence', errors)) {
    if (!text(mutation.source_evidence.customer_request)) errors.push('source_evidence.customer_request is required');
    if (!text(mutation.source_evidence.staff_confirmation)) errors.push('source_evidence.staff_confirmation is required');
    if (!Number.isInteger(mutation.source_evidence.conversation_revision) || mutation.source_evidence.conversation_revision <= 0) {
      errors.push('source_evidence.conversation_revision must be a positive integer');
    }
    if (roomRevision !== undefined && mutation.source_evidence.conversation_revision !== roomRevision) {
      errors.push('source_evidence.conversation_revision does not match room revision');
    }
  }

  const registered = scope === 'registered_trade';
  if (registered) {
    if (!TRADE_ID.test(text(mutation.trade_id))) errors.push('trade_id is invalid');
    if (Object.hasOwn(mutation, 'request_id')) errors.push('request_id is forbidden for registered_trade');
    validatePeriod(mutation.expected_period, 'expected_period', errors);
    const expectedInstant = periodInstant(mutation.expected_period);
    if (expectedInstant && expectedInstant.end <= expectedInstant.start) {
      errors.push('expected_period end instant must be after start instant');
    }
  }
  if (scope === 'pending_request') {
    if (!REQUEST_ID.test(text(mutation.request_id))) errors.push('request_id is invalid');
    if (Object.hasOwn(mutation, 'trade_id')) errors.push('trade_id is forbidden for pending_request');
    if (Object.hasOwn(mutation, 'expected_period')) errors.push('expected_period is forbidden for pending_request');
  }

  validateRows(mutation.expected_before, { registered, tradeId: text(mutation.trade_id), label: 'expected_before', errors });
  validateRows(mutation.desired_after, { registered, tradeId: text(mutation.trade_id), label: 'desired_after', errors });
  if (!Array.isArray(mutation.expected_before) || !Array.isArray(mutation.desired_after)) {
    // Row validators provide the specific errors; this branch only avoids an invalid empty-change decision.
  } else if (mutation.expected_before.length === 0 && mutation.desired_after.length === 0 && mutation.date_change === null) {
    errors.push('mutation must contain a change');
  }

  if (mutation.date_change !== null) {
    validateDateChange(mutation.date_change, errors);
  }
  if (registered && KINDS.has(mutation.kind)) validateRegisteredKindShape(mutation, errors);
  return { valid: errors.length === 0, errors };
}

export function buildRegisteredTradeCorrectionInput(mutation, operationId) {
  const validation = validateStaffConfirmedMutation(mutation);
  if (!validation.valid || mutation.target_scope !== 'registered_trade') {
    throw new Error(`invalid registered staff-confirmed mutation: ${validation.errors.join('; ') || 'target_scope must be registered_trade'}`);
  }
  const normalizedOperationId = text(operationId);
  if (!normalizedOperationId) throw new Error('operationId is required');
  return {
    tradeId: mutation.trade_id,
    operationId: normalizedOperationId,
    expectedPeriod: {
      startDate: mutation.expected_period.start_date,
      startTime: mutation.expected_period.start_time,
      endDate: mutation.expected_period.end_date,
      endTime: mutation.expected_period.end_time
    },
    ...(mutation.date_change === null ? {} : {
      dateChange: {
        newStartDate: mutation.date_change.new_start_date,
        startTime: mutation.date_change.new_start_time,
        newEndDate: mutation.date_change.new_end_date,
        endTime: mutation.date_change.new_end_time,
        allowConflicts: false
      }
    }),
    remove: mutation.expected_before.map((row) => ({
      scheduleId: row.schedule_id, expectedName: row.name, expectedQty: row.quantity
    })),
    add: mutation.desired_after.map((row) => ({ name: row.name, qty: row.quantity })),
    sendEstimate: false
  };
}

export async function executeVillageRegisteredReservationChange(request = {}, options = {}) {
  const config = request.config || {};
  const job = request.job || {};
  const requestedRevision = request.roomRevision;
  const jobId = text(job.job_id);
  const roomKey = text(job.room_key);
  const jobRevision = job.room_revision;
  if (!jobId) throw new Error('job_id is required');
  if (!roomKey) throw new Error('room_key is required');
  if (!Number.isInteger(requestedRevision) || requestedRevision <= 0) throw new Error('room revision must be a positive integer');
  if (!Number.isInteger(jobRevision) || jobRevision !== requestedRevision) throw new Error('room revision does not match the job');

  const dependencies = request.dependencies || {};
  const operationFence = options.operationFence || dependencies.operationFence;
  const operationId = text(operationFence?.operation_id);
  if (!operationId) throw new Error('operation fence operation_id is required');
  const uuid = dependencies.randomUUID || crypto.randomUUID;
  const now = dependencies.now || (() => new Date());
  const receiptId = text(uuid());
  if (!receiptId) throw new Error('receipt_id generation failed');
  const createdValue = now();
  const createdAt = (createdValue instanceof Date ? createdValue : new Date(createdValue)).toISOString();
  const mutation = request.mutation;
  const buildReceipt = ({ status, authoritativeResult = null, appliedStages = [], attemptedStage = null, error = null }) => ({
    schema: 'village-registered-reservation-change-receipt/v1',
    receipt_id: receiptId,
    job_id: jobId,
    room_key: roomKey,
    room_revision: requestedRevision,
    status,
    target_scope: 'registered_trade',
    trade_id: text(mutation?.trade_id) || null,
    mutation_kind: text(mutation?.kind) || null,
    authoritative_result: authoritativeResult,
    applied_stages: Array.isArray(appliedStages) ? appliedStages : [],
    attempted_stage: attemptedStage,
    customer_reply: 'no_reply',
    created_at: createdAt,
    error
  });

  const validation = validateStaffConfirmedMutation(mutation, { roomRevision: requestedRevision });
  if (!validation.valid || mutation.target_scope !== 'registered_trade') {
    return buildReceipt({
      status: 'failed',
      error: mutationError('invalid_mutation', 'registered staff-confirmed mutation validation failed', { validation_errors: validation.errors })
    });
  }

  const input = buildRegisteredTradeCorrectionInput(mutation, operationId);
  const assertCurrentClaim = options.assertCurrentClaim || dependencies.assertCurrentClaim || (async () => {});
  const runner = dependencies.runRegisteredTradeCorrection || runRegisteredTradeCorrection;
  if (typeof runner !== 'function') throw new Error('runRegisteredTradeCorrection is unavailable');
  try {
    await assertCurrentClaim();
    const result = await runner({ config, input });
    const authoritativeReadback = result?.authoritativeReadback;
    const hasExactAuthoritativeEnvelope = isRecord(authoritativeReadback)
      && isRecord(authoritativeReadback.before)
      && isRecord(authoritativeReadback.after)
      && isRecord(result?.readback)
      && JSON.stringify(authoritativeReadback.after) === JSON.stringify(result.readback);
    if (result?.ok !== true || result?.verified !== true || text(result.tradeId) !== mutation.trade_id || !hasExactAuthoritativeEnvelope) {
      const appliedStages = Array.isArray(result?.appliedStages) ? result.appliedStages : [];
      return buildReceipt({
        status: appliedStages.length > 0 ? 'partial_success' : 'failed',
        appliedStages,
        error: mutationError('invalid_authoritative_result', 'registered correction returned incomplete authoritative result')
      });
    }
    return buildReceipt({ status: 'ok', authoritativeResult: authoritativeReadback, appliedStages: result.appliedStages || [] });
  } catch (error) {
    const stageError = error instanceof CorrectionStageError || error?.name === 'CorrectionStageError';
    const appliedStages = Array.isArray(error?.appliedStages) ? error.appliedStages : [];
    const attemptedStage = text(error?.stage) || null;
    if (stageError && error?.outcomeUnknown === true) {
      return buildReceipt({
        status: 'partial_success', appliedStages, attemptedStage,
        error: mutationError('outcome_unknown', text(error?.message) || 'registered correction outcome is unknown', error?.details ?? null)
      });
    }
    if (stageError) {
      return buildReceipt({
        status: appliedStages.length > 0 ? 'partial_success' : 'blocked', appliedStages, attemptedStage,
        error: mutationError('gas_rejected', text(error?.message) || 'GAS rejected registered correction', error?.details ?? null)
      });
    }
    return buildReceipt({
      status: 'failed', appliedStages, attemptedStage,
      error: mutationError('execution_failed', text(error?.message) || 'registered correction failed before a known write')
    });
  }
}
