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

export const INTAKE_REPAIR_INSTRUCTION = '\nINTAKE COMPLETION GUARD: Your final decision identified a new unresolved equipment inquiry, but no native intake receipt exists. Before FINAL_JSON, call village_confirmation_request with should_write_to_sheet=true. Preserve known fields; use empty strings for unknown or contradictory schedule fields and plan_complete=false. Never guess a return date. A staff approval, later thanks/arrival message, or invalid period does not erase the inquiry. If already applied/declined, verify live records and correct inquiry_disposition instead. A failed/partial receipt requires owner review, never blind replay.\n';

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
    || !String(job.event?.prompt || '').includes('INTAKE COMPLETION GUARD:')
    || job.state !== 'failed') return null;
  const notice=reservationOwnerNotice(config,{...job.local_context?.job,detectedAt:job.event.detected_at,
    roomKey:job.room_key},{decision:{customer:{name:job.local_context?.job?.customerName || '상담방 확인'},
      reservation_inquiry:{is_reservation_inquiry:true},owner_case:{caseKey:job.job_id},
      follow_up_items:[{requiresHumanAction:true,route:'schedule',status:'open',taskKey:'intake-failed',
        title:'예약 접수 재처리 실패',summary:'새 예약 문의의 저장 결과가 없어 자동 완료를 차단했습니다. 대화와 원장 확인이 필요합니다.'}]}});
  return notice;
}
