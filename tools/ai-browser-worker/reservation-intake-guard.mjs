import {createHash} from 'node:crypto';

// This checks the AI's explicit business decision; it never classifies chat text
// or invents a reservation/date. The native tool remains the only write path.
export function unrecordedReservationInquiry(result, receipts = []) {
  let decision;
  try {
    const content = String(result?.content || '');
    const json = content.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1] || content;
    decision = JSON.parse(json.replace(/^\s*FINAL_JSON\s*/, ''));
  } catch { return false; }
  const inquiry = decision?.reservation_inquiry;
  return decision?.inquiry_disposition === 'new_inquiry'
    && inquiry?.is_reservation_inquiry === true && inquiry.is_test_message !== true
    && inquiry.already_registered === false && inquiry.equipment_requested?.length > 0
    && !(decision.existing_confirm_request_ids?.length > 0)
    && !receipts.some(receipt => ['village-confirmation-receipt/v1',
      'village-confirmed-reservation-commit-receipt/v1'].includes(receipt?.schema));
}

export const RESERVATION_DATE_POLICY = `RESERVATION DATE INTERPRETATION:
- Interpret obvious date typos from the whole conversation, not a blind date rollover. Correct a reversed return date only when the intended period has one well-supported interpretation (for example, an explicitly same-day rental with a later return clock time and one mistyped day). Preserve the customer's original text and explain the correction in evidence/memo. A corrected date alone never supplies staff approval or bypasses availability/registration receipts.
- When multiple plausible periods remain, first save the inquiry with the unresolved fields blank, then ask the customer one focused question naming the proposed exact period. Use replyMode="auto_send", safetyClass="contact_request", grounding="visible_conversation", requiresRag=false with the successful incomplete-intake receipt. Do not hand ordinary date clarification to the owner or silently leave it in a draft. Never invent a duration or adjust the clock time without evidence.
- A later answer completes the SAME pending RQ with its exact current baseline; it does not create another booking. Later thanks/arrival cannot erase an unrecorded approved rental. Distinguish inquiry capture, availability, registration and physical handover.`;

export const RESERVATION_PRIORITY_POLICY = `RESERVATION PRIORITY AND ALTERNATIVES:
- Before allocating scarce equipment, check all existing overlapping registered schedules (including rentals starting earlier), pending inquiries and relevant original Kakao request timestamps. Respect existing confirmed allocations. Compare first relevant request times for this rental, not queue creation, form correction or latest thanks; explain missing evidence rather than manufacture priority.
- Evaluate actual shared body/lens/component inventory across sets. Two pending RQs can each appear available without reserving stock. A lens substitution cannot solve a shared camera-body shortage. Check exact compatibility and availability, offer alternatives only within authorization, and record an offer as awaiting customer acceptance until accepted. Never silently replace equipment or promise unconfirmed external supply.`;

export const RESERVATION_PENDING_NOTICE = '아직 예약이 확정되지 않았습니다.';
export const RESERVATION_REPLY_POLICY = `RESERVATION CUSTOMER EXPECTATIONS:
- 고객은 "접수했습니다/확인했습니다/잡아드릴게요"와 방문 안내를 예약 확정으로 받아들인다. 접수 성공·scheduleComplete=true·재고 가용·직원 승인·감사 인사는 등록 완료가 아니다.
- 미등록 안내(reservation_intake_ack)와 필수 질문(contact_request)은 "${RESERVATION_PENDING_NOTICE}"로 시작한다. 발송 직전 호스트도 이 상태를 강제한다. 기존 예약의 변경은 기존 예약이 아니라 요청한 변경이 미확정이라고 안내한다.
- staff_confirmed_reservation_acceptance는 정확한 등록 영수증과 실제 결과를 호스트가 검증한 뒤에만 허용한다. 승인된 등록은 native 도구로 실행·검증하고 답한다. 답장을 위해 승인을 만들지 않는다. 안내 발송·고객 감사 뒤에도 미확정 업무를 유지한다. 가격·정책·반납·서류는 각 근거 규칙을 따른다.`;

// The model chooses the business intent. The host renders the known pending
// state, so calling the same receipt a simple_ack cannot hide that state.
export function pendingReservationReply(decision = {}, replyText = '') {
  const reply = decision.reply_decision || {};
  const safety = reply.safetyClass || reply.safety_class;
  if (!['simple_ack', 'reservation_intake_ack', 'contact_request'].includes(safety)) return null;
  const inquiry = decision.reservation_inquiry || {};
  const disposition = decision.inquiry_disposition;
  if (['declined', 'inventory_only', 'already_applied'].includes(disposition)) return null;
  const change = disposition === 'registered_change_inquiry';
  const pending = change || safety === 'reservation_intake_ack'
    || inquiry.is_reservation_inquiry === true && inquiry.already_registered !== true
    || decision.classification === 'reservation' && inquiry.already_registered !== true;
  if (!pending) return null;
  const notice = change ? '아직 요청하신 예약 변경이 확정되지 않았습니다.' : RESERVATION_PENDING_NOTICE;
  const acknowledgement = `${notice} ${change ? '변경 내용을' : '장비와 일정을'} 확인한 뒤 확정 여부를 안내드리겠습니다.`;
  const original = String(replyText).trim();
  const content = original === acknowledgement ? ''
    : original.startsWith(notice) ? original.slice(notice.length).trim() : original;
  return {text:safety === 'contact_request' && content ? `${notice}\n${content}` : acknowledgement,
    // ACK wording after the exact pending notice is replaced in full. Validate
    // retained questions strictly, without rejecting discarded explanatory prose.
    commitmentText:safety !== 'contact_request' && original.startsWith(notice) ? '' : content};
}

