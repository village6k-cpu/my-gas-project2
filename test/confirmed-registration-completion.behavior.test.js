'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {normalizeConfirmedReservationCommit}=require('../scripts/windows/village-confirm-request.js');
function registration() {return {
  confirmed:true,target_scope:'pending_request',request_id:'RQ-260908-001',
  source_evidence:{customer_request:'김지윤 / 010-0000-0002 / 프리랜서\nDJI 마이크 / F21C\n9/8 21시~9/9 21시',staff_confirmation:'네',conversation_revision:8,conversation_evidence_hash:'a'.repeat(64),customer_message_ids:['customer-form'],staff_message_ids:['staff-yes']},
  expected_before:[{name:'FX3',quantity:1}],expected_set_components:[],set_component_selections:[],
  expected_period:{start_date:'2026-09-08',start_time:'',end_date:'',end_time:''},
  desired_after:[{name:'DJI 마이크',quantity:1},{name:'F21C',quantity:1}],
  desired_period:{start_date:'2026-09-08',start_time:'21:00',end_date:'2026-09-09',end_time:'21:00'},
  customer_identity_update:{expected_name:'지윤',expected_phone:'',name:'김지윤',phone:'010-0000-0002',discount_type:'개인사업자/프리랜서'}
};}

test('final approved form can complete an incomplete pending period and customer identity through every normalizer',async()=>{
  const input=registration();
  const module=await import('../tools/ai-browser-worker/staff-confirmed-registration.mjs');
  assert.deepEqual(module.validateStaffConfirmedRegistration(input,{roomRevision:8}),{valid:true,errors:[]});
  const normalized=normalizeConfirmedReservationCommit(input);
  assert.deepEqual(normalized.expected_period,input.expected_period);
  const ctx={console};vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../checkAvailability.js'),'utf8'),ctx);
  const gas=ctx._normalizeConfirmedReservationCommit_(normalized);
  assert.equal(gas.customer_identity_update.name,'김지윤');
  const values=Array(18).fill('');values[10]='지윤';values[12]='일반';
  const sheet={getRange:()=>({getValues:()=>[values],getDisplayValues:()=>[values]})};
  const replacement=ctx._confirmedReservationReplacementRequest_(sheet,{group:{rows:[2],name:'지윤',phone:''}},gas,[]);
  assert.equal(replacement.예약자명,'김지윤');assert.equal(replacement.연락처,'010-0000-0002');
  assert.equal(replacement.할인유형,'개인사업자/프리랜서');
  assert.equal(replacement.반출시간,'21:00');
});

test('final registration still rejects incomplete desired periods and contact reassignment',async()=>{
  const module=await import('../tools/ai-browser-worker/staff-confirmed-registration.mjs');
  for(const change of [x=>{x.desired_period.end_time='';},x=>{x.customer_identity_update.expected_phone='01000000001';}]) {
    const x=registration();change(x);
    assert.equal(module.validateStaffConfirmedRegistration(x,{roomRevision:8}).valid,false);
    assert.throws(()=>normalizeConfirmedReservationCommit(x));
  }
});

test('a replacement set selection survives every normalizer without pretending it existed in the old set',async()=>{
  const value=registration();
  value.desired_after=[{name:'소니 A7S3 바디세트',quantity:1}];
  value.set_component_selections=[{set_item:'소니 A7S3 바디세트',component_item:'메모리',selected_item:'소니 CF-A 160'}];
  const module=await import('../tools/ai-browser-worker/staff-confirmed-registration.mjs');
  assert.equal(module.validateStaffConfirmedRegistration(value,{roomRevision:8}).valid,true);
  const normalized=normalizeConfirmedReservationCommit(value);
  const ctx={console};vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../checkAvailability.js'),'utf8'),ctx);
  const gas=ctx._normalizeConfirmedReservationCommit_(normalized);
  assert.equal(gas.set_component_selections[0].selected_item,'소니 CF-A 160');
});
