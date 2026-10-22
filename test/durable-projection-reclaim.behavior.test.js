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
    dashboardMutationLog_260801001: 'unknown-age-receipt',
    'itemCheck_200101-001-01_checkout': '1',
    INTERNAL_CREDENTIAL: 'do-not-return-or-delete',
  };
  const props = {getProperties:()=>({...state}),getKeys:()=>Object.keys(state),getProperty:k=>state[k],setProperty:(k,v)=>{state[k]=v;},deleteProperty:k=>{delete state[k];}};
  const ctx = {PropertiesService:{getScriptProperties:()=>props},Logger:{log(){}}};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../checkAvailability.js'),'utf8'),ctx);
  ctx.supaMarkTradeDirty_ = () => {};
  return {ctx,props,state,tid,queueKey};
}
for (const aggressive of [false,true]) {
  test('property reclamation preserves queued work and its coordination state, aggressive='+aggressive,()=>{
    const f=fixture(), before={...f.state};
    const result=f.ctx.reclaimDashboardScriptProperties_(f.props,{aggressive});
    for(const key of Object.keys(before).filter(k=>k.endsWith(f.tid))) assert.equal(f.state[key],before[key],key);
    assert.equal(f.state.INTERNAL_CREDENTIAL,before.INTERNAL_CREDENTIAL);
    assert.equal(f.state.dashboardMutationLog_260801001,before.dashboardMutationLog_260801001);
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


test('a newly queued projection protects its records and checkout mirror during cache deletion',()=>{
  const f=fixture(),pending=f.state[f.queueKey],first='itemCheck_200101-001-01_checkout',mirror='itemCheck_'+f.tid+'-01_checkout';
  delete f.state[f.queueKey];
  f.state[mirror]='1';
  f.props.getProperties=()=>({[first]:f.state[first],...f.state});
  const remove=f.props.deleteProperty;
  f.props.deleteProperty=k=>{remove(k);if(k===first)f.state[f.queueKey]=pending;};
  const result=f.ctx.reclaimDashboardScriptProperties_(f.props,{aggressive:true});
  assert.equal(f.state[f.queueKey],pending);
  for(const suffix of ['dashboardStructureMutation_','dashboardReturnProjectionLease_','dashboardMutationLog_']) assert.ok(f.state[suffix+f.tid]);
  assert.equal(f.state[mirror],'1');assert.equal(result.deleted,1);
});
test('reclamation preserves a property changed after its snapshot',()=>{
  const f=fixture(),key='itemCheck_200101-001-01_checkout',read=f.props.getProperty;
  f.props.getProperty=k=>{if(k===key)f.state[k]='new concurrent value';return read(k);};
  f.ctx.reclaimDashboardScriptProperties_(f.props,{aggressive:true});
  assert.equal(f.state[key],'new concurrent value');
});

test('accepted projection also preserves the real per-scope hashed mutation-log key',()=>{
 const f=fixture(),key=f.ctx.dashboardMutationLogKey_(f.tid,'addEquip');
 const receipt=JSON.stringify([{id:'accepted:add',state:'pending',at:Date.now()}]);f.state[key]=receipt;
 f.ctx.reclaimDashboardScriptProperties_(f.props,{aggressive:true});
 assert.equal(f.state[key],receipt);
});

for (const aggressive of [false,true]) test('generic reclaim never expires active, recent, old or unknown coordination and receipts, aggressive='+aggressive,()=>{
  const f=fixture();delete f.state[f.queueKey];
  const prefixes=['setupClosing_','setupMutation_','returnMutation_','checkoutItemMutation_',
    'dashboardMutationLog_','dashboardMutationLog_v2_','dashboardStructureMutation_','dashboardReturnProjectionLease_',
    'dashboardReturnProjectionInFlight_','dashboardRemovalProjectionInFlight_','dashboardAuxMutation_',
    'registeredTradePriceMutation_','checkoutBaselineStarted_','returnForced_v1_','returnPrevContractStatus_',
    'dashboardCompletionRevision_setup_','dashboardCompletionRevision_return_'];
  const raws=[JSON.stringify({token:'active',at:Date.now()}),JSON.stringify({state:'committed',at:Date.now()-1000}),
    JSON.stringify({at:1}),'unparseable unknown age'];
  const protectedValues={};
  prefixes.forEach(prefix=>raws.forEach((raw,index)=>{ const key=prefix+'200101-00'+index;f.state[key]=raw;protectedValues[key]=raw; }));
  const dry=f.ctx.reclaimDashboardScriptProperties_(f.props,{aggressive,dryRun:true,cutoffYYMMDD:'991231'});
  assert.ok(!dry.sample.some(key=>Object.hasOwn(protectedValues,key)));
  f.ctx.reclaimDashboardScriptProperties_(f.props,{aggressive,cutoffYYMMDD:'991231'});
  Object.entries(protectedValues).forEach(([key,value])=>assert.equal(f.state[key],value,key));
});

test('quota reclamation cannot remove a live checkout lease and let a conflicting operation through',()=>{
  const f=fixture();delete f.state[f.queueKey];
  const key='checkoutItemMutation_'+f.tid;f.state[key]=JSON.stringify({token:'live-http',at:Date.now()});
  assert.equal(f.ctx.dashboardTradeMutationLeaseError_(f.props,f.tid,'setup','other').code,'BUSY');
  f.ctx.reclaimDashboardScriptProperties_(f.props,{aggressive:true});
  assert.equal(f.ctx.dashboardTradeMutationLeaseError_(f.props,f.tid,'setup','other').code,'BUSY');
});

test('quota reclamation preserves recent A then B receipts so an old A retry still skips',()=>{
  const f=fixture();delete f.state[f.queueKey];
  const scope='item:checkout:'+f.tid+'-01';
  f.ctx.beginDashboardMutation_(f.props,f.tid,'item:A',scope,'1');f.ctx.commitDashboardMutation_(f.props,f.tid,'item:A',scope);
  f.ctx.beginDashboardMutation_(f.props,f.tid,'item:B',scope,'0');f.ctx.commitDashboardMutation_(f.props,f.tid,'item:B',scope);
  f.ctx.reclaimDashboardScriptProperties_(f.props,{aggressive:true});
  const retry=f.ctx.beginDashboardMutation_(f.props,f.tid,'item:A',scope,'1');
  assert.equal(retry.duplicate,true);assert.equal(retry.skip,true);assert.equal(retry.pendingLater,false);
});

for (const aggressive of [false,true]) test('completion replay and checkin identity evidence survive reclamation, aggressive='+aggressive,()=>{
  const f=fixture(),tid='200101-001',sid=tid+'-01';
  ['setupDone_','returnDone_'].forEach(prefix=>{f.state[prefix+tid]='1';});
  ['setupDoneAt_','returnDoneAt_'].forEach(prefix=>{f.state[prefix+tid]='2026-10-23T00:00:00Z';});
  f.state['dashboardCompletionRevision_setup_'+tid]='1234';
  f.state['itemCheck_'+sid+'_checkin']=f.ctx.dashboardReturnInspectionToken_(tid,1,'part','set',false);
  const before=JSON.stringify(f.ctx.dashboardSetupCanonicalResult_(tid,f.props));
  f.ctx.reclaimDashboardScriptProperties_(f.props,{aggressive});
  assert.equal(JSON.stringify(f.ctx.dashboardSetupCanonicalResult_(tid,f.props)),before);
  assert.equal(f.ctx.getDashboardCheckinItemDefault_(f.props,sid,true,true,tid,1,'part','set',false),true);
  assert.equal(f.state['returnDone_'+tid],'1');assert.equal(f.state['returnDoneAt_'+tid],'2026-10-23T00:00:00Z');
});

for (const aggressive of [false,true]) test('only recognized checkout mirrors, retired quantity mirrors and retired photo indexes remain disposable, aggressive='+aggressive,()=>{
  const f=fixture();
  const old='itemCheck_200101-001-01_checkout',recent='itemCheck_991231-001-01_checkout',legacy='itemCheckQty_200101-001-01_checkin';
  const photo='dashboard_photo_file_index_v2_property_0',manifest='dashboard_photo_file_index_v2_property_manifest';
  f.state[recent]='1';f.state[legacy]='1';f.state[photo]='retired chunk';f.state[manifest]='retired manifest';
  f.state.itemCheck_unrecognized_checkout='unknown identity';f.state.itemCheck_200101001='unknown legacy';
  f.state.dashboardPhotoUpload_active='durable upload receipt';
  f.ctx.reclaimDashboardScriptProperties_(f.props,{aggressive,cutoffYYMMDD:'260901'});
  for(const key of [old,legacy,photo,manifest]) assert.equal(f.state[key],undefined,key);
  assert.equal(f.state[recent],aggressive?undefined:'1');
  assert.equal(f.state.itemCheck_unrecognized_checkout,'unknown identity');assert.equal(f.state.itemCheck_200101001,'unknown legacy');
  assert.equal(f.state.dashboardPhotoUpload_active,'durable upload receipt');
});

test('pending queues and unreadable queue existence protect checkout mirrors',()=>{
  for (const unreadable of [false,true]) {
    const f=fixture(),key='itemCheck_'+f.tid+'-01_checkout';f.state[key]='1';
    if(unreadable) {
      delete f.state[f.queueKey];const read=f.props.getProperty;
      f.props.getProperty=k=>{if(k===f.queueKey)throw Error('queue lookup unavailable');return read(k);};
    }
    f.ctx.reclaimDashboardScriptProperties_(f.props,{aggressive:true,cutoffYYMMDD:'991231'});
    assert.equal(f.state[key],'1');
  }
});
