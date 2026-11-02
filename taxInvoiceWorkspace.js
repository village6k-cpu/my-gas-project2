/** 계산서 작업대. 청구·발행처는 재무 원본에서 읽고, 발행 직전에 같은 스냅샷인지 검증한다. */
function invoiceWorkspaceText_(value) { return String(value == null ? '' : value).trim(); }
function invoiceWorkspaceBuyer_(row) {
  return { corpNum: invoiceWorkspaceText_(row[0]).replace(/\D/g, ''), corpName: invoiceWorkspaceText_(row[1]),
    ceoName: invoiceWorkspaceText_(row[2]), email: invoiceWorkspaceText_(row[3]), addr: invoiceWorkspaceText_(row[4]),
    bizType: invoiceWorkspaceText_(row[5]), bizClass: invoiceWorkspaceText_(row[6]) };
}
function invoiceWorkspaceGuardKey_(tid) { return 'taxInvoiceWorkspacePending_' + tid; }
function invoiceWorkspacePending_(tid) {
  var raw = PropertiesService.getScriptProperties().getProperty(invoiceWorkspaceGuardKey_(tid));
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (err) { return { state: 'unknown' }; }
}
function invoiceWorkspaceIssueGuard_(tid, token) {
  var pending = invoiceWorkspacePending_(tid);
  if (pending && (!token || pending.token !== token)) return {
    success: false, code: 'INVOICE_OUTCOME_UNKNOWN', outcomeUnknown: true,
    error: '앞선 계산서 발행 결과를 먼저 확인해주세요. 중복 발행을 막기 위해 재발행을 보류했습니다.'
  };
  return null;
}
function invoiceWorkspaceDigest_(value) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, JSON.stringify(value), Utilities.Charset.UTF_8)
    .map(function(n) { return ('0' + ((n + 256) % 256).toString(16)).slice(-2); }).join('');
}

