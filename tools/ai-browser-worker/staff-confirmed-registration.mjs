import { createHash, randomUUID as defaultRandomUUID } from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { normalizePendingCustomerIdentity, normalizePendingBaselinePeriod } = require('../../scripts/windows/pending-customer-identity.js');
const { commitConfirmedReservation: defaultCommitConfirmedReservation } = require('../../scripts/windows/village-confirm-request.js');

const REGISTRATION_FIELDS = new Set([
  'confirmed', 'target_scope', 'request_id', 'source_evidence',
  'expected_before', 'expected_period', 'desired_after', 'desired_period',
  'expected_set_components', 'set_component_selections', 'pending_request_candidate', 'customer_identity_update'
]);
const EVIDENCE_FIELDS = new Set([
  'customer_request', 'staff_confirmation', 'conversation_revision',
  'conversation_evidence_hash', 'customer_message_ids', 'staff_message_ids', 'post_confirmation_review'
]);
const PERIOD_FIELDS = new Set(['start_date', 'start_time', 'end_date', 'end_time']);
const PLAN_FIELDS = new Set(['name', 'quantity']);
const PENDING_REQUEST_CANDIDATE_FIELDS = new Set([
  'customer_name', 'phone', 'discount_type', 'memo', 'extra_request'
]);
const PENDING_REQUEST_CANDIDATE_REQUIRED_FIELDS = new Set([
  'customer_name', 'phone', 'discount_type', 'memo', 'extra_request'
]);
const SET_COMPONENT_SELECTION_FIELDS = new Set(['set_item', 'component_item', 'selected_item']);
const SET_COMPONENT_BASELINE_FIELDS = new Set(['set_item', 'component_item', 'quantity']);
const REQUEST_ID = /^RQ-\d{6}-\d{3}$/;
const DISCOUNT_TYPES = new Set(['일반', '학생', '개인사업자/프리랜서', '단골', '제휴']);

function objectErrors(value, allowed, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [`${label} must be an object`];
  return Object.keys(value)
    .filter((key) => !allowed.has(key))
    .map((key) => `${label}.${key} is unsupported`);
}

function normalizedText(value) {
  return String(value ?? '').normalize('NFKC').trim();
}

function normalizedConversationText(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[\t ]+/g, ' ').trim())
    .filter(Boolean)
    .join('\n')
    .trim();
}

function evidenceMessageIdErrors(value, label) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 20) {
    return [`${label} must contain 1-20 message IDs`];
  }
  const errors = [];
  const seen = new Set();
  value.forEach((candidate, index) => {
    const messageId = normalizedText(candidate);
    if (!/^[A-Za-z0-9._:-]{1,160}$/.test(messageId)) errors.push(`${label}[${index}] is invalid`);
    if (seen.has(messageId)) errors.push(`${label}[${index}] is duplicated`);
    seen.add(messageId);
  });
  return errors;
}

function snapshotEvidenceHash(snapshot) {
  const conversation = snapshot?.navigation?.conversation_evidence || {};
  return createHash('sha256').update(JSON.stringify(canonicalValue({
    roomKey: normalizedText(snapshot?.roomKey),
    roomRevision: Number(snapshot?.roomRevision || 0),
    title: normalizedText(conversation.title),
    hintMatched: conversation.hint_matched === true,
    visibleText: String(conversation.visible_static_text_tail ?? ''),
    messages: conversation.messages
  }))).digest('hex');
}

