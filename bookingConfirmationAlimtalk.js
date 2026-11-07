var BOOKING_CONFIRMATION_LINK_ = 'https://today-dashboard-ten.vercel.app/my?t=';
var BOOKING_CONFIRMATION_BUTTON_ = '내 예약 확인';

function buildBookingConfirmationMessage_(name, checkout, checkin) {
  return name + ' 감독님, 안녕하세요. 빌리지 렌탈샵입니다.\n\n'
    + '예약이 확정되었습니다.\n\n'
    + '· 반출: ' + checkout + '\n· 반납: ' + checkin + '\n\n'
    + '아래 [내 예약 확인]을 눌러 예약 내역을 확인해주세요.\n'
    + '견적서는 [견적서 보기]에서 열고, [PDF 저장] 또는 [공유]로 전달하실 수 있습니다.\n\n'
    + '예약 변경·연장·취소는 빌리지 카카오톡 채널로 문의해주세요.';
}

function bookingConfirmationTemplateCode_() {
  var cache = CacheService.getScriptCache();
  var key = 'bookingConfirmationQuoteTemplate_v1';
  var cached = cache.get(key);
  if (cached !== null) return cached === 'pending' ? '' : cached;

  var expected = buildBookingConfirmationMessage_('#{고객명}', '#{반출일시}', '#{반납일시}');
  var expectedLink = BOOKING_CONFIRMATION_LINK_ + '#{예약토큰}';
  var templates = popbillKakaoRead_('/KakaoTalk/ListATSTemplate');
  var matches = Array.isArray(templates) ? templates.filter(function(template) {
    var button = template.btns && template.btns.length === 1 && template.btns[0];
    return String(template.state) === '3' && /^\d{12}$/.test(String(template.templateCode))
      && String(template.template || '').replace(/\r\n/g, '\n').trim() === expected
      && button && button.n === BOOKING_CONFIRMATION_BUTTON_ && button.t === 'WL'
      && button.u1 === expectedLink && button.u2 === expectedLink;
  }) : [];
  var code = matches.length === 1 ? String(matches[0].templateCode) : '';
  cache.put(key, code || 'pending', 300);
  return code;
}

function bookingConfirmationRecordKey_(tid) {
  return 'bookingConfirmationAlimtalk_v1_' + tid;
}

function sendBookingConfirmationAlimtalk_(tid, name, phone, outDate, outTime, inDate, inTime) {
  if (!tid || !name || !phone) return null;
  var code;
  try { code = bookingConfirmationTemplateCode_(); } catch (error) { return null; }
  if (!code) return null;
  var link = getMyPageLink(tid);
  if (!link.success || !link.token || link.url !== BOOKING_CONFIRMATION_LINK_ + encodeURIComponent(link.token)) return null;

  var props = PropertiesService.getScriptProperties();
  var receipts = operationalPropertyStore_('receipts', props);
  var key = bookingConfirmationRecordKey_(tid);
  var receiver = normalizeAlimtalkReceiver_(phone);
  var checkout = fmtDT(outDate, outTime);
  var checkin = fmtDT(inDate, inTime);
  var vars = { '#{고객명}': name, '#{반출일시}': checkout, '#{반납일시}': checkin, '#{예약토큰}': link.token };
  var button = { n: BOOKING_CONFIRMATION_BUTTON_, t: 'WL', u1: link.url, u2: link.url };
  var record = { requestNum: Utilities.getUuid(), templateCode: code, state: 'unknown', createdAt: Date.now() };
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(3000)) return { state: 'busy', sent: false };
  try {
    if (props.getProperty('REG_ALIM_SENT_' + tid) || receipts.getProperty(key)) {
      return { state: 'duplicate', sent: false };
    }
    // 팝빌 응답이 끊겨도 같은 확정 안내가 다시 접수되지 않도록 먼저 기록한다.
    receipts.setProperty(key, JSON.stringify(record));
  } finally { lock.releaseLock(); }

  var result;
  try {
    result = sendAlimtalk(code, receiver, name, buildBookingConfirmationMessage_(name, checkout, checkin),
      vars, [button], { altSendType: '', requestNum: record.requestNum });
    record.state = _alimtalkAccepted_(result) ? 'pending' : 'rejected';
    if (record.state === 'pending') record.receiptNum = String(result.receiptNum);
  } catch (error) { /* 결과를 모르면 최초 기록을 유지한다. */ }
  receipts.setProperty(key, JSON.stringify(record));
  return { state: record.state, sent: record.state === 'pending', receiptNum: record.receiptNum || '' };
}
