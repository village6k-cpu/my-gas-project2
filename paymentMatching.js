/** 카드 승인 후보 전용 조회. 전체 대시보드/장비 검색 및 캐시를 거치지 않는다. */
function getCardPaymentCandidates_(amount, tid) {
  amount = Number(amount);
  tid = String(tid || '').trim();
  if (!Number.isSafeInteger(amount) || amount <= 0) throw new Error('유효한 승인금액 필요');
  var ledger = getVillageTradeSheet_();
  var result = { checkout: [], checkin: [] };
  if (ledger.getLastRow() < 2) return result;
  // 거래내역 E: 거래ID, I: 현재 청구액, J: 결제수단, M: 입금상태.
  var rows = ledger.getRange(2, 1, ledger.getLastRow() - 1, 13).getValues();
  var wanted = {};
  rows.forEach(function(row) {
    var id = String(row[4] || '').trim();
    if (!id || (tid && id !== tid)) return;
    var currentAmount = typeof row[8] === 'number' ? row[8] : Number(String(row[8]).replace(/[,₩원\s]/g, ''));
    if (currentAmount !== amount) return;
    if (wanted[id]) throw new Error('거래내역 거래ID 중복: ' + id);
    wanted[id] = {
      tradeId: id, name: String(row[1] || ''), actualAmount: currentAmount,
      paymentMethod: String(row[9] || ''), depositStatus: String(row[12] || '')
    };
  });
  if (Object.keys(wanted).length === 0) return result;
  var contracts = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('계약마스터');
  if (!contracts) throw new Error('계약마스터 시트 없음');
  if (contracts.getLastRow() < 2) return result;
  var seen = {};
  contracts.getRange(2, 1, contracts.getLastRow() - 1, 10).getValues().forEach(function(row) {
    var id = String(row[0] || '').trim();
    if (!wanted[id]) return;
    if (seen[id]) throw new Error('계약마스터 거래ID 중복: ' + id);
    seen[id] = true;
    var item = wanted[id];
    // 계약마스터 E/G는 반출일/반납일, J는 계약상태. 연락처는 반환하지 않는다.
    item.searchDate = cardPaymentDate_(row[4]);
    item.returnDate = cardPaymentDate_(row[6]);
    item.contractStatus = String(row[9] || '');
    result.checkout.push(item);
  });
  return result;
}

function cardPaymentDate_(value) {
  if (value && typeof value.getTime === 'function' && !isNaN(value.getTime())) {
    return Utilities.formatDate(value, 'Asia/Seoul', 'yyyy-MM-dd');
  }
  return String(value || '').trim();
}

/** 단말 결제 가능 여부의 정본은 빌리지2.0 거래내역. 복사본/캐시로 완납을 뒤집지 않는다. */
function getTerminalPaymentState_(tradeIds) {
  if (typeof tradeIds === 'string') tradeIds = JSON.parse(tradeIds);
  if (!Array.isArray(tradeIds) || tradeIds.length > 5000) throw new Error('유효한 거래ID 목록 필요');
  var items = {};
  tradeIds.forEach(function(value) {
    var tid = String(value || '').trim();
    if (!tid) throw new Error('거래ID 필요');
    items[tid] = { found: false, canPay: false, reason: 'missing_ledger' };
  });
  var ids = Object.keys(items);
  if (!ids.length) return { success: true, items: items };
  var ledger = getVillageTradeSheet_();
  if (!ledger) throw new Error('거래내역 시트 없음');
  var rows = ledger.getLastRow() < 2 ? [] : ledger.getRange(2, 1, ledger.getLastRow() - 1, 13).getValues();
  rows.forEach(function(row) {
    var tid = String(row[4] || '').trim();
    if (!Object.prototype.hasOwnProperty.call(items, tid)) return;
    if (items[tid].found) throw new Error('거래내역 거래ID 중복: ' + tid);
    var amount = typeof row[8] === 'number' ? row[8] : Number(String(row[8]).replace(/[,₩원\s]/g, ''));
    var status = String(row[12] || '').trim();
    items[tid] = {
      found: true, canPay: false, reason: 'missing_contract',
      amount: Number.isSafeInteger(amount) && amount > 0 ? amount : null,
      depositStatus: status, paymentMethod: String(row[9] || '').trim()
    };
  });
  var contracts = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('계약마스터');
  if (!contracts) throw new Error('계약마스터 시트 없음');
  var seen = {};
  var contractRows = contracts.getLastRow() < 2 ? [] : contracts.getRange(2, 1, contracts.getLastRow() - 1, 10).getValues();
  contractRows.forEach(function(row) {
    var tid = String(row[0] || '').trim();
    if (!Object.prototype.hasOwnProperty.call(items, tid)) return;
    if (seen[tid]) throw new Error('계약마스터 거래ID 중복: ' + tid);
    seen[tid] = true;
    var item = items[tid];
    if (!item.found) return;
    item.contractStatus = String(row[9] || '').trim();
    // 부분입금/환불 등은 잔액 확인이 필요하므로 원 청구액 전액을 단말에 제시하지 않는다.
    item.canPay = (item.depositStatus === '' || item.depositStatus === '미입금') &&
      item.contractStatus !== '취소' && item.amount !== null;
    item.reason = item.canPay ? 'unpaid' : 'not_payable';
  });
  return { success: true, items: items };
}