function getTaxInvoiceWorkspace_(tids, options) {
  if (!Array.isArray(tids) || tids.length > 200 || tids.some(function(id) { return !/^\d{6}-\d{3}$/.test(id); })) {
    throw new Error('계산서 거래ID 목록 오류');
  }
  options = options || {};
  var ledger = getVillageTradeSheet_(), master = ledger.getParent().getSheetByName('발행처DB');
  if (!master) throw new Error('발행처DB 시트 없음');
  var masterRows = master.getLastRow() < 2 ? [] : master.getRange(2, 1, master.getLastRow() - 1, 7).getDisplayValues();
  var buyers = masterRows.map(invoiceWorkspaceBuyer_).filter(function(b) { return b.corpNum || b.corpName; });
  var ledgerRows = ledger.getLastRow() < 2 ? [] : ledger.getRange(2, 1, ledger.getLastRow() - 1, 15).getDisplayValues();
  var contracts = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('계약마스터');
  if (!contracts) throw new Error('계약마스터 시트 없음');
  var contractRows = contracts.getLastRow() < 2 ? [] : contracts.getRange(2, 1, contracts.getLastRow() - 1, 10).getDisplayValues();
  var targets = options.targets || tids.map(function(tid) { return { key: tid, tradeId: tid }; });
  if (!Array.isArray(targets) || targets.length > 200 || targets.some(function(t) { return !t || tids.indexOf(t.tradeId) < 0; })) throw new Error('계산서 조회 대상 오류');
  var items = targets.map(function(target) {
    var tid = target.tradeId;
    var choice = Object.assign({}, options, target.buyer ? { buyer: target.buyer } : {});
    var matched = ledgerRows.filter(function(r) { return invoiceWorkspaceText_(r[4]) === tid; });
    var contractMatches = contractRows.filter(function(r) { return invoiceWorkspaceText_(r[0]) === tid; });
    var reasons = [], row = matched[0] || [], contract = contractMatches[0] || [];
    if (matched.length !== 1) reasons.push(matched.length ? '거래ID 중복 확인 필요' : '거래내역에 연결할 거래가 없습니다');
    if (contractMatches.length !== 1) reasons.push(contractMatches.length ? '계약ID 중복 확인 필요' : '계약 연결 확인 필요');
    if (invoiceWorkspaceText_(contract[9]) === '취소') reasons.push('취소된 예약입니다');
    var rawAmount = invoiceWorkspaceText_(row[8]);
    var amount = rawAmount ? Number(rawAmount.replace(/[,₩원\s]/g, '')) : NaN;
    if (!Number.isSafeInteger(amount) || amount <= 0) reasons.push('발행 금액 확인 필요');
    var corpNum = invoiceWorkspaceText_(row[7]).replace(/\D/g, '');
    var company = invoiceWorkspaceText_(row[6]);
    var selected = buyers.filter(function(b) { return choice.buyerId ? b.corpNum === choice.buyerId : corpNum ? b.corpNum === corpNum : company && b.corpName === company; });
    var buyer = choice.buyer ? invoiceWorkspaceBuyer_([
      choice.buyer.corpNum, choice.buyer.corpName, choice.buyer.ceoName, choice.buyer.email,
      choice.buyer.addr, choice.buyer.bizType, choice.buyer.bizClass
    ]) : selected.length === 1 ? selected[0] : invoiceWorkspaceBuyer_([corpNum, company]);
    var buyerMaster = buyers.filter(function(b) { return b.corpNum === buyer.corpNum; });
    if (buyerMaster.length > 1) reasons.push('동일 사업자번호가 발행처DB에 중복되어 있습니다');
    if (choice.buyer && buyerMaster.length === 1 && JSON.stringify(buyerMaster[0]) !== JSON.stringify(buyer)) reasons.push('기존 발행처DB와 입력 정보가 다릅니다. 발행처 정보를 먼저 확인해주세요');
    if (!choice.buyer && selected.length > 1) reasons.push('동일 발행처 정보가 중복되어 있습니다');
    if (!/^\d{10}$/.test(buyer.corpNum)) reasons.push('사업자등록번호 10자리 필요');
    if (!buyer.corpName) reasons.push('발행처 상호 필요');
    if (!buyer.ceoName) reasons.push('대표자명 필요');
    var emails = buyer.email.split(',').map(function(e) { return e.trim(); });
    if (!buyer.email || emails.some(function(e) { return !/^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/.test(e); }) || emails.length > 2) reasons.push('수신 이메일 확인 필요');
    var proofType = invoiceWorkspaceText_(row[10]), issueStatus = invoiceWorkspaceText_(row[11]), mgtKey = invoiceWorkspaceText_(row[14]);
    var issued = proofType === '세금계산서' && issueStatus === '발행완료' && !!mgtKey;
    var requestedBuyer = buyer;
    if (issued) buyer = selected.length === 1 ? selected[0] : invoiceWorkspaceBuyer_([corpNum, company]);
    var recipientMismatch = issued && choice.buyer && (requestedBuyer.corpNum !== buyer.corpNum || requestedBuyer.email !== buyer.email);
    if (recipientMismatch) reasons.push('기존 계산서와 요청 수신처가 다릅니다. 정정 여부 확인 필요');
    var amountMismatch = issued && target.expectedAmount != null && target.expectedAmount !== amount;
    if (amountMismatch) reasons.push('기존 발행 이력과 현재 청구 금액이 다릅니다. 정정 여부 확인 필요');
    if (proofType && ['미발행', '안함', '세금계산서'].indexOf(proofType) < 0) reasons.push('다른 증빙이 선택되어 있습니다');
    if (mgtKey && !issued) reasons.push('기존 증빙 관리번호 확인 필요');
    if (/발행요청|전송중|처리중|발행중/.test(issueStatus)) reasons.push('기존 발행 요청의 결과 확인 필요');
    var pending = invoiceWorkspacePending_(tid);
    if (pending && !issued) reasons.push('앞선 발행 결과 확인 필요 — 재발행 보류');
    var depositStatus = invoiceWorkspaceText_(row[12]);
    if (!invoiceWorkspaceText_(row[9])) reasons.push('결제수단 확인 필요');
    if (/환불/.test(depositStatus)) reasons.push('환불 거래의 정정 여부 확인 필요');
    var fingerprint = invoiceWorkspaceDigest_({ tid: tid, ledger: row, contract: contract, buyer: buyer,
      master: buyers.filter(function(b) { return b.corpNum === buyer.corpNum; }) });
    return { workspaceKey: target.key, tradeId: tid, customerName: invoiceWorkspaceText_(row[1]), phone: invoiceWorkspaceText_(row[5]),
      checkoutAt: invoiceWorkspaceText_(contract[4]), checkinAt: invoiceWorkspaceText_(contract[5]),
      amount: Number.isSafeInteger(amount) && amount > 0 ? amount : null,
      supplyCost: Number.isSafeInteger(amount) && amount > 0 ? amount - Math.floor(amount / 11) : null,
      tax: Number.isSafeInteger(amount) && amount > 0 ? Math.floor(amount / 11) : null,
      buyer: buyer, paymentMethod: invoiceWorkspaceText_(row[9]), depositStatus: depositStatus,
      purposeType: depositStatus === '입금완료' ? '영수' : '청구', proofType: proofType,
      issueStatus: issueStatus, issueNote: invoiceWorkspaceText_(row[13]), mgtKey: mgtKey,
      status: issued && !recipientMismatch && !amountMismatch ? 'issued' : reasons.length ? 'needs_info' : 'ready', canIssue: !issued && !reasons.length,
      missing: reasons, fingerprint: fingerprint };
  });
  return { success: true, observedAt: new Date().toISOString(), items: items,
    buyers: buyers.map(function(b) { return { id: b.corpNum, name: b.corpName }; }) };
}

