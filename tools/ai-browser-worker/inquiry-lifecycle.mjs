import { createHash } from 'node:crypto';
import identityHelpers from '../../scripts/windows/pending-customer-identity.js';

const dispositions = new Set(['new_inquiry', 'pending_revision', 'registered_change_inquiry', 'already_applied', 'inventory_only', 'declined', 'independent_rental']);
const record = (value) => value && typeof value === 'object' && !Array.isArray(value);
const text = (value) => typeof value === 'string' ? value.normalize('NFKC').trim() : '';
const canonical = (value) => Array.isArray(value) ? value.map(canonical)
  : record(value) ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;

export const INQUIRY_LIFECYCLE_PROMPT = `INQUIRY LIFECYCLE — read context, reconcile, then choose one operation:
- Native Hermes owns semantic interpretation. Read all same-room messages in chronological order, resolve the latest still-valid equipment plan and every distinct rental period, and compare live 확인요청 + 계약마스터 + 스케줄상세 before choosing a write. A missing RQ can mean it was registered/removed; it is not evidence of a new inquiry. Quote delivery, payment discussion, staff substitutions, and customer acknowledgements require reconciliation of the ongoing booking, not catch-up recreation of its old request.
- Set inquiry_disposition to new_inquiry, pending_revision, registered_change_inquiry, already_applied, inventory_only, declined, or independent_rental. These are your semantic decisions, never keyword triggers. Already fulfilled equipment, a declined proposal, staff-confirmed non-owned equipment, and a bare inventory question without a live rental request do not create an RQ. Catalog absence is not proof of a particular substitute: distinguish truly unknown wording from a known non-owned model; retain genuine unresolved rental requests for review, but do not turn every catalog question into a reservation.
- For new_inquiry, capture the complete currently requested plan immediately without waiting for staff approval. Genuine unknown fields stay blank. First use the shop single-session default: an otherwise unqualified dated pickup request (for example a date plus '오전 8시부터') means one 24-hour session ending the following day at the same time. Hermes calculates both dates/times and sets sheet_row_candidate.schedule_basis=shop_single_session_default. Explicit duration/end, current booking period, or contrary conversation takes priority; never overwrite those with the default. Missing pickup date/time is still unknown. Do not add a default to a question that is not a rental inquiry.
- For pending_revision, preserve the existing unregistered inquiry as one evolving request. Reconcile substitutions/reductions with the full conversation: a proposal to replace unavailable units is not an additive list retaining those units. Read the exact RQ full top-level plan, set components, period, phone, discount, memo and extra request. Copy unchanged commercial fields. Use equipment_write_mode=replace_full_plan and customer_requested_pending_revision with target_scope=pending_request, request_id, expected_before [{name,quantity}], expected_set_components [{set_item,component_item,quantity}], expected_period {start_date,start_time,end_date,end_time}, source_evidence {customer_request,conversation_revision,conversation_evidence_hash,customer_message_ids}. Copy ordered customer DOM texts/IDs and snapshot hash exactly. Put only this RQ in existing_confirm_request_ids. This revises an inquiry only; it does not authorize registration or a registered trade change. Staff authorization for registration still uses the existing commit operation.
- For registered_change_inquiry, first compare requested items/quantities to the live registered schedule. Already-applied additions/substitutions are already_applied with no write. A genuinely unapplied change may have one inquiry record and later use the staff-confirmed registered route. Never duplicate the whole existing booking, replay a previously applied delta, or reset already_registered to escape a validation error. Independent_rental is only an explicitly separate rental with source evidence in inquiry_source_evidence; matching customer/dates alone neither grants nor denies that interpretation.
- Multiple periods: plan them ALL before the first tool call. One village_confirmation_request call may carry decision.confirmation_requests=[full child decision per distinct period] (2 to 8). Keep the outer should_write_to_sheet=true, safety_checks and sheet_row_candidate equal to the first child's compatible transport fields. Every child has its own complete plan, period and catalog evidence. This is one durable operation; never verify/write period one and then call again for period two. Inspect every child result/request_id; partial_success is incomplete, preserve completed IDs and never replay. For a single period omit confirmation_requests.
- A correlated successful receipt remains authoritative even if a later attempted call conflicts. Do not say '입력 실패' when the first receipt proves creation. Use read-only lookup for further verification; the mutating confirmation tool is not a general read tool. Do not call it to pre-verify an operation or to reset a consumed lease.
- DOM read dividers ('여기까지 읽었습니다'), attachment placeholders and timestamps are UI metadata, never customer or staff message text. Preserve exact message IDs and text. A role of unknown is missing extractor metadata: determine the speaker from the full conversation and supplied layout, then cite the exact customer IDs; it does not automatically block a pending revision. Known opposing sender roles must not be contradicted. A later acknowledgement must not erase pending business work, but does not create another inquiry. No duplicate customer reply after a staff answer.
`;

function validDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00Z`))
    && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
}

function periodValid(period) {
  return record(period) && ['start_date', 'end_date'].every((key) => validDate(text(period[key])))
    && ['start_time', 'end_time'].every((key) => /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(text(period[key])))
    && Date.parse(`${period.end_date}T${period.end_time}:00Z`) > Date.parse(`${period.start_date}T${period.start_time}:00Z`);
}

function baselinePeriodValid(period) {
  if (!record(period)) return false;
  const keys = ['start_date','start_time','end_date','end_time'];
  if (keys.some(key => !Object.hasOwn(period,key) || typeof period[key] !== 'string')) return false;
  if (['start_date','end_date'].some(key => period[key] !== '' && !validDate(period[key]))) return false;
  if (['start_time','end_time'].some(key => period[key] !== '' && !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(period[key]))) return false;
  return keys.some(key => period[key] === '') || periodValid(period);
}

export function validateCustomerInquiryEvidence(evidence, { roomRevision, roomSnapshot } = {}) {
  const errors = [];
  if (!record(evidence)) return ['customer inquiry source_evidence is required'];
  const ids = evidence.customer_message_ids;
  if (!text(evidence.customer_request) || evidence.customer_request.length > 2000) errors.push('customer_request is required and bounded');
  if (!Number.isSafeInteger(evidence.conversation_revision) || evidence.conversation_revision < 1
    || (roomRevision !== undefined && evidence.conversation_revision !== Number(roomRevision))) errors.push('customer inquiry revision must match the current room revision');
  if (!/^[a-f0-9]{64}$/.test(evidence.conversation_evidence_hash || '')) errors.push('customer inquiry evidence hash is required');
  if (!Array.isArray(ids) || !ids.length || ids.length > 30 || new Set(ids).size !== ids.length
    || ids.some((id) => typeof id !== 'string' || !/^[A-Za-z0-9._:-]{1,160}$/.test(id))) errors.push('customer_message_ids must be exact unique DOM IDs');
  if (roomSnapshot === undefined) return errors;
  const conversation = roomSnapshot?.navigation?.conversation_evidence || {};
  const hash = createHash('sha256').update(JSON.stringify(canonical({
    roomKey: String(roomSnapshot?.roomKey ?? '').trim(), roomRevision: Number(roomSnapshot?.roomRevision || 0),
    title: String(conversation.title ?? '').trim(), hintMatched: conversation.hint_matched === true,
    visibleText: String(conversation.visible_static_text_tail ?? ''), messages: conversation.messages
  }))).digest('hex');
  if (roomSnapshot?.schema !== 'kakao-room-snapshot/v1' || roomSnapshot.roomRevision !== evidence.conversation_revision
    || roomSnapshot.evidenceHash !== evidence.conversation_evidence_hash || hash !== evidence.conversation_evidence_hash) errors.push('customer inquiry evidence must bind the immutable room snapshot');
  const messages = Array.isArray(conversation.messages) ? conversation.messages : [];
  const byId = new Map(messages.map((message) => [message.message_id, message]));
  const selected = Array.isArray(ids) ? ids.map((id) => byId.get(id)) : [];
  const normalizeMessage = (value) => String(value ?? '').replace(/\r\n/g, '\n').trim();
  if (byId.size !== messages.length || !selected.length || selected.some((message, index) => !message
    || !['customer', 'unknown'].includes(message.role) || !Number.isSafeInteger(message.order)
    || (index > 0 && selected[index - 1]?.order >= message.order)
    || message.text_hash !== createHash('sha256').update(normalizeMessage(message.text)).digest('hex'))) errors.push('customer inquiry IDs must refer to ordered customer messages');
  if (selected.map((message) => normalizeMessage(message?.text)).join('\n') !== normalizeMessage(evidence.customer_request)) errors.push('customer_request must equal the selected DOM message text');
  return errors;
}

export function validatePendingInquiryRevision(decision, options = {}) {
  const revision = decision?.customer_requested_pending_revision;
  if (revision === undefined || revision === null) return [];
  if (!record(revision)) return ['customer_requested_pending_revision must be an object'];
  const errors = validateCustomerInquiryEvidence(revision.source_evidence, options);
  try {
    const identity = identityHelpers.normalizePendingCustomerIdentity(revision.customer_identity_update, revision.source_evidence?.customer_request);
    if (identity && (text(identity.name) !== text(decision.sheet_row_candidate?.customer_name) ||
        identity.phone.replace(/\D/g, '') !== String(decision.sheet_row_candidate?.phone || '').replace(/\D/g, ''))) {
      errors.push('customer_identity_update must match the final sheet customer');
    }
  } catch (error) { errors.push(error.message); }
  const ids = decision.existing_confirm_request_ids;
  if (revision.target_scope !== 'pending_request' || !/^RQ-\d{6}-\d{3}$/.test(revision.request_id || '')) errors.push('customer revision must target one exact pending RQ');
  if (!Array.isArray(ids) || ids.length !== 1 || ids[0] !== revision.request_id) errors.push('customer revision must match existing_confirm_request_ids');
  if (decision.should_write_to_sheet !== true || decision.reservation_inquiry?.already_registered !== false
    || decision.sheet_row_candidate?.equipment_write_mode !== 'replace_full_plan'
    || decision.staff_confirmed_mutation || decision.staff_confirmed_registration) errors.push('customer revision only authorizes a pending full-plan replacement');
  if (!baselinePeriodValid(revision.expected_period)) errors.push('customer revision requires an exact expected_period');
  if (!Array.isArray(revision.expected_before) || !revision.expected_before.length
    || revision.expected_before.some((item) => !record(item) || !text(item.name) || !Number.isInteger(item.quantity) || item.quantity <= 0)) errors.push('customer revision requires a full expected_before plan');
  if (!Array.isArray(revision.expected_set_components) || revision.expected_set_components.some((item) => !record(item)
    || !text(item.set_item) || !text(item.component_item) || !Number.isInteger(item.quantity) || item.quantity <= 0)) errors.push('customer revision requires exact expected_set_components');
  return errors;
}

export function inquiryLifecycleErrors(decision, options = {}) {
  const errors = validatePendingInquiryRevision(decision, options);
  const disposition = decision?.inquiry_disposition;
  if (disposition !== undefined && !dispositions.has(disposition)) errors.push('inquiry_disposition is invalid');
  if (decision?.should_write_to_sheet === true && ['already_applied', 'inventory_only', 'declined'].includes(disposition)) errors.push(`${disposition} does not authorize a confirmation request`);
  if (decision?.should_write_to_sheet === true && disposition === 'pending_revision'
    && !decision.customer_requested_pending_revision && !decision.staff_confirmed_mutation) errors.push('pending_revision requires its exact typed revision');
  if (decision?.should_write_to_sheet === true && disposition === 'independent_rental') errors.push(...validateCustomerInquiryEvidence(decision.inquiry_source_evidence, options));
  const row = decision?.sheet_row_candidate || {};
  if (decision?.should_write_to_sheet === true && row.schedule_basis === 'shop_single_session_default') {
    const period = { start_date: row.start_date, start_time: row.pickup_time, end_date: row.end_date, end_time: row.return_time };
    if (!periodValid(period) || Date.parse(`${row.end_date}T${row.return_time}:00Z`)
      - Date.parse(`${row.start_date}T${row.pickup_time}:00Z`) !== 86400000) errors.push('shop_single_session_default requires exactly one 24-hour session');
  }
  return errors;
}
