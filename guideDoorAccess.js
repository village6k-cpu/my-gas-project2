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
  return body + '\n\n[매장 출입문 비밀번호: ' + password + ']\n'
    + '나가실 때는 반드시 검정색 철문을 닫고 #버튼을 눌러 문을 잠궈주세요!';
}

function getGuideDoorTemplateStatus_(kind) {
  var code = GUIDE_DOOR_TEMPLATE_CODES_[kind];
  if (!code) throw new Error('반출/반납 구분 오류');
  var cache = null;
  var key = 'guideDoorTemplate_v1_' + code;
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
  var matches = template.templateCode === code && String(template.template || '').trim() === expected;
  return { templateCode: code, state: String(template.state || 'unavailable'), contentMatches: matches,
    approved: String(template.state) === '3' && matches };
}

function getGuideAlimtalkPayload_(kind, customerName) {
  if (!GUIDE_DOOR_TEMPLATE_CODES_[kind]) throw new Error('반출/반납 구분 오류');
  var password = PropertiesService.getScriptProperties().getProperty(GUIDE_DOOR_PASSWORD_PROPERTY_);
  var status = password ? getGuideDoorTemplateStatus_(kind) : null;
  if (status && status.approved) {
    return { templateCode: status.templateCode, content: buildGuideDoorMessage_(kind, customerName, password),
      vars: { '#{고객명}': customerName, '#{출입문비밀번호}': password }, doorAccess: true };
  }
  // 심사중/반려/조회 실패에는 기존 승인 템플릿과 기존 본문을 함께 유지한다.
  return { templateCode: kind === 'checkin' ? TPL_CHECKIN : _getCheckoutGuideTemplate_(),
    content: kind === 'checkin' ? _buildCheckinMsg(customerName) : _buildCheckoutGuideMsg(customerName),
    vars: { '#{고객명}': customerName }, doorAccess: false };
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
  return { configured: configured, checkout: checkout, checkin: checkin };
}
