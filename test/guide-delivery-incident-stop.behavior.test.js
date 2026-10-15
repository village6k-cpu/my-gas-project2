const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
test('production incident stop blocks all guide API calls and removes only the guide sending/watchdog triggers',()=>{
  let calls=0;const removed=[],props={};
  const triggers=['checkGuideAlimtalk','checkGuideDeliverySafety','onEditInstallable','warmDashboardCache'].map(name=>({getHandlerFunction:()=>name}));
  const ctx={Date,Error,PropertiesService:{getScriptProperties:()=>({setProperty:(k,v)=>props[k]=v})},
    ScriptApp:{getProjectTriggers:()=>triggers.filter(t=>!removed.includes(t.getHandlerFunction())),deleteTrigger:t=>removed.push(t.getHandlerFunction())},
    UrlFetchApp:{fetch:()=>{calls++;throw Error('must not reach gateway');}}};
  vm.runInNewContext(fs.readFileSync('guideDeliverySafety.js','utf8'),ctx);
  assert.equal(ctx.GUIDE_DELIVERY_INCIDENT_SUSPENDED_,true);
  assert.throws(()=>ctx.sendGuideLms_(),/긴급 중단/);
  assert.throws(()=>ctx.guidePopbillRead_('/Message/Search'),/긴급 중단/);
  assert.equal(ctx.sendGuideSafely_().state,'suspended');
  assert.equal(ctx.sendGuideSafetyAlert_().state,'suspended');
  assert(ctx.checkGuideDeliverySafety().suspended);
  assert.deepEqual(removed,['checkGuideAlimtalk','checkGuideDeliverySafety']);
  assert(ctx.setupGuideDeliverySafety().suspended);
  const source=fs.readFileSync('checkAvailability.js','utf8');
  for(const name of ['checkGuideAlimtalk','checkGuideAlimtalkLocked_','setupGuideAlimtalkTrigger']){
    const start=source.indexOf('function '+name+'(');vm.runInNewContext(source.slice(start,source.indexOf('\n}',start)+2),ctx);
    assert(ctx[name]().suspended,name+' must stop before reading sheets or reaching the gateway');
  }
  assert.equal(calls,0);assert(props.GUIDE_DELIVERY_INCIDENT_STOPPED_AT);
});
