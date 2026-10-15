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

test('disabling the incident flag cannot recreate SMS sending or the five-minute watchdog',()=>{
  let calls=0,created=0;const removed=[];
  const triggers=['checkGuideAlimtalk','checkGuideDeliverySafety','warmDashboardCache'].map(name=>({getHandlerFunction:()=>name}));
  const ctx={Date,Error,PropertiesService:{getScriptProperties:()=>({getProperty:()=>null,setProperty:()=>{}})},
    ScriptApp:{getProjectTriggers:()=>triggers.filter(t=>!removed.includes(t.getHandlerFunction())),deleteTrigger:t=>removed.push(t.getHandlerFunction()),newTrigger:()=>{created++;throw Error('watchdog must not be recreated');}},
    UrlFetchApp:{fetch:()=>{calls++;throw Error('SMS gateway must not be reached');}}};
  vm.runInNewContext(fs.readFileSync('guideDeliverySafety.js','utf8'),ctx);
  ctx.GUIDE_DELIVERY_INCIDENT_SUSPENDED_=false;
  ctx.inspectGuideDeliverySafety=()=>({rows:[]});
  assert.throws(()=>ctx.sendGuideLms_(),/문자.*중단/);
  assert.equal(ctx.sendGuideSafetyAlert_().state,'disabled');
  assert.equal(ctx.setupGuideDeliverySafety().mode,'manual');
  assert.deepEqual(removed,['checkGuideDeliverySafety']);
  assert.equal(ctx.checkGuideDeliverySafety().rows.length,0);
  assert.equal(created,0);assert.equal(calls,0);
});

test('manual guide tests also respect the incident stop and pending template approval',()=>{
  let sends=0;
  const ctx={GUIDE_DELIVERY_INCIDENT_SUSPENDED_:true,
    getGuideAlimtalkPayload_:()=>({channel:'blocked',approvalPending:true}),
    sendAlimtalk:()=>{sends++;},sendGuideLms_:()=>{sends++;}};
  const source=fs.readFileSync('checkAvailability.js','utf8');
  const start=source.indexOf('function testGuideAlimtalk(');
  vm.runInNewContext(source.slice(start,source.indexOf('\n}',start)+2),ctx);
  assert.equal(ctx.testGuideAlimtalk({phone:'01012345678'}).suspended,true);
  ctx.GUIDE_DELIVERY_INCIDENT_SUSPENDED_=false;
  assert.equal(ctx.testGuideAlimtalk({phone:'01012345678'}).approvalPending,true);
  assert.equal(sends,0);
});
