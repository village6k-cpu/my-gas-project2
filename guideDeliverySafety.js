// 출입 안내 안전장치: 접수와 도착을 구분하고, 별도 트리거가 누락 및 실제 반출자 확인을 점검한다.
// 비밀번호/본문은 발송 기록, 로그, 운영자 경보에 저장하지 않는다.
function guideSafetyKey_(prefix, tid) { return prefix + String(tid).replace(/-/g, '_'); }
function guideSafetyRead_(key) {
  var raw = PropertiesService.getScriptProperties().getProperty(key);
  return raw ? JSON.parse(raw) : null; // 기록 파손 시 조용히 지워 재발송하지 않는다.
}
function guideSafetyWrite_(key, value) {
  PropertiesService.getScriptProperties().setProperty(key, JSON.stringify(value));
}
function guideRecordKey_(tid, kind) {
  return guideSafetyKey_('GUIDE_DELIVERY_V3_' + (kind === 'checkout' ? 'out_' : 'in_'), tid);
}
function guideBookerContactKey_(value) {
  try{return normalizeAlimtalkReceiver_(value);}catch(e){return 'invalid:'+String(value||'').replace(/[^0-9]/g,'');}
}
function guidePickup_(tid, cust, checkoutAt) {
  var r = guideSafetyRead_(guideSafetyKey_('GUIDE_PICKUP_V1_', tid));
  return r && r.bookerPhone === guideBookerContactKey_(cust.tel)
    && r.checkoutMs === checkoutAt.getTime() ? r : null;
}
function guideRecipient_(tid, cust, checkoutAt) {
  var pickup = guidePickup_(tid, cust, checkoutAt);
  return pickup ? { name: pickup.name, tel: pickup.phone } : cust;
}
function guidePickupAcknowledged_(tid, cust, checkoutAt) {
  var pickup = guidePickup_(tid, cust, checkoutAt);
  return !!(pickup && pickup.accessConfirmed === true);
}
function guidePopbillRead_(path) {
  var options = { headers: { Authorization: 'Bearer ' + _getPopbillToken() }, muteHttpExceptions: true };
  var response = UrlFetchApp.fetch('https://popbill.linkhub.co.kr' + path, options);
  if (response.getResponseCode() === 401) {
    options.headers.Authorization = 'Bearer ' + _getPopbillToken(true);
    response = UrlFetchApp.fetch('https://popbill.linkhub.co.kr' + path, options);
  }
  if (response.getResponseCode() !== 200) throw new Error('전송 결과 조회 실패');
  return JSON.parse(response.getContentText());
}
function sendGuideLms_(phone, name, content, requestNum) {
  phone = normalizeAlimtalkReceiver_(phone);
  if (Utilities.newBlob(content).getBytes().length > 2000) throw new Error('출입 안내 대체문자 길이 초과');
  var props = PropertiesService.getScriptProperties();
  var payload = { snd: props.getProperty('POPBILL_SENDER_NUM'), msgs: [{ rcv: phone, rcvnm: name }],
    subject: '빌리지 출입 안내', content: content, adsYN: false, requestNum: requestNum };
  var options = { method: 'post', contentType: 'application/json;charset=utf-8',
    headers: { Authorization: 'Bearer ' + _getPopbillToken() }, payload: JSON.stringify(payload), muteHttpExceptions: true };
  var response = UrlFetchApp.fetch('https://popbill.linkhub.co.kr/LMS', options);
  if (response.getResponseCode() === 401) {
    options.headers.Authorization = 'Bearer ' + _getPopbillToken(true);
    response = UrlFetchApp.fetch('https://popbill.linkhub.co.kr/LMS', options);
  }
  return JSON.parse(response.getContentText());
}
function verifyGuideRecord_(record) {
  if (record.state === 'delivered' || record.state === 'failed' || record.state === 'rejected') return record;
  try {
    var prefix = record.channel === 'sms' ? '/Message/' : '/KakaoTalk/';
    var path = record.receiptNum ? prefix + record.receiptNum : prefix + 'Get/' + record.requestNum;
    var info = guidePopbillRead_(path);
    var msgs = Array.isArray(info) ? info : info.msgs;
    if (!msgs || msgs.length !== 1) return record;
    var msg = msgs[0];
    if (normalizeAlimtalkReceiver_(msg.receiveNum) !== record.phone) {
      record.state = 'failed'; record.reason = '수신번호 불일치'; return record;
    }
    if(record.channel==='alimtalk' && String(info.templateCode)!==record.templateCode) {
      record.state='failed';record.reason='안내 템플릿 불일치';return record;
    }
    if (!record.receiptNum && msg.receiptNum) record.receiptNum = String(msg.receiptNum);
    var password = PropertiesService.getScriptProperties().getProperty(GUIDE_DOOR_PASSWORD_PROPERTY_);
    var result = Number(msg.result);
    var body = String(msg.content || '');
    var via = record.channel;
    if (record.channel === 'alimtalk' && result !== 100 && Number(msg.altResult) === 100) {
      body = String(msg.altContent || info.altContent || ''); via = 'sms';
    }
    var finalSuccess = record.channel === 'sms' ? Number(msg.state) === 3 && result === 100
      : (Number(msg.state) === 3 && result === 100) || Number(msg.altResult) === 100;
    if (finalSuccess) {
      var expected=via==='sms' ? buildGuideAccessSms_(record.kind,record.name,password) : buildGuideDoorMessage_(record.kind,record.name,password);
      if (!password || body.trim()!==expected.trim()) { record.state = 'failed'; record.reason = '비밀번호/출입 안내 본문 불일치'; }
      else { record.state = 'delivered'; record.deliveredVia = via; record.verifiedAt = Date.now(); }
    } else if (Number(msg.state) === 3 && result !== 100) {
      // 카카오 실패 이후 통신사 결과가 아직 없으면 대체문자 처리 중일 수 있다.
      if (record.channel === 'sms' || (msg.altResult !== undefined && String(msg.altResult) !== '')) {
        record.state = 'failed'; record.reason = '전송 실패 ' + result + '/' + String(msg.altResult || '');
      }
    }
  } catch (e) { /* 조회 장애는 성공이나 재발송 근거가 아니다. */ }
  return record;
}

