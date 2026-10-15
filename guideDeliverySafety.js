// 출입 안내 안전장치: 접수와 도착을 구분하고, 실제 반출자 수신 확인은 별도로 기록한다.
// 비밀번호/본문은 발송 기록, 로그, 운영자 경보에 저장하지 않는다.
// 2026-10-15 팝빌 국외 IP 반복 요청 사고: 검증된 국내 발송 경로를 준비하기 전까지 중단.
var GUIDE_DELIVERY_INCIDENT_SUSPENDED_ = true;
function stopGuideDeliveryIncident() {
  var removed=[];
  ScriptApp.getProjectTriggers().forEach(function(t) {
    var name=t.getHandlerFunction();
    if(name==='checkGuideAlimtalk' || name==='checkGuideDeliverySafety') {
      ScriptApp.deleteTrigger(t);removed.push(name);
    }
  });
  PropertiesService.getScriptProperties().setProperty('GUIDE_DELIVERY_INCIDENT_STOPPED_AT',String(Date.now()));
  return {suspended:true,removed:removed};
}
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
  if (GUIDE_DELIVERY_INCIDENT_SUSPENDED_) throw new Error('팝빌 출입 안내 API 긴급 중단');
  var options = { headers: { Authorization: 'Bearer ' + _getPopbillToken() }, muteHttpExceptions: true };
  var response = UrlFetchApp.fetch('https://popbill.linkhub.co.kr' + path, options);
  if (response.getResponseCode() === 401) {
    options.headers.Authorization = 'Bearer ' + _getPopbillToken(true);
    response = UrlFetchApp.fetch('https://popbill.linkhub.co.kr' + path, options);
  }
  if (response.getResponseCode() !== 200) {
    var errorCode='unknown';try{errorCode=JSON.parse(response.getContentText()).code;}catch(e){}
    throw new Error('전송 결과 조회 실패 HTTP '+response.getResponseCode()+' 코드 '+String(errorCode));
  }
  return JSON.parse(response.getContentText());
}
function sendGuideLms_(phone, name, content, requestNum) {
  // 과거 호출자가 남아 있어도 국외 IP 문자 API를 다시 호출할 수 없게 한다.
  throw new Error('앱스크립트 직접 문자 API 긴급 중단');
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
  if (GUIDE_DELIVERY_INCIDENT_SUSPENDED_) return {state:'suspended',sent:false};
  var phone = normalizeAlimtalkReceiver_(cust.tel);
  var key = guideRecordKey_(tid, kind);
  var record = guideSafetyRead_(key);
  var binding = phone + '|' + cust.name + '|' + operationAt.getTime();
  if (record && record.binding === binding) {
    record = verifyGuideRecord_(record); guideSafetyWrite_(key, record);
    // 보안/IP 제한으로 거절된 요청도 운영자 확인 없이 자동 재접수하지 않는다.
    return { state: record.state, receiptNum: record.receiptNum || '', sent: false };
  }
  var payload = getGuideAlimtalkPayload_(kind, cust.name);
  if (payload.channel !== 'alimtalk') return {state:'approval_pending',sent:false};
  record = { tid: tid, binding: binding, phone: phone, operationMs: operationAt.getTime(),
    kind: kind, name: cust.name, templateCode: payload.templateCode || '', channel: payload.channel,
    state: 'unknown', requestNum: Utilities.getUuid(), createdAt: Date.now() };
  // 외부 호출 전에 원장에 남겨 하드킬/timeout에서도 같은 건을 다시 접수하지 않는다.
  guideSafetyWrite_(key, record);
  try {
    var result = sendAlimtalk(payload.templateCode, phone, cust.name, payload.content, payload.vars, null,
      { altSendType: '', requestNum: record.requestNum });
    if (!result || !result.receiptNum) {
      record.state = 'rejected'; record.reason = '발송 접수 거절';
      if (result && Number(result.code)<0) record.rejectionCode=Number(result.code);
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
  if (GUIDE_DELIVERY_INCIDENT_SUSPENDED_) return {state:'suspended'};
  return {state:'disabled',reason:'자동 문자 경보 중단'};
}
function verifyGuideAlertRecord_(record) {
  // 과거 경보 기록은 보존하지만 별도 조회·재전송하지 않는다.
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
  if (GUIDE_DELIVERY_INCIDENT_SUSPENDED_) return stopGuideDeliveryIncident();
  return inspectGuideDeliverySafety();
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
  if (GUIDE_DELIVERY_INCIDENT_SUSPENDED_) return stopGuideDeliveryIncident();
  var props=PropertiesService.getScriptProperties();
  var removed=[];
  ScriptApp.getProjectTriggers().forEach(function(t) {
    if(t.getHandlerFunction()==='checkGuideDeliverySafety') {
      ScriptApp.deleteTrigger(t);removed.push('checkGuideDeliverySafety');
    }
  });
  if(!props.getProperty('GUIDE_SAFETY_INSTALLED_AT'))props.setProperty('GUIDE_SAFETY_INSTALLED_AT',String(Date.now()));
  return {configured:true,mode:'manual',removed:removed};
}

// 과거 편집기 실행 진입점은 수동 점검 설정만 유지한다.
function setupGuideDeliverySafetyForCurrentSender() {
  return setupGuideDeliverySafety();
}