export function validateStaffConfirmedRegistrationEvidence(evidence, {
  roomRevision,
  roomSnapshot
} = {}) {
  const errors = objectErrors(evidence, EVIDENCE_FIELDS, 'source_evidence');
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) return errors;

  const customerRequest = normalizedConversationText(evidence.customer_request);
  const staffConfirmation = normalizedConversationText(evidence.staff_confirmation);
  const revision = Number(evidence.conversation_revision);
  const evidenceHash = normalizedText(evidence.conversation_evidence_hash);
  if (!customerRequest || customerRequest.length > 2_000) errors.push('source_evidence.customer_request is invalid');
  if (!staffConfirmation || staffConfirmation.length > 2_000) errors.push('source_evidence.staff_confirmation is invalid');
  if (!Number.isSafeInteger(revision) || revision < 1) {
    errors.push('source_evidence.conversation_revision must be a positive integer');
  } else if (roomRevision !== undefined && revision !== Number(roomRevision)) {
    errors.push('source_evidence.conversation_revision must match the current room revision');
  }
  if (!/^[a-f0-9]{64}$/.test(evidenceHash)) {
    errors.push('source_evidence.conversation_evidence_hash must be a lowercase SHA-256');
  }
  errors.push(...evidenceMessageIdErrors(evidence.customer_message_ids, 'source_evidence.customer_message_ids'));
  errors.push(...evidenceMessageIdErrors(evidence.staff_message_ids, 'source_evidence.staff_message_ids'));
  const continuation = evidence.post_confirmation_review;
  if (continuation !== undefined) {
    errors.push(...objectErrors(continuation, new Set(['message_ids', 'reservation_unchanged', 'reason']), 'post_confirmation_review'));
    errors.push(...evidenceMessageIdErrors(continuation?.message_ids, 'post_confirmation_review.message_ids'));
    if (continuation?.reservation_unchanged !== true) errors.push('post_confirmation_review must confirm the reservation is unchanged');
    if (typeof continuation?.reason !== 'string' || !continuation.reason.trim() || continuation.reason.length > 1000) {
      errors.push('post_confirmation_review.reason must explain why the later messages do not change the approved reservation');
    }
  }

  if (roomSnapshot === undefined) return errors;
  if (!roomSnapshot || typeof roomSnapshot !== 'object' || Array.isArray(roomSnapshot)
    || roomSnapshot.schema !== 'kakao-room-snapshot/v1') {
    errors.push('source_evidence requires the current immutable Kakao room snapshot');
    return errors;
  }
  if (!Number.isSafeInteger(Number(roomSnapshot.roomRevision)) || Number(roomSnapshot.roomRevision) !== revision) {
    errors.push('source_evidence snapshot revision does not match');
  }
  if (normalizedText(roomSnapshot.evidenceHash) !== evidenceHash
    || snapshotEvidenceHash(roomSnapshot) !== evidenceHash) {
    errors.push('source_evidence conversation evidence hash does not match the snapshot');
  }

  const messages = roomSnapshot?.navigation?.conversation_evidence?.messages;
  if (!Array.isArray(messages) || messages.length < 1 || messages.length > 100) {
    errors.push('source_evidence snapshot messages are invalid');
    return errors;
  }
  const byId = new Map();
  let lastOrder = 0;
  for (const [index, message] of messages.entries()) {
    const messageId = normalizedText(message?.message_id);
    const messageText = normalizedConversationText(message?.text);
    const order = Number(message?.order);
    if (!/^[A-Za-z0-9._:-]{1,160}$/.test(messageId) || byId.has(messageId)
      || !['customer', 'staff', 'unknown'].includes(message?.role)
      || !Number.isSafeInteger(order) || order <= lastOrder
      || !messageText || messageText.length > 2_000
      || normalizedText(message?.text_hash) !== createHash('sha256').update(messageText).digest('hex')) {
      errors.push(`source_evidence snapshot message ${index} is invalid`);
      continue;
    }
    lastOrder = order;
    byId.set(messageId, { ...message, message_id: messageId, order, text: messageText });
  }

  const customerIds = Array.isArray(evidence.customer_message_ids)
    ? evidence.customer_message_ids.map(normalizedText)
    : [];
  const staffIds = Array.isArray(evidence.staff_message_ids)
    ? evidence.staff_message_ids.map(normalizedText)
    : [];
  const selectedCustomers = customerIds.map((id) => byId.get(id));
  const selectedStaff = staffIds.map((id) => byId.get(id));
  if (customerIds.some((id) => staffIds.includes(id))) {
    errors.push('source_evidence customer and staff message IDs must not overlap');
  }
  // Unknown is missing DOM metadata, not a contradictory sender. Hermes selects
  // the speakers from the full conversation; a known opposing role still conflicts.
  if (selectedCustomers.some((message) => !message || message.role === 'staff')) {
    errors.push('source_evidence.customer_message_ids must reference existing messages without a conflicting staff role');
  }
  if (selectedStaff.some((message) => !message || message.role === 'customer')) {
    errors.push('source_evidence.staff_message_ids must reference existing messages without a conflicting customer role');
  }
  const ordered = (selected) => selected.every((message, index) => (
    message && (index === 0 || selected[index - 1]?.order < message.order)
  ));
  if (!ordered(selectedCustomers)) errors.push('source_evidence.customer_message_ids must follow DOM order');
  if (!ordered(selectedStaff)) errors.push('source_evidence.staff_message_ids must follow DOM order');
  // Whether approval remains applicable is part of Hermes' confirmed decision.
  // Message position cannot decide whether a quote, thanks, correction or later
  // staff reply changes that authorization. Keep legacy review data verifiable
  // when supplied, but do not require a second attestation to permit normal work.
  if (continuation !== undefined) {
    const selectedApproval = selectedStaff.at(-1);
    const laterIds = [...byId.values()]
      .filter(message => selectedApproval && message.order > selectedApproval.order)
      .map(message => message.message_id);
    if (!laterIds.length || JSON.stringify(continuation.message_ids) !== JSON.stringify(laterIds)) {
      errors.push('post_confirmation_review must reference every later DOM message exactly in order');
    }
  }
  if (selectedCustomers.every(Boolean)
    && selectedCustomers.map((message) => message.text).join('\n') !== customerRequest) {
    errors.push('source_evidence.customer_request must exactly match selected DOM messages');
  }
  if (selectedStaff.every(Boolean)
    && selectedStaff.map((message) => message.text).join('\n') !== staffConfirmation) {
    errors.push('source_evidence.staff_confirmation must exactly match selected DOM messages');
  }
  return errors;
}