// 기존 GUIDE_SENT_V2는 API 접수 기록이다. 새 버전은 자체 도착 기록만으로 중복을 막는다.
// 이미 예전 안내를 받은 가까운 예약에는 새 조건문과 주차 안내를 1회 보완 발송한다.
function sendGuideSafely_(tid, kind, cust, operationAt) {
  var phone = normalizeAlimtalkReceiver_(cust.tel);
  var key = guideRecordKey_(tid, kind);
  var record = guideSafetyRead_(key);
  var binding = phone + '|' + cust.name + '|' + operationAt.getTime();
  if (record && record.binding === binding) {
    record = verifyGuideRecord_(record); guideSafetyWrite_(key, record);
    return { state: record.state, receiptNum: record.receiptNum || '', sent: false };
  }
  var payload = getGuideAlimtalkPayload_(kind, cust.name);
  record = { tid: tid, binding: binding, phone: phone, operationMs: operationAt.getTime(),
    kind: kind, name: cust.name, templateCode: payload.templateCode || '', channel: payload.channel,
    state: 'unknown', requestNum: Utilities.getUuid(), createdAt: Date.now() };
  // 외부 호출 전에 원장에 남겨 하드킬/timeout에서도 같은 건을 다시 접수하지 않는다.
  guideSafetyWrite_(key, record);
  try {
    var result = payload.channel === 'sms'
      ? sendGuideLms_(phone, cust.name, payload.content, record.requestNum)
      : sendAlimtalk(payload.templateCode, phone, cust.name, payload.content, payload.vars, null,
        { altSendType: 'A', altContent: payload.altContent, requestNum: record.requestNum });
    if (!result || !result.receiptNum) {
      record.state = 'rejected'; record.reason = '발송 접수 거절';
    } else {
      record.state = 'pending'; record.receiptNum = String(result.receiptNum);
    }
  } catch (e) { record.state = 'unknown'; record.reason = '발송 응답 확인 불가'; }
  guideSafetyWrite_(key, record);
  return { state: record.state, receiptNum: record.receiptNum || '', sent: record.state === 'pending' };
}

