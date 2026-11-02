'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
function gas(){const ctx=vm.createContext({console});vm.runInContext(fs.readFileSync(require.resolve('../checkAvailability.js'),'utf8'),ctx);return ctx;}
const input=()=>({confirmed:true,target_scope:'pending_request',request_id:'RQ-261102-012',source_evidence:{customer_request:'합성고객 / 010-0000-0001 / 학생+지인할인',staff_confirmation:'학생30%와 이번 소개5% 승인',conversation_revision:1,conversation_evidence_hash:'a'.repeat(64),customer_message_ids:['c1'],staff_message_ids:['s1']},expected_before:[{name:'카메라',quantity:1}],desired_after:[{name:'카메라',quantity:1}],expected_period:{start_date:'2026-11-07',start_time:'10:00',end_date:'2026-11-08',end_time:'00:00'},desired_period:{start_date:'2026-11-07',start_time:'10:00',end_date:'2026-11-08',end_time:'00:00'},expected_set_components:[],set_component_selections:[],customer_identity_update:{expected_name:'합성고객',expected_phone:'01000000001',name:'합성고객',phone:'01000000001',discount_type:'학생소개'}});
test('approved student introduction survives native, transport and GAS registration normalizers',async()=>{
 const {validateStaffConfirmedRegistration}=await import('../tools/ai-browser-worker/staff-confirmed-registration.mjs');
 const {normalizeConfirmedReservationCommit}=require('../scripts/windows/village-confirm-request.js');const r=input();
 assert.equal(validateStaffConfirmedRegistration(r,{roomRevision:1}).valid,true);
 const normalized=normalizeConfirmedReservationCommit(r);assert.equal(normalized.customer_identity_update.discount_type,'학생소개');
 assert.equal(gas()._normalizeConfirmedReservationCommit_(normalized).customer_identity_update.discount_type,'학생소개');
});
test('introduction is kept on this trade but not copied as a permanent customer discount',()=>{
 const ctx=gas();assert.equal(ctx._normalizeDiscountTypeOrBlank_('학생소개'),'학생소개');
 const rows=[['01000000001','합성고객','','','','','','','학생']];const plan=ctx._planCustomerDbRegistrationWrite_(rows,'합성고객','01000000001','학생소개');
 assert.equal(plan.discount,'학생');assert.equal(plan.action,'keep-existing');
});


test('native trade pricing reads the stored stacked discount and leaves standard student pricing unchanged',async()=>{
 const {executeVillageReadOnlyLookup}=await import('../tools/ai-browser-worker/worker.mjs');
 for(const [discount,expected] of [['학생소개',43890],['학생',46200]]) {
  const contract=['261102-099','합성고객','','','2026-11-07','10:00','2026-11-08','00:00',1,'예약',discount];
  const schedule=['261102-099-01','261102-099','카메라','카메라',1,'2026-11-07','10:00','2026-11-08','00:00','대기','',60000];
  const config={gasApiUrl:'https://script.example/exec',sheetApiKey:'test',fetchImpl:async value=>({ok:true,status:200,text:async()=>JSON.stringify({headers:[],results:[{data:new URL(value).searchParams.get('sheet')==='계약마스터'?contract:schedule}]})})};
  const quote=await executeVillageReadOnlyLookup(config,{kind:'quote',quote:{source:'trade',id:'261102-099'}});
  assert.equal(quote.complete,true);assert.equal(quote.totalVatIncluded,expected);assert.equal(quote.calculations[0].pricedItems[0].price,60000);
 }
});