function planErrors(value, label) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 40) {
    return [`${label} must contain 1-40 complete equipment items`];
  }
  const errors = [];
  const seen = new Set();
  value.forEach((entry, index) => {
    errors.push(...objectErrors(entry, PLAN_FIELDS, `${label}[${index}]`));
    const name = normalizedText(entry?.name);
    const quantity = Number(entry?.quantity);
    if (!name || name.length > 120) errors.push(`${label}[${index}].name is invalid`);
    if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > 999) {
      errors.push(`${label}[${index}].quantity must be an integer from 1 to 999`);
    }
    if (name && seen.has(name)) errors.push(`${label}[${index}].name is duplicated`);
    seen.add(name);
  });
  return errors;
}

function validDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(normalizedText(value));
  if (!match) return false;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return date.getUTCFullYear() === Number(match[1])
    && date.getUTCMonth() === Number(match[2]) - 1
    && date.getUTCDate() === Number(match[3]);
}

function validTime(value) {
  return /^(?:[01]\d|2[0-3]):00$/.test(normalizedText(value));
}

function periodErrors(value, label) {
  const errors = objectErrors(value, PERIOD_FIELDS, label);
  if (errors.length || !value || typeof value !== 'object' || Array.isArray(value)) return errors;
  if (!validDate(value.start_date)) errors.push(`${label}.start_date must use YYYY-MM-DD`);
  if (!validTime(value.start_time)) errors.push(`${label}.start_time must use HH:00`);
  if (!validDate(value.end_date)) errors.push(`${label}.end_date must use YYYY-MM-DD`);
  if (!validTime(value.end_time)) errors.push(`${label}.end_time must use HH:00`);
  if (!errors.length) {
    const start = Date.parse(`${value.start_date}T${value.start_time}:00Z`);
    const end = Date.parse(`${value.end_date}T${value.end_time}:00Z`);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
      errors.push(`${label} end must be after start`);
    }
  }
  return errors;
}

function pendingRequestCandidateErrors(value) {
  const label = 'pending_request_candidate';
  const errors = objectErrors(value, PENDING_REQUEST_CANDIDATE_FIELDS, label);
  if (!value || typeof value !== 'object' || Array.isArray(value)) return errors;
  for (const field of PENDING_REQUEST_CANDIDATE_REQUIRED_FIELDS) {
    if (!Object.hasOwn(value, field)) errors.push(`${label}.${field} is required`);
  }
  for (const field of PENDING_REQUEST_CANDIDATE_REQUIRED_FIELDS) {
    if (Object.hasOwn(value, field) && typeof value[field] !== 'string') {
      errors.push(`${label}.${field} must be a string`);
    }
  }
  const customerName = normalizedText(value.customer_name);
  const phone = normalizedText(value.phone);
  const discountType = normalizedText(value.discount_type);
  const memo = normalizedText(value.memo);
  const extraRequest = normalizedText(value.extra_request);
  if (!customerName || customerName.length > 120) errors.push(`${label}.customer_name is invalid`);
  if (!phone || phone.length > 80) errors.push(`${label}.phone is invalid`);
  if (!DISCOUNT_TYPES.has(discountType)) errors.push(`${label}.discount_type is invalid`);
  if (memo.length > 500) errors.push(`${label}.memo is too long`);
  if (extraRequest.length > 1_000) errors.push(`${label}.extra_request is too long`);
  return errors;
}

