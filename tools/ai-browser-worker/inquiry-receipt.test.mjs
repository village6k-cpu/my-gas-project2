import assert from 'node:assert/strict';
import test from 'node:test';
import {createImmutableKakaoRoomSnapshot, prepareKakaoGatewayDecision} from './worker.mjs';
import {executeConfirmationBatch} from './confirmation-batch.mjs';

const period = {start_date:'2026-09-12',start_time:'11:00',end_date:'2026-09-13',end_time:'11:00'};
function fixture() {
  const job = {jobId:'inquiry-receipt-job',roomKey:'inquiry-receipt-room',roomRevision:7};
  const snapshot = createImmutableKakaoRoomSnapshot({job,navigationContext:{status:'opened_conversation',conversation_evidence:{title:'테스트',hint_matched:true,visible_static_text_tail:'새 장비로 바꿔 주세요',messages:[{message_id:'customer-1',role:'customer',text:'새 장비로 바꿔 주세요'}]}}});
  const turn = {event:{schema:'village-kakao-gateway-event/v1',job_id:job.jobId,room_key:job.roomKey,room_revision:7},internal:{snapshot}};
  const evidence = {customer_request:'새 장비로 바꿔 주세요',conversation_revision:7,conversation_evidence_hash:snapshot.evidenceHash,customer_message_ids:['customer-1']};
  const decision = {
    classification:'reservation',confidence:'high',should_write_to_sheet:true,inquiry_disposition:'pending_revision',
    existing_confirm_request_ids:['RQ-260907-001'],
    customer_requested_pending_revision:{target_scope:'pending_request',request_id:'RQ-260907-001',expected_before:[{name:'기존 장비',quantity:1}],expected_set_components:[],expected_period:period,source_evidence:evidence},
    safety_checks:{kakao_conversation_opened:true,did_not_classify_from_preview_only:true,latest_customer_message_after_last_staff_reply:true,duplicate_checked_contract_master:true,duplicate_checked_schedule_detail:true,duplicate_checked_request_sheet:true,no_auto_reply_sent:true},
    reservation_inquiry:{is_reservation_inquiry:true,already_registered:false,equipment_requested:[{raw_text:'새 장비',normalized_guess:'새 장비',exact_name_from_equipment_catalog:'새 장비',exact_name_from_set_master:null,catalog_match_status:'matched',quantity:1,confidence:'high'}]},
    sheet_row_candidate:{plan_complete:true,equipment_write_mode:'replace_full_plan',start_date:period.start_date,pickup_time:period.start_time,end_date:period.end_date,return_time:period.end_time,customer_name:'테스트',phone:'010-0000-0001',discount_type:'일반',memo:'',extra_request:'',equipment:[{item:'새 장비',quantity:1}]},
    follow_up_items:[],reply_decision:{replyMode:'no_reply',text:'',confidence:'high',reason:'권위 결과 확인',shouldCreateTask:false,safetyClass:'no_send',grounding:'authoritative_sheet',requiresRag:false}
  };
  const receipt = {schema:'village-confirmation-receipt/v1',receipt_id:'receipt-1',job_id:job.jobId,room_key:job.roomKey,room_revision:7,status:'ok',created_at:'2026-09-07T00:00:00.000Z',error:null,availability_report:[{장비명:'새 장비',수량:1,결과:'가능',상세:'가용1'}],authoritative_sheet_result:{success:true,reqID:'RQ-260907-002',replacedReqIDs:['RQ-260907-001'],results:[{장비명:'새 장비',수량:1,결과:'가능',상세:'가용1'}],customer_requested_pending_revision:{target_scope:'pending_request',target_request_id:'RQ-260907-001',expected_before:[{name:'기존 장비',quantity:1}],expected_period:period,replacement_request_id:'RQ-260907-002',final_plan:[{name:'새 장비',quantity:1}],final_period:period}}};
  const prepare = (candidate = decision, receipts = [receipt]) => prepareKakaoGatewayDecision({job,turn,finalText:`FINAL_JSON\n${JSON.stringify(candidate)}`,trustedToolReceipts:receipts});
  return {job,turn,decision,receipt,prepare};
}
test('customer revision receipt validates exact replacement while preserving pending availability review', async () => {
  const f = fixture(); const result = await f.prepare();
  assert.deepEqual(result.gatewaySafetyFailures,[]);
  assert.equal(result.decision.post_action_reconciled,true);
  assert.equal(result.decision.customer_pending_revision_readback.target_request_id,'RQ-260907-001');
  assert.equal(result.decision.owner_review_required,true);
  assert.equal(result.decision.should_write_to_sheet,false);
  assert.equal(result.decision.pending_mutation_readback,undefined);
  assert.doesNotMatch(result.decision.reply_decision.reason,/직원 확정/);
});
test('customer revision accepts an honest no-write final only with the exact trusted receipt', async () => {
  const f=fixture(); f.decision.should_write_to_sheet=false;
  const result=await f.prepare();
  assert.deepEqual(result.gatewaySafetyFailures,[]);
  assert.equal(result.decision.post_action_reconciled,true);
  const missing=await f.prepare(f.decision,[]);
  assert.notEqual(missing.decision.post_action_reconciled,true);
});
for (const [label,change] of [
  ['wrong target',e=>e.target_request_id='RQ-260907-099'],
  ['wrong replacement',e=>e.replacement_request_id='RQ-260907-099'],
  ['wrong baseline plan',e=>e.expected_before=[{name:'다른 장비',quantity:1}]],
  ['wrong baseline period',e=>e.expected_period={...period,start_time:'12:00'}],
  ['wrong final plan',e=>e.final_plan=[{name:'다른 장비',quantity:1}]],
  ['wrong final period',e=>e.final_period={...period,end_time:'12:00'}]
]) test(`customer revision rejects ${label} in a successful receipt`,async()=>{
  const f=fixture();change(f.receipt.authoritative_sheet_result.customer_requested_pending_revision);
  const result=await f.prepare();
  assert.ok(result.gatewaySafetyFailures.includes('trusted_customer_revision_readback_contradiction'));
  assert.notEqual(result.decision.post_action_reconciled,true);
  assert.equal(result.decision.owner_review_required,true);
});
test('customer revision rejects a source evidence mismatch at finalization',async()=>{
  const f=fixture();f.decision.customer_requested_pending_revision.source_evidence.customer_request='조작된 문장';
  const result=await f.prepare();
  assert.ok(result.gatewaySafetyFailures.includes('invalid_gateway_decision'));
  assert.notEqual(result.decision.post_action_reconciled,true);
});
function registeredFixture() {
  const f=fixture(); delete f.decision.customer_requested_pending_revision;
  f.decision.inquiry_disposition='new_inquiry';f.decision.existing_confirm_request_ids=[];
  f.decision.sheet_row_candidate.equipment_write_mode='full_plan';
  f.receipt.authoritative_sheet_result={success:true,alreadyRegistered:true,duplicate:true,matchedRegisteredTradeId:'260907-001',results:[{장비명:'새 장비',수량:2,결과:'등록완료',상세:'등록 스케줄 확인',scheduleId:'260907-001-01',period}]};
  f.receipt.availability_report=f.receipt.authoritative_sheet_result.results;
  return f;
}
test('registered reconciliation does not claim an RQ or manufacture another schedule review',async()=>{
  const f=registeredFixture();const result=await f.prepare();
  assert.deepEqual(result.gatewaySafetyFailures,[]);
  assert.equal(result.decision.inquiry_disposition,'already_applied');
  assert.equal(result.decision.registered_reconciliation_readback.matchedRegisteredTradeId,'260907-001');
  assert.equal(result.decision.owner_review_required,false);
  assert.equal(result.decision.post_action_reconciled,true);
  assert.equal(result.decision.reply_decision.replyMode,'no_reply');
  assert.equal(result.decision.should_write_to_sheet,false);
  assert.deepEqual(result.availabilityAwareRows,[]);
  assert.equal(result.decision.existing_confirm_request_ids.length,0);
  assert.doesNotMatch(result.decision.reply_decision.reason,/RQ.*(생성|입력)|가용확인.*다시/);
});
for(const [label,change] of [
  ['invented RQ',r=>r.reqID='RQ-260907-099'],
  ['insufficient quantity',r=>r.results[0].수량=0],
  ['wrong item',r=>r.results[0].장비명='다른 장비'],
  ['wrong known period',r=>r.results[0].period={...period,end_date:'2026-09-14'}],
  ['invalid trade ID',r=>r.matchedRegisteredTradeId='RQ-260907-001']
])test(`registered reconciliation rejects ${label}`,async()=>{
  const f=registeredFixture();change(f.receipt.authoritative_sheet_result);
  const result=await f.prepare();
  assert.ok(result.gatewaySafetyFailures.includes('trusted_registered_reconciliation_contradiction'));
  assert.equal(result.decision.owner_review_required,true);
});
test('registered reconciliation accepts partial requested period against full authoritative period',async()=>{
  const f=registeredFixture();f.decision.sheet_row_candidate.return_time='';f.decision.sheet_row_candidate.plan_complete=false;
  const result=await f.prepare();
  assert.deepEqual(result.gatewaySafetyFailures,[]);
  assert.equal(result.decision.post_action_reconciled,true);
});
test('agent-supplied lifecycle readback fields never become trusted evidence',async()=>{
  const f=fixture();
  const decision={classification:'faq',should_write_to_sheet:false,customer_pending_revision_readback:{invented:true},registered_reconciliation_readback:{invented:true},follow_up_items:[]};
  const result=await f.prepare(decision,[]);
  assert.equal(result.decision.customer_pending_revision_readback,undefined);
  assert.equal(result.decision.registered_reconciliation_readback,undefined);
});
async function batchFixture({count=2,failAt=-1,registered=false}={}) {
  const f=registeredFixture();
  const children=Array.from({length:count},(_,index)=>{
    const child=structuredClone(f.decision);
    child.sheet_row_candidate.start_date=`2026-09-${12+index*2}`;
    child.sheet_row_candidate.end_date=`2026-09-${13+index*2}`;
    return child;
  });
  const receipt=await executeConfirmationBatch({decision:{confirmation_requests:children},validateDecision:()=>({valid:true}),preflightDecision:async decision=>({ok:true,decision}),
    buildReceipt:({status,authoritativeSheetResult,availabilityReport=[],error=null})=>({...f.receipt,status,authoritative_sheet_result:authoritativeSheetResult,availability_report:availabilityReport,error}),
    executeDecision:async(child,index)=>{
      if(index===failAt)return {...f.receipt,status:'failed',authoritative_sheet_result:null,error:{type:'gas_rejected',message:'synthetic failure'}};
      const result={success:true,results:[{장비명:'새 장비',수량:1,결과:registered?'등록완료':'가능',상세:'검증',period:{...period,start_date:child.sheet_row_candidate.start_date,end_date:child.sheet_row_candidate.end_date}}],...(registered?{alreadyRegistered:true,matchedRegisteredTradeId:`260907-00${index+1}`}:{reqID:`RQ-260907-00${index+1}`})};
      return {...f.receipt,receipt_id:`child-${index}`,authoritative_sheet_result:result,availability_report:result.results};
    }});
  return {...f,children,receipt};
}
test('batch finalization preserves every period and disables all writes even when final children are omitted',async()=>{
  const f=await batchFixture();const result=await f.prepare({classification:'reservation',should_write_to_sheet:false,follow_up_items:[]},[f.receipt]);
  assert.deepEqual(result.gatewaySafetyFailures,[]);
  assert.equal(result.decision.confirmation_batch_results.length,2);
  assert.deepEqual(result.decision.confirmation_requests.map(c=>c.should_write_to_sheet),[false,false]);
  assert.deepEqual(result.availabilityAwareRows.map(row=>row.payload.confirmation_batch_result.request_ids[0]),['RQ-260907-001','RQ-260907-002']);
});
test('partial batch finalization keeps successful, failed and unattempted period evidence separately',async()=>{
  const f=await batchFixture({count:3,failAt:1});const result=await f.prepare({should_write_to_sheet:false},[f.receipt]);
  assert.deepEqual(result.decision.confirmation_batch_results.map(r=>r.status),['ok','failed','unattempted']);
  assert.equal(result.availabilityAwareRows.length,3);
  assert.equal(result.availabilityAwareRows[0].payload.confirmation_batch_result.request_ids[0],'RQ-260907-001');
  assert.equal(result.decision.post_action_reconciled,false);
  assert.equal(result.decision.reply_decision.text,'');
});
test('all-registered batch quietly retains both trade proofs without fictitious RQ work',async()=>{
  const f=await batchFixture({registered:true});const result=await f.prepare({should_write_to_sheet:false},[f.receipt]);
  assert.deepEqual(result.gatewaySafetyFailures,[]);
  assert.deepEqual(result.decision.confirmation_batch_results.map(r=>r.trade_id),['260907-001','260907-002']);
  assert.deepEqual(result.availabilityAwareRows,[]);
  assert.equal(result.decision.owner_review_required,false);
});
