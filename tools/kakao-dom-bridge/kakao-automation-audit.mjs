import { createHash } from 'node:crypto';

const EVENT_FIELDS = Object.freeze([
  'event_key',
  'job_id',
  'room_revision',
  'operation_id',
  'receipt_id',
  'occurred_at',
  'effect_type',
  'action_type',
  'outcome',
  'customer_label',
  'target_type',
  'target_id',
  'summary',
  'change_items',
  'outbound_text',
  'evidence',
  'source_message_at',
  'historical_import'
]);

const EFFECT_TYPES = new Set([
  'auto_reply',
  'confirmation_request',
  'reservation_registration',
  'registered_reservation_change',
  'document_send'
]);
const ACTION_TYPES = new Set([
  'send',
  'create',
  'update',
  'add',
  'remove',
  'replace',
  'quantity_change',
  'date_time_change'
]);
const OUTCOMES = new Set(['success', 'partial_success', 'failed', 'blocked', 'no_action']);
const TARGET_TYPES = new Set(['room', 'request', 'trade', 'document']);
const CHANGE_FIELDS = new Set(['equipment', 'quantity', 'start_at', 'end_at', 'tax_mode', 'document']);
const PHONE_PATTERN = /01[016789][ -]?[0-9]{3,4}[ -]?[0-9]{4}/i;
const SECRET_PATTERN = /(bearer\s+[a-z0-9._~-]+|(?:token|secret|password|apikey|api[ _-]?key)\s*[:=])/i;
const BANK_ACCOUNT_PATTERN = /(?:계좌|은행|account)(?:번호)?[^0-9\r\n]{0,20}[0-9][0-9 -]{7,}[0-9]/i;
const EVENT_KEY_PATTERN = /^kakao:(auto_reply|confirmation_request|reservation_registration|registered_reservation_change|document_send):[0-9a-f]{64}$/;
const HASH_PATTERN = /^[0-9a-f]{64}$/;
const REPLY_RECEIPT_PATTERN = /^reply-readback-[0-9a-f]{64}$/;
const TOOL_RECEIPT_SCHEMA = Object.freeze({
  confirmation_request: 'village-confirmation-receipt/v1',
  confirmed_reservation_commit: 'village-confirmed-reservation-commit-receipt/v1',
  registered_reservation_change: 'village-registered-reservation-change-receipt/v1',
  document_send: 'village-document-receipt/v1'
});
const REGISTERED_ACTION = Object.freeze({
  equipment_add: 'add',
  equipment_remove: 'remove',
  equipment_replace: 'replace',
  equipment_quantity_change: 'quantity_change',
  date_time_change: 'date_time_change'
});

