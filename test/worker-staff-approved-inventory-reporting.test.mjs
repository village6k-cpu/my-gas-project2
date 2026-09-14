import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source=fs.readFileSync(new URL('../tools/ai-browser-worker/worker.mjs',import.meta.url),'utf8');
function functionSource(name){const start=source.indexOf(`function ${name}(`);assert.ok(start>=0,name);const end=source.indexOf('\nfunction ',start+1);return source.slice(start,end);}
function load(){const c={text:x=>String(x??''),decisionReply:d=>d.reply_decision||{}};for(const name of ['registeredMutationInventoryFollowUps','forceRegisteredMutationSuccess'])if(source.includes(`function ${name}(`))vm.runInNewContext(functionSource(name),c);return c;}
test('successful registration keeps verified supply warnings as actionable followup without repeating customer reply',()=>{
 const c=load();const receipt={trade_id:'260914-021',receipt_id:'receipt-1',authoritative_result:{inventoryWarnings:[{stage:'add',equipment:'camera',message:'camera: need 2, available 1'}]}};
 const result=c.forceRegisteredMutationSuccess({customer:{name:'customer'},follow_up_items:[]},receipt);
 assert.equal(result.post_action_reconciled,true);assert.equal(result.reply_decision.replyMode,'no_reply');assert.equal(result.owner_review_required,true);
 assert.equal(result.follow_up_items.length,1);assert.equal(result.follow_up_items[0].actionFamily,'inventory_check');assert.equal(result.follow_up_items[0].businessKey,'trade:260914-021');assert.match(result.follow_up_items[0].summary,/need 2/);
});
test('successful registration with no verified issue does not create repeat approval noise',()=>{
 const result=load().forceRegisteredMutationSuccess({follow_up_items:[{type:'reservation_review',status:'open'}]},{trade_id:'260914-021',authoritative_result:{}});
 assert.equal(result.owner_review_required,false);assert.equal(result.follow_up_items.length,0);
});


const TRADE='260914-021';
const WARNING={stage:'equipment_replace',equipment:'롱 SDI or HDMI',message:'롱 SDI or HDMI 미등록, 가용확인 제외'};
const SECOND_WARNING={stage:'equipment_replace',equipment:'마스4K',message:'마스4K 미등록, 가용확인 제외'};
function successfulReceipt(warnings=[WARNING]){return{trade_id:TRADE,receipt_id:'receipt-1',authoritative_result:{inventoryWarnings:warnings}};}
function reviewedWarning(warning=WARNING,overrides={}){
 const basis={warning:warning.message,source:'set_manifest',record:'FX9 세트',finding:'세트마스터 FX9에 기본 영상 케이블 1개가 동봉품으로 기록되어 있음',resolution:'별도 대여 재고 차감 대상이 아니며 요청한 동봉 수량을 충족함'};
 return{type:'completed_log',route:'inventory',taskKey:'registered-supply-review:'+TRADE,status:'done',requiresHumanAction:false,actionFamily:'none',businessKey:'',summary:basis.record+': '+basis.finding+'. '+basis.resolution+'.',evidence:[warning.message,'inventory_review_basis: '+JSON.stringify(basis)],...overrides};
}
function force(items=[],warnings=[WARNING]){return load().forceRegisteredMutationSuccess({customer:{name:'customer'},follow_up_items:items},successfulReceipt(warnings));}
function pending(result){return result.follow_up_items.filter(item=>item.status==='open');}

test('exact same-trade completed inventory review suppresses only the reviewed missing-master duplicate',()=>{
 const log=reviewedWarning();const result=force([log]);
 assert.equal(result.owner_review_required,false);assert.equal(result.reply_decision.shouldCreateTask,false);assert.equal(result.reply_decision.replyMode,'no_reply');assert.equal(result.follow_up_items.length,1);assert.deepEqual(result.follow_up_items[0],log);
});

test('unreviewed missing-master warnings remain actionable after another warning is resolved',()=>{
 const result=force([reviewedWarning()],[WARNING,SECOND_WARNING]);
 assert.equal(result.owner_review_required,true);assert.equal(pending(result).length,1);assert.deepEqual(Array.from(pending(result)[0].evidence),[SECOND_WARNING.message]);
});

test('accessory names or generic completion alone cannot remove native warnings',()=>{
 for(const overrides of [
  {evidence:[WARNING.equipment],summary:'케이블은 동봉품입니다'},
  {evidence:[WARNING.message],summary:'검토 완료'},
  {evidence:[WARNING.message,'inventory_review_basis: 케이블 동봉품'],summary:'케이블 동봉품'},
  {summary:''},
  {summary:'검토 완료'},
  {summary:WARNING.message},
  {evidence:[WARNING.message+' 추가 설명']},
  {evidence:[WARNING.message,{source:'set_manifest'}]},
  {requiresHumanAction:true,actionFamily:'inventory_check'},
  {blocking_reason:'현물 확인이 아직 필요함'}
 ])assert.equal(pending(force([reviewedWarning(WARNING,overrides)])).length,1,JSON.stringify(overrides));
});

