const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
function load(){
  const props={GUIDE_DOOR_PASSWORD:'test-password',GUIDE_ALERT_PHONE:'01000000000'};
  const sends=[],alerts=[];let reply={receiptNum:'026101499999900001'},delivery=null;
  const ctx={Date,JSON,Math,Object,String,Number,Error,GUIDE_DOOR_PASSWORD_PROPERTY_:'GUIDE_DOOR_PASSWORD',
    PropertiesService:{getScriptProperties:()=>({getProperty:k=>props[k]||null,setProperty:(k,v)=>props[k]=v,getKeys:()=>Object.keys(props),deleteProperty:k=>delete props[k]})},
    Utilities:{getUuid:()=> '11111111-2222-3333-4444-555555555555',newBlob:s=>({getBytes:()=>Buffer.from(s)}),formatDate:()=> '20261014 23:00'},
    normalizeAlimtalkReceiver_:v=>{let p=String(v).replace(/\D/g,'');if(/^10\d{8}$/.test(p))p='0'+p;if(!/^010\d{8}$/.test(p))throw Error('전화번호 형식 오류');return p;},
    getGuideAlimtalkPayload_:()=>({channel:'alimtalk',templateCode:'new-approved',content:'test-password',vars:{},altContent:'test-password'}),
    buildGuideDoorMessage_:()=> 'test-password',buildGuideAccessSms_:()=> 'test-password',
    sendAlimtalk:(...args)=>{sends.push(args);if(reply instanceof Error)throw reply;return reply;},
    _getPopbillToken:()=> 'test-token',
    UrlFetchApp:{fetch:()=>({getResponseCode:()=>200,getContentText:()=>JSON.stringify(delivery||{code:-1,message:'lookup unavailable'})})},
    Logger:{log:()=>{}},
  };
  const code=fs.existsSync('guideDeliverySafety.js')?fs.readFileSync('guideDeliverySafety.js','utf8'):'';
  vm.runInNewContext(code,ctx);
  // 발송 로직 단위 테스트만 격리해서 검사한다. 운영 코드의 긴급 중단 기본값은 별도 검증한다.
  ctx.GUIDE_DELIVERY_INCIDENT_SUSPENDED_=false;
  ctx.sendGuideSafetyAlert_=issue=>alerts.push(issue);
  return {ctx,props,sends,alerts,setReply:r=>reply=r,setDelivery:r=>delivery=r};
}
const due=new Date(Date.now()+60*60*1000),cust={name:'테스트',tel:'01012345678'};
function message(result=100,altResult='',phone=cust.tel){return {templateCode:'new-approved',msgs:[{state:3,result,altResult,receiveNum:phone,content:'test-password',altContent:'test-password'}]};}
test('API acceptance remains pending; final delivery is checked and not resent',()=>{
  const h=load();assert.equal(typeof h.ctx.sendGuideSafely_,'function','a durable guide delivery guard must exist');
  h.ctx.sendGuideSafely_('261014-020','checkout',cust,due);
  assert.equal(h.sends.length,1);
  assert.equal(h.sends[0][6].altSendType,'','guide requests must not silently enable SMS substitution');
  const r=JSON.parse(h.props.GUIDE_DELIVERY_V3_out_261014_020);
  assert.equal(r.state,'pending');assert(!JSON.stringify(r).includes('test-password'));
  h.setDelivery(message());h.ctx.sendGuideSafely_('261014-020','checkout',cust,due);
  assert.equal(h.sends.length,1);assert.equal(JSON.parse(h.props.GUIDE_DELIVERY_V3_out_261014_020).state,'delivered');
});
test('unapproved or unavailable templates never fall back to a direct SMS or create a sent record',()=>{
  const h=load();
  h.ctx.getGuideAlimtalkPayload_=()=>({channel:'blocked',approvalPending:true});
  let sms=0;h.ctx.sendGuideLms_=()=>{sms++;};
  const result=h.ctx.sendGuideSafely_('261014-020','checkout',cust,due);
  assert.equal(result.state,'approval_pending');assert.equal(result.sent,false);
  assert.equal(h.sends.length,0);assert.equal(sms,0);
  assert.equal(h.props.GUIDE_DELIVERY_V3_out_261014_020,undefined);
});
test('blocked Kakao succeeds only if the alternate SMS has a final success result',()=>{
  const h=load();h.ctx.sendGuideSafely_('261014-020','checkout',cust,due);
  h.setDelivery(message(681,100));h.ctx.sendGuideSafely_('261014-020','checkout',cust,due);
  const r=JSON.parse(h.props.GUIDE_DELIVERY_V3_out_261014_020);assert.equal(r.state,'delivered');assert.equal(r.deliveredVia,'sms');
});
test('wrong recipient or a password-free success cannot satisfy access delivery',()=>{
  for(const mutate of [r=>r.msgs[0].receiveNum='01087654321',r=>r.msgs[0].content='old guide without password',r=>r.templateCode='wrong-template',r=>r.msgs[0].content='test-password but wrong instructions']){
    const h=load();h.ctx.sendGuideSafely_('261014-020','checkout',cust,due);const r=message();mutate(r);h.setDelivery(r);
    h.ctx.sendGuideSafely_('261014-020','checkout',cust,due);
    assert.notEqual(JSON.parse(h.props.GUIDE_DELIVERY_V3_out_261014_020).state,'delivered');assert.equal(h.sends.length,1);
  }
});

