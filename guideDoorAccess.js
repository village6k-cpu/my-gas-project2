// 심사 승인과 본문 일치 확인 후 반출/반납 출입문 안내를 자동 활성화한다.
// 실제 비밀번호는 공개 코드에 저장하지 않고 GAS Script Properties에서만 읽는다.
var GUIDE_DOOR_PASSWORD_PROPERTY_ = 'GUIDE_DOOR_PASSWORD';
var GUIDE_DOOR_TEMPLATE_CODES_ = {
  checkout: '026100001008',
  checkin: '026100001009'
};

var CONFIRMED_CHECKOUT_BUTTON_ = '내 예약 확인';
var CONFIRMED_CHECKOUT_LINK_ = 'https://today-dashboard-ten.vercel.app/my?t=';

function buildConfirmedCheckoutMessage_(name, checkout, checkin, password) {
  return '[빌리지 예약이 확정되었습니다]\n'
    + '· 반출 ' + checkout + '\n· 반납 ' + checkin + '\n\n'
    + '견적서는 [내 예약 확인] → [견적서 보기]에서 확인해주세요. '
    + '다른 분께 전달할 때는 [PDF 저장] 또는 [공유]로 견적서 파일만 보내주세요.\n\n'
    + buildGuideDoorMessage_('checkout', name, password);
}

function confirmedCheckoutTemplateCode_() {
  var cache, key = 'confirmedCheckoutTemplate_v2';
  try {
    cache = CacheService.getScriptCache();
    var cached = cache.get(key);
    if (cached !== null) return cached === 'pending' ? '' : cached;
  } catch (e) {}
  var expected = buildConfirmedCheckoutMessage_('#{고객명}', '#{반출일시}', '#{반납일시}', '#{출입문비밀번호}');
  var expectedLink = CONFIRMED_CHECKOUT_LINK_ + '#{예약토큰}';
  var list = guidePopbillRead_('/KakaoTalk/ListATSTemplate');
  var candidates = Array.isArray(list) ? list.filter(function(template) {
    var button = template.btns && template.btns.length === 1 && template.btns[0];
    return String(template.state) === '3' && /^\d{12}$/.test(String(template.templateCode))
      && String(template.template || '').replace(/\r\n/g, '\n').trim() === expected
      && button && button.n === CONFIRMED_CHECKOUT_BUTTON_ && button.t === 'WL'
      && button.u1 === expectedLink && button.u2 === expectedLink;
  }) : [];
  var code = candidates.length === 1 ? String(candidates[0].templateCode) : '';
  if (cache) {
    try { cache.put(key, code || 'pending', 300); } catch (e) {}
  }
  return code;
}

function sendConfirmedCheckoutAlimtalk_(tid, name, phone, outDate, outTime, inDate, inTime) {
  if (GUIDE_DELIVERY_INCIDENT_SUSPENDED_ || !name || !phone) return null;
  var operationAt = _parseCheckoutDateTime(outDate, outTime);
  if (!operationAt || !(operationAt.getTime() > Date.now())) return null;
  var code;
  try { code = confirmedCheckoutTemplateCode_(); } catch (e) { return null; }
  if (!code) return null;
  var password = PropertiesService.getScriptProperties().getProperty(GUIDE_DOOR_PASSWORD_PROPERTY_);
  if (!password) return null;
  var link = getMyPageLink(tid);
  if (!link.success || link.url !== CONFIRMED_CHECKOUT_LINK_ + encodeURIComponent(link.token)) return null;
  var period = { checkout: fmtDT(outDate, outTime), checkin: fmtDT(inDate, inTime) };
  var payload = {
    channel: 'alimtalk', templateCode: code,
    content: buildConfirmedCheckoutMessage_(name, period.checkout, period.checkin, password),
    vars: { '#{고객명}': name, '#{반출일시}': period.checkout, '#{반납일시}': period.checkin,
      '#{출입문비밀번호}': password, '#{예약토큰}': link.token },
    btns: [{ n: CONFIRMED_CHECKOUT_BUTTON_, t: 'WL', u1: link.url, u2: link.url }]
  };
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(3000)) return null;
  var claim;
  try {
    var prior = guideSafetyRead_(guideRecordKey_(tid, 'checkout'));
    if (prior) return prior.confirmedCheckout ? { state: prior.state, sent: false } : null;
    claim = sendGuideSafely_(tid, 'checkout', { name: name, tel: phone }, operationAt, payload, period);
  } finally { lock.releaseLock(); }
  return claim.record ? submitGuideAlimtalk_(claim.key, claim.record, payload, true) : claim;
}