// 점검은 계약/스케줄을 직접 읽는다. 방문 횟수와 과거 접수 플래그에 의존하지 않는다.
function guideSafetyBookings_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var cm = ss.getSheetByName('계약마스터'), sched = ss.getSheetByName('스케줄상세');
  if (!cm || !sched) throw new Error('계약마스터/스케줄상세 조회 불가');
  var contracts = {}, bookings = {}, conflicts = {};
  if (cm.getLastRow() > 1) cm.getRange(2, 1, cm.getLastRow()-1, 10).getValues().forEach(function(r) {
    var tid=String(r[0]||'').trim();
    if(!tid)return;
    if (contracts[tid]) conflicts[tid]=true;
    contracts[tid]={name:String(r[1]||'').trim(),tel:String(r[2]||'').trim(),status:String(r[9]||'').trim(),
      checkoutAt:_parseCheckoutDateTime(r[4],r[5]),returnAt:_parseCheckoutDateTime(r[6],r[7])};
  });
  if (sched.getLastRow() > 1) sched.getRange(2, 1, sched.getLastRow()-1, 10).getValues().forEach(function(r) {
    var tid=String(r[1]||'').trim(); if(!tid || String(r[9]||'').trim()==='취소') return;
    var out=_parseCheckoutDateTime(r[5],r[6]), ret=_parseCheckoutDateTime(r[7],r[8]);
    var sourceIssue='';
    if(!out || !ret || isNaN(out.getTime()) || isNaN(ret.getTime())) {
      conflicts[tid]=true;sourceIssue='스케줄 반출/반납 일시 확인 필요';
      if(!out || isNaN(out.getTime()))out=contracts[tid]&&contracts[tid].checkoutAt;
      if(!ret || isNaN(ret.getTime()))ret=contracts[tid]&&contracts[tid].returnAt;
    }
    if(out && isNaN(out.getTime()))out=null;if(ret && isNaN(ret.getTime()))ret=null;
    if(out && ret && ret.getTime()<=out.getTime()){conflicts[tid]=true;sourceIssue='반납일시가 반출일시보다 빠름';}
    if(bookings[tid] && (String(bookings[tid].checkoutAt)!==String(out) || String(bookings[tid].returnAt)!==String(ret))) conflicts[tid]=true;
    bookings[tid]={tid:tid,cust:contracts[tid],checkoutAt:out,returnAt:ret,sourceIssue:sourceIssue};
  });
  Object.keys(contracts).forEach(function(tid){if(!bookings[tid] && !/취소|완료/.test(contracts[tid].status)) {
    var cust=contracts[tid];
    if(cust.checkoutAt && cust.returnAt && !isNaN(cust.returnAt.getTime()) && cust.returnAt.getTime()>cust.checkoutAt.getTime() && cust.returnAt.getTime()<Date.now())return;
    bookings[tid]={tid:tid,cust:cust,checkoutAt:cust.checkoutAt&&!isNaN(cust.checkoutAt.getTime())?cust.checkoutAt:null,
      returnAt:cust.returnAt&&!isNaN(cust.returnAt.getTime())?cust.returnAt:null,sourceIssue:'스케줄상세 누락'};
    conflicts[tid]=true;
  }});
  return Object.keys(bookings).map(function(tid) { bookings[tid].conflict=!!conflicts[tid]; return bookings[tid]; });
}
function sendGuideSafetyAlert_(issue) {
  var props=PropertiesService.getScriptProperties();
  var phone=props.getProperty('GUIDE_ALERT_PHONE');
  if(!phone) throw new Error('출입 안내 긴급 경보 번호 미설정');
  var key=guideSafetyKey_('GUIDE_ALERT_V1_',issue.category||issue.tid||'system');
  var prior=null, now=Date.now();
  try {prior=guideSafetyRead_(key);}catch(e){}
  if(prior) {prior=verifyGuideAlertRecord_(prior);guideSafetyWrite_(key,prior);}
  var signature=String(issue.reason);
  // 미해결 경보는 1시간 간격으로 반복. 경보의 API 접수도 도착 성공과 구별한다.
  var cooldown=prior && /failed|rejected/.test(prior.state)?5*60*1000:60*60*1000;
  if(prior && prior.signature===signature && now-prior.at<cooldown) return prior;
  var text='[빌리지 출입 안내 긴급]\n'+(issue.tid||'시스템')+'\n'+issue.reason
    +'\n'+(issue.checkoutAt ? '반출 '+Utilities.formatDate(issue.checkoutAt,'Asia/Seoul','MM-dd HH:mm')+'\n' : '')
    +'실제 반출자의 연락처와 비밀번호 수신 여부를 직접 확인해주세요.';
  var record={at:now,signature:signature,state:'unknown',requestNum:Utilities.getUuid()};
  guideSafetyWrite_(key,record);
  try {
    var result=sendGuideLms_(phone,'빌리지 운영자',text,record.requestNum);
    if(!result || !result.receiptNum) record.state='rejected';
    else {record.receiptNum=String(result.receiptNum);record.state='pending';}
  } catch(e) {record.state='unknown';}
  guideSafetyWrite_(key,record);return record;
}
function verifyGuideAlertRecord_(record) {
  if(record.state==='delivered' || record.state==='failed' || record.state==='rejected')return record;
  try {
    var info=guidePopbillRead_(record.receiptNum?'/Message/'+record.receiptNum:'/Message/Get/'+record.requestNum);
    if(!Array.isArray(info) || info.length!==1)return record;
    var phone=PropertiesService.getScriptProperties().getProperty('GUIDE_ALERT_PHONE');
    if(normalizeAlimtalkReceiver_(info[0].receiveNum)!==normalizeAlimtalkReceiver_(phone)) {record.state='failed';return record;}
    if(Number(info[0].state)===3)record.state=Number(info[0].result)===100?'delivered':'failed';
  }catch(e){}
  return record;
}
function inspectGuideDeliverySafety() {
  var now=Date.now(), rows=[];
  var installedAt=Number(PropertiesService.getScriptProperties().getProperty('GUIDE_SAFETY_INSTALLED_AT')||0);
  guideSafetyBookings_().forEach(function(b) {
    if(b.cust && /취소|완료/.test(b.cust.status))return;
    if(b.checkoutAt && b.returnAt && b.returnAt.getTime()<=b.checkoutAt.getTime()) {
      rows.push({tid:b.tid,checkoutAt:Utilities.formatDate(b.checkoutAt,'Asia/Seoul','yyyy-MM-dd HH:mm'),delivered:false,pickupConfirmed:false,state:'source_error',issues:['반납일시가 반출일시보다 빠름: 예약 원장 확인 필요']});return;
    }
    if(b.returnAt && b.returnAt.getTime()<now)return;
    if(b.checkoutAt && b.checkoutAt.getTime()>now+24*60*60*1000)return;
    var issue=[], recipient;
    if(!b.cust)issue.push('계약마스터 누락: 실제 반출자 확인 필요');
    if(!b.checkoutAt || !b.returnAt)issue.push('반출/반납 일시 확인 필요');
    if(b.sourceIssue)issue.push(b.sourceIssue);
    if(b.conflict) issue.push('예약 일정/계약 중복 확인 필요');
    if(!b.cust || !b.checkoutAt || !b.returnAt) {
      rows.push({tid:b.tid,checkoutAt:b.checkoutAt?Utilities.formatDate(b.checkoutAt,'Asia/Seoul','yyyy-MM-dd HH:mm'):'',delivered:false,pickupConfirmed:false,state:'source_error',issues:issue});return;
    }
    try { recipient=guideRecipient_(b.tid,b.cust,b.checkoutAt); normalizeAlimtalkReceiver_(recipient.tel); }
    catch(e) { recipient=null; issue.push('실제 반출자 전화번호 확인 필요'); }
    var record=null;
    try{record=guideSafetyRead_(guideRecordKey_(b.tid,'checkout'));}catch(e){issue.push('반출 안내 발송 기록 확인 필요');}
    var verified=record && recipient && record.binding===normalizeAlimtalkReceiver_(recipient.tel)+'|'+recipient.name+'|'+b.checkoutAt.getTime() && record.state==='delivered';
    var settling=record && /pending|unknown/.test(record.state) && now-record.createdAt<15*60*1000 && b.checkoutAt.getTime()>now+60*60*1000;
    var outCheckRequired=!installedAt || b.checkoutAt.getTime()>=installedAt;
    if(outCheckRequired && b.checkoutAt.getTime()<=now+12*60*60*1000 && !verified && !settling) issue.push('비밀번호 포함 출입 안내 도착 미확인');
    var acknowledged=false;
    try { acknowledged=guidePickupAcknowledged_(b.tid,b.cust,b.checkoutAt); } catch(e) {}
    if(outCheckRequired && b.checkoutAt.getTime()<=now+2*60*60*1000 && !acknowledged) issue.push('실제 반출자 연락처/비밀번호 수신 확인 필요');
    if(record && /failed|rejected/.test(record.state)) issue.push(record.reason||'안내 발송 실패');
    var inRecord=null;
    try{inRecord=guideSafetyRead_(guideRecordKey_(b.tid,'checkin'));}catch(e){issue.push('반납 안내 발송 기록 확인 필요');}
    var inDue=_getGuideCheckinSendMs_(b.checkoutAt.getTime(),b.returnAt.getTime());
    if(inDue!==null && now>=inDue && now<b.returnAt.getTime()) {
      var inBinding=recipient?normalizeAlimtalkReceiver_(recipient.tel)+'|'+recipient.name+'|'+b.returnAt.getTime():'';
      var inSettling=inRecord && inRecord.binding===inBinding && /pending|unknown/.test(inRecord.state) && now-inRecord.createdAt<15*60*1000;
      if(!inRecord || inRecord.binding!==inBinding || (inRecord.state!=='delivered' && !inSettling))issue.push('반납 안내 도착 확인 필요');
    }
    rows.push({tid:b.tid,checkoutAt:Utilities.formatDate(b.checkoutAt,'Asia/Seoul','yyyy-MM-dd HH:mm'),
      delivered:!!verified,pickupConfirmed:acknowledged,outCheckRequired:outCheckRequired,state:record?record.state:'missing',issues:issue});
  });
  return {checkedAt:now,rows:rows,alertPhoneConfigured:!!PropertiesService.getScriptProperties().getProperty('GUIDE_ALERT_PHONE')};
}
function checkGuideDeliverySafety() {
  var lock=LockService.getScriptLock();
  if(!lock.tryLock(1000))return {skipped:true,reason:'출입 안내 작업 진행 중'};
  var props=PropertiesService.getScriptProperties();
  var errors=[],report={rows:[]};
  try {
    // 발송부터 확인 원장 갱신까지 같은 잠금 안에서 실행해 새 수신자의 기록을 덮어쓰지 않는다.
    // 발송 API 장애로 실행 시간을 소진하기 전에 원장 상태와 긴급 반출자 미확인을 남긴다.
    try {report=inspectGuideDeliverySafety();}catch(e){errors.push('발송 전 계약/일정 점검 오류');}
    props.setProperty('GUIDE_SAFETY_HEALTH',JSON.stringify({checkedAt:Date.now(),ok:false,phase:'checking',issueCount:report.rows.filter(function(r){return r.issues.length;}).length}));
    var activeIds={};report.rows.forEach(function(r){activeIds[r.tid]=true;});
    var urgent=report.rows.filter(function(r){return r.state==='source_error' || r.issues.some(function(x){return /실제 반출자|전화번호|누락/.test(x);});});
    if(urgent.length)sendGuideSafetyAlert_({category:'preflight',reason:'긴급 확인 '+urgent.length+'건: '+urgent.slice(0,12).map(function(r){return r.tid;}).join(', ')+' / 실제 반출자·출입 안내 및 예약 원장을 직접 확인해주세요.'});
    try {checkGuideAlimtalkLocked_();}catch(e){errors.push('출입 안내 발송 작업 오류');}
    props.getKeys().filter(function(k){return /^GUIDE_DELIVERY_V3_/.test(k);}).forEach(function(k) {
      try {
        var r=guideSafetyRead_(k);if(!r)return;
        var recordTid=r.tid||k.replace(/^GUIDE_DELIVERY_V3_(out|in)_/,'').replace('_','-');
        if(!activeIds[recordTid] && r.operationMs<Date.now()-7*24*60*60*1000){props.deleteProperty(k);return;}
        guideSafetyWrite_(k,verifyGuideRecord_(r));
      }catch(e){errors.push('출입 안내 기록 확인 오류 '+k.replace('GUIDE_DELIVERY_V3_',''));}
    });
    try {report=inspectGuideDeliverySafety();}catch(e){errors.push('계약/스케줄 또는 안내 기록 점검 오류');}
    var pending=report.rows.filter(function(r){return r.issues.length;});
    if(pending.length) {
      var reasons=[];pending.forEach(function(r){r.issues.forEach(function(x){if(reasons.indexOf(x)<0)reasons.push(x);});});
      var a=sendGuideSafetyAlert_({category:'delivery',reason:'확인 필요 '+pending.length+'건: '+pending.slice(0,12).map(function(r){return r.tid;}).join(', ')+'\n'+reasons.slice(0,5).join(' / ')});
      if(a && /failed|rejected|unknown/.test(a.state))errors.push('운영자 경보 도착 미확인');
    }
    props.getKeys().filter(function(k){return /^GUIDE_ALERT_V1_/.test(k);}).forEach(function(k){
      try{var a=guideSafetyRead_(k);if(!a)return;
        if(a.at<Date.now()-7*24*60*60*1000){props.deleteProperty(k);return;}
        a=verifyGuideAlertRecord_(a);guideSafetyWrite_(k,a);
        if(/failed|rejected|unknown/.test(a.state))errors.push('운영자 긴급 경보 도착 미확인');
      }catch(e){errors.push('운영자 경보 원장 확인 오류');}
    });
    if(errors.length)sendGuideSafetyAlert_({reason:errors.join(' / ').slice(0,350)});
    props.setProperty('GUIDE_SAFETY_LAST_CHECK',String(Date.now()));
    props.setProperty('GUIDE_SAFETY_HEALTH',JSON.stringify({checkedAt:Date.now(),ok:errors.length===0,errors:errors}));
    Logger.log('출입 안내 안전 점검: '+report.rows.length+'건, 확인 필요 '+report.rows.filter(function(r){return r.issues.length;}).length+'건');
    return report;
  } finally {lock.releaseLock();}
}