function invalidAuditEvent() {
  return new TypeError('invalid audit event');
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value, keys) {
  if (!isRecord(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function containsPrivateText(value) {
  return PHONE_PATTERN.test(value) || SECRET_PATTERN.test(value) || BANK_ACCOUNT_PATTERN.test(value);
}

function boundedText(value, max, { nullable = false, trim = true } = {}) {
  if (nullable && value === null) return null;
  if (typeof value !== 'string') throw invalidAuditEvent();
  const normalized = trim ? value.trim() : value;
  if (!normalized || normalized.length > max || containsPrivateText(normalized)) throw invalidAuditEvent();
  return normalized;
}

function boundedIdentifier(value, max, { nullable = false } = {}) {
  if (nullable && value === null) return null;
  if (typeof value !== 'string' || value.length < 1 || value.length > max || value !== value.trim()
    || containsPrivateText(value)) {
    throw invalidAuditEvent();
  }
  return value;
}

function positiveInteger(value) {
  if (!Number.isSafeInteger(value) || value <= 0) throw invalidAuditEvent();
  return value;
}

function nonNegativeInteger(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw invalidAuditEvent();
  return value;
}

function canonicalTimestamp(value, { nullable = false } = {}) {
  if (nullable && value === null) return null;
  if (typeof value !== 'string' || !value.trim()) throw invalidAuditEvent();
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) throw invalidAuditEvent();
  return new Date(milliseconds).toISOString();
}

function safeOptionalText(value, max = 160) {
  if (value === undefined || value === null || value === '') return null;
  try {
    return boundedText(value, max);
  } catch {
    return null;
  }
}

// Internal receipt equality must compare the real normalized values.  The
// public audit serializer deliberately drops PII/secret-shaped text via
// safeOptionalText(); reusing that redaction helper here would collapse two
// different private values to the same null and falsely certify a readback.
function exactInternalTextMatch(left, right, max) {
  const normalize = (value) => {
    if (typeof value !== 'string') return null;
    const normalized = value.normalize('NFKC').trim();
    return normalized.length <= max ? normalized : null;
  };
  const normalizedLeft = normalize(left);
  const normalizedRight = normalize(right);
  return normalizedLeft !== null && normalizedRight !== null
    && normalizedLeft === normalizedRight;
}

function safeCustomerLabel({ durableJob, prepared, proof }) {
  const candidates = [
    proof?.customer_label,
    prepared?.customerLabel,
    prepared?.customer_label,
    prepared?.decision?.customer_name,
    prepared?.sheetCandidate?.customerName,
    prepared?.sheet_candidate?.customer_name,
    durableJob?.local_context?.job?.customerName,
    durableJob?.local_context?.job?.customer_name,
    durableJob?.local_context?.job?.roomTitle,
    durableJob?.local_context?.job?.room_title
  ];
  for (const candidate of candidates) {
    const safe = safeOptionalText(candidate, 120);
    if (safe) return safe;
  }
  return null;
}

function normalizeNullableChangeText(value) {
  if (value === null) return null;
  return boundedText(value, 1000);
}

function normalizeChangeItems(value) {
  if (!Array.isArray(value) || value.length > 20) throw invalidAuditEvent();
  const result = value.map((item) => {
    if (!hasExactKeys(item, ['field', 'before', 'after'])) throw invalidAuditEvent();
    if (!CHANGE_FIELDS.has(item.field)) throw invalidAuditEvent();
    const normalized = {
      field: item.field,
      before: normalizeNullableChangeText(item.before),
      after: normalizeNullableChangeText(item.after)
    };
    if (normalized.before === null && normalized.after === null) throw invalidAuditEvent();
    return normalized;
  });
  if (Buffer.byteLength(JSON.stringify(result), 'utf8') > 8000) throw invalidAuditEvent();
  return result;
}

function normalizeEvidence(value) {
  if (!isRecord(value)) throw invalidAuditEvent();
  const allowed = new Set(['schema', 'status', 'readback', 'applied_stages', 'attempted_stage', 'error_type']);
  if (Object.keys(value).some((key) => !allowed.has(key))) throw invalidAuditEvent();
  const evidence = {};
  evidence.schema = boundedIdentifier(value.schema, 160);
  evidence.status = boundedIdentifier(value.status, 80);
  if (value.readback !== true && value.readback !== false) throw invalidAuditEvent();
  evidence.readback = value.readback;
  if (value.applied_stages !== undefined) {
    if (!Array.isArray(value.applied_stages) || value.applied_stages.length > 20) throw invalidAuditEvent();
    evidence.applied_stages = value.applied_stages.map((stage) => boundedIdentifier(stage, 120));
  }
  if (value.attempted_stage !== undefined) {
    evidence.attempted_stage = boundedIdentifier(value.attempted_stage, 120);
  }
  if (value.error_type !== undefined) {
    evidence.error_type = boundedIdentifier(value.error_type, 120);
  }
  if (Buffer.byteLength(JSON.stringify(evidence), 'utf8') > 4000 || containsPrivateText(JSON.stringify(evidence))) {
    throw invalidAuditEvent();
  }
  return evidence;
}

export function normalizeKakaoAutomationAuditEvent(value) {
  if (!hasExactKeys(value, EVENT_FIELDS)) throw invalidAuditEvent();
  if (typeof value.event_key !== 'string' || !EVENT_KEY_PATTERN.test(value.event_key)) throw invalidAuditEvent();
  if (!EFFECT_TYPES.has(value.effect_type) || !ACTION_TYPES.has(value.action_type)
    || !OUTCOMES.has(value.outcome) || !TARGET_TYPES.has(value.target_type)) {
    throw invalidAuditEvent();
  }
  if (typeof value.historical_import !== 'boolean') throw invalidAuditEvent();
  const normalized = {
    event_key: value.event_key,
    job_id: boundedIdentifier(value.job_id, 160),
    room_revision: positiveInteger(value.room_revision),
    operation_id: boundedIdentifier(value.operation_id, 160, { nullable: true }),
    receipt_id: boundedIdentifier(value.receipt_id, 200, { nullable: true }),
    occurred_at: canonicalTimestamp(value.occurred_at),
    effect_type: value.effect_type,
    action_type: value.action_type,
    outcome: value.outcome,
    customer_label: boundedText(value.customer_label, 120),
    target_type: value.target_type,
    target_id: boundedIdentifier(value.target_id, 160, { nullable: true }),
    summary: boundedText(value.summary, 500),
    change_items: normalizeChangeItems(value.change_items),
    outbound_text: value.outbound_text === null ? null : boundedText(value.outbound_text, 2000, { trim: false }),
    evidence: normalizeEvidence(value.evidence),
    source_message_at: canonicalTimestamp(value.source_message_at, { nullable: true }),
    historical_import: value.historical_import
  };
  if (!normalized.event_key.startsWith(`kakao:${normalized.effect_type}:`)) throw invalidAuditEvent();
  return normalized;
}

function authorityEventKey(effectType, authorityId) {
  const digest = createHash('sha256')
    .update(`village-kakao-automation-audit/v1\n${effectType}\n${authorityId}`)
    .digest('hex');
  return `kakao:${effectType}:${digest}`;
}

function statusOutcome(status) {
  if (status === 'ok') return 'success';
  if (status === 'partial_success') return 'partial_success';
  if (status === 'failed') return 'failed';
  if (status === 'blocked') return 'blocked';
  throw new TypeError('trusted tool receipt set is invalid');
}

function sourceMessageAt(durableJob) {
  const value = durableJob?.event?.detected_at ?? durableJob?.detected_at ?? null;
  try {
    return canonicalTimestamp(value, { nullable: true });
  } catch {
    return null;
  }
}

function exactToolReceipt(durableJob) {
  const operation = durableJob?.tool_operation;
  const receipts = durableJob?.tool_receipts;
  if (operation === null || operation === undefined) {
    if (Array.isArray(receipts) && receipts.length > 0) throw new TypeError('trusted tool receipt set is invalid');
    return null;
  }
  if (!isRecord(operation) || operation.state !== 'completed' || !Array.isArray(receipts) || receipts.length !== 1) {
    throw new TypeError('trusted tool receipt set is invalid');
  }
  const receipt = receipts[0];
  const expectedSchema = TOOL_RECEIPT_SCHEMA[operation.tool];
  if (!expectedSchema || !isRecord(receipt)
    || receipt.schema !== expectedSchema
    || receipt.receipt_id !== operation.receipt_id
    || receipt.operation_id !== operation.operation_id
    || receipt.job_id !== operation.job_id
    || receipt.room_key !== operation.room_key
    || receipt.room_revision !== operation.room_revision
    || receipt.lease_id !== operation.lease_id
    || receipt.request_digest !== operation.request_digest
    || durableJob?.job_id !== operation.job_id
    || durableJob?.room_key !== operation.room_key
    || durableJob?.room_revision !== operation.room_revision) {
    throw new TypeError('trusted tool receipt set is invalid');
  }
  return { operation, receipt };
}

function unresolvedConfirmedRegistrationOperation(durableJob) {
  const operation = durableJob?.tool_operation;
  const target = operation?.audit_target;
  const receipts = durableJob?.tool_receipts;
  const lateReceipt = Array.isArray(receipts) && receipts.length === 1 ? receipts[0] : null;
  const unresolvedEvidenceState = operation?.state === 'reserved'
    ? Array.isArray(receipts) && receipts.length === 0
    : operation?.state === 'completed'
      && isRecord(lateReceipt)
      && lateReceipt.receipt_id === operation.receipt_id
      && lateReceipt.operation_id === operation.operation_id
      && lateReceipt.job_id === operation.job_id
      && lateReceipt.room_key === operation.room_key
      && lateReceipt.room_revision === operation.room_revision
      && lateReceipt.lease_id === operation.lease_id
      && lateReceipt.request_digest === operation.request_digest;
  if (!isRecord(operation)
    || operation.tool !== 'confirmed_reservation_commit'
    || !unresolvedEvidenceState
    || !['failed', 'superseded'].includes(durableJob?.state)
    || durableJob?.error?.type !== 'confirmation_operation_unresolved'
    || durableJob.error.operation_id !== operation.operation_id
    || durableJob.job_id !== operation.job_id
    || durableJob.room_key !== operation.room_key
    || durableJob.room_revision !== operation.room_revision
    || !hasExactKeys(target, ['schema', 'effect_type', 'action_type', 'target_type', 'target_id'])
    || target.schema !== 'village-kakao-tool-audit-target/v1'
    || target.effect_type !== 'reservation_registration'
    || target.action_type !== 'create'
    || !['request', 'room'].includes(target.target_type)
    || (target.target_type === 'request' && !/^RQ-\d{6}-\d{3}$/.test(String(target.target_id || '')))
    || (target.target_type === 'room' && target.target_id !== null)) {
    return null;
  }
  return { operation, target };
}

function equipmentText(items) {
  if (!Array.isArray(items) || items.length === 0) return null;
  const parts = [];
  for (const item of items) {
    if (!isRecord(item)) continue;
    const name = safeOptionalText(item.name, 300);
    const quantity = Number(item.quantity);
    if (!name || !Number.isSafeInteger(quantity) || quantity <= 0 || quantity > 9999) continue;
    parts.push(`${name} ${quantity}개`);
  }
  if (parts.length === 0) return null;
  const combined = parts.join(', ');
  return combined.length <= 1000 && !containsPrivateText(combined) ? combined : null;
}

function failureEvidence(receipt, base) {
  const result = { ...base };
  if (Array.isArray(receipt.applied_stages)) {
    const stages = receipt.applied_stages
      .map((stage) => safeOptionalText(stage, 120))
      .filter(Boolean)
      .slice(0, 20);
    if (stages.length > 0) result.applied_stages = stages;
  }
  const attemptedStage = safeOptionalText(receipt.attempted_stage, 120);
  if (attemptedStage) result.attempted_stage = attemptedStage;
  const errorType = safeOptionalText(receipt.error?.type || receipt.error?.code, 120);
  if (errorType) result.error_type = errorType;
  return result;
}

function outcomeSummary({ outcome, success, partial, failed, blocked }) {
  if (outcome === 'success') return success;
  if (outcome === 'partial_success') return partial;
  if (outcome === 'blocked') return blocked;
  return failed;
}

function buildConfirmationEvent({ durableJob, operation, receipt, customerLabel, historicalImport,
  eventAuthorityId = operation.operation_id, auditReceiptId = receipt.receipt_id, batchIndex = null }) {
  let outcome = receipt.status === 'no_action' ? 'no_action' : statusOutcome(receipt.status);
  const sheet = isRecord(receipt.authoritative_sheet_result) ? receipt.authoritative_sheet_result : null;
  const uncertain = sheet?.uncertainWrite === true || sheet?.uncertain_write === true;
  if (uncertain && (outcome === 'success' || outcome === 'no_action')) outcome = 'partial_success';
  const tradeOnly = sheet?.alreadyRegistered === true && !sheet.reqID;
  const tradeIds = [sheet?.matchedRegisteredTradeId, sheet?.tradeID]
    .filter(value => value !== undefined && value !== null && value !== '');
  if (tradeOnly && (tradeIds.length === 0 || tradeIds.some(value => typeof value !== 'string'
    || !/^\d{6}-\d{3}$/.test(value) || value !== tradeIds[0]))) {
    throw new TypeError('trusted tool receipt set is invalid');
  }
  const reconciled = tradeOnly && sheet.success === true && !uncertain && (outcome === 'success' || outcome === 'no_action');
  if (reconciled) outcome = 'no_action';
  if (outcome === 'success' && (!sheet || sheet.success !== true || typeof sheet.reqID !== 'string' || !/^RQ-\d{6}-\d{3}$/.test(sheet.reqID))) {
    throw new TypeError('trusted tool receipt set is invalid');
  }
  const targetId = safeOptionalText(tradeOnly ? tradeIds[0] : sheet?.reqID, 160);
  const mutation = isRecord(sheet?.staff_confirmed_pending_mutation) ? sheet.staff_confirmed_pending_mutation : null;
  const replaced = Array.isArray(sheet?.replacedReqIDs) ? sheet.replacedReqIDs.filter((item) => typeof item === 'string') : [];
  const actionType = tradeOnly || replaced.length > 0 || mutation?.target_request_id ? 'update' : 'create';
  const before = equipmentText(mutation?.expected_before);
  const after = equipmentText(mutation?.final_plan);
  const changeItems = before !== null || after !== null
    ? [{ field: 'equipment', before, after }]
    : [];
  const label = targetId || '대상 미확정';
  const summary = reconciled ? `기존 등록 거래 ${targetId}에 요청 내용이 이미 반영되어 있음을 확인했습니다.`
    : outcome === 'no_action' ? '확인요청에 추가로 반영한 변경이 없습니다.'
    : outcomeSummary({
    outcome,
    success: `확인요청 ${label}을 ${actionType === 'update' ? '수정' : '생성'}했습니다.`,
    partial: `확인요청 ${label}이 부분 반영되었습니다.`,
    failed: '확인요청 자동처리가 실패했습니다.',
    blocked: '확인요청 자동처리가 차단되었습니다.'
  });
  return normalizeKakaoAutomationAuditEvent({
    event_key: authorityEventKey('confirmation_request', eventAuthorityId),
    job_id: durableJob.job_id,
    room_revision: durableJob.room_revision,
    operation_id: operation.operation_id,
    receipt_id: auditReceiptId,
    occurred_at: operation.completed_at || receipt.created_at,
    effect_type: 'confirmation_request',
    action_type: actionType,
    outcome,
    customer_label: customerLabel,
    target_type: tradeOnly ? 'trade' : 'request',
    target_id: targetId,
    summary,
    change_items: changeItems,
    outbound_text: null,
    evidence: failureEvidence(batchIndex === null ? receipt : { ...receipt, attempted_stage: `batch_child_${batchIndex}` }, {
      schema: receipt.schema,
      status: receipt.status,
      readback: Boolean(sheet && sheet.success === true && !uncertain)
    }),
    source_message_at: sourceMessageAt(durableJob),
    historical_import: Boolean(historicalImport)
  });
}

function buildConfirmationEvents(args) {
  const { receipt, operation } = args;
  const sheet = receipt.authoritative_sheet_result;
  if (sheet?.batch !== true && !Object.hasOwn(receipt, 'request_results')) return [buildConfirmationEvent(args)];
  const entries = sheet?.request_results;
  const unattempted = sheet?.unattempted_indices;
  const invalid = () => { throw new TypeError('trusted tool receipt set is invalid'); };
  if (sheet?.batch !== true || !Array.isArray(entries) || entries.length > 8 || !Array.isArray(unattempted)
    || entries.length + unattempted.length < 2 || entries.length + unattempted.length > 8
    || unattempted.some((index, offset) => index !== entries.length + offset)
    || !sameValue(entries, receipt.request_results)
    || !sameValue(unattempted, receipt.unattempted_indices)
    || !Array.isArray(receipt.child_receipts)
    || !sameValue(entries.map(entry => entry?.receipt).filter(Boolean), receipt.child_receipts)) invalid();
  const projected = [];
  const requestIds = [];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (!isRecord(entry) || entry.index !== index || !Array.isArray(entry.request_ids)) invalid();
    const child = entry.receipt;
    if (child === null) {
      if (entry.status !== 'uncertain' || entry.request_ids.length > 0) invalid();
      projected.push({ index, receipt: {
        schema: receipt.schema, receipt_id: receipt.receipt_id, created_at: receipt.created_at,
        status: 'partial_success', authoritative_sheet_result: null,
        error: { code: 'confirmation_batch_execution_uncertain' }
      } });
      continue;
    }
    if (!isRecord(child) || child.schema !== receipt.schema
      || child.job_id !== receipt.job_id || child.room_key !== receipt.room_key || child.room_revision !== receipt.room_revision
      || typeof child.receipt_id !== 'string' || !child.receipt_id.trim()
      || !['ok', 'failed', 'partial_success', 'no_action'].includes(child.status)
      || entry.status !== child.status || !Array.isArray(child.availability_report)
      || child.authoritative_sheet_result?.batch === true || Object.hasOwn(child, 'request_results')
      || !sameValue(entry.authoritative_sheet_result, child.authoritative_sheet_result)) invalid();
    canonicalTimestamp(child.created_at);
    const childResult = child.authoritative_sheet_result;
    const childIds = [...new Set([childResult?.reqID, ...(Array.isArray(childResult?.request_ids) ? childResult.request_ids : [])]
      .filter(value => typeof value === 'string' && /^RQ-\d{6}-\d{3}$/.test(value)))];
    if (!sameValue(childIds, entry.request_ids)) invalid();
    requestIds.push(...childIds);
    projected.push({ index, receipt: child });
  }
  const uniqueRequestIds = [...new Set(requestIds)];
  if (!sameValue(uniqueRequestIds, sheet.request_ids) || !sameValue(uniqueRequestIds, receipt.request_ids)
    || (sheet.reqID ?? null) !== (uniqueRequestIds[0] ?? null)
    || sheet.success !== (receipt.status === 'ok')
    || (receipt.status === 'ok' && (unattempted.length > 0 || projected.some(child => child.receipt.status !== 'ok')))) invalid();
  return projected.map(child => buildConfirmationEvent({
    ...args, receipt: child.receipt, auditReceiptId: receipt.receipt_id,
    eventAuthorityId: `${operation.operation_id}\nbatch-child:${child.index}`, batchIndex: child.index
  }));
}

function registeredSummary(actionType, tradeId, outcome) {
  const verb = {
    add: '장비를 추가',
    remove: '장비를 삭제',
    replace: '장비를 교체',
    quantity_change: '장비 수량을 변경',
    date_time_change: '대여 일정을 변경'
  }[actionType];
  if (outcome === 'success') return `등록예약 ${tradeId}에 ${verb}했습니다.`;
  if (outcome === 'partial_success') return `등록예약 ${tradeId} 변경이 부분 반영되었습니다.`;
  if (outcome === 'blocked') return `등록예약 ${tradeId} 변경이 차단되었습니다.`;
  return `등록예약 ${tradeId} 변경이 실패했습니다.`;
}

function contractPeriod(result, side) {
  const contract = result?.[side]?.contract;
  if (!isRecord(contract)) return { start: null, end: null };
  const startDate = safeOptionalText(contract.startDate ?? contract.start_date, 20);
  const startTime = safeOptionalText(contract.startTime ?? contract.start_time, 20);
  const endDate = safeOptionalText(contract.endDate ?? contract.end_date, 20);
  const endTime = safeOptionalText(contract.endTime ?? contract.end_time, 20);
  return {
    start: startDate && startTime ? `${startDate} ${startTime}` : null,
    end: endDate && endTime ? `${endDate} ${endTime}` : null
  };
}

function buildRegisteredEvent({ durableJob, operation, receipt, customerLabel, historicalImport }) {
  const outcome = statusOutcome(receipt.status);
  const actionType = REGISTERED_ACTION[receipt.mutation_kind];
  const mutation = receipt.authorized_mutation;
  const result = receipt.authoritative_result;
  const tradeId = safeOptionalText(receipt.trade_id, 160);
  if (!actionType || !tradeId || !isRecord(mutation)) throw new TypeError('trusted tool receipt set is invalid');
  if ((outcome === 'success' || outcome === 'partial_success')
    && (!isRecord(result) || !isRecord(result.before) || !isRecord(result.after))) {
    throw new TypeError('trusted tool receipt set is invalid');
  }
  const changeItems = [];
  if (actionType === 'date_time_change') {
    const before = contractPeriod(result, 'before');
    const after = contractPeriod(result, 'after');
    if (before.start !== null || after.start !== null) {
      changeItems.push({ field: 'start_at', before: before.start, after: after.start });
    }
    if (before.end !== null || after.end !== null) {
      changeItems.push({ field: 'end_at', before: before.end, after: after.end });
    }
  } else {
    const before = equipmentText(mutation.expected_before);
    const after = equipmentText(mutation.desired_after);
    if (before !== null || after !== null) changeItems.push({ field: 'equipment', before, after });
  }
  return normalizeKakaoAutomationAuditEvent({
    event_key: authorityEventKey('registered_reservation_change', operation.operation_id),
    job_id: durableJob.job_id,
    room_revision: durableJob.room_revision,
    operation_id: operation.operation_id,
    receipt_id: receipt.receipt_id,
    occurred_at: operation.completed_at || receipt.created_at,
    effect_type: 'registered_reservation_change',
    action_type: actionType,
    outcome,
    customer_label: customerLabel,
    target_type: 'trade',
    target_id: tradeId,
    summary: registeredSummary(actionType, tradeId, outcome),
    change_items: changeItems,
    outbound_text: null,
    evidence: failureEvidence(receipt, {
      schema: receipt.schema,
      status: receipt.status,
      readback: Boolean(isRecord(result) && isRecord(result.before) && isRecord(result.after))
    }),
    source_message_at: sourceMessageAt(durableJob),
    historical_import: Boolean(historicalImport)
  });
}

function normalizedRegistrationPeriod(period) {
  if (!isRecord(period)) return { start: null, end: null };
  const startDate = safeOptionalText(period.start_date, 20);
  const startTime = safeOptionalText(period.start_time, 20);
  const endDate = safeOptionalText(period.end_date, 20);
  const endTime = safeOptionalText(period.end_time, 20);
  return {
    start: startDate && startTime ? `${startDate} ${startTime}` : null,
    end: endDate && endTime ? `${endDate} ${endTime}` : null
  };
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (isRecord(value)) {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]));
  }
  return value;
}

