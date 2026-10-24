const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const gas=fs.readFileSync(path.join(__dirname,'../checkAvailability.js'),'utf8');
const tid='261008-003',other='261008-004';
function fixture(){
 const state={},calls=[],deleted=[];
 const props={getProperty:k=>state[k],getProperties:()=>({...state}),setProperty:(k,v)=>{state[k]=v;},deleteProperty:k=>{delete state[k];}};
 for(const id of [tid,other])state['dashboardStructureQueue_v1_'+id]=JSON.stringify({token:'t',tradeId:id,revision:1,nextAt:0,syncStructure:true});
 const ctx={PropertiesService:{getScriptProperties:()=>props},Logger:{log(){}},
  LockService:{getScriptLock:()=>({tryLock:()=>true,releaseLock(){}})},
  ScriptApp:{getProjectTriggers:()=>[{getHandlerFunction:()=> 'flushDashboardStructureProjectionQueue_'}],deleteTrigger:t=>deleted.push(t)},
  SpreadsheetApp:{getActiveSpreadsheet:()=>({})}};
 vm.runInNewContext(gas,ctx);Object.assign(ctx,{ensureDashboardStructureProjectionTrigger_:()=>{},isDashboardTradeCheckoutStarted_:()=>false,
  SUPA_CFG_:()=>({}),buildSupabaseTrades_:ids=>{calls.push(ids[0]);return{trades:[],items:[]};},supaInsertAuthorizedScheduleItems_:()=>true});
 return{ctx,state,calls,deleted};
}
test('scoped drain executes only already-queued target work and preserves other trades/global trigger',()=>{
 const f=fixture(),before=f.state['dashboardStructureQueue_v1_'+other];
 f.ctx.flushDashboardStructureProjectionQueue_(tid);
 assert.deepEqual(f.calls,[tid]);assert.equal(f.state['dashboardStructureQueue_v1_'+tid],undefined);
 assert.equal(f.state['dashboardStructureQueue_v1_'+other],before);assert.equal(f.deleted.length,0);
});
test('a missing scoped target is not recreated and cannot execute another trade',()=>{
 const f=fixture();delete f.state['dashboardStructureQueue_v1_'+tid];f.ctx.flushDashboardStructureProjectionQueue_(tid);
 assert.deepEqual(f.calls,[]);assert.equal(f.deleted.length,0);
});
test('invalid scoped target never falls back to a global drain',()=>{
 const f=fixture();assert.throws(()=>f.ctx.flushDashboardStructureProjectionQueue_('invalid'),/거래ID/);assert.deepEqual(f.calls,[]);
});

test('scoped drain rejects a mismatched stored trade without consuming either queue',()=>{
 const f=fixture(),key='dashboardStructureQueue_v1_'+tid;
 f.state[key]=JSON.stringify({token:'t',tradeId:other,revision:1,nextAt:0,syncStructure:true});
 const before=JSON.stringify(f.state);
 assert.throws(()=>f.ctx.flushDashboardStructureProjectionQueue_(tid),/거래ID 불일치/);
 assert.deepEqual(f.calls,[]);assert.equal(JSON.stringify(f.state),before);assert.equal(f.deleted.length,0);
});
test('repair drain option does not enqueue or replay any source mutation',()=>{
 const f=fixture();f.ctx.readDashboardTradeProjectionState_=()=>({success:true,statusOnly:true,queue:null});
 const r=f.ctx.repairDashboardTradeProjection_(tid,undefined,false,{drainPending:true});
 assert.deepEqual(f.calls,[tid]);assert.equal(r.drainPerformed,true);assert.equal(r.projectionPending,false);
});
test('statusOnly dominates a drain flag and remains strictly read-only',()=>{
 const f=fixture();f.ctx.readDashboardTradeProjectionState_=()=>({success:true,statusOnly:true});
 const r=f.ctx.repairDashboardTradeProjection_(tid,undefined,true,{drainPending:true});
 assert.equal(r.statusOnly,true);assert.deepEqual(f.calls,[]);
});
test('drain refuses new removal grants rather than quietly mixing execution with enqueue',()=>{
 const f=fixture();const r=f.ctx.repairDashboardTradeProjection_(tid,[tid+'-08'],false,{drainPending:true});
 assert.ok(r.error);assert.deepEqual(f.calls,[]);
});
test('API rejects GET drains and accepts only authenticated-router POST execution',()=>{
 const api=fs.readFileSync(path.join(__dirname,'../sheetAPI.js'),'utf8');
 const code=api.slice(api.indexOf('case "repairTradeProjection":'),api.indexOf('case "getTradeDiscountState":'));
 for(const method of ['GET','POST']){
  const calls=[],ctx={e:{villageHttpMethod_:method},params:{tid,drainPending:'true'},postBody:{},jsonResponse:x=>x,
   requireVillagePost_:event=>event.villageHttpMethod_==='POST'?null:{error:'POST required'},
   repairDashboardTradeProjection_:(...args)=>{calls.push(args);return {success:true};}};
  vm.runInNewContext('function route(){switch("repairTradeProjection"){'+code+'}} result=route();',ctx);
  assert.equal(calls.length,method==='POST'?1:0);
  if(method==='POST')assert.equal(calls[0][3].drainPending,true);else assert.ok(ctx.result.error);
 }
});

test('API GET with both flags remains a read-only status request',()=>{
 const api=fs.readFileSync(path.join(__dirname,'../sheetAPI.js'),'utf8');
 const code=api.slice(api.indexOf('case "repairTradeProjection":'),api.indexOf('case "getTradeDiscountState":'));
 const ctx={e:{villageHttpMethod_:'GET'},params:{tid,statusOnly:'true',drainPending:'true'},postBody:{},jsonResponse:x=>x,
  requireVillagePost_:()=>{throw Error('must remain read-only');},
  repairDashboardTradeProjection_:(id,removed,status,options)=>({status,drain:options.drainPending})};
 vm.runInNewContext('function route(){switch("repairTradeProjection"){'+code+'}} result=route();',ctx);
 assert.equal(ctx.result.status,true);assert.equal(ctx.result.drain,false);
});

test('deferred financial authority retains structure task before any external or return/removal work',()=>{
 const f=fixture(),key='dashboardStructureQueue_v1_'+tid;
 const task=JSON.parse(f.state[key]);task.returnState={done:true};task.removeScheduleIds=[tid+'-01'];f.state[key]=JSON.stringify(task);
 let external=0;
 f.ctx.buildSupabaseTrades_=()=>({trades:[],items:[],deferredTradeIds:[tid]});
 for(const name of ['supaInsertAuthorizedScheduleItems_','supaSetTradeReturnDone_','supaMarkScheduleItemsRemoved_'])f.ctx[name]=()=>{external++;return {ok:true};};
 const otherBefore=f.state['dashboardStructureQueue_v1_'+other];
 f.ctx.flushDashboardStructureProjectionQueue_(tid);
 assert.equal(external,0);
 const pending=JSON.parse(f.state[key]);assert.equal(pending.token,task.token);assert.equal(pending.revision,task.revision);assert.equal(pending.lastAttemptStage,'financial_source');assert.equal(pending.attempts,1);
 assert.equal(f.state['dashboardStructureQueue_v1_'+other],otherBefore);
});
