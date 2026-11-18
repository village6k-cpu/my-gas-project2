// A row records a staff-verified introduction. Bind each side to the exact
// booking; a quote preview and a contract reprint both reuse that binding.
function assertReferralIsFirstRental_(ss, id, phone) {
  var isRequest = id.indexOf('RQ-') === 0;
  var booking = referralBookingRows_(ss, id).find(function (row) {
    return referralPhone_(row[isRequest ? 11 : 2]) === phone && row[isRequest ? 1 : 4];
  });
  var start = booking && parseDT(booking[isRequest ? 1 : 4], booking[isRequest ? 2 : 5]);
  if (!start) throw new Error('소개받은 고객의 첫 대여 일시를 확인해주세요');
  var sheet = ss.getSheetByName('계약마스터');
  if (!sheet || sheet.getLastRow() < 2) return;
  var foundEarlier = sheet.getRange(2, 1, sheet.getLastRow() - 1, 10).getDisplayValues().some(function (row) {
    if (row[0] === id || referralPhone_(row[2]) !== phone || /^(?:예약취소|취소|폐기)/.test(String(row[9] || '').trim())) return false;
    var previous = parseDT(row[4], row[5]);
    if (!previous || previous < start) return true;
    if (previous > start) return false;
    // 동일 반출 시각의 확정 거래는 먼저 발급된 거래번호 한 건만 최초 대여로 인정한다.
    // 아직 발급 전인 요청이나 순서를 증명할 수 없는 기존 거래는 임의로 앞세우지 않는다.
    var otherId = String(row[0] || '').trim();
    return isRequest || !/^\d{6}-\d{3}$/.test(otherId) || otherId < id;
  });
  if (foundEarlier) throw new Error('소개받은 고객의 이전 대여 이력을 확인해주세요');
}

function assertReferralUsesStandardPricing_(ss, id) {
  if (referralBookingUsesFixedQuote_(ss, id)) {
    throw new Error('기간확정견적의 합의 금액은 소개할인으로 자동 변경할 수 없습니다');
  }
}

function promoteRegisteredReferralDiscount_(ss, requestId, tradeId) {
  var rows = referralDiscountRows_(ss);
  rows.forEach(function (row, index) {
    var column = row[2] === requestId ? 2 : row[3] === requestId ? 3 : -1;
    if (column < 0) return;
    if (referralActiveBooking_(ss, tradeId, row[column - 2]) !== tradeId) {
      throw new Error('소개할인에 연결된 거래의 예약자를 확인해주세요');
    }
    ss.getSheetByName(REFERRAL_DISCOUNT_SHEET_).getRange(index + 2, column + 1).setValue(tradeId);
  });
}

