import test from 'node:test';
import assert from 'node:assert/strict';
import {validateStaffConfirmedMutation, buildRegisteredTradeCorrectionInput,executeVillageRegisteredReservationChange} from './staff-confirmed-mutation.mjs';
const mutation={confirmed:true,kind:'reservation_cancel',target_scope:'registered_trade',trade_id:'260901-003',source_evidence:{customer_request:'이번 일정은 진행하지 않겠습니다',staff_confirmation:'네 처리하겠습니다',conversation_revision:3},expected_period:{start_date:'2026-09-20',start_time:'09:00',end_date:'2026-09-21',end_time:'09:00'},expected_before:[{schedule_id:'260901-003-01',name:'카메라',quantity:1}],desired_after:[],date_change:null};
test('contextually authorized cancellation is a supported registered operation',()=>{
 assert.deepEqual(validateStaffConfirmedMutation(mutation),{valid:true,errors:[]});
 const input=buildRegisteredTradeCorrectionInput(mutation,'cancel-test');
 assert.equal(input.cancel,true); assert.equal(input.sendEstimate,false); assert.equal(input.remove.length,1);
});
test('cancellation cannot become an addition, date revision, pending request or partial ambiguous command',()=>{
 for(const patch of [{desired_after:[{name:'렌즈',quantity:1}]},{expected_before:[]},{target_scope:'pending_request',request_id:'RQ-260901-001'},{request_id:'RQ-260901-001'},{confirmed:false}]) assert.equal(validateStaffConfirmedMutation({...mutation,...patch}).valid,false);
});
test('cancellation returns an authoritative native receipt without contract regeneration',async()=>{
 const before={contract:{startDate:'2026-09-20',startTime:'09:00',endDate:'2026-09-21',endTime:'09:00',status:'예약'},schedule:{rows:[{scheduleId:'260901-003-01',name:'카메라',qty:1}],periods:['2026-09-20|09:00|2026-09-21|09:00'],topLevelQuantities:{'카메라':1}},ledger:null};
 const after={...before,contract:{...before.contract,status:'취소'},schedule:{rows:[],periods:[],topLevelQuantities:{}}};
 const receipt=await executeVillageRegisteredReservationChange({job:{job_id:'test',room_key:'room',room_revision:3},roomRevision:3,mutation,dependencies:{runRegisteredTradeCorrection:async({input})=>{assert.equal(input.cancel,true);return {ok:true,verified:true,tradeId:mutation.trade_id,appliedStages:['updateContractStatus'],readback:after,authoritativeReadback:{before,after}}}}},{operationFence:{operation_id:'cancel-test'}});
 assert.equal(receipt.status,'ok'); assert.equal(receipt.authoritative_result.after.contract.status,'취소');
});

test('real runner posts the existing status route and requires cancelled readback',async()=>{
 const {createRequire}=await import('node:module');const require=createRequire(import.meta.url);
 const {runRegisteredTradeCorrection}=require('../../scripts/windows/village-registered-trade-correction.js');
 const before={contract:{startDate:'2026-09-20',startTime:'09:00',endDate:'2026-09-21',endTime:'09:00',status:'예약'},schedule:{rows:[{scheduleId:'260901-003-01',name:'카메라',qty:1}],periods:[],topLevelQuantities:{'카메라':1}}};
 const after={contract:{...before.contract,status:'취소'},schedule:{rows:[],periods:[],topLevelQuantities:{}}};
 for(const corrupt of [false,true]){
  let calls=0;const input=buildRegisteredTradeCorrectionInput(mutation,'11111111-2222-4333-8444-555555555555');
  const execution=runRegisteredTradeCorrection({config:{VILLAGE2_API_URL:'https://script.google.com/macros/s/test/exec',VILLAGE2_API_KEY:'test-key'},input,fetchImpl:async(url,opts)=>{calls++;const body=JSON.parse(opts.body);assert.equal(body.action,'updateContractStatus');assert.equal(body.status,'취소');assert.equal(body.expectedCancellation.expectedRows.length,1);const rb=structuredClone(after);if(corrupt)rb.contract.status='예약';return {ok:true,json:async()=>({success:true,tradeId:mutation.trade_id,operationId:'11111111-2222-4333-8444-555555555555',customerNotificationSent:false,readback:rb,authoritativeReadback:{before,after:rb}})};}});
  if(corrupt)await assert.rejects(execution,e=>e.outcomeUnknown===true);else assert.equal((await execution).verified,true);
  assert.equal(calls,1);
 }
});