function setComponentBaselineErrors(value, label = 'expected_set_components') {
  if (!Array.isArray(value) || value.length > 120) {
    return [`${label} must contain 0-120 exact set components`];
  }
  const errors = [];
  const seen = new Set();
  value.forEach((entry, index) => {
    const entryLabel = `${label}[${index}]`;
    errors.push(...objectErrors(entry, SET_COMPONENT_BASELINE_FIELDS, entryLabel));
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return;
    for (const field of ['set_item', 'component_item']) {
      if (!Object.hasOwn(entry, field)) errors.push(`${entryLabel}.${field} is required`);
      if (Object.hasOwn(entry, field) && typeof entry[field] !== 'string') {
        errors.push(`${entryLabel}.${field} must be a string`);
      }
      const normalized = normalizedText(entry[field]);
      if (!normalized || normalized.length > 120) errors.push(`${entryLabel}.${field} is invalid`);
    }
    const quantity = Number(entry.quantity);
    if (!Object.hasOwn(entry, 'quantity')) errors.push(`${entryLabel}.quantity is required`);
    if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > 999) {
      errors.push(`${entryLabel}.quantity must be an integer from 1 to 999`);
    }
    const signature = [entry.set_item, entry.component_item].map(normalizedText).join('\u0000');
    if (seen.has(signature)) errors.push(`${entryLabel} is duplicated`);
    seen.add(signature);
  });
  return errors;
}

function setComponentSelectionErrors(value, label = 'set_component_selections') {
  if (!Array.isArray(value) || value.length > 40) {
    return [`${label} must contain 0-40 exact selections`];
  }
  const errors = [];
  const seen = new Set();
  value.forEach((selection, index) => {
    const selectionLabel = `${label}[${index}]`;
    errors.push(...objectErrors(selection, SET_COMPONENT_SELECTION_FIELDS, selectionLabel));
    if (!selection || typeof selection !== 'object' || Array.isArray(selection)) return;
    for (const field of SET_COMPONENT_SELECTION_FIELDS) {
      if (!Object.hasOwn(selection, field)) errors.push(`${selectionLabel}.${field} is required`);
      if (Object.hasOwn(selection, field) && typeof selection[field] !== 'string') {
        errors.push(`${selectionLabel}.${field} must be a string`);
      }
      const normalized = normalizedText(selection[field]);
      if (!normalized || normalized.length > 120) errors.push(`${selectionLabel}.${field} is invalid`);
    }
    const signature = [selection.set_item, selection.component_item].map(normalizedText).join('\u0000');
    if (seen.has(signature)) errors.push(`${selectionLabel} is duplicated`);
    seen.add(signature);
  });
  return errors;
}