function sameValue(left, right) {
  return JSON.stringify(canonicalValue(left)) === JSON.stringify(canonicalValue(right));
}

function canonicalRegistrationComponents(values) {
  if (!Array.isArray(values)) return null;
  const seen = new Set();
  const rows = [];
  for (const value of values) {
    const setItem = safeOptionalText(value?.set_item, 300);
    const componentItem = safeOptionalText(value?.component_item, 300);
    const quantity = Number(value?.quantity);
    const key = `${setItem}\u0000${componentItem}`;
    if (!setItem || !componentItem || !Number.isSafeInteger(quantity) || quantity < 1 || seen.has(key)) return null;
    seen.add(key);
    rows.push({ set_item: setItem, component_item: componentItem, quantity });
  }
  return rows.sort((left, right) => (
    left.set_item.localeCompare(right.set_item) || left.component_item.localeCompare(right.component_item)
  ));
}

function canonicalRegistrationPlan(values, quantityField = 'quantity') {
  if (!Array.isArray(values)) return null;
  const totals = new Map();
  for (const value of values) {
    const name = safeOptionalText(value?.name, 300);
    const quantity = Number(value?.[quantityField]);
    if (!name || !Number.isSafeInteger(quantity) || quantity < 1) return null;
    totals.set(name, (totals.get(name) || 0) + quantity);
  }
  if (!totals.size) return null;
  return [...totals.entries()].map(([name, quantity]) => ({ name, quantity }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

function confirmedRegistrationRequestReadback(result, registration) {
  const request = result?.authoritative?.request;
  const effectiveRequestId = safeOptionalText(result?.effective_request_id, 160);
  const tradeId = safeOptionalText(result?.trade_id, 160);
  if (!isRecord(request) || safeOptionalText(request.reqID, 160) !== effectiveRequestId
    || !Array.isArray(request.tradeIds)
    || !request.tradeIds.map((value) => safeOptionalText(value, 160)).includes(tradeId)) return false;
  const requestPlan = canonicalRegistrationPlan(request.topLevelEquipItems, 'qty');
  const desiredPlan = canonicalRegistrationPlan(registration?.desired_after);
  if (!requestPlan || !desiredPlan || !sameValue(requestPlan, desiredPlan)) return false;
  const desiredPeriod = registration?.desired_period;
  if (safeOptionalText(request.startDate, 20) !== safeOptionalText(desiredPeriod?.start_date, 20)
    || safeOptionalText(request.startTime, 20) !== safeOptionalText(desiredPeriod?.start_time, 20)
    || safeOptionalText(request.endDate, 20) !== safeOptionalText(desiredPeriod?.end_date, 20)
    || safeOptionalText(request.endTime, 20) !== safeOptionalText(desiredPeriod?.end_time, 20)) return false;
  const requestComponents = canonicalRegistrationComponents(request.setComponentItems);
  const finalComponents = canonicalRegistrationComponents(result?.final_set_components);
  if (!requestComponents || !finalComponents || !sameValue(requestComponents, finalComponents)) return false;
  if (registration?.request_id === null) {
    const candidate = registration?.pending_request_candidate;
    const phoneKey = (value) => String(value || '').replace(/\D/g, '');
    if (!isRecord(candidate)
      || !exactInternalTextMatch(request.name, candidate.customer_name, 300)
      || phoneKey(request.phone) !== phoneKey(candidate.phone)
      || !exactInternalTextMatch(request.discount, candidate.discount_type, 120)
      || !exactInternalTextMatch(request.memo, candidate.memo, 500)
      || !exactInternalTextMatch(request.extraRequest, candidate.extra_request, 1000)) return false;
  }
  return true;
}

function confirmedRegistrationComponentReadback(result, registration) {
  const finalRows = canonicalRegistrationComponents(result?.final_set_components);
  const scheduleRows = result?.authoritative?.registered_trade?.schedule?.rows;
  if (!finalRows || !Array.isArray(scheduleRows)) return false;
  const authoritativeRows = canonicalRegistrationComponents(scheduleRows
    .filter((row) => row?.isComponent === true)
    .map((row) => ({ set_item: row?.setName, component_item: row?.name, quantity: row?.qty })));
  if (!authoritativeRows || !sameValue(finalRows, authoritativeRows)) return false;
  if (registration?.request_id === null) {
    return (registration.set_component_selections || []).every((selection) => finalRows.some((row) => (
      row.set_item === selection?.set_item && row.component_item === selection?.selected_item
    )));
  }
  const expectedPlan = canonicalRegistrationPlan(registration?.expected_before);
  const desiredPlan = canonicalRegistrationPlan(registration?.desired_after);
  if (!expectedPlan || !desiredPlan) return false;
  if (!sameValue(expectedPlan, desiredPlan)) {
    return (registration.set_component_selections || []).every((selection) => finalRows.some((row) => (
      row.set_item === selection?.set_item && row.component_item === selection?.selected_item
    )));
  }
  const projected = canonicalRegistrationComponents(registration?.expected_set_components);
  if (!projected) return false;
  for (const selection of registration.set_component_selections || []) {
    const target = projected.find((row) => row.set_item === selection?.set_item
      && row.component_item === selection?.component_item);
    if (!target) return false;
    target.component_item = selection.selected_item;
  }
  return sameValue(finalRows, canonicalRegistrationComponents(projected));
}

function buildConfirmedRegistrationEvent({ durableJob, operation, receipt, customerLabel, historicalImport }) {
  const outcome = statusOutcome(receipt.status);
  const registration = receipt.authorized_registration;
  const result = receipt.authoritative_result;
  const requestId = safeOptionalText(receipt.request_id, 160);
  const effectiveRequestId = safeOptionalText(receipt.effective_request_id, 160);
  const tradeId = safeOptionalText(receipt.trade_id, 160);
  const bootstrapped = requestId === null;
  const registrationIdentityValid = bootstrapped
    ? registration?.request_id === null && isRecord(registration?.pending_request_candidate)
    : registration?.request_id === requestId;
  if (!isRecord(registration) || registration.target_scope !== 'pending_request'
    || !registrationIdentityValid) {
    throw new TypeError('trusted tool receipt set is invalid');
  }
  const readback = isRecord(result)
    && result.success === true
    && result.status === 'ok'
    && result.request_id === requestId
    && result.effective_request_id === effectiveRequestId
    && result.trade_id === tradeId
    && sameValue(result.final_plan, registration.desired_after)
    && sameValue(result.final_period, registration.desired_period)
    && confirmedRegistrationComponentReadback(result, registration)
    && confirmedRegistrationRequestReadback(result, registration)
    && result.customerNotificationAttempted === false
    && result.customerNotificationSent === false
    && isRecord(result.authoritative);
  if (outcome === 'success' && (!tradeId || !effectiveRequestId || !readback
    || (bootstrapped && !receipt.applied_stages?.includes('pending_request_bootstrap')))) {
    throw new TypeError('trusted tool receipt set is invalid');
  }
  const before = equipmentText(registration.expected_before);
  const after = equipmentText(registration.desired_after);
  const changeItems = [];
  if (before !== null || after !== null) {
    changeItems.push({ field: 'equipment', before, after });
  }
  const beforePeriod = normalizedRegistrationPeriod(registration.expected_period);
  const afterPeriod = normalizedRegistrationPeriod(registration.desired_period);
  if (beforePeriod.start !== afterPeriod.start) {
    changeItems.push({ field: 'start_at', before: beforePeriod.start, after: afterPeriod.start });
  }
  if (beforePeriod.end !== afterPeriod.end) {
    changeItems.push({ field: 'end_at', before: beforePeriod.end, after: afterPeriod.end });
  }
  const label = tradeId || (bootstrapped ? effectiveRequestId : requestId) || effectiveRequestId
    || safeOptionalText(durableJob.room_key, 160) || safeOptionalText(durableJob.job_id, 160);
  const summary = outcomeSummary({
    outcome,
    success: `예약 ${label}을 등록했습니다.`,
    partial: `예약 ${label} 등록이 부분 반영되었습니다.`,
    failed: `예약 ${label} 등록이 실패했습니다.`,
    blocked: `예약 ${label} 등록이 차단되었습니다.`
  });
  return normalizeKakaoAutomationAuditEvent({
    event_key: authorityEventKey('reservation_registration', operation.operation_id),
    job_id: durableJob.job_id,
    room_revision: durableJob.room_revision,
    operation_id: operation.operation_id,
    receipt_id: receipt.receipt_id,
    occurred_at: operation.completed_at || receipt.created_at,
    effect_type: 'reservation_registration',
    action_type: 'create',
    outcome,
    customer_label: customerLabel,
    target_type: tradeId ? 'trade' : (effectiveRequestId || requestId) ? 'request' : 'room',
    target_id: label,
    summary,
    change_items: changeItems,
    outbound_text: null,
    evidence: failureEvidence(receipt, {
      schema: receipt.schema,
      status: receipt.status,
      readback
    }),
    source_message_at: sourceMessageAt(durableJob),
    historical_import: Boolean(historicalImport)
  });
}

function buildUnresolvedConfirmedRegistrationEvent({
  durableJob, operation, target, customerLabel, historicalImport
}) {
  const targetId = target.target_id;
  const label = targetId || null;
  return normalizeKakaoAutomationAuditEvent({
    event_key: authorityEventKey('reservation_registration', operation.operation_id),
    job_id: durableJob.job_id,
    room_revision: durableJob.room_revision,
    operation_id: operation.operation_id,
    receipt_id: null,
    // A late exact receipt updates the durable job timestamp. The unresolved
    // fact itself began when this immutable operation reservation was created.
    occurred_at: operation.created_at,
    effect_type: 'reservation_registration',
    action_type: 'create',
    outcome: 'partial_success',
    customer_label: customerLabel,
    target_type: target.target_type,
    target_id: targetId,
    summary: label
      ? `예약 ${label} 자동처리 결과를 확인해야 합니다.`
      : '예약 자동처리 결과를 확인해야 합니다.',
    change_items: [],
    outbound_text: null,
    evidence: {
      schema: 'village-confirmed-reservation-commit-receipt/v1',
      status: 'unresolved',
      readback: false,
      attempted_stage: 'receipt_persistence',
      error_type: 'confirmation_operation_unresolved'
    },
    source_message_at: sourceMessageAt(durableJob),
    historical_import: Boolean(historicalImport)
  });
}

function buildDocumentEvent({ durableJob, operation, receipt, customerLabel, historicalImport }) {
  const outcome = statusOutcome(receipt.status);
  const tradeId = safeOptionalText(receipt.trade_id, 160);
  const documentType = receipt.document_type;
  const readback = receipt.authoritative_document_result;
  if (!tradeId || !['quote', 'contract'].includes(documentType)) throw new TypeError('trusted tool receipt set is invalid');
  const readbackMatches = isRecord(readback)
    && readback.status === 'OK'
    && readback.tradeID === receipt.trade_id
    && readback.taxMode === receipt.tax_mode;
  if (outcome === 'success' && !readbackMatches) throw new TypeError('trusted tool receipt set is invalid');
  const documentName = documentType === 'quote' ? '견적서' : '계약서';
  const summary = outcomeSummary({
    outcome,
    success: `${documentName} ${tradeId}을 전송했습니다.`,
    partial: `${documentName} ${tradeId} 전송이 부분 완료되었습니다.`,
    failed: `${documentName} ${tradeId} 전송이 실패했습니다.`,
    blocked: `${documentName} ${tradeId} 전송이 차단되었습니다.`
  });
  const taxMode = safeOptionalText(receipt.tax_mode, 100);
  return normalizeKakaoAutomationAuditEvent({
    event_key: authorityEventKey('document_send', operation.operation_id),
    job_id: durableJob.job_id,
    room_revision: durableJob.room_revision,
    operation_id: operation.operation_id,
    receipt_id: receipt.receipt_id,
    occurred_at: operation.completed_at || receipt.created_at,
    effect_type: 'document_send',
    action_type: 'send',
    outcome,
    customer_label: customerLabel,
    target_type: 'document',
    target_id: tradeId,
    summary,
    change_items: taxMode ? [{ field: 'tax_mode', before: null, after: taxMode }] : [],
    outbound_text: null,
    evidence: failureEvidence(receipt, {
      schema: receipt.schema,
      status: receipt.status,
      readback: readbackMatches
    }),
    source_message_at: sourceMessageAt(durableJob),
    historical_import: Boolean(historicalImport)
  });
}

function replyReadbackProof({ durableJob, applied }) {
  const candidates = [
    durableJob?.application?.applied_audit?.auto_reply_readback,
    applied?.auto_reply_readback,
    applied?.autoReplyResult?.readbackReceipt,
    applied?.auto_reply_result?.readback_receipt
  ];
  for (const candidate of candidates) {
    if (isRecord(candidate)) return candidate;
  }
  return null;
}

function buildReplyEvent({ durableJob, proof, customerLabel, historicalImport }) {
  if (proof.schema !== 'kakao-auto-reply-readback/v1'
    || typeof proof.receipt_id !== 'string'
    || !REPLY_RECEIPT_PATTERN.test(proof.receipt_id)
    || proof.readback_confirmed !== true
    || typeof proof.text !== 'string'
    || typeof proof.text_sha256 !== 'string'
    || !HASH_PATTERN.test(proof.text_sha256)
    || createHash('sha256').update(proof.text).digest('hex') !== proof.text_sha256) {
    return null;
  }
  try {
    return normalizeKakaoAutomationAuditEvent({
      event_key: authorityEventKey('auto_reply', proof.receipt_id),
      job_id: durableJob.job_id,
      room_revision: durableJob.room_revision,
      operation_id: null,
      receipt_id: proof.receipt_id,
      occurred_at: proof.confirmed_at,
      effect_type: 'auto_reply',
      action_type: 'send',
      outcome: 'success',
      customer_label: customerLabel,
      target_type: 'room',
      target_id: null,
      summary: '카카오 답변을 전송했습니다.',
      change_items: [],
      outbound_text: proof.text,
      evidence: { schema: proof.schema, status: 'sent', readback: true },
      source_message_at: proof.source_message_at ?? sourceMessageAt(durableJob),
      historical_import: Boolean(historicalImport)
    });
  } catch {
    return null;
  }
}

export function buildKakaoAutomationAuditEvents({
  durableJob,
  prepared = null,
  applied = null,
  historicalImport = false
} = {}) {
  if (!isRecord(durableJob)) throw new TypeError('durable job is required');
  const proof = replyReadbackProof({ durableJob, applied });
  const unresolvedRegistration = unresolvedConfirmedRegistrationOperation(durableJob);
  const customerLabel = safeCustomerLabel({ durableJob, prepared, proof })
    || (unresolvedRegistration ? '고객 식별 미확정' : null);
  if (!customerLabel) return [];

  const events = [];
  const tool = unresolvedRegistration ? null : exactToolReceipt(durableJob);
  if (tool) {
    const args = { durableJob, ...tool, customerLabel, historicalImport };
    if (tool.operation.tool === 'confirmation_request') events.push(...buildConfirmationEvents(args));
    else if (tool.operation.tool === 'confirmed_reservation_commit') events.push(buildConfirmedRegistrationEvent(args));
    else if (tool.operation.tool === 'registered_reservation_change') events.push(buildRegisteredEvent(args));
    else if (tool.operation.tool === 'document_send') events.push(buildDocumentEvent(args));
  }
  if (unresolvedRegistration) {
    events.push(buildUnresolvedConfirmedRegistrationEvent({
      durableJob,
      ...unresolvedRegistration,
      customerLabel,
      historicalImport
    }));
  }
  if (proof) {
    const replyEvent = buildReplyEvent({ durableJob, proof, customerLabel, historicalImport });
    if (replyEvent) events.push(replyEvent);
  }
  return events;
}

function safeError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function parseJsonResponse(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    throw safeError('automation_audit_store_response_invalid', 'automation audit store response is invalid');
  }
}

function normalizeDatabaseRow(row) {
  if (!isRecord(row)) throw invalidAuditEvent();
  const { recorded_at: recordedAt, ...event } = row;
  canonicalTimestamp(recordedAt);
  return normalizeKakaoAutomationAuditEvent(event);
}

function sameEvent(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function projectionConflict() {
  return safeError('automation_audit_projection_conflict', 'automation audit projection conflicts with durable evidence');
}

export function createKakaoAutomationAuditStore({
  supabaseUrl,
  serviceRoleKey,
  fetchImpl = fetch,
  timeoutMs = 7000
} = {}) {
  let base;
  try {
    base = new URL(supabaseUrl);
  } catch {
    throw new Error('automation audit Supabase URL is invalid');
  }
  if (base.protocol !== 'https:') throw new Error('automation audit Supabase URL is invalid');
  if (typeof serviceRoleKey !== 'string' || !serviceRoleKey.trim()) {
    throw new Error('automation audit service role credential is required');
  }
  if (typeof fetchImpl !== 'function') throw new TypeError('automation audit fetch implementation is required');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60000) {
    throw new TypeError('automation audit timeout is invalid');
  }
  const root = base.toString().replace(/\/$/, '');
  const headers = {
    apikey: serviceRoleKey,
    authorization: `Bearer ${serviceRoleKey}`,
    'content-type': 'application/json'
  };

  async function request(url, init) {
    let response;
    try {
      response = await fetchImpl(url, {
        ...init,
        headers: { ...headers, ...(init.headers || {}) },
        signal: init.signal || AbortSignal.timeout(timeoutMs)
      });
    } catch {
      throw safeError('automation_audit_store_unavailable', 'automation audit store request failed');
    }
    const text = await response.text();
    if (!response.ok) {
      throw safeError('automation_audit_store_rejected', `automation audit store rejected request with HTTP ${response.status}`);
    }
    return parseJsonResponse(text);
  }

  return Object.freeze({
    async insertAndReadback(values) {
      if (!Array.isArray(values) || values.length < 1 || values.length > 100) {
        throw new TypeError('automation audit event batch is invalid');
      }
      const events = values.map(normalizeKakaoAutomationAuditEvent);
      if (new Set(events.map((event) => event.event_key)).size !== events.length) {
        throw new TypeError('automation audit event batch is invalid');
      }
      const insertUrl = `${root}/rest/v1/kakao_automation_audit_events?on_conflict=event_key`;
      const insertedRows = await request(insertUrl, {
        method: 'POST',
        headers: { Prefer: 'resolution=ignore-duplicates,return=representation' },
        body: JSON.stringify(events)
      });
      if (!Array.isArray(insertedRows)) throw safeError('automation_audit_store_response_invalid', 'automation audit store response is invalid');
      const insertedKeys = new Set();
      for (const row of insertedRows) {
        const normalized = row?.recorded_at === undefined
          ? normalizeKakaoAutomationAuditEvent(row)
          : normalizeDatabaseRow(row);
        const expected = events.find((event) => event.event_key === normalized.event_key);
        if (!expected || !sameEvent(expected, normalized)) throw projectionConflict();
        insertedKeys.add(normalized.event_key);
      }
      const keys = events.map((event) => `"${encodeURIComponent(event.event_key)}"`).join(',');
      const select = EVENT_FIELDS.join(',');
      const readUrl = `${root}/rest/v1/kakao_automation_audit_events?select=${select},recorded_at&event_key=in.(${keys})`;
      const readRows = await request(readUrl, { method: 'GET' });
      if (!Array.isArray(readRows)) throw projectionConflict();
      const byKey = new Map();
      for (const row of readRows) {
        const normalized = normalizeDatabaseRow(row);
        if (byKey.has(normalized.event_key)) throw projectionConflict();
        byKey.set(normalized.event_key, normalized);
      }
      for (const expected of events) {
        const actual = byKey.get(expected.event_key);
        if (!actual || !sameEvent(expected, actual)) throw projectionConflict();
      }
      return {
        inserted: insertedKeys.size,
        existing: events.length - insertedKeys.size,
        events
      };
    },

    async recordProjectionStatus({ pendingCount, conflictCount, oldestPendingAt, lastSuccessAt, updatedAt }) {
      const body = {
        pending_count: nonNegativeInteger(pendingCount),
        conflict_count: nonNegativeInteger(conflictCount),
        oldest_pending_at: canonicalTimestamp(oldestPendingAt, { nullable: true }),
        ...(lastSuccessAt === undefined ? {} : {
          last_success_at: canonicalTimestamp(lastSuccessAt, { nullable: true })
        }),
        updated_at: canonicalTimestamp(updatedAt)
      };
      const url = `${root}/rest/v1/kakao_automation_audit_projection_status?singleton=eq.true`;
      const rows = await request(url, {
        method: 'PATCH',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify(body)
      });
      if (!Array.isArray(rows) || rows.length !== 1 || !isRecord(rows[0]) || rows[0].singleton !== true) {
        throw safeError('automation_audit_store_response_invalid', 'automation audit store response is invalid');
      }
      const row = rows[0];
      const normalized = {
        singleton: true,
        pending_count: nonNegativeInteger(row.pending_count),
        conflict_count: nonNegativeInteger(row.conflict_count),
        oldest_pending_at: canonicalTimestamp(row.oldest_pending_at, { nullable: true }),
        last_success_at: canonicalTimestamp(row.last_success_at, { nullable: true }),
        updated_at: canonicalTimestamp(row.updated_at)
      };
      if (normalized.pending_count !== body.pending_count
        || normalized.conflict_count !== body.conflict_count
        || normalized.oldest_pending_at !== body.oldest_pending_at
        || (Object.hasOwn(body, 'last_success_at') && normalized.last_success_at !== body.last_success_at)
        || normalized.updated_at !== body.updated_at) {
        throw projectionConflict();
      }
      return normalized;
    }
  });
}
