import test from 'node:test';
import assert from 'node:assert/strict';
import {unrecordedReservationInquiry, reservationClarificationConfigured, freshReservationJob, reservationOwnerNotice,reservationFailureOwnerNotice,INTAKE_REPAIR_INSTRUCTION} from './reservation-intake-guard.mjs';

const decision = {should_write_to_sheet:false, inquiry_disposition:'new_inquiry', classification:'already_answered',
  reservation_inquiry:{is_reservation_inquiry:true,already_registered:false,equipment_requested:[{quantity:1}]}};
test('an incomplete approved rental cannot disappear behind a no-write/thanks final',()=>{
  assert.equal(unrecordedReservationInquiry({content:'FINAL_JSON\n```json\n'+JSON.stringify(decision)+'\n```'}),true);
  for(const change of [{inquiry_disposition:'declined'},{inquiry_disposition:'already_applied'},
    {existing_confirm_request_ids:['RQ-261102-001']},{reservation_inquiry:{...decision.reservation_inquiry,already_registered:true}},
    {reservation_inquiry:{...decision.reservation_inquiry,is_test_message:true}}])
    assert.equal(unrecordedReservationInquiry({content:JSON.stringify({...decision,...change})}),false);
  assert.equal(unrecordedReservationInquiry({content:JSON.stringify(decision)},[{schema:'village-confirmation-receipt/v1'}]),false);
});
test('recovery clarification requires durable incomplete intake, explicit enablement and a fresh job',()=>{
  const config={reservationClarificationAutoSendEnabled:true,reservationRecoveryEnabledAfter:'2026-11-02T03:00:00Z'};
  const d={...decision,reply_decision:{safetyClass:'contact_request',grounding:'visible_conversation',requiresRag:false},
    trusted_confirmation_receipt:{status:'ok',error:null,authoritative_sheet_result:{success:true,scheduleComplete:false}}};
  assert.equal(reservationClarificationConfigured(config,d),true);
  for(const patch of [{trusted_confirmation_receipt:null},{reply_decision:{...d.reply_decision,safetyClass:'sensitive_commitment'}},
    {trusted_confirmation_receipt:{...d.trusted_confirmation_receipt,status:'failed'}}])
    assert.equal(reservationClarificationConfigured(config,{...d,...patch}),false);
  assert.equal(freshReservationJob(config,{detectedAt:'2026-11-01T00:00:00Z'}),false);
  assert.equal(freshReservationJob(config,{detectedAt:'2026-11-02T03:00:00Z'}),true);
});
test('blocked reservation work is visible to the owner without customer PII or repeated thanks alerts',()=>{
  const config={reservationClarificationAutoSendEnabled:true,reservationRecoveryEnabledAfter:'2026-11-02T03:00:00Z',pricingOwnerSlackUserId:'UOWNER'};
  const job={detectedAt:'2026-11-02T03:01:00Z',roomKey:'chat:test'};
  const final={decision:{...decision,customer:{name:'테스트'},follow_up_items:[{requiresHumanAction:true,route:'schedule',status:'open',taskKey:'date',title:'반납일 확인',summary:'반납일이 반출일보다 앞섭니다.'}]},autoReplyResult:{sent:false}};
  const notice=reservationOwnerNotice(config,job,final);
  assert.match(notice.text,/전송되지 않음/);
  assert.equal(notice.key,reservationOwnerNotice(config,{...job,jobId:'later-thanks'},final).key);
  assert.equal(reservationOwnerNotice(config,job,{...final,decision:{...final.decision,follow_up_items:[]}}),null);
});

test('exhausted fresh intake retries alert the owner while historical and unrelated failures remain held',()=>{
  const config={reservationClarificationAutoSendEnabled:true,reservationRecoveryEnabledAfter:'2026-11-02T03:00:00Z',pricingOwnerSlackUserId:'UOWNER'};
  const job={job_id:'test',room_key:'chat:test',state:'failed',event:{detected_at:'2026-11-02T03:01:00Z',prompt:INTAKE_REPAIR_INSTRUCTION}};
  assert.ok(reservationFailureOwnerNotice(config,job));
  assert.equal(reservationFailureOwnerNotice(config,{...job,event:{...job.event,detected_at:'2026-10-01T03:00:00Z'}}),null);
  assert.equal(reservationFailureOwnerNotice(config,{...job,event:{...job.event,prompt:'unrelated'}}),null);
});
