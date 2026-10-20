/** 수납 원본/배분은 Postgres가 정본, 청구액은 기존 거래내역 I열이 정본이다. */
function paymentLedgerEnabled_() {
  return PropertiesService.getScriptProperties().getProperty('PAYMENT_LEDGER_ENABLED') === 'true';
}

function paymentLedgerDate_(value) {
  var text = cardPaymentDate_(value);
  if (!/^\d{4}-\d{2}-\d{2}(?:$|[T ])/.test(text)) return null;
  var day = text.slice(0, 10), date = new Date(day + 'T00:00:00Z');
  return !isNaN(date.getTime()) && date.toISOString().slice(0, 10) === day ? day : null;
}

function getPaymentLedgerSnapshot_(tradeIds) {
  if (typeof tradeIds === 'string') tradeIds = JSON.parse(tradeIds);
  if (tradeIds != null && (!Array.isArray(tradeIds) || tradeIds.length > 5000)) throw new Error('거래ID 목록 오류');
  var wanted = tradeIds == null ? null : {};
  if (wanted) tradeIds.forEach(function(id) { wanted[String(id).trim()] = true; });
  var observedAt = new Date().toISOString();
  var ledger = getVillageTradeSheet_();
  var rows = ledger.getLastRow() < 2 ? [] : ledger.getRange(2, 1, ledger.getLastRow() - 1, 13).getValues();
  var contracts = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('계약마스터');
  if (!contracts) throw new Error('계약마스터 시트 없음');
  var contractMap = {}, duplicateIds = {};
  var contractRows = contracts.getLastRow() < 2 ? [] : contracts.getRange(2, 1, contracts.getLastRow() - 1, 10).getValues();
  contractRows.forEach(function(row) {
    var id = String(row[0] || '').trim();
    if (!id || (wanted && !wanted[id])) return;
    if (contractMap[id]) duplicateIds[id] = true;
    contractMap[id] = { status: String(row[9] || '').trim(), checkout: paymentLedgerDate_(row[4]) };
  });
  var seen = {}, accounts = [];
  rows.forEach(function(row) {
    var id = String(row[4] || '').trim();
    if (!id || (wanted && !wanted[id])) return;
    if (seen[id]) { duplicateIds[id] = true; return; }
    seen[id] = true;
    var text = String(row[8] == null ? '' : row[8]).trim();
    var amount = text === '' ? NaN : Number(text.replace(/[,₩원\s]/g, ''));
    var contract = contractMap[id];
    accounts.push({
      trade_id: id, billed_amount: Number.isSafeInteger(amount) && amount >= 0 ? amount : null,
      deposit_status: String(row[12] || '').trim(), payment_method: String(row[9] || '').trim(),
      customer_name: String(row[1] || '').trim(), payer_name: String(row[3] || row[1] || '').trim(),
      contract_status: contract ? contract.status : '계약누락',
      checkout_at: contract && contract.checkout ? contract.checkout : null, observed_at: observedAt
    });
  });
  accounts.forEach(function(account) {
    if (!duplicateIds[account.trade_id]) return;
    // 어느 행이 정본인지 추정하지 않는다. 해당 거래만 결제/배분에서 제외한다.
    account.billed_amount = null;
    account.deposit_status = '거래ID 중복 확인필요';
  });
  return { success: true, accounts: accounts, observedAt: observedAt, duplicateTradeIds: Object.keys(duplicateIds) };
}

