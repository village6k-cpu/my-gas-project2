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

test('the confirmation and scheduled checkout share one delivery record for the same recipient',()=>{
  const {ctx, props, booking} = load();
  vm.runInNewContext(fs.readFileSync('guideDoorAccess.js','utf8'),ctx);
  ctx.GUIDE_DELIVERY_INCIDENT_SUSPENDED_ = false;
  ctx.confirmedCheckoutTemplateCode_ = () => '026100001099';
  ctx.getMyPageLink = () => ({success:true,token:'synthetic',url:ctx.CONFIRMED_CHECKOUT_LINK_+'synthetic'});
  ctx._parseCheckoutDateTime = () => booking.checkoutAt;
  ctx.fmtDT = (date, time) => date + ' ' + time;
  ctx.normalizeAlimtalkReceiver_ = (phone) => phone;
  ctx.Utilities = { getUuid: () => 'test-request' };
  ctx.GUIDE_PARKING_NOTICE_ = '주차 안내';
  ctx._buildCheckoutMsg = (name) => name + ' 반출 안내';
  props.GUIDE_DOOR_PASSWORD = 'synthetic-password';
  let lastPayload;
  ctx.sendAlimtalk = (code, phone, name, content, vars, btns) => {
    lastPayload = {code, phone, name, content, vars, btns};
    return { receiptNum: '026101599999900001' };
  };
  vm.runInNewContext(fs.readFileSync('guideDeliverySafety.js','utf8'),ctx);
  ctx.GUIDE_DELIVERY_INCIDENT_SUSPENDED_ = false;
  const send = () => ctx.sendConfirmedCheckoutAlimtalk_(booking.tid, booking.cust.name, booking.cust.tel,
    '2026-11-07', '17:00', '2026-11-08', '17:00');
  assert.equal(send().state, 'pending');
  const confirmation = lastPayload;
  assert.equal(confirmation.btns[0].u1, ctx.CONFIRMED_CHECKOUT_LINK_ + 'synthetic');
  const key = ctx.guideRecordKey_(booking.tid, 'checkout');
  assert(!props[key].includes('synthetic-password') && !props[key].includes('synthetic'));
  ctx.guidePopbillRead_ = () => ({ templateCode: confirmation.code, msgs: [
    { state: 3, result: 100, content: confirmation.content, receiveNum: booking.cust.tel }
  ] });
  assert.equal(send().sent, false);
  assert.equal(ctx.sendGuideSafely_(booking.tid, 'checkout', booking.cust, booking.checkoutAt).state, 'delivered');
  assert.equal(lastPayload, confirmation);
  ctx.getGuideAlimtalkPayload_ = () => ({ channel: 'alimtalk', templateCode: '026100001008', content: '반출 안내' });
  const delegate = { name: '실제 반출자', tel: '01012345679' };
  assert.equal(ctx.sendGuideSafely_(booking.tid, 'checkout', delegate, booking.checkoutAt).sent, true);
  assert.equal(lastPayload.phone, delegate.tel);
  assert.equal(lastPayload.btns, null);
});
