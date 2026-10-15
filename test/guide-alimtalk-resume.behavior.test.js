const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
function load(){
  const props={};let approved=true,triggers=0,sends=0;
  const booking={tid:'261015-001',cust:{name:'예약자',tel:'01012345678',status:'예약'},checkoutAt:new Date(Date.now()+3600000),returnAt:new Date(Date.now()+86400000)};
  const ctx={Date,Error,PropertiesService:{getScriptProperties:()=>({getProperty:k=>props[k]||null,setProperty:(k,v)=>{props[k]=v;}})},
    getGuideDoorAccessStatus:()=>({configured:true,checkout:{approved},checkin:{approved}}),
    setupGuideAlimtalkTrigger:()=>{triggers++;},guideSafetyBookings_:()=>[booking],guideRecipient_:(_tid,c)=>c,
    LockService:{getScriptLock:()=>({tryLock:()=>true,releaseLock:()=>{}})},
    ScriptApp:{getProjectTriggers:()=>[]},
  };
  vm.runInNewContext(fs.readFileSync('guideDeliverySafety.js','utf8'),ctx);
  ctx.guideSafetyBookings_=()=>[booking];
  ctx.guideRecipient_=(_tid,c)=>c;
  ctx.sendGuideSafely_=()=>{sends++;return {state:'pending',sent:true,receiptNum:'026101599999900001'};};
  return {ctx,props,booking,getSends:()=>sends,getTriggers:()=>triggers,setApproved:v=>{approved=v;}};
}
test('Alimtalk resume requires both exact approved templates and never sends by itself',()=>{
  const h=load();assert.equal(typeof h.ctx.manageGuideAlimtalk,'function');
  h.setApproved(false);assert.throws(()=>h.ctx.manageGuideAlimtalk({action:'resume'}),/승인/);
  assert.equal(h.getTriggers(),0);assert.equal(h.getSends(),0);
  h.setApproved(true);h.ctx.manageGuideAlimtalk({action:'resume'});
  assert.equal(h.props.GUIDE_ALIMTALK_SUSPENDED,'false');assert.equal(h.getTriggers(),1);assert.equal(h.getSends(),0);
  assert.throws(()=>h.ctx.sendGuideLms_(),/문자.*중단/);
});
test('one booking send uses authoritative contact, normal journal and no SMS bypass',()=>{
  const h=load();assert.equal(typeof h.ctx.manageGuideAlimtalk,'function');
  assert.throws(()=>h.ctx.manageGuideAlimtalk({action:'send',tradeId:h.booking.tid,kind:'checkout'}),/중단/);
  h.ctx.manageGuideAlimtalk({action:'resume'});
  const r=h.ctx.manageGuideAlimtalk({action:'send',tradeId:h.booking.tid,kind:'checkout'});
  assert.equal(r.state,'pending');assert.equal(r.delivered,false);assert.equal(h.getSends(),1);
  h.booking.conflict=true;assert.throws(()=>h.ctx.manageGuideAlimtalk({action:'send',tradeId:h.booking.tid,kind:'checkout'}),/유효 예약/);
  assert.equal(h.getSends(),1);
});
test('stop persists across the next invocation and preserves SMS isolation',()=>{
  const h=load();assert.equal(typeof h.ctx.manageGuideAlimtalk,'function');
  h.ctx.manageGuideAlimtalk({action:'resume'});h.ctx.manageGuideAlimtalk({action:'stop'});
  assert.equal(h.props.GUIDE_ALIMTALK_SUSPENDED,'true');assert.equal(h.ctx.GUIDE_DELIVERY_INCIDENT_SUSPENDED_,true);
  assert.throws(()=>h.ctx.manageGuideAlimtalk({action:'send',tradeId:h.booking.tid,kind:'checkout'}),/중단/);
});
