const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const gas=fs.readFileSync(require('node:path').join(__dirname,'../checkAvailability.js'),'utf8');
function harness({changed=false,checkout=false,failCleanup=false}={}){
 let status='예약',rows=[{scheduleId:'260901-003-01',name:'카메라',qty:1}],writes=0;
 const contract=()=>({startDate:'2026-09-20',startTime:'09:00',endDate:'2026-09-21',endTime:'09:00',rounds:1,status});
 const sheet={getLastRow:()=>2,getRange:(row,col)=>({getDisplayValues:()=>[['260901-003']],getDisplayValue:()=>status,setValue:value=>{writes++;status=value;}})};
 const context={LockService:{getScriptLock:()=>({tryLock:()=>true,releaseLock(){}})},PropertiesService:{getScriptProperties:()=>({deleteProperty(){}})},SpreadsheetApp:{getActiveSpreadsheet:()=>({getSheetByName:()=>sheet})},dashboardTradeMutationLeaseError_:()=>null,isDashboardTradeCheckoutStarted_:()=>checkout,readRegisteredTradeCorrectionState_:()=>({contract:contract(),schedule:{rows:changed?[...rows,{scheduleId:'260901-003-02',name:'렌즈',qty:1}]:rows,periods:rows.length?['2026-09-20|09:00|2026-09-21|09:00']:[],topLevelQuantities:rows.length?{'카메라':1}:{}}}),cancelContract:()=>{if(failCleanup)throw Error('cleanup failed');rows=[];},invalidateDashboardCache(){},ensureCancelledTradeCleanupTrigger_(){}};
 vm.createContext(context);
 const start=gas.indexOf('function validateRegisteredCancellationBaseline_');
 if(start>=0)vm.runInContext(gas.slice(start,gas.indexOf('function updateDashboardContractStatus',start)),context);
 vm.runInContext(gas.slice(gas.indexOf('function updateDashboardContractStatus'),gas.indexOf('function getEquipmentCheckSpreadsheet_')),context);
 const expected={operationId:'cancel-test',expectedPeriod:{startDate:'2026-09-20',startTime:'09:00',endDate:'2026-09-21',endTime:'09:00'},expectedRows:[{scheduleId:'260901-003-01',expectedName:'카메라',expectedQty:1}],staffApproval:{source:'kakao_staff_confirmed',conversationRevision:3,customerRequest:'취소 부탁드립니다',staffConfirmation:'네 처리하겠습니다'}};
 return {run:()=>context.updateDashboardContractStatus('260901-003','취소',expected),writes:()=>writes};
}
test('existing cancellation returns locked before and cancelled empty-schedule readback',()=>{const h=harness();const r=h.run();assert.equal(r.success,true);assert.equal(r.operationId,'cancel-test');assert.equal(r.authoritativeReadback.before.contract.status,'예약');assert.equal(r.readback.contract.status,'취소');assert.equal(r.readback.schedule.rows.length,0);assert.equal(h.writes(),1);});
test('concurrent schedule additions block cancellation without any writes',()=>{const h=harness({changed:true});assert.equal(h.run().success,false);assert.equal(h.writes(),0);});
test('physical checkout still protects the transaction from cancellation',()=>{const h=harness({checkout:true});assert.match(h.run().error,/반출/);assert.equal(h.writes(),0);});
test('failure after status write is uncertain rather than safe-to-replay',()=>{const h=harness({failCleanup:true});assert.equal(h.run().outcomeUnknown,true);assert.equal(h.writes(),1);});