/** 최신 청구액과 단조 revision이 모두 일치할 때만 M열을 투영한다. */
function applyPaymentLedgerProjection_(items) {
  if (!Array.isArray(items) || items.length > 5000) throw new Error('수납 반영 목록 오류');
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) throw new Error('다른 변경을 반영 중입니다. 재시도해주세요.');
  try {
    var ledger = getVillageTradeSheet_(), props = PropertiesService.getScriptProperties();
    var rows = ledger.getLastRow() < 2 ? [] : ledger.getRange(2, 1, ledger.getLastRow() - 1, 13).getValues();
    var index = {}, duplicates = {};
    rows.forEach(function(row, i) {
      var id = String(row[4] || '').trim();
      if (!id) return;
      if (index[id]) duplicates[id] = true;
      index[id] = { row: i + 2, values: row };
    });
    var applied = [], rejected = [];
    items.forEach(function(item) {
      var id = String(item.tradeId || '').trim(), target = index[id];
      var revision = Number(item.revision), key = 'PAYMENT_REV_' + id;
      if (duplicates[id]) { rejected.push({ tradeId: id, reason: 'duplicate_trade_id' }); return; }
      if (!target || !Number.isSafeInteger(revision) || revision < 1) { rejected.push({ tradeId: id, reason: 'missing_or_invalid' }); return; }
      var rawAmount = String(target.values[8] == null ? '' : target.values[8]).trim();
      var amount = rawAmount === '' ? null : Number(rawAmount.replace(/[,₩원\s]/g, ''));
      if (amount !== item.billedAmount) { rejected.push({ tradeId: id, reason: 'amount_changed' }); return; }
      if (revision < Number(props.getProperty(key) || 0)) { rejected.push({ tradeId: id, reason: 'stale_revision' }); return; }
      if (['입금완료', '부분입금', '미입금', '환불'].indexOf(item.status) < 0 || item.reviewRequired || amount == null) {
        rejected.push({ tradeId: id, reason: 'review_required' }); return;
      }
      var cell = ledger.getRange(target.row, 13), changed = String(target.values[12] || '').trim() !== item.status;
      if (changed) {
        var options = paymentOptionsFromRule_(cell.getDataValidation());
        if (options.length && options.indexOf(item.status) < 0) {
          // 기존 선택지를 보존하면서 새 수납 상태만 추가한다. 열/시트 구조는 변경하지 않는다.
          cell.setDataValidation(SpreadsheetApp.newDataValidation().requireValueInList(options.concat([item.status]), true).setAllowInvalid(false).build());
        }
        cell.setValue(item.status);
      }
      if (item.method === '카드결제' && item.paidAmount > 0 && !target.values[9]) {
        ledger.getRange(target.row, 10).setValue('카드결제'); changed = true;
      }
      props.setProperty(key, String(revision));
      if (changed) {
        supaMarkTradeDirty_(id);
        if (typeof invalidateDashboardTradeExtraCache_ === 'function') invalidateDashboardTradeExtraCache_([id]);
      }
      applied.push({ tradeId: id, revision: revision });
    });
    if (applied.length && typeof invalidateDashboardCache === 'function') invalidateDashboardCache();
    return { success: true, applied: applied, rejected: rejected };
  } finally { lock.releaseLock(); }
}

function paymentLedgerServerRequest_(body) {
  var props = PropertiesService.getScriptProperties();
  var key = props.getProperty('VILLAGE_API_WRITE_KEY_V1');
  if (!key) throw new Error('수납 내부 인증 설정 없음');
  var response = UrlFetchApp.fetch('https://today-dashboard-ten.vercel.app/api/internal/payments', {
    method: 'post', contentType: 'application/json',
    headers: { 'x-payment-internal-key': key }, payload: JSON.stringify(body), muteHttpExceptions: true
  });
  var result = JSON.parse(response.getContentText());
  if (response.getResponseCode() !== 200 || result.success !== true) throw new Error(result.error || '수납 동기화 실패');
  return result;
}

/** 기존 1분 dirty 큐를 재사용한다. 실패하면 해당 dirty 표식을 지우지 않는다. */
function flushPaymentLedgerMirror_(tradeIds) {
  if (!paymentLedgerEnabled_()) return true;
  var snapshot = getPaymentLedgerSnapshot_(tradeIds);
  var result = paymentLedgerServerRequest_({ action: 'syncSnapshot', accounts: snapshot.accounts });
  var projected = applyPaymentLedgerProjection_(result.projections || []);
  paymentLedgerServerRequest_({ action: 'ackProjections', applied: projected.applied, rejected: projected.rejected });
  return projected.rejected.length === 0;
}

function configurePaymentLedger_(enabled) {
  if (enabled !== true && enabled !== false) throw new Error('enabled boolean 필요');
  PropertiesService.getScriptProperties().setProperty('PAYMENT_LEDGER_ENABLED', enabled ? 'true' : 'false');
  return { success: true, enabled: enabled };
}