function issueTaxInvoiceWorkspace_(args) {
  args = args || {};
  var tid = invoiceWorkspaceText_(args.tradeId);
  if (!/^\d{6}-\d{3}$/.test(tid) || !/^[a-f0-9]{64}$/.test(args.fingerprint || '')) return { success: false, error: '발행 미리보기를 먼저 확인해주세요' };
  var lock = LockService.getScriptLock(), snapshot, token = invoiceWorkspaceText_(args.mutationId);
  if (!lock.tryLock(5000)) return { success: false, code: 'BUSY', error: '다른 작업을 처리 중입니다. 잠시 후 다시 확인해주세요' };
  try {
    snapshot = getTaxInvoiceWorkspace_([tid], { buyer: args.buyer }).items[0];
    if (snapshot.status === 'issued') {
      if (args.buyer && (args.buyer.corpNum !== snapshot.buyer.corpNum || args.buyer.email !== snapshot.buyer.email)) {
        return { success: false, code: 'INVOICE_CORRECTION_REQUIRED', error: '기존 계산서와 수신처가 다릅니다. 정정 발행 여부를 확인해주세요', item: snapshot };
      }
      // 다른 경로에서 발행된 기록을 오래된 화면의 승인으로 간주하지 않는다.
      return { success: false, alreadyIssued: true, code: 'INVOICE_ALREADY_ISSUED',
        error: '이미 발행된 기록이 있습니다. 원장을 다시 확인하고 업무 완료만 반영해주세요.', item: snapshot };
    }
    if (!snapshot.canIssue) return { success: false, error: snapshot.missing.join(' · '), item: snapshot };
    if (snapshot.fingerprint !== args.fingerprint) return { success: false, code: 'STALE_INVOICE', error: '발행 정보가 바뀌었습니다. 최신 정보를 다시 확인해주세요', item: snapshot };
    if (args.dryRun !== false) return { success: true, dryRun: true, item: snapshot };
    if (!/^[a-f0-9-]{16,80}$/i.test(token)) return { success: false, error: '발행 요청 식별자가 필요합니다' };
    PropertiesService.getScriptProperties().setProperty(invoiceWorkspaceGuardKey_(tid), JSON.stringify({ token: token, state: 'issuing', at: new Date().toISOString() }));
  } finally { lock.releaseLock(); }
  var b = snapshot.buyer, result;
  try {
    result = requestDirectTaxInvoice(tid, { amount: snapshot.amount, invoiceeCorpNum: b.corpNum,
      invoiceeCorpName: b.corpName, invoiceeCEOName: b.ceoName, invoiceeEmail: b.email,
      invoiceeAddr: b.addr, invoiceeBizType: b.bizType, invoiceeBizClass: b.bizClass,
      paymentMethod: snapshot.paymentMethod, depositStatus: snapshot.depositStatus,
      mutationId: token, invoiceWorkspaceToken: token }, {});
    var after = getTaxInvoiceWorkspace_([tid]).items[0];
    if (result && !result.error && (result.success === true || result.status === 'OK') && after.status === 'issued'
      && after.amount === snapshot.amount && after.buyer.corpNum === b.corpNum && after.buyer.email === b.email) {
      PropertiesService.getScriptProperties().deleteProperty(invoiceWorkspaceGuardKey_(tid));
      return { success: true, item: after, message: '세금계산서 발행과 원장 반영을 확인했습니다' };
    }
  } catch (error) { result = { error: error.message }; }
  PropertiesService.getScriptProperties().setProperty(invoiceWorkspaceGuardKey_(tid), JSON.stringify({ token: token, state: 'unknown', at: new Date().toISOString() }));
  return { success: false, code: 'INVOICE_OUTCOME_UNKNOWN', outcomeUnknown: true,
    error: '발행 결과 확인이 필요합니다. 중복 발행을 막기 위해 재발행을 보류했습니다.', detail: result && result.error || '' };
}
