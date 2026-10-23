// An explicit staff-approved billing period lives with the contract, never in a
// disposable property/cache. Unmarked legacy contracts retain their date policy.
function isApprovedBillingRounds_(value) {
  return typeof value === 'number' && Number.isFinite(value) &&
    value >= 1 && value <= 99 && Number.isSafeInteger(value * 2);
}

function approvedBillingPeriodKey_(period) {
  function dateText(value) {
    if (Object.prototype.toString.call(value) === '[object Date]') {
      return Utilities.formatDate(value, 'Asia/Seoul', 'yyyy-MM-dd');
    }
    var match = String(value || '').trim().match(/^(\d{4})[-/.]\s*(\d{1,2})[-/.]\s*(\d{1,2})\.?$/);
    if (!match) throw new Error('승인회차 기간 날짜 형식 오류');
    var date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
    if (date.getUTCFullYear() !== Number(match[1]) || date.getUTCMonth() + 1 !== Number(match[2]) || date.getUTCDate() !== Number(match[3])) {
      throw new Error('승인회차 기간 날짜 오류');
    }
    return match[1] + '-' + ('0' + match[2]).slice(-2) + '-' + ('0' + match[3]).slice(-2);
  }
  function timeText(value) {
    if (Object.prototype.toString.call(value) === '[object Date]') return Utilities.formatDate(value, 'Asia/Seoul', 'HH:mm');
    var match = String(value || '').trim().match(/^(\d{1,2}):([0-5]\d)$/);
    if (!match || Number(match[1]) > 23) throw new Error('승인회차 기간 시간 형식 오류');
    return ('0' + match[1]).slice(-2) + ':' + match[2];
  }
  var start = dateText(period.startDate) + 'T' + timeText(period.startTime);
  var end = dateText(period.endDate) + 'T' + timeText(period.endTime);
  if (end <= start) throw new Error('승인회차 반납일시는 반출일시 이후여야 합니다');
  return start + '/' + end;
}

function parseApprovedBillingRoundsNote_(note) {
  note = String(note === null || note === undefined ? '' : note);
  if (note.indexOf('[승인회차') === -1) return null;
  var matches = note.match(/\[승인회차:v1 회차=(\d+(?:\.5)?) 기간=\d{4}-\d{2}-\d{2}T\d{2}:\d{2}\/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}\]/g);
  if (!matches || matches.length !== 1 || note.split('[승인회차').length !== 2) throw new Error('승인회차 표식 중복 또는 형식 오류');
  var fields = matches[0].match(/^\[승인회차:v1 회차=(\d+(?:\.5)?) 기간=(.+)\]$/);
  var rounds = Number(fields[1]);
  if (!isApprovedBillingRounds_(rounds)) throw new Error('승인회차는 1~99 사이 0.5 단위 숫자여야 합니다');
  return { text: matches[0], rounds: rounds, period: fields[2] };
}

function readApprovedBillingRounds_(note, contractRounds, period) {
  var marker = parseApprovedBillingRoundsNote_(note);
  if (!marker) return null;
  if (!isApprovedBillingRounds_(contractRounds) || marker.rounds !== contractRounds || marker.period !== approvedBillingPeriodKey_(period)) {
    throw new Error('승인회차와 계약 I열·현재 기간이 일치하지 않습니다. 회차 재승인 필요');
  }
  return marker.rounds;
}

function writeApprovedBillingRoundsNote_(note, rounds, period) {
  if (!isApprovedBillingRounds_(rounds)) throw new Error('승인회차는 1~99 사이 0.5 단위 숫자여야 합니다');
  note = String(note === null || note === undefined ? '' : note);
  var previous = parseApprovedBillingRoundsNote_(note);
  var marker = '[승인회차:v1 회차=' + rounds + ' 기간=' + approvedBillingPeriodKey_(period) + ']';
  return previous ? note.replace(previous.text, marker) : note + (note ? '\n' : '') + marker;
}

function assertApprovedBillingDateChange_(contractRow, nextPeriod, displayRow) {
  if (String(contractRow[11] || '').indexOf('[승인회차') === -1) return null;
  displayRow = displayRow || contractRow;
  readApprovedBillingRounds_(contractRow[11], contractRow[8], {
    startDate: contractRow[4], startTime: displayRow[5], endDate: contractRow[6], endTime: displayRow[7]
  });
  // A new date approval is not a new billing-round approval. Keep the old ledger
  // intact until an explicit combined amendment is supported and approved.
  return readApprovedBillingRounds_(contractRow[11], contractRow[8], nextPeriod);
}

// Shared strict validation also runs before the authenticated Windows POST.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { isApprovedBillingRounds_: isApprovedBillingRounds_ };
}