test('a reviewed warning must have matching source finding and resolution in its summary',()=>{
 const log=reviewedWarning(),basis=JSON.parse(log.evidence[1].slice('inventory_review_basis: '.length));
 for(const change of [{source:'rental_history'},{record:''},{finding:''},{resolution:''},{warning:SECOND_WARNING.message}]){
  const altered={...log,evidence:[WARNING.message,'inventory_review_basis: '+JSON.stringify({...basis,...change})]};
  assert.equal(pending(force([altered])).length,1,JSON.stringify(change));
 }
});

test('other-trade and non-inventory completion logs cannot resolve this trade warning',()=>{
 for(const overrides of [{taskKey:'registered-supply-review:260914-099'},{businessKey:'trade:260914-099'},{route:'schedule'},{status:'dismissed'},{type:'reservation_review'}]){
  assert.equal(pending(force([reviewedWarning(WARNING,overrides)])).length,1,JSON.stringify(overrides));
 }
});

test('real numeric shortages and ambiguous native warning formats always retain fallback even with a completion claim',()=>{
 for(const warning of [
  {...WARNING,requested:2,available:1},
  {stage:'date_change',장비명:'FX9',요청수량:1,가용수량:0},
  {stage:'equipment_add',equipment:'camera',message:'camera: need 2, available 1'},
  {stage:'equipment_add',equipment:'마스4K',message:'마스4K 모델 선택 필요'},
  WARNING.message
 ]){
  const result=force([reviewedWarning(typeof warning==='object'?warning:{message:warning})],[warning]);
  assert.equal(result.owner_review_required,true);assert.equal(pending(result).length,1,JSON.stringify(warning));
 }
});

test('an existing AI inventory task for this trade survives success and covers the same warning without another card',()=>{
 const open={type:'reservation_review',route:'inventory',taskKey:'registered-supply-review:'+TRADE,status:'open',requiresHumanAction:true,actionFamily:'inventory_check',businessKey:'trade:'+TRADE,summary:'기간별 실제 부족 카메라 1대를 외부 조달해야 함',recommended_action:'대여 업체 재고를 확인하고 공급을 확정',evidence:['camera: need 2, available 1'],priority:'urgent',alertLevel:'p0',alertReason:'내일 반출인데 공급 미확정'};
 const result=force([open],[{equipment:'camera',requested:2,available:1,message:open.evidence[0]}]);
 assert.equal(pending(result).length,1);assert.deepEqual(pending(result)[0],open);assert.equal(result.owner_review_required,true);
 const withoutWarnings=force([open],[]);assert.deepEqual(pending(withoutWarnings)[0],open);assert.equal(withoutWarnings.owner_review_required,true);
});

test('uncovered warnings join the same open inventory task without overwriting its AI judgment',()=>{
 const open={type:'reservation_review',route:'inventory',taskKey:'registered-supply-review:'+TRADE,status:'open',requiresHumanAction:true,actionFamily:'inventory_check',businessKey:'trade:'+TRADE,summary:'배터리 현물 상태 확인 필요',recommended_action:'현물 상태 확인 후 공급 확정',evidence:['배터리 손상 접수'],priority:'urgent',alertLevel:'p0',alertReason:'반출 준비 중'};
 const result=force([open]);assert.equal(pending(result).length,1);assert.match(pending(result)[0].summary,/배터리 현물/);assert.match(pending(result)[0].summary,/미등록/);assert.match(pending(result)[0].recommended_action,/현물 상태 확인/);assert.equal(pending(result)[0].alertLevel,'p0');assert.ok(pending(result)[0].evidence.includes(WARNING.message));assert.ok(pending(result)[0].summary.includes('\n'));
});

test('an AI open task for another trade cannot consume the native fallback of this trade',()=>{
 const other={type:'reservation_review',route:'inventory',taskKey:'registered-supply-review:260914-099',status:'open',requiresHumanAction:true,actionFamily:'inventory_check',businessKey:'trade:260914-099',summary:'다른 거래 재고 확인',evidence:[WARNING.message]};
 const result=force([other]);assert.equal(pending(result).length,1);assert.equal(pending(result)[0].businessKey,'trade:'+TRADE);
});


test('empty or malformed native warnings keep the existing conservative fallback',()=>{
 for(const warning of [null,'',undefined]){const result=force([],[warning]);assert.equal(result.owner_review_required,true);assert.equal(pending(result).length,1);}
});