function buildGuideDoorMessage_(kind, customerName, password) {
  var body = kind === 'checkin'
    ? _buildCheckinMsg(customerName, true)
    : _buildCheckoutMsg(customerName);
  return body + '\n\n' + buildGuideAccessBlock_(password) + '\n\n' + GUIDE_PARKING_NOTICE_;
}

function buildGuideAccessBlock_(password) {
  return '━━━━━━━━━━━━━━━━\n★★ 매장 출입 안내 ★★\n'
    + '[매장 출입문 비밀번호: ' + password + ']\n\n'
    + '★ ' + guideLockInstruction_() + '\n\n'
    + '⚠️ 예약자와 실제 반출자가 다른 경우 실제 반출자에게 이 안내를 전달해주세요. 실제 반출자의 성함·연락처와 비밀번호 확인 여부를 카카오톡 채널로 알려주세요.\n'
    + '━━━━━━━━━━━━━━━━';
}

function guideLockInstruction_() {
  return '22:00~07:00에 반출/반납하실 경우에는 검정색 철문을 닫고 #버튼을 눌러 문을 잠그고 가주세요.';
}

// 알림톡 원문은 길어질 수 있으므로 대체문자는 출입·작업·주차 핵심 안내로 구성한다.
// 팝빌 LMS 제한(UTF-8 2,000 byte)을 발송 전에 검사한다.
function buildGuideAccessSms_(kind, name, password) {
  return '[빌리지 ' + (kind === 'checkin' ? '반납' : '반출') + ' 안내]\n' + name + ' 감독님\n'
    + (kind === 'checkin'
      ? '장비를 안쪽부터 모아 반납하고 사진을 카카오톡 채널로 보내주세요.\n'
      : '성함·반출 시간이 적힌 테이블에서 장비를 확인하고 반출해주세요. 이상이 있으면 사진을 카카오톡 채널로 보내주세요.\n')
    + '\n' + buildGuideAccessBlock_(password) + '\n\n' + GUIDE_PARKING_NOTICE_;
}

