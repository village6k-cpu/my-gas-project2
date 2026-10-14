// 심사 승인과 본문 일치 확인 후 반출/반납 출입문 안내를 자동 활성화한다.
// 실제 비밀번호는 공개 코드에 저장하지 않고 GAS Script Properties에서만 읽는다.
var GUIDE_DOOR_PASSWORD_PROPERTY_ = 'GUIDE_DOOR_PASSWORD';
var GUIDE_DOOR_TEMPLATE_CODES_ = {
  checkout: '026090001186',
  checkin: '026090001187'
};

function buildGuideDoorMessage_(kind, customerName, password) {
  var body = kind === 'checkin'
    ? _buildCheckinMsg(customerName, true)
    : _buildCheckoutMsg(customerName);
  return body + '\n\n' + buildGuideAccessBlock_(password) + '\n\n' + GUIDE_PARKING_NOTICE_;
}

function buildGuideAccessBlock_(password) {
  return '━━━━━━━━━━━━━━━━\n🔐🔐 매장 출입 안내 🔐🔐\n'
    + '[매장 출입문 비밀번호: ' + password + ']\n\n'
    + '🌙 ' + guideLockInstruction_() + '\n\n'
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
  var sms = buildGuideAccessSms_(kind, customerName, password);
  if (status && status.approved) {
    return { templateCode: status.templateCode, content: buildGuideDoorMessage_(kind, customerName, password),
      vars: { '#{고객명}': customerName, '#{출입문비밀번호}': password }, doorAccess: true,
      channel: 'alimtalk', altContent: sms };
  }
  // 승인 전/본문 불일치/조회 실패에도 비밀번호 없는 안내나 잘못된 잠금 지침을 보내지 않는다.
  return { channel: 'sms', content: sms, doorAccess: true, approvalPending: true };
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
  var checkout = getGuideDoorTemplateStatus_('checkout');
  var checkin = getGuideDoorTemplateStatus_('checkin');
  checkout.active = configured && checkout.approved;
  checkin.active = configured && checkin.approved;
  checkout.channel=checkout.active?'alimtalk':configured?'sms':'unconfigured';
  checkin.channel=checkin.active?'alimtalk':configured?'sms':'unconfigured';
  return { configured: configured, checkout: checkout, checkin: checkin,lockingInstruction:guideLockInstruction_() };
}