function applyVerifiedReferralDiscount_(args) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var referred = referralPhone_(args.referredPhone), referrer = referralPhone_(args.referrerPhone);
  var first = referralBookingId_(args.firstBookingId), use = referralBookingId_(args.referrerBookingId);
  var referrerName = referralName_(args.referrerName);
  if (!referred || (!referrer && !referrerName) || referred === referrer || !first ||
      (args.referrerBookingId && (!use || !referrer)) || args.verified !== true) {
    throw new Error('확인된 소개자와 첫 대여 예약자 연락처를 입력해주세요');
  }
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  var pendingContracts = [];
  try {
    var firstTarget = referralActiveBooking_(ss, first, referred);
    var useTarget = use && referralActiveBooking_(ss, use, referrer);
    if (!firstTarget || (use && !useTarget)) {
      throw new Error('소개할인 적용 건의 예약자 연락처를 다시 확인해주세요');
    }
    first = firstTarget;
    use = useTarget || "";
    var rows = referralDiscountRows_(ss);
    var indexes = rows.reduce(function (all, row, index) {
      if (row[0] === referred) all.push(index);
      return all;
    }, []);
    if (indexes.length > 1) throw new Error('소개받은 고객의 할인 기록이 중복됩니다');
    var index = indexes.length ? indexes[0] : -1;
    var saved = rows[index];
    if (saved && (saved[2] !== first || (saved[1] && referrer && saved[1] !== referrer) ||
        (saved[4] && saved[4] !== referrerName && (!saved[1] || saved[1] !== referrer)) ||
        (saved[3] && use && saved[3] !== use))) {
      throw new Error('이 고객의 소개 기록이 이미 다른 대여 건에 연결되어 있습니다');
    }
    if (use && (!saved || !saved[3]) && verifiedReferralDiscountRate_(ss, use, referrer)) {
      throw new Error('이 대여 건에 이미 소개할인이 연결되어 있습니다');
    }
    if (!saved) {
      assertReferralIsFirstRental_(ss, first, referred);
      assertReferralUsesStandardPricing_(ss, first);
    }
    if (use && (!saved || !saved[3])) {
      var confirmed = first.indexOf('RQ-') !== 0 && referralBookingRows_(ss, first).some(function (row) {
        return referralPhone_(row[2]) === referred && /^(?:예약|반출|반납완료)$/.test(String(row[9] || '').trim());
      });
      if (!confirmed) throw new Error('새 고객의 첫 대여가 확정된 뒤 소개한 고객의 5%를 사용할 수 있습니다');
      assertReferralUsesStandardPricing_(ss, use);
    }
    if (!saved && verifiedReferralDiscountRate_(ss, first, referred)) {
      throw new Error('이 첫 대여 건에 이미 소개할인이 연결되어 있습니다');
    }
    var stored = [referred, referrer || (saved && saved[1]) || '', first, use || (saved && saved[3]) || '',
      referrerName || (saved && saved[4]) || ''];
    if (saved && JSON.stringify(saved) === JSON.stringify(stored)) return {success:true, firstBookingId:first, referrerBookingId:stored[3], rate:REFERRAL_DISCOUNT_RATE_};
    // Enqueue under the same lock before saving the binding so a queue failure
    // leaves the booker's current amount intact. The worker reads after unlock.
    pendingContracts = [!saved && first, use && (!saved || !saved[3]) && use].filter(function (id) {
      return id && id.indexOf('RQ-') !== 0;
    });
    pendingContracts.forEach(scheduleContractRegenUnderLock_);
    var sheet = ss.getSheetByName(REFERRAL_DISCOUNT_SHEET_);
    if (!sheet) {
      sheet = ss.insertSheet(REFERRAL_DISCOUNT_SHEET_);
      sheet.getRange(1, 1, 1, 4).setValues([REFERRAL_DISCOUNT_HEADERS_]);
      sheet.setFrozenRows(1);
    }
    var nameHeader = sheet.getRange(1, 5, 1, 1);
    var currentHeader = nameHeader.getDisplayValues()[0][0] || '';
    if (currentHeader && currentHeader !== REFERRAL_DISCOUNT_NAME_HEADER_) throw new Error('소개할인 확인 열을 점검해주세요');
    if (!currentHeader) nameHeader.setValue(REFERRAL_DISCOUNT_NAME_HEADER_);
    var row = index < 0 ? sheet.getLastRow() + 1 : index + 2;
    sheet.getRange(row, 1, 1, 5).setNumberFormat('@').setValues([stored]);
    SpreadsheetApp.flush();
    if (verifiedReferralDiscountRate_(ss, first, referred) !== REFERRAL_DISCOUNT_RATE_ ||
        (stored[3] && verifiedReferralDiscountRate_(ss, stored[3], referrer) !== REFERRAL_DISCOUNT_RATE_)) {
      throw new Error('소개할인 저장 후 확인에 실패했습니다');
    }
    return {success:true, firstBookingId:first, referrerBookingId:stored[3], rate:REFERRAL_DISCOUNT_RATE_, contractRegenPending:pendingContracts};
  } finally {
    lock.releaseLock();
    if (pendingContracts.length) ensureContractRegenTrigger_();
  }
}
