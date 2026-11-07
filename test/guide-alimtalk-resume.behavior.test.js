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

test('booking confirmation has its own delivery record and cannot suppress scheduled checkout',()=>{
  const {ctx, props, booking} = load();
  vm.runInNewContext(fs.readFileSync('guideDeliverySafety.js','utf8'),ctx);
  vm.runInNewContext(fs.readFileSync('bookingConfirmationAlimtalk.js','utf8'),ctx);
  const linkTemplate = ctx.BOOKING_CONFIRMATION_LINK_ + '#{예약토큰}';
  const bodyTemplate = ctx.buildBookingConfirmationMessage_('#{고객명}', '#{반출일시}', '#{반납일시}');
  const template = { templateCode:'026100001099', state:'2', template:bodyTemplate,
    btns:[{n:'내 예약 확인', t:'WL', u1:linkTemplate, u2:linkTemplate}] };
  const cache = new Map();
  ctx.CacheService = {getScriptCache:()=>({get:key=>cache.get(key) ?? null,put:(key,value)=>cache.set(key,value)})};
  ctx.popbillKakaoRead_ = () => [template];
  ctx.getMyPageLink = () => ({success:true,token:'synthetic',url:ctx.BOOKING_CONFIRMATION_LINK_+'synthetic'});
  ctx.fmtDT = (date, time) => date + ' ' + time;
  ctx.normalizeAlimtalkReceiver_ = (phone) => phone;
  ctx.Utilities = { getUuid: () => 'test-request' };
  ctx.operationalPropertyStore_ = (_group, base) => base;
  ctx._alimtalkAccepted_ = (result) => !!result.receiptNum;
  let lastPayload;
  ctx.sendAlimtalk = (code, phone, name, content, vars, btns) => {
    lastPayload = {code, phone, name, content, vars, btns};
    return { receiptNum: '026101599999900001' };
  };
  const send = () => ctx.sendBookingConfirmationAlimtalk_(booking.tid, booking.cust.name, booking.cust.tel,
    '2026-11-07', '17:00', '2026-11-08', '17:00');
  assert.equal(send(), null);
  template.state = '3';
  template.btns[0].u2 += 'wrong';
  cache.clear();
  assert.equal(send(), null);
  template.btns[0].u2 = linkTemplate;
  cache.clear();
  assert.equal(send().state, 'pending');
  const confirmation = lastPayload;
  assert.equal(confirmation.btns[0].u1, ctx.BOOKING_CONFIRMATION_LINK_ + 'synthetic');
  assert.match(confirmation.content, /견적서 보기/);
  assert.doesNotMatch(confirmation.content, /비밀번호|주차/);
  const key = ctx.guideRecordKey_(booking.tid, 'checkout');
  assert.equal(props[key], undefined);
  assert.equal(send().state, 'duplicate');
  assert.equal(lastPayload, confirmation);
  ctx.GUIDE_DELIVERY_INCIDENT_SUSPENDED_ = false;
  ctx.getGuideAlimtalkPayload_ = () => ({ channel: 'alimtalk', templateCode: '026100001008', content: '반출 안내' });
  // 통합 안내가 이미 접수됐던 예약도 기존 반출 안내를 받는다.
  props[key] = JSON.stringify({confirmedCheckout:{},state:'delivered',
    binding:booking.cust.tel+'|'+booking.cust.name+'|'+booking.checkoutAt.getTime()});
  assert.equal(ctx.sendGuideSafely_(booking.tid, 'checkout', booking.cust, booking.checkoutAt).sent, true);
  assert.equal(lastPayload.code, '026100001008');
  assert.equal(lastPayload.phone, booking.cust.tel);
  assert.equal(lastPayload.btns, null);
});
