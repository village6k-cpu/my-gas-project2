const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const gas=fs.readFileSync(path.join(__dirname,'../checkAvailability.js'),'utf8');
function fixture(tasks){
 const state={},processed=[],delays=[],now=Date.now();
 const props={getProperties:()=>({...state}),getProperty:k=>state[k],setProperty:(k,v)=>{state[k]=v;},deleteProperty:k=>{delete state[k];}};
 tasks.forEach(([tid,offset,valid=true])=>{state['dashboardStructureQueue_v1_'+tid]=JSON.stringify({tradeId:tid,token:valid?'t':undefined,revision:1,nextAt:now+offset,syncStructure:true});});
 const ctx={PropertiesService:{getScriptProperties:()=>props},Logger:{log(){}},
  ScriptApp:{getProjectTriggers:()=>[]},SpreadsheetApp:{getActiveSpreadsheet:()=>({})},
  LockService:{getScriptLock:()=>({tryLock:()=>true,releaseLock(){}})}};
 vm.runInNewContext(gas,ctx);
 Object.assign(ctx,{ensureDashboardStructureProjectionTrigger_:ms=>delays.push(ms),isDashboardTradeCheckoutStarted_:()=>false,
  SUPA_CFG_:()=>({}),buildSupabaseTrades_:ids=>{processed.push(ids[0]);return {trades:[],items:[]};},supaInsertAuthorizedScheduleItems_:()=>true});
 return {ctx,state,processed,delays,now,flush:()=>ctx.flushDashboardStructureProjectionQueue_()};
}
const ids=n=>Array.from({length:n},(_,i)=>'261001-'+String(i+1).padStart(3,'0'));
test('twenty future/backoff entries cannot starve the twenty-first due task',()=>{
 const f=fixture([...ids(20).map(id=>[id,30*60000]),['261008-003',-60000]]);
 f.flush();assert.deepEqual(f.processed,['261008-003']);
  assert.equal(f.state['dashboardStructureQueue_v1_261008-003'],undefined);
 assert.equal(Object.keys(f.state).filter(k=>k.startsWith('dashboardStructureQueue_')).length,20);
});
test('an entirely future queue schedules one bounded future wake-up, not an overflow hot loop',()=>{
 const f=fixture(ids(25).map(id=>[id,30*60000]));f.flush();
 assert.deepEqual(f.processed,[]);assert.deepEqual(f.delays,[5*60000]);
});
test('oldest eligible work is selected before newer due retries, retaining the batch limit',()=>{
 const f=fixture([...ids(20).map(id=>[id,-1000]),['261008-003',-60000]]);f.flush();
 assert.equal(f.processed[0],'261008-003');assert.equal(f.processed.length,20);
 assert.equal(Object.keys(f.state).filter(k=>k.startsWith('dashboardStructureQueue_')).length,1);
 assert.equal(f.delays.at(-1),1000);
});
test('an invalid task is still cleaned even if its timestamp is in the future',()=>{
 const f=fixture([['261008-003',30*60000,false]]);f.flush();
 assert.equal(Object.keys(f.state).filter(k=>k.startsWith('dashboardStructureQueue_')).length,0);
});
test('read-only planner exposes aggregate eligibility and target position without changing the snapshot',()=>{
 const f=fixture([...ids(20).map(id=>[id,30*60000]),['261008-003',-60000]]),before={...f.state};
 assert.equal(typeof f.ctx.planDashboardStructureProjectionBatch_,'function');
 const plan=f.ctx.planDashboardStructureProjectionBatch_(f.state,f.now);
 assert.equal(plan.total,21);assert.equal(plan.futureCount,20);assert.equal(plan.dueKeys.length,1);
 assert.equal(plan.allKeys.indexOf('dashboardStructureQueue_v1_261008-003'),20);
 assert.deepEqual(f.state,before);
});