export function validateStaffConfirmedRegistration(value, { roomRevision, roomSnapshot } = {}) {
  const errors = objectErrors(value, REGISTRATION_FIELDS, 'staff_confirmed_registration');
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { valid: false, errors };
  if (value.confirmed !== true) errors.push('confirmed must be exactly true');
  if (value.target_scope !== 'pending_request') errors.push('target_scope must be pending_request');
  const requestId = normalizedText(value.request_id).toUpperCase();
  if (REQUEST_ID.test(requestId)) {
    if (value.pending_request_candidate !== undefined && value.pending_request_candidate !== null) {
      errors.push('pending_request_candidate is forbidden when request_id identifies an existing RQ');
    }
  } else if (value.request_id === null) {
    errors.push(...pendingRequestCandidateErrors(value.pending_request_candidate));
  } else {
    errors.push('request_id must use RQ-YYMMDD-NNN or be exactly null with pending_request_candidate');
  }
  errors.push(...validateStaffConfirmedRegistrationEvidence(value.source_evidence, { roomRevision, roomSnapshot }));
  errors.push(...planErrors(value.expected_before, 'expected_before'));
  errors.push(...setComponentBaselineErrors(value.expected_set_components));
  errors.push(...setComponentSelectionErrors(value.set_component_selections));
  try { normalizePendingBaselinePeriod(value.expected_period); } catch (error) { errors.push(error.message); }
  try {
    const update = normalizePendingCustomerIdentity(value.customer_identity_update, value.source_evidence?.customer_request);
    if (update && value.request_id === null) errors.push('customer_identity_update requires an existing pending RQ');
  } catch (error) { errors.push(error.message); }
  errors.push(...planErrors(value.desired_after, 'desired_after'));
  errors.push(...periodErrors(value.desired_period, 'desired_period'));
  if (value.request_id === null && Array.isArray(value.expected_set_components)
    && value.expected_set_components.length !== 0) {
    errors.push('bootstrapped registration expected_set_components must be empty');
  }
  const desiredNames = new Set((Array.isArray(value.desired_after) ? value.desired_after : [])
    .map((item) => normalizedText(item?.name)).filter(Boolean));
  const expectedNames = new Set((Array.isArray(value.expected_before) ? value.expected_before : [])
    .map((item) => normalizedText(item?.name)).filter(Boolean));
  const baselineTargets = new Set((Array.isArray(value.expected_set_components)
    ? value.expected_set_components : []).map((entry) => (
      [entry?.set_item, entry?.component_item].map(normalizedText).join('\u0000')
    )));
  (Array.isArray(value.set_component_selections) ? value.set_component_selections : [])
    .forEach((selection, index) => {
      if (!desiredNames.has(normalizedText(selection?.set_item))) {
        errors.push(`set_component_selections[${index}].set_item must exist in desired_after`);
      }
      if (value.request_id !== null && expectedNames.has(normalizedText(selection?.set_item))) {
        const target = [selection?.set_item, selection?.component_item]
          .map(normalizedText).join('\u0000');
        if (!baselineTargets.has(target)) {
          errors.push(`set_component_selections[${index}] must target expected_set_components`);
        }
      }
    });
  return { valid: errors.length === 0, errors };
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]));
  }
  return value;
}

export function confirmedReservationCommitRequestDigest(value) {
  return createHash('sha256').update(JSON.stringify(canonicalValue(value))).digest('hex');
}

function sameCanonicalValue(left, right) {
  return JSON.stringify(canonicalValue(left)) === JSON.stringify(canonicalValue(right));
}

