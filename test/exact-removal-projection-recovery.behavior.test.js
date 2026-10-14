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

function workerFixture(){
  const state={}, calls=[], rows=[[tid+'-01',tid]];
  let locked=false, duringUpsert=()=>{}, duringRemoval=()=>{};
  const props={getProperty:k=>state[k],getProperties:()=>({...state}),
    setProperty:(k,v)=>{state[k]=v;},deleteProperty:k=>{delete state[k];}};
  const sheet={getLastRow:()=>rows.length+1,getRange:()=>({getDisplayValues:()=>rows.map(r=>r.slice())})};
  const ctx={Logger:{log(){}},PropertiesService:{getScriptProperties:()=>props},
    ScriptApp:{getProjectTriggers:()=>[]},SpreadsheetApp:{getActiveSpreadsheet:()=>({getSheetByName:()=>sheet})},
    LockService:{getScriptLock:()=>({tryLock(){locked=true;return true;},releaseLock(){locked=false;}})}};
  vm.runInNewContext(gas,ctx);
  Object.assign(ctx,{ensureDashboardStructureProjectionTrigger_:()=>{},supaMarkTradeDirty_:()=>{},
    isDashboardTradeCheckoutStarted_:()=>false,SUPA_CFG_:()=>({}),
    buildSupabaseTrades_:()=>({trades:[],items:rows.map(r=>({schedule_id:r[0],trade_id:r[1]}))}),
    supaInsertAuthorizedScheduleItems_:(cfg,id,items,ids)=>{calls.push(['insert',...ids]);return true;},
    supaUpsertGrouped_:()=>{duringUpsert();return true;},
    supaMarkScheduleItemsRemoved_:(id,ids)=>{assert.equal(locked,false);duringRemoval();calls.push(['remove',...ids]);return {ok:true};}});
  return {ctx,props,state,calls,rows,queue:patch=>ctx.scheduleDashboardStructureProjectionUnderLock_(tid,patch),
    flush:()=>ctx.flushDashboardStructureProjectionQueue_(),onUpsert:fn=>{duringUpsert=fn;},onRemoval:fn=>{duringRemoval=fn;}};
}
test('a readdition cancels an older exact removal grant before the worker runs',()=>{
  const f=workerFixture();f.queue({syncStructure:true,removeScheduleIds:[missing]});
  f.rows.push([missing,tid]);f.queue({syncStructure:true,addedScheduleIds:[missing]});f.flush();
  assert.deepEqual(f.calls,[['insert',missing]]);
  assert.equal(f.state[f.ctx.DASHBOARD_STRUCTURE_QUEUE_PREFIX_+tid],undefined);
});
test('current authoritative GAS presence defeats a queued tombstone even without an addition grant',()=>{
  const f=workerFixture();f.queue({syncStructure:true,removeScheduleIds:[missing]});
  f.rows.push([missing,tid]);f.flush();
  assert.equal(f.calls.some(c=>c[0]==='remove'),false);
});
test('a readdition during structure HTTP invalidates the removal claim and keeps the newer revision',()=>{
  const f=workerFixture();f.queue({syncStructure:true,removeScheduleIds:[missing]});
  f.onUpsert(()=>{f.rows.push([missing,tid]);f.queue({syncStructure:true,addedScheduleIds:[missing]});f.onUpsert(()=>{});});
  f.flush();assert.equal(f.calls.some(c=>c[0]==='remove'),false);
  assert.ok(f.state[f.ctx.DASHBOARD_STRUCTURE_QUEUE_PREFIX_+tid]);
  f.calls.length=0;f.flush();assert.deepEqual(f.calls,[['insert',missing]]);
});
test('only the target trade is briefly fenced during removal HTTP, outside the global lock',()=>{
  const f=workerFixture();f.queue({syncStructure:true,removeScheduleIds:[missing]});
  f.onRemoval(()=>{
    assert.equal(f.ctx.dashboardTradeMutationLeaseError_(f.props,tid,'equipmentAdd','').code,'BUSY');
    assert.equal(f.ctx.dashboardTradeMutationLeaseError_(f.props,'260810-002','equipmentAdd',''),null);
  });
  f.flush();assert.deepEqual(f.calls,[['insert'],['remove',missing]]);
  assert.equal(f.ctx.dashboardTradeMutationLeaseError_(f.props,tid,'equipmentAdd',''),null);
  assert.equal(f.state[f.ctx.DASHBOARD_STRUCTURE_QUEUE_PREFIX_+tid],undefined);
});
test('legacy registration merge preserves its request in a retryable queue during removal claim',()=>{
  const start=gas.indexOf('    // 기존 거래 합침도 제외 투영');
  assert.ok(start>0,'registration merge must guard its existing trade before business writes');
  const end=gas.indexOf('    // 합침 요청에는',start);
  const events=[],ctx={mergeMode:true,mergeTargetTID:tid,reqID:'RQ-261014-001',sheet:{},triggerRow:2,
    registerOptions:{},_deferRegistrationDrain:false,
    PropertiesService:{getScriptProperties:()=>({})},
    dashboardTradeMutationLeaseError_:()=>({code:'BUSY',retryable:true,error:'in flight'}),
    markRegisterQueued_:()=>{events.push('preserved');return true;},
    enqueuePendingRegister_:(id,ms)=>{assert.equal(id,'RQ-261014-001');assert.equal(ms,30000);events.push('retry');}};
  vm.runInNewContext('function mergeGuard(){'+gas.slice(start,end)+';return "continue";} outcome=mergeGuard();',ctx);
  assert.equal(ctx.outcome.code,'BUSY');assert.equal(ctx._deferRegistrationDrain,true);
  assert.deepEqual(events,['preserved','retry']);
  assert.ok(start<gas.indexOf('var mergeSchedulePlan = planMergedScheduleRows_(',start));
});