/** 편집 권한 있는 운영자가 직접 실제 반출자와 안내 수신을 확인한 후 기록한다. */
function confirmGuidePickupContact(args) {
  args=args||{};
  if(args.accessConfirmed!==true || !String(args.confirmationNote||'').trim()) throw new Error('실제 반출자 본인과 비밀번호 수신 확인 근거 필수');
  var tid=String(args.tradeId||'').trim(), name=String(args.name||'').trim();
  if(!/^\d{6}-\d{3}$/.test(tid) || !name || name.length>50) throw new Error('거래ID/실제 반출자 성함 오류');
  var phone=normalizeAlimtalkReceiver_(args.phone);
  if(!args.confirmedPhone || normalizeAlimtalkReceiver_(args.confirmedPhone)!==phone) throw new Error('실제 반출자와 직접 확인한 번호 재확인 불일치');
  if(['call','kakao_reply','in_person'].indexOf(args.confirmationMethod)<0)throw new Error('전화/카카오톡 회신/대면 확인 방법 필수');
  var matches=guideSafetyBookings_().filter(function(b){return b.tid===tid;});
  if(matches.length!==1 || matches[0].conflict || !matches[0].cust || /취소|완료/.test(matches[0].cust.status)) throw new Error('확정된 유효 예약 1건 필요');
  var b=matches[0];
  var lock=LockService.getScriptLock(); if(!lock.tryLock(10000)) throw new Error('안내 작업 진행 중. 잠시 후 다시 확인해주세요.');
  try { guideSafetyWrite_(guideSafetyKey_('GUIDE_PICKUP_V1_',tid),{name:name,phone:phone,
    bookerPhone:guideBookerContactKey_(b.cust.tel),checkoutMs:b.checkoutAt.getTime(),returnMs:b.returnAt.getTime(),accessConfirmed:true,
    confirmedAt:Date.now(),confirmationMethod:args.confirmationMethod,confirmationNote:String(args.confirmationNote).trim().slice(0,300)}); }
  finally {lock.releaseLock();}
  return {success:true,tid:tid,pickupConfirmed:true};
}
function confirmGuidePickupContactFromMenu() {
  var ui=SpreadsheetApp.getUi();
  function ask(label) {var r=ui.prompt(label,ui.ButtonSet.OK_CANCEL);return r.getSelectedButton()===ui.Button.OK?r.getResponseText().trim():null;}
  var tid=ask('출입 안내 확인: 거래ID');if(!tid)return;
  var name=ask('실제 반출자 성함 (예약자와 같아도 본인 확인)');if(!name)return;
  var phone=ask('실제 반출자 본인이 확인한 휴대폰 번호');if(!phone)return;
  var confirmedPhone=ask('실제 반출자와 직접 확인한 번호를 다시 입력해주세요 (예약 접수 번호를 추측해 복사하지 마세요)');if(!confirmedPhone)return;
  var methodText=ask('직접 확인 방법: 전화 / 카카오톡 / 대면');if(!methodText)return;
  var methods={'전화':'call','카카오톡':'kakao_reply','대면':'in_person'};
  var note=ask('실제 반출자가 비밀번호를 확인한 근거 (통화/카카오톡 회신 등)');if(!note)return;
  try {confirmGuidePickupContact({tradeId:tid,name:name,phone:phone,confirmedPhone:confirmedPhone,confirmationMethod:methods[methodText],accessConfirmed:true,confirmationNote:note});ui.alert('실제 반출자와 비밀번호 수신 확인을 기록했습니다.');}
  catch(e){ui.alert(e.message);}
}
function showGuideDeliverySafety() {
  var r=inspectGuideDeliverySafety();
  SpreadsheetApp.getUi().alert('출입 안내 안전 점검',r.rows.map(function(b){return b.tid+' · '+b.checkoutAt+'\n'+(b.issues.join(' / ')||(b.outCheckRequired===false?'도입 전 반출 건 · 반납 안내 점검 대상':'전송·반출자 확인 완료'));}).join('\n\n')||'24시간 이내 미완료 예약 없음',SpreadsheetApp.getUi().ButtonSet.OK);
}
function setupGuideDeliverySafety(args) {
  args=args||{};
  var props=PropertiesService.getScriptProperties();
  if(args.alertPhone) props.setProperty('GUIDE_ALERT_PHONE',normalizeAlimtalkReceiver_(args.alertPhone));
  if(!props.getProperty('GUIDE_ALERT_PHONE')) {
    var ui=SpreadsheetApp.getUi(),r=ui.prompt('출입 안내 긴급 경보 휴대폰 번호',ui.ButtonSet.OK_CANCEL);
    if(r.getSelectedButton()!==ui.Button.OK)return {cancelled:true};
    props.setProperty('GUIDE_ALERT_PHONE',normalizeAlimtalkReceiver_(r.getResponseText()));
  }
  var existing=ScriptApp.getProjectTriggers().filter(function(t){return t.getHandlerFunction()==='checkGuideDeliverySafety';});
  if(!props.getProperty('GUIDE_SAFETY_INSTALLED_AT'))props.setProperty('GUIDE_SAFETY_INSTALLED_AT',String(Date.now()));
  if(!existing.length)ScriptApp.newTrigger('checkGuideDeliverySafety').timeBased().everyMinutes(5).create();
  return {configured:true,monitorEveryMinutes:5};
}

// 편집기에서 명시적으로 실행하는 내부 초기화 도구. 발신번호가 지정한 운영자 번호와
// 동일함을 사전에 확인한 경우에만 사용한다. 유일한 등록·사용 번호인지 다시 검사한다.
function setupGuideDeliverySafetyForCurrentSender() {
  var phone=normalizeAlimtalkReceiver_(PropertiesService.getScriptProperties().getProperty('POPBILL_SENDER_NUM'));
  var senders=guidePopbillRead_('/Message/SenderNumber');
  var active=Array.isArray(senders)?senders.filter(function(s){return Number(s.state)===1;}):[];
  if(active.length!==1 || String(active[0].number).replace(/[^0-9]/g,'')!==phone)throw new Error('운영자가 확인한 유일한 등록 발신번호 필요');
  return setupGuideDeliverySafety({alertPhone:phone});
}