function canonicalComponentRows(values) {
  if (!Array.isArray(values)) return null;
  const seen = new Set();
  const rows = [];
  for (const value of values) {
    const setItem = normalizedText(value?.set_item);
    const componentItem = normalizedText(value?.component_item);
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

function canonicalAuthoritativePlan(values) {
  if (!Array.isArray(values)) return null;
  const rows = [];
  for (const value of values) {
    const name = normalizedText(value?.name);
    const quantity = Number(value?.qty ?? value?.quantity);
    if (!name || !Number.isSafeInteger(quantity) || quantity < 1) return null;
    rows.push({ name, quantity });
  }
  return rows.sort((left, right) => left.name.localeCompare(right.name));
}

function phoneKey(value) {
  return normalizedText(value).replace(/\D/g, '');
}

function exactAuthoritativeRequestReadback(result, registration) {
  const request = result?.authoritative?.request;
  const effectiveRequestId = normalizedText(result?.effective_request_id).toUpperCase();
  const tradeId = normalizedText(result?.trade_id);
  if (!request || typeof request !== 'object' || Array.isArray(request)
    || normalizedText(request.reqID).toUpperCase() !== effectiveRequestId
    || !Array.isArray(request.tradeIds)
    || !request.tradeIds.map(normalizedText).includes(tradeId)) return false;
  const requestPlan = canonicalAuthoritativePlan(request.topLevelEquipItems);
  const desiredPlan = canonicalAuthoritativePlan(registration?.desired_after);
  if (!requestPlan || !desiredPlan || !sameCanonicalValue(requestPlan, desiredPlan)) return false;
  const period = registration?.desired_period;
  if (normalizedText(request.startDate) !== normalizedText(period?.start_date)
    || normalizedText(request.startTime) !== normalizedText(period?.start_time)
    || normalizedText(request.endDate) !== normalizedText(period?.end_date)
    || normalizedText(request.endTime) !== normalizedText(period?.end_time)) return false;
  const requestComponents = canonicalComponentRows(request.setComponentItems);
  const finalComponents = canonicalComponentRows(result?.final_set_components);
  if (!requestComponents || !finalComponents
    || !sameCanonicalValue(requestComponents, finalComponents)) return false;
  const identity = registration?.customer_identity_update;
  if (identity && (normalizedText(request.name) !== normalizedText(identity.name)
    || phoneKey(request.phone) !== phoneKey(identity.phone)
    || (identity.discount_type !== undefined && normalizedText(request.discount) !== identity.discount_type))) return false;
  if (registration?.request_id === null) {
    const candidate = registration?.pending_request_candidate;
    if (!candidate || normalizedText(request.name) !== normalizedText(candidate.customer_name)
      || phoneKey(request.phone) !== phoneKey(candidate.phone)
      || normalizedText(request.discount) !== normalizedText(candidate.discount_type)
      || normalizedText(request.memo) !== normalizedText(candidate.memo)
      || normalizedText(request.extraRequest) !== normalizedText(candidate.extra_request)) return false;
  }
  return true;
}

function exactComponentReadback(result, registration) {
  const finalRows = canonicalComponentRows(result?.final_set_components);
  const scheduleRows = result?.authoritative?.registered_trade?.schedule?.rows;
  if (!finalRows || !Array.isArray(scheduleRows)) return false;
  const authoritativeRows = canonicalComponentRows(scheduleRows
    .filter((row) => row?.isComponent === true)
    .map((row) => ({ set_item: row?.setName, component_item: row?.name, quantity: row?.qty })));
  if (!authoritativeRows || !sameCanonicalValue(finalRows, authoritativeRows)) return false;
  if (registration?.request_id === null) {
    return (registration.set_component_selections || []).every((selection) => finalRows.some((row) => (
      row.set_item === normalizedText(selection?.set_item)
        && row.component_item === normalizedText(selection?.selected_item)
    )));
  }
  const expectedPlan = canonicalAuthoritativePlan(registration?.expected_before);
  const desiredPlan = canonicalAuthoritativePlan(registration?.desired_after);
  if (!expectedPlan || !desiredPlan) return false;
  if (!sameCanonicalValue(expectedPlan, desiredPlan)) {
    return (registration.set_component_selections || []).every((selection) => finalRows.some((row) => (
      row.set_item === normalizedText(selection?.set_item)
        && row.component_item === normalizedText(selection?.selected_item)
    )));
  }
  const projected = canonicalComponentRows(registration?.expected_set_components);
  if (!projected) return false;
  for (const selection of registration.set_component_selections || []) {
    const target = projected.find((row) => row.set_item === normalizedText(selection?.set_item)
      && row.component_item === normalizedText(selection?.component_item));
    if (!target) return false;
    target.component_item = normalizedText(selection?.selected_item);
  }
  return sameCanonicalValue(finalRows, canonicalComponentRows(projected));
}

function executionError(type, message, details = null) {
  return { type, message: String(message || type).slice(0, 1000), ...(details === null ? {} : { details }) };
}

export async function executeVillageConfirmedReservationCommit(request = {}, options = {}) {
  const config = request.config || {};
  const job = request.job || {};
  const requestedRevision = request.roomRevision;
  const jobId = normalizedText(job.job_id);
  const roomKey = normalizedText(job.room_key);
  if (!jobId) throw new Error('job_id is required');
  if (!roomKey) throw new Error('room_key is required');
  if (!Number.isInteger(requestedRevision) || requestedRevision <= 0) {
    throw new Error('room revision must be a positive integer');
  }
  if (!Number.isInteger(job.room_revision) || job.room_revision !== requestedRevision) {
    throw new Error('room revision does not match the job');
  }

  const dependencies = request.dependencies || {};
  const operationFence = options.operationFence || dependencies.operationFence;
  const operationId = normalizedText(operationFence?.operation_id);
  if (!operationId) throw new Error('operation fence operation_id is required');
  const uuid = dependencies.randomUUID || defaultRandomUUID;
  const now = dependencies.now || (() => new Date());
  const receiptId = normalizedText(uuid());
  if (!receiptId) throw new Error('receipt_id generation failed');
  const createdValue = now();
  const createdAt = (createdValue instanceof Date ? createdValue : new Date(createdValue)).toISOString();
  const registration = request.registration;
  const buildReceipt = ({
    status, authoritativeResult = null, appliedStages = [], attemptedStage = null, error = null
  }) => ({
    schema: 'village-confirmed-reservation-commit-receipt/v1',
    receipt_id: receiptId,
    job_id: jobId,
    room_key: roomKey,
    room_revision: requestedRevision,
    status,
    target_scope: 'pending_request',
    request_id: normalizedText(registration?.request_id).toUpperCase() || null,
    effective_request_id: normalizedText(authoritativeResult?.effective_request_id).toUpperCase() || null,
    trade_id: normalizedText(authoritativeResult?.trade_id) || null,
    authoritative_result: authoritativeResult,
    applied_stages: appliedStages,
    attempted_stage: attemptedStage,
    customer_reply: 'no_reply',
    created_at: createdAt,
    error
  });

  const validation = validateStaffConfirmedRegistration(registration, {
    roomRevision: requestedRevision,
    roomSnapshot: options.roomSnapshot || dependencies.roomSnapshot
  });
  if (!validation.valid) {
    return buildReceipt({
      status: 'failed',
      error: executionError('invalid_registration', 'staff-confirmed registration validation failed', {
        validation_errors: validation.errors
      })
    });
  }

  const assertCurrentClaim = options.assertCurrentClaim || dependencies.assertCurrentClaim || (async () => {});
  const runner = dependencies.commitConfirmedReservation || defaultCommitConfirmedReservation;
  if (typeof runner !== 'function') throw new Error('commitConfirmedReservation is unavailable');
  try {
    await assertCurrentClaim();
    const result = await runner({ config, registration, operationId });
    const replacedIds = Array.isArray(result?.replaced_request_ids) ? result.replaced_request_ids : [];
    const authoritativeAppliedStages = Array.isArray(result?.applied_stages)
      ? result.applied_stages.map(normalizedText).filter(Boolean).slice(0, 20)
      : [];
    const appliedStages = [...new Set([
      ...authoritativeAppliedStages,
      ...(registration?.request_id === null && REQUEST_ID.test(normalizedText(result?.effective_request_id).toUpperCase())
        ? ['pending_request_bootstrap'] : []),
      ...(replacedIds.length ? ['pending_request_replacement'] : []),
      ...(result?.success === true ? ['registration', 'authoritative_readback'] : [])
    ])];
    const exactSuccess = result?.schema === 'village-confirmed-reservation-commit-result/v1'
      && result.success === true
      && result.status === 'ok'
      && normalizedText(result.request_id).toUpperCase() === normalizedText(registration.request_id).toUpperCase()
      && REQUEST_ID.test(normalizedText(result.effective_request_id).toUpperCase())
      && /^\d{6}-\d{3}$/.test(normalizedText(result.trade_id))
      && sameCanonicalValue(result.final_plan, registration.desired_after)
      && sameCanonicalValue(result.final_period, registration.desired_period)
      && exactComponentReadback(result, registration)
      && exactAuthoritativeRequestReadback(result, registration)
      && result.customerNotificationAttempted === false
      && result.customerNotificationSent === false
      && result.authoritative && typeof result.authoritative === 'object' && !Array.isArray(result.authoritative);
    if (exactSuccess) {
      return buildReceipt({ status: 'ok', authoritativeResult: result, appliedStages });
    }
    const status = result?.status === 'partial_success' || replacedIds.length
      ? 'partial_success'
      : result?.status === 'blocked' ? 'blocked' : 'failed';
    return buildReceipt({
      status,
      authoritativeResult: result && typeof result === 'object' && !Array.isArray(result) ? result : null,
      appliedStages,
      attemptedStage: normalizedText(result?.attempted_stage) || null,
      error: executionError(
        normalizedText(result?.error?.type) || 'invalid_authoritative_result',
        normalizedText(result?.error?.message) || 'confirmed reservation commit returned an invalid authoritative result'
      )
    });
  } catch (error) {
    const outcomeUnknown = error?.uncertainWrite === true;
    return buildReceipt({
      status: outcomeUnknown ? 'partial_success' : 'failed',
      attemptedStage: normalizedText(error?.stage) || null,
      error: executionError(
        outcomeUnknown ? 'outcome_unknown' : 'execution_failed',
        normalizedText(error?.message) || 'confirmed reservation commit failed'
      )
    });
  }
}
