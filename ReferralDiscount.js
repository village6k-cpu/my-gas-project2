// Shared by the inventory and official-document Apps Script projects.
var REFERRAL_DISCOUNT_SHEET_ = '소개할인';
var REFERRAL_DISCOUNT_HEADERS_ = ['소개받은 고객 연락처', '소개한 고객 연락처', '소개받은 고객 적용 건', '소개한 고객 적용 건'];
var REFERRAL_DISCOUNT_RATE_ = 5;

function referralPhone_(value) {
  var digits = String(value == null ? '' : value).replace(/[^0-9]/g, '');
  if (/^821[016789]\d{7,8}$/.test(digits)) digits = '0' + digits.slice(2);
  if (/^1[016789]\d{7,8}$/.test(digits)) digits = '0' + digits;
  return /^01[016789]\d{7,8}$/.test(digits) ? digits : '';
}

function referralBookingId_(value) {
  var id = String(value || '').trim();
  return /^(?:RQ-)?\d{6}-\d{3}$/.test(id) ? id : '';
}

function referralDiscountRows_(ss) {
  var sheet = ss.getSheetByName(REFERRAL_DISCOUNT_SHEET_);
  if (!sheet) return [];
  if (sheet.getLastRow() < 1 || JSON.stringify(sheet.getRange(1, 1, 1, 4).getDisplayValues()[0]) !== JSON.stringify(REFERRAL_DISCOUNT_HEADERS_)) {
    throw new Error('소개할인 시트의 헤더를 확인해주세요');
  }
  if (sheet.getLastRow() === 1) return [];
  return sheet.getRange(2, 1, sheet.getLastRow() - 1, 4).getDisplayValues().map(function (row) {
    return [referralPhone_(row[0]), referralPhone_(row[1]), referralBookingId_(row[2]), referralBookingId_(row[3])];
  });
}

function referralBookingRows_(ss, id) {
  var request = id.indexOf('RQ-') === 0;
  var sheet = ss.getSheetByName(request ? '확인요청' : '계약마스터');
  if (!sheet || sheet.getLastRow() < 2) return [];
  return sheet.getRange(2, 1, sheet.getLastRow() - 1, 1)
    .createTextFinder(id).matchEntireCell(true).matchCase(true).findAll().map(function (cell) {
      return sheet.getRange(cell.getRow(), 1, 1, request ? 17 : 12).getDisplayValues()[0];
    });
}

function referralActiveBooking_(ss, id, phone) {
  var request = id.indexOf('RQ-') === 0;
  var rows = referralBookingRows_(ss, id).filter(function (row) {
    return request ? !/^(?:취소|거절|제외)/.test(row[14]) : !/^(?:예약취소|취소|폐기)/.test(String(row[9] || '').trim());
  });
  var phones = rows.map(function (row) { return String(row[request ? 11 : 2] || '').trim(); }).filter(Boolean);
  if (!phones.length || phones.some(function (value) { return referralPhone_(value) !== phone; })) return null;
  if (!request) return rows.length === 1 ? id : null;
  var links = [];
  rows.forEach(function (row) {
    var link = referralBookingId_(row[15]);
    if (/^등록완료/.test(row[14]) && link && link.indexOf('RQ-') !== 0 && links.indexOf(link) === -1) links.push(link);
  });
  if (links.length > 1) throw new Error('소개할인 요청의 연결 거래가 여러 건입니다');
  return links.length ? referralActiveBooking_(ss, links[0], phone) : id;
}

function referralBookingUsesFixedQuote_(ss, id) {
  var column = id.indexOf('RQ-') === 0 ? 16 : 11;
  return referralBookingRows_(ss, id).some(function (row) {
    return String(row[column] || '').indexOf('[기간확정견적') !== -1;
  });
}

function verifiedReferralDiscountRate_(ss, bookingId, customerPhone) {
  var id = referralBookingId_(bookingId), phone = referralPhone_(customerPhone);
  if (!id || !phone) return 0;
  var rows = referralDiscountRows_(ss);
  var target, matches = 0;
  rows.forEach(function (row) {
    var referred = row[0], referrer = row[1];
    if (phone !== referred && phone !== referrer) return;
    var binding = phone === referred ? row[2] : row[3];
    if (!binding || (id.indexOf('RQ-') === 0 && binding !== id && binding.indexOf('RQ-') === 0)) return;
    if (!referred || !referrer || referred === referrer || !row[2]) throw new Error('소개할인 확인 기록이 올바르지 않습니다');
    if (target === undefined) target = referralActiveBooking_(ss, id, phone);
    if (!target || referralBookingUsesFixedQuote_(ss, target)) return;
    if (binding === id || binding === target || referralActiveBooking_(ss, binding, phone) === target) {
      if (rows.filter(function (entry) { return entry[0] === referred; }).length !== 1) {
        throw new Error('소개받은 고객의 할인 기록이 중복됩니다');
      }
      matches++;
    }
  });
  if (matches > 1) throw new Error('한 거래의 소개할인 확인 기록이 중복됩니다');
  return matches === 1 ? REFERRAL_DISCOUNT_RATE_ : 0;
}
