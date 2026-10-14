const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const gas=fs.readFileSync(require('node:path').join(__dirname,'../checkAvailability.js'),'utf8');
const from=gas.indexOf('function repairDashboardTradeProjection_(');
const source=gas.slice(from,gas.indexOf('\nfunction ',from+1));
const tid='260810-001',missing=tid+'-08';
function run(ids,{present=false,started=false,remoteOk=true,readded=false}={}){
  let locked=false;const queued=[];
  const rows=[['260810-001-01',tid]];
  if(present)rows.push([missing,tid]);
  const sheet={getLastRow:()=>rows.length+1,getRange:()=>({getValues:()=>rows,getDisplayValues:()=>rows})};
  const ctx={console,SpreadsheetApp:{getActiveSpreadsheet:()=>({getSheetByName:()=>sheet})},
    getDashboardRowsByTradeId_:()=>({[tid]:[2]}),getDashboardSearchGroupsForIds_:()=>({[tid]:{equipments:[]}}),
    PropertiesService:{getScriptProperties:()=>({})},isDashboardTradeCheckoutStarted_:()=>false,
    supaGetCheckoutBaselineState_:()=>({ok:remoteOk,started,items:[],tradeFound:true}),
    getDashboardReturnCheckableItems_:()=>[],canDashboardRecoverMissingCheckoutBaseline_:()=>false,
    LockService:{getScriptLock:()=>({tryLock(){locked=true;if(readded)rows.push([missing,tid]);return true;},releaseLock(){locked=false;}})},
    dashboardTradeMutationLeaseError_:()=>null,
    scheduleDashboardStructureProjectionUnderLock_:(id,payload)=>{assert.equal(locked,true);queued.push({id,payload});return 'token';},
    ensureDashboardStructureProjectionTrigger_:()=>{assert.equal(locked,false);}
  };
  vm.runInNewContext(source,ctx);
  return {result:ctx.repairDashboardTradeProjection_(tid,ids),queued};
}
test('explicit missing-row repair queues only its exact removal ID without replaying a sheet deletion',()=>{
  const r=run([missing]);assert.equal(r.result.success,true);
  assert.deepEqual(Array.from(r.queued[0].payload.removeScheduleIds),[missing]);
});
for(const [label,ids,options] of [
  ['present in current sheet',[missing],{present:true}],
  ['readded while waiting for lock',[missing],{readded:true}],
  ['other trade',['260810-002-08'],{}],
  ['name instead of exact ID',['렌즈'],{}],
  ['checkout has started',[missing],{started:true}],
  ['remote authority unavailable',[missing],{remoteOk:false}]
])test(`removal projection recovery rejects ${label} before queuing`,()=>{
  const r=run(ids,options);assert.ok(r.result.error);assert.equal(r.queued.length,0);
});
test('ordinary missing-row insertion repair does not infer a removal keep-set',()=>{
  const r=run(undefined);assert.equal(r.result.success,true);assert.equal(r.queued[0].payload.removeScheduleIds,undefined);
});
