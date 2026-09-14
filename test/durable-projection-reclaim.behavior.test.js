'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
function fixture() {
  const tid = '260914-099';
  const queueKey = 'dashboardStructureQueue_v1_' + tid;
  const state = {
    [queueKey]: JSON.stringify({token:'pending',tradeId:tid,revision:2,removeScheduleIds:[tid+'-01'],addedScheduleIds:[tid+'-02'],returnState:{done:false}}),
    ['dashboardStructureMutation_'+tid]: JSON.stringify({token:'pending',at:Date.now()}),
    ['dashboardReturnProjectionLease_'+tid]: JSON.stringify({token:'pending',at:Date.now()}),
    ['dashboardMutationLog_'+tid]: JSON.stringify({operation:'accepted'}),
    dashboardMutationLog_260801001: 'orphan',
    itemCheck_200101001: 'stale',
    INTERNAL_CREDENTIAL: 'do-not-return-or-delete',
  };
  const props = {getProperties:()=>({...state}),getKeys:()=>Object.keys(state),getProperty:k=>state[k],setProperty:(k,v)=>{state[k]=v;},deleteProperty:k=>{delete state[k];}};
  const ctx = {PropertiesService:{getScriptProperties:()=>props},Logger:{log(){}}};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../checkAvailability.js'),'utf8'),ctx);
  ctx.activeDashboardMutationLease_ = () => null;
  ctx.supaMarkTradeDirty_ = () => {};
  return {ctx,props,state,tid,queueKey};
}
for (const aggressive of [false,true]) {
  test('property reclamation preserves queued work and its coordination state, aggressive='+aggressive,()=>{
    const f=fixture(), before={...f.state};
    const result=f.ctx.reclaimDashboardScriptProperties_(f.props,{aggressive});
    for(const key of Object.keys(before).filter(k=>k.endsWith(f.tid))) assert.equal(f.state[key],before[key],key);
    assert.equal(f.state.INTERNAL_CREDENTIAL,before.INTERNAL_CREDENTIAL);
    assert.equal(f.state.dashboardMutationLog_260801001,undefined);
    assert.ok(result.deleted>0);
    f.ctx.scheduleDashboardStructureProjectionUnderLock_(f.tid,{addedScheduleIds:[f.tid+'-03']});
    const task=JSON.parse(f.state[f.queueKey]);
    assert.deepEqual(task.removeScheduleIds,[f.tid+'-01']);
    assert.deepEqual(task.addedScheduleIds,[f.tid+'-02',f.tid+'-03']);
    assert.deepEqual(task.returnState,{done:false});
  });
}
test('dry run does not nominate pending work as disposable cache',()=>{
  const f=fixture(),before={...f.state};
  const result=f.ctx.reclaimDashboardScriptProperties_(f.props,{dryRun:true,aggressive:true});
  assert.deepEqual(f.state,before);
  assert.ok(!result.sample.some(k=>k.endsWith(f.tid)));
});
test('quota recovery cannot erase already accepted projection work',()=>{
  const f=fixture(),before=f.state[f.queueKey],set=f.props.setProperty;
  let first=true;
  f.props.setProperty=(k,v)=>{if(first){first=false;throw Error('storage quota exceeded');}set(k,v);};
  assert.equal(f.ctx.trySetScriptProperty_(f.props,'unrelated_property','new value'),true);
  assert.equal(f.state[f.queueKey],before);
  assert.equal(f.state.unrelated_property,'new value');
});
test('unparseable durable queue stays available for diagnosis and recovery',()=>{
  const f=fixture();f.state[f.queueKey]='incomplete payload';
  f.ctx.reclaimDashboardScriptProperties_(f.props,{aggressive:true});
  assert.equal(f.state[f.queueKey],'incomplete payload');
});


test('a newly queued projection protects its records during cache deletion',()=>{
  const f=fixture(),pending=f.state[f.queueKey],orphan='dashboardMutationLog_260801001';
  delete f.state[f.queueKey];
  f.props.getProperties=()=>({[orphan]:f.state[orphan],...f.state});
  const remove=f.props.deleteProperty;
  f.props.deleteProperty=k=>{remove(k);if(k===orphan)f.state[f.queueKey]=pending;};
  const result=f.ctx.reclaimDashboardScriptProperties_(f.props,{aggressive:true});
  assert.equal(f.state[f.queueKey],pending);
  for(const suffix of ['dashboardStructureMutation_','dashboardReturnProjectionLease_','dashboardMutationLog_']) assert.ok(f.state[suffix+f.tid]);
  assert.equal(result.deleted,2);
});
test('reclamation preserves a property changed after its snapshot',()=>{
  const f=fixture(),key='dashboardMutationLog_260801001',read=f.props.getProperty;
  f.props.getProperty=k=>{if(k===key)f.state[k]='new concurrent value';return read(k);};
  f.ctx.reclaimDashboardScriptProperties_(f.props,{aggressive:true});
  assert.equal(f.state[key],'new concurrent value');
});