test('night-time bookings and frequent customers are sent even when legacy receipt flags exist',()=>{
  const realSource=fs.readFileSync('checkAvailability.js','utf8');
  const fn=realSource.slice(realSource.indexOf('function checkGuideAlimtalk()'),realSource.indexOf('function setupGuideAlimtalkTrigger()'));
  const now='2026-10-14T23:00:00+09:00';
  class FakeDate extends Date {constructor(...args){super(...(args.length?args:[now]));}}
  const deliveries=[],p={GUIDE_SENT_V2:JSON.stringify({'out_261014-020':'20261014 21:00'})};
  const cm=[['261014-020','단골','01012345678','','','','','','','반출']];
  const sched=[['SC','261014-020','','','', '2026-10-15','01:00','2026-10-15','10:00','예약']];
  const ctx={Date:FakeDate,PropertiesService:{getScriptProperties:()=>({getProperty:k=>p[k],setProperty:(k,v)=>p[k]=v,getKeys:()=>Object.keys(p),deleteProperty:k=>delete p[k]})},
    SpreadsheetApp:{getActiveSpreadsheet:()=>({getSheetByName:name=>({getLastRow:()=>2,getRange:()=>({getValues:()=>name==='계약마스터'?cm:sched})})})},
    LockService:{getScriptLock:()=>({tryLock:()=>true,releaseLock:()=>{}})},
    readGuideCustomerVisitMap_:()=>{throw Error('visit counts must not gate access');},
    _isInSendWindow:()=>false,
    _parseCheckoutDateTime:(d,t)=>new FakeDate(d+'T'+t+':00+09:00'),
    guideRecipient_:(_tid,cust)=>cust,
    _getGuideSentData_:()=>JSON.parse(p.GUIDE_SENT_V2),
    _getGuideCheckinSendMs_:()=>new FakeDate('2026-10-15T08:00:00+09:00').getTime(),
    sendGuideSafely_:(...a)=>{deliveries.push(a);return{state:'pending',sent:true};},
    Utilities:{formatDate:()=> '20261014 23:00'},Logger:{log:()=>{}}};
  vm.runInNewContext(fn,ctx);ctx.checkGuideAlimtalk();assert.equal(deliveries.length,1);assert.equal(deliveries[0][1],'checkout');
});
test('uncertain network failure retains the request identifier and is never blindly resent',()=>{
  const h=load();h.setReply(new Error('connection lost'));h.ctx.sendGuideSafely_('261014-020','checkout',cust,due);
  h.ctx.sendGuideSafely_('261014-020','checkout',cust,due);assert.equal(h.sends.length,1);
  const r=JSON.parse(h.props.GUIDE_DELIVERY_V3_out_261014_020);assert.equal(r.state,'unknown');assert(r.requestNum);
});
test('IP/security rejections never automatically retry even after the former cooldown',()=>{
  const h=load();let sequence=0;h.ctx.Utilities.getUuid=()=> 'request-'+(++sequence);
  h.setReply({code:-10010039});h.ctx.sendGuideSafely_('261014-020','checkout',cust,due);
  let rejected=JSON.parse(h.props.GUIDE_DELIVERY_V3_out_261014_020);
  assert.equal(rejected.state,'rejected');assert.equal(rejected.rejectionCode,-10010039);
  const firstRequest=rejected.requestNum;
  h.ctx.sendGuideSafely_('261014-020','checkout',cust,due);assert.equal(h.sends.length,1,'blocked calls must be rate limited');
  rejected.createdAt=Date.now()-5*60*1000-1;h.props.GUIDE_DELIVERY_V3_out_261014_020=JSON.stringify(rejected);
  h.setReply({receiptNum:'026101499999900003'});h.ctx.sendGuideSafely_('261014-020','checkout',cust,due);
  const recovered=JSON.parse(h.props.GUIDE_DELIVERY_V3_out_261014_020);
  assert.equal(h.sends.length,1);assert.equal(recovered.state,'rejected');assert.equal(recovered.requestNum,firstRequest);
  for(const state of ['unknown','pending','failed','rejected']){
    const other=load();other.props.GUIDE_DELIVERY_V3_out_261014_020=JSON.stringify({binding:cust.tel+'|'+cust.name+'|'+due.getTime(),state,rejectionCode:-1,createdAt:Date.now()-3600000,requestNum:'prior'});
    other.ctx.sendGuideSafely_('261014-020','checkout',cust,due);assert.equal(other.sends.length,0);
  }
});
test('pickup confirmation cannot be inferred from a successful delivery to the booker',()=>{
  const h=load();assert.equal(h.ctx.guidePickupAcknowledged_('261014-020',cust,due),false);
});
test('a confirmed different pickup contact is used and tied to this active booking',()=>{
  const h=load();h.props.GUIDE_PICKUP_V1_261014_020=JSON.stringify({bookerPhone:cust.tel,checkoutMs:due.getTime(),name:'반출자',phone:'01087654321',accessConfirmed:true});
  const actual=h.ctx.guideRecipient_('261014-020',cust,due);
  assert.equal(actual.tel,'01087654321');assert.equal(h.ctx.guidePickupAcknowledged_('261014-020',cust,due),true);
  assert.equal(h.ctx.guidePickupAcknowledged_('261014-020',cust,new Date(due.getTime()+86400000)),false,'date changes require renewed pickup confirmation');
});
test('manual safety inspection never sends messages or runs the send worker',()=>{
  const h=load();
  h.ctx.checkGuideAlimtalkLocked_=()=>{throw Error('inspection must not send');};
  h.ctx.inspectGuideDeliverySafety=()=>({rows:[]});
  h.props.GUIDE_DELIVERY_V3_out_bad='{broken';
  const report=h.ctx.checkGuideDeliverySafety();
  assert.equal(report.rows.length,0);assert.equal(h.alerts.length,0);assert.equal(h.sends.length,0);
  assert.equal(h.props.GUIDE_DELIVERY_V3_out_bad,'{broken','read-only inspection must retain source evidence');
});
test('legacy operator alert records are preserved without further network requests',()=>{
  const h=load();assert.equal(typeof h.ctx.verifyGuideAlertRecord_,'function');
  h.ctx.UrlFetchApp.fetch=()=>{throw Error('legacy alert must not trigger another gateway request');};
  const result=h.ctx.verifyGuideAlertRecord_({receiptNum:'026101499999900002',requestNum:'alert',state:'pending'});
  assert.equal(result.state,'pending');
});
test('a missing contract remains an alertable schedule row',()=>{
  const h=load();const out=new Date(Date.now()+3600000),ret=new Date(Date.now()+7200000);
  h.ctx.guideSafetyBookings_=()=>[{tid:'261014-020',cust:null,checkoutAt:out,returnAt:ret,conflict:true,sourceIssue:'계약 없음'}];
  h.ctx.Utilities.formatDate=()=> '2026-10-15 01:00';
  const r=h.ctx.inspectGuideDeliverySafety();assert.equal(r.rows.length,1);assert(r.rows[0].issues.length>0);
});
test('a missing or stale due checkin record raises an issue even when checkout was delivered',()=>{
  for(const stale of [false,true]){
    const h=load(),out=new Date(Date.now()-3600000),ret=new Date(Date.now()+3600000);
    h.ctx.guideSafetyBookings_=()=>[{tid:'261014-020',cust,checkoutAt:out,returnAt:ret}];
    h.ctx._getGuideCheckinSendMs_=()=>Date.now()-1000;
    h.props.GUIDE_PICKUP_V1_261014_020=JSON.stringify({bookerPhone:cust.tel,checkoutMs:out.getTime(),name:cust.name,phone:cust.tel,accessConfirmed:true});
    h.props.GUIDE_DELIVERY_V3_out_261014_020=JSON.stringify({binding:cust.tel+'|'+cust.name+'|'+out.getTime(),state:'delivered'});
    if(stale)h.props.GUIDE_DELIVERY_V3_in_261014_020=JSON.stringify({binding:'stale',state:'delivered'});
    const r=h.ctx.inspectGuideDeliverySafety();assert(r.rows[0].issues.some(x=>x.includes('반납 안내')));
  }
});
test('valid-looking but mistyped pickup numbers cannot be marked confirmed without a matching independent readback',()=>{
  const h=load();
  h.ctx.guideSafetyBookings_=()=>[{tid:'261014-020',cust,checkoutAt:due,returnAt:new Date(due.getTime()+3600000)}];
  h.ctx.LockService={getScriptLock:()=>({tryLock:()=>true,releaseLock:()=>{}})};
  assert.throws(()=>h.ctx.confirmGuidePickupContact({tradeId:'261014-020',name:'반출자',phone:'01012345678',confirmedPhone:'01012345679',accessConfirmed:true,confirmationMethod:'call',confirmationNote:'통화로 실제 반출자 확인'}),/번호 재확인/);
  assert.throws(()=>h.ctx.confirmGuidePickupContact({tradeId:'261014-020',name:'반출자',phone:'01012345678',accessConfirmed:true,confirmationNote:'확인'}),/번호 재확인/);
});
test('delivery proof is retained while a long rental is still active',()=>{
  const h=load(),out=new Date(Date.now()-8*86400000),ret=new Date(Date.now()+10*86400000);
  h.ctx.guideSafetyBookings_=()=>[{tid:'261014-020',cust,checkoutAt:out,returnAt:ret}];
  h.ctx._getGuideCheckinSendMs_=()=>ret.getTime()-12*3600000;
  h.ctx.LockService={getScriptLock:()=>({tryLock:()=>true,releaseLock:()=>{}})};
  h.ctx.checkGuideAlimtalkLocked_=()=>({});
  h.props.GUIDE_PICKUP_V1_261014_020=JSON.stringify({bookerPhone:cust.tel,checkoutMs:out.getTime(),name:cust.name,phone:cust.tel,accessConfirmed:true});
  h.props.GUIDE_DELIVERY_V3_out_261014_020=JSON.stringify({binding:cust.tel+'|'+cust.name+'|'+out.getTime(),state:'delivered',operationMs:out.getTime()});
  h.ctx.checkGuideDeliverySafety();assert(h.props.GUIDE_DELIVERY_V3_out_261014_020,'an active rental must retain access delivery proof');
});
test('reversed pickup/return dates raise an alert instead of being discarded as historical',()=>{
  const h=load(),out=new Date(Date.now()+3600000),ret=new Date(Date.now()-3600000);
  h.ctx.guideSafetyBookings_=()=>[{tid:'261014-020',cust,checkoutAt:out,returnAt:ret}];
  const report=h.ctx.inspectGuideDeliverySafety();assert.equal(report.rows.length,1);assert(report.rows[0].issues.length);
});
test('legacy editor setup now enables manual inspection without guessing an operator number',()=>{
  const h=load();delete h.props.GUIDE_ALERT_PHONE;h.props.POPBILL_SENDER_NUM='01000000000';
  h.ctx.guidePopbillRead_=()=>[{number:'01000000000',state:1}];
  h.ctx.ScriptApp={getProjectTriggers:()=>[],newTrigger:()=>({timeBased(){return this;},everyMinutes(){return this;},create(){return{};}})};
  assert.equal(typeof h.ctx.setupGuideDeliverySafetyForCurrentSender,'function');
  const r=h.ctx.setupGuideDeliverySafetyForCurrentSender();assert(r.configured);assert.equal(r.mode,'manual');assert.equal(h.props.GUIDE_ALERT_PHONE,undefined);
});
test('manual inspection setup never creates a watchdog or calls a failing messaging gateway',()=>{
  const h=load();delete h.props.GUIDE_ALERT_PHONE;h.props.POPBILL_SENDER_NUM='01000000000';
  let creates=0;
  h.ctx.guidePopbillRead_=()=>{throw Error('전송 결과 조회 실패 HTTP 400 코드 -10010039');};
  h.ctx.ScriptApp={getProjectTriggers:()=>[],newTrigger:()=>{creates++;throw Error('watchdog must not be recreated');}};
  assert(h.ctx.setupGuideDeliverySafetyForCurrentSender().configured);
  assert.equal(h.props.GUIDE_ALERT_PHONE,undefined);assert(h.props.GUIDE_SAFETY_INSTALLED_AT);
  h.ctx.setupGuideDeliverySafetyForCurrentSender();assert.equal(creates,0,'repeated setup must not create a watchdog');
});
