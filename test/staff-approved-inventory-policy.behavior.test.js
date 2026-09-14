const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const gas=fs.readFileSync(path.join(__dirname,'../checkAvailability.js'),'utf8');
function fn(name){const start=gas.indexOf('function '+name+'(');assert.ok(start>=0,name);const end=gas.indexOf('\nfunction ',start+1);return gas.slice(start,end<0?undefined:end);}
const plain=x=>JSON.parse(JSON.stringify(x));
test('staff-approved demand absent from the catalog is preserved as a review issue',()=>{
 const context={};vm.runInNewContext(fn('_collectConfirmedReservationCatalogIssues_'),context);
 const ss={getSheetByName:()=>({getLastRow:()=>2,getRange:()=>({getDisplayValues:()=>[['정식 카메라']]})})};
 const plan=[{name:'정식 카메라',quantity:1},{name:'외부 조달 렌즈',quantity:2}];
 assert.deepEqual(plain(context._collectConfirmedReservationCatalogIssues_(ss,plan)),[{kind:'catalog_unresolved',equipment:'외부 조달 렌즈',quantity:2}]);
 assert.equal(plan[1].name,'외부 조달 렌즈');assert.equal(plan[1].quantity,2);
});
function gate(approved,result='⚠️ 모델 선택 필요'){
 const queued=[],queueOptions=[],failures=[];let synchronousChecks=0;
 const rows=[['RQ-260914-099','','','','','선택 전 조명',1,'',result,'','','','','','','','']];
 const context={queuePreRegistrationStockCheck_:(id,options)=>{queued.push(id);queueOptions.push(options);},checkPreRegistrationStockBeforeRegister_:()=>{synchronousChecks++;return {ready:false};},markRequestRegisterFailed_:(_s,_d,_id,msg)=>failures.push(msg)};
 let code=fn('requestHasDirectRegisterApproval_')+'\n'+fn('getBlockingRegisterIssue_');
 if(gas.includes('function prepareRegistrationInventoryReview_('))code+='\n'+fn('prepareRegistrationInventoryReview_');
 const start=gas.indexOf('  const directRegisterApproved =',gas.indexOf('function registerByReqID('));
 const end=gas.indexOf('  // ── 예약자명 확인',start);assert.ok(start>0&&end>start);
 code+='\nfunction run(hasTransferredConfirmedLock,allData){var reqID="RQ-260914-099",sheet={};'+gas.slice(start,end)+'\nreturn {continued:true,approved:directRegisterApproved};}';
 vm.runInNewContext(code,context);
 return {result:context.run(approved,rows),queued,queueOptions,failures,synchronousChecks};
}
test('verified staff approval commits despite unresolved model and unavailable Slack, with durable review queued',()=>{
 const state=gate(true);assert.equal(state.result?.continued,true);assert.equal(state.result.approved,true);
 assert.deepEqual(state.queued,['RQ-260914-099']);assert.deepEqual(plain(state.queueOptions),[{includeRegistered:true,forceQueue:true}]);assert.equal(state.synchronousChecks,0);assert.deepEqual(state.failures,[]);
});
test('ordinary unapproved registration keeps its existing review gate',()=>{
 const state=gate(false);assert.equal(state.result,undefined);assert.equal(state.synchronousChecks,1);assert.equal(state.failures.length,1);
});
test('staff approval never bypasses invalid reservation dates',()=>{
 const state=gate(true,'❌ 날짜 역전');assert.equal(state.result,undefined);assert.deepEqual(state.failures,['날짜 역전']);
});

test('equipment-master identity remains valid when the autocomplete catalog is stale',()=>{
 const context={};vm.runInNewContext(fn('_collectConfirmedReservationCatalogIssues_'),context);
 const ss={getSheetByName:name=>name==='장비마스터'?{getLastRow:()=>2,getRange:(row,col)=>{assert.equal(col,4);return {getDisplayValues:()=>[['파보용 그리드']]};}}:null};
 assert.deepEqual(plain(context._collectConfirmedReservationCatalogIssues_(ss,[{name:'파보용 그리드',quantity:1}])),[]);
});