function getGuideDoorTemplateStatus_(kind) {
  var props = PropertiesService.getScriptProperties();
  var code = props.getProperty('GUIDE_SAFE_TEMPLATE_' + kind) || GUIDE_DOOR_TEMPLATE_CODES_[kind];
  if (!code) throw new Error('반출/반납 구분 오류');
  var cache = null;
  var key = 'guideDoorTemplate_v2_' + code;
  var template = null;
  try {
    cache = CacheService.getScriptCache();
    var cached = cache.get(key);
    if (cached) template = JSON.parse(cached);
  } catch (cacheError) {}
  if (!template) {
    try {
      var url = 'https://popbill.linkhub.co.kr/KakaoTalk/GetATSTemplate/' + code;
      var response = UrlFetchApp.fetch(url, {
        headers: { Authorization: 'Bearer ' + _getPopbillToken() }, muteHttpExceptions: true
      });
      if (response.getResponseCode() === 401) {
        response = UrlFetchApp.fetch(url, {
          headers: { Authorization: 'Bearer ' + _getPopbillToken(true) }, muteHttpExceptions: true
        });
      }
      template = JSON.parse(response.getContentText());
      if (response.getResponseCode() !== 200 || !template.templateCode) template = { state: 'unavailable' };
    } catch (fetchError) {
      template = { state: 'unavailable' };
    }
    if (cache) {
      try { cache.put(key, JSON.stringify(template), template.state === 'unavailable' ? 60 : 300); } catch (putError) {}
    }
  }
  var expected = buildGuideDoorMessage_(kind, '#{고객명}', '#{출입문비밀번호}');
  // 새 심사가 승인되면 본문이 정확히 같은 승인 템플릿 하나만 자동 선택한다.
  // 템플릿 이름이나 상태만 보고 문구가 다른 템플릿을 활성화하지 않는다.
  if (String(template.template || '').trim() !== expected || String(template.state) !== '3') {
    try {
      var listKey='guideDoorApprovedList_v1',list=null;
      var listRaw=cache && cache.get(listKey);if(listRaw)list=JSON.parse(listRaw);
      if(!list){list=guidePopbillRead_('/KakaoTalk/ListATSTemplate');if(cache)cache.put(listKey,JSON.stringify(list),300);}
      var candidates=Array.isArray(list)?list.filter(function(t){return String(t.state)==='3' && /^\d{12}$/.test(String(t.templateCode)) && String(t.template||'').trim()===expected;}):[];
      if(candidates.length===1) {template=candidates[0];code=String(template.templateCode);props.setProperty('GUIDE_SAFE_TEMPLATE_'+kind,code);}
    }catch(e){}
  }
  var matches = template.templateCode === code && String(template.template || '').trim() === expected;
  return { templateCode: code, state: String(template.state || 'unavailable'), contentMatches: matches,
    approved: String(template.state) === '3' && matches };
}

function getGuideAlimtalkPayload_(kind, customerName) {
  if (!GUIDE_DOOR_TEMPLATE_CODES_[kind]) throw new Error('반출/반납 구분 오류');
  var password = PropertiesService.getScriptProperties().getProperty(GUIDE_DOOR_PASSWORD_PROPERTY_);
  if (!password) throw new Error('출입문 비밀번호 미설정');
  var status = getGuideDoorTemplateStatus_(kind);
  if (status && status.approved) {
    return { templateCode: status.templateCode, content: buildGuideDoorMessage_(kind, customerName, password),
      vars: { '#{고객명}': customerName, '#{출입문비밀번호}': password }, doorAccess: true,
      channel: 'alimtalk' };
  }
  // 승인 전·본문 불일치·조회 실패를 직접 문자 발송으로 우회하지 않는다.
  return { channel: 'blocked', doorAccess: true, approvalPending: true };
}

/** 내부 인증 run 전용. 비밀번호 값, 본문, 발송 기록은 응답에 포함하지 않는다. */
function configureGuideDoorAccess(args) {
  args = args || {};
  var password = typeof args.password === 'string' ? args.password.trim() : '';
  if (!password || password.length > 32 || /[\r\n]/.test(password)) return { error: '출입문 비밀번호 형식 오류' };
  PropertiesService.getScriptProperties().setProperty(GUIDE_DOOR_PASSWORD_PROPERTY_, password);
  return { configured: true, approvalRequired: true };
}

/** 발송 없이 승인 상태와 적용 여부만 확인한다. */
function getGuideDoorAccessStatus() {
  var configured = !!PropertiesService.getScriptProperties().getProperty(GUIDE_DOOR_PASSWORD_PROPERTY_);
  var suspended = typeof GUIDE_DELIVERY_INCIDENT_SUSPENDED_ !== 'undefined' && GUIDE_DELIVERY_INCIDENT_SUSPENDED_;
  var checkout = getGuideDoorTemplateStatus_('checkout');
  var checkin = getGuideDoorTemplateStatus_('checkin');
  checkout.active = !suspended && configured && checkout.approved;
  checkin.active = !suspended && configured && checkin.approved;
  checkout.channel=checkout.active?'alimtalk':suspended?'suspended':configured?'blocked':'unconfigured';
  checkin.channel=checkin.active?'alimtalk':suspended?'suspended':configured?'blocked':'unconfigured';
  return { configured: configured, suspended: suspended, checkout: checkout, checkin: checkin,lockingInstruction:guideLockInstruction_() };
}