export const INTAKE_REPAIR_INSTRUCTION = '\nINTAKE COMPLETION GUARD: Your final decision identified a new unresolved equipment inquiry, but no native intake receipt exists. Before FINAL_JSON, call village_confirmation_request with should_write_to_sheet=true. Preserve known fields. A validation rejection before operation reservation is an input correction, not a failed write: first reconcile current RQ and receipts; only when no operation was reserved or applied, fix the explicit validation error and submit corrected input. For a conflict between selected set components and top-level extras, preserve the full requested quantities as raw demand and memo while leaving unresolved component mapping for follow-up; do not drop an item or invent a catalog match. Apply the date interpretation policy below; leave genuinely unknown or still contradictory schedule fields blank and plan_complete=false. A staff approval, later thanks/arrival message, or invalid period does not erase the inquiry. If already applied/declined, verify live records and correct inquiry_disposition instead. A failed/partial receipt or unknown write requires owner review, never blind replay.\n' + RESERVATION_DATE_POLICY + '\n' + RESERVATION_PRIORITY_POLICY + '\n' + RESERVATION_REPLY_POLICY + '\n';


export function freshReservationJob(config = {}, job = {}) {
  const cutoff = Date.parse(config.reservationRecoveryEnabledAfter || '');
  const detected = Date.parse(job.detectedAt || job.detected_at || '');
  return Number.isFinite(cutoff) && Number.isFinite(detected) && detected >= cutoff;
}

export function reservationClarificationConfigured(config = {}, decision = {}) {
  const reply = decision.reply_decision || {}, receipt = decision.trusted_confirmation_receipt;
  return config.reservationClarificationAutoSendEnabled === true
    && decision.reservation_inquiry?.is_reservation_inquiry === true
    && receipt?.status === 'ok' && receipt.error === null
    && receipt.authoritative_sheet_result?.success === true
    && receipt.authoritative_sheet_result?.scheduleComplete === false
    && reply.safetyClass === 'contact_request'
    && reply.grounding === 'visible_conversation' && reply.requiresRag === false;
}

export function reservationOwnerNotice(config, job, finalized) {
  if (!config.reservationClarificationAutoSendEnabled || !freshReservationJob(config, job)) return null;
  const decision = finalized.decision || {}, result = finalized.autoReplyResult || {};
  if (decision.reservation_inquiry?.is_reservation_inquiry !== true) return null;
  const work = (decision.follow_up_items || []).filter(item => item.requiresHumanAction === true
    && ['schedule', 'inventory'].includes(item.route)
    && !['done', 'completed', 'resolved', 'cancelled', 'dismissed'].includes(item.status));
  if (!work.length) return null;
  const clean = value => String(value || '').replace(/01[016789][ -]?\d{3,4}[ -]?\d{4}/g, '[연락처 생략]').replace(/[\r\n<>]/g, ' ').trim().slice(0,1000);
  const caseKey = decision.owner_case?.caseKey || job.roomKey || job.room_key;
  const outcome = result.sent === true ? 'question_sent' : 'needs_attention';
  const key = createHash('sha256').update(`${caseKey}:reservation:${outcome}:${work.map(item=>item.taskKey).sort().join('|')}`).digest('hex');
  const row = decision.sheet_row_candidate || {};
  return {schema:'village-pricing-owner-notice/v1', key,
    clientMsgId:`${key.slice(0,8)}-${key.slice(8,12)}-4${key.slice(13,16)}-a${key.slice(17,20)}-${key.slice(20,32)}`,
    channel:config.pricingOwnerSlackUserId, state:'pending', createdAt:new Date().toISOString(),
    text:['예약 자동반영 확인 필요', `고객: ${clean(decision.customer?.name || job.customerName)}`,
      `반출: ${clean(row.start_date)} ${clean(row.pickup_time)}`,
      ...work.map(item=>`${clean(item.title)}: ${clean(item.summary)}`),
      `고객 확인 질문: ${result.sent === true ? '전송 확인' : '전송되지 않음 — 직원 확인 필요'}`,
      '헤이빌리 > 후속조치: https://today-dashboard-ten.vercel.app/'].join('\n')};
}

export function reservationFailureOwnerNotice(config, job) {
  if (!config.reservationClarificationAutoSendEnabled
    || !freshReservationJob(config,{detectedAt:job.event?.detected_at})
    || !(job.state === 'failed' || job.application?.state === 'failed')) return null;
  const notice=reservationOwnerNotice(config,{...job.local_context?.job,detectedAt:job.event.detected_at,
    roomKey:job.room_key},{decision:{customer:{name:job.local_context?.job?.customerName || '상담방 확인'},
      reservation_inquiry:{is_reservation_inquiry:true},owner_case:{caseKey:job.job_id},
      follow_up_items:[{requiresHumanAction:true,route:'schedule',status:'open',taskKey:'intake-failed',
        title:'상담 자동처리 미완료',summary:'자동 처리가 끝나지 않아 대화와 원장을 대조하고 예약·변경 누락을 확인해야 합니다.'}]}});
  return notice ? {...notice,text:notice.text.replace('예약 자동반영 확인 필요','상담 자동처리 확인 필요')} : null;
}
