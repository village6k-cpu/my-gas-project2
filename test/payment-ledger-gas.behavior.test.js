const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('./helpers/gas-storage-vm');
const fs = require('node:fs');
const path = require('node:path');

function harness(amount = 100, status = '미입금', duplicates = false, options = {}) {
  const row = ['', '고객', '', '입금자', '261020-001', '', '', '', amount,
    options.method || '', options.proof || '', options.issue || '', status];
  const contract = ['261020-001', '', '', '', '2026-10-20T10:00:00+09:00', '', '', '', '', '예약'];
  const props = {}, writes = [], dirty = [];
  const duplicateRow = ['', '중복', '', '', '260406-010', '', '', '', 50, '', '', '', '입금완료'];
  const rows = duplicates ? [row, duplicateRow, duplicateRow.slice()] : [row];
  const ledger = { getLastRow: () => rows.length + 1, getRange: (r, c, n = 1, width = 1) => ({
    getValues: () => rows.slice(r - 2, r - 2 + n).map(value => value.slice(c - 1, c - 1 + width)),
    getFormulas: () => Array.from({ length: n }, () => Array.from({ length: width }, (_, i) => options.formulas?.[c + i] || '')),
    getDataValidation: () => options.validation?.[c] ? { options: options.validation[c] } : null,
    setValue: value => { rows[r - 2][c - 1] = value; writes.push([r, c, value]); },
  }) };
  const context = vm.createContext({
    PropertiesService: { getScriptProperties: () => ({ getProperty: k => props[k], setProperty: (k, v) => { props[k] = v; } }) },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) },
    SpreadsheetApp: { getActiveSpreadsheet: () => ({ getSheetByName: () => ({ getLastRow: () => 2, getRange: () => ({ getValues: () => [contract] }) }) }) },
    getVillageTradeSheet_: () => ledger, cardPaymentDate_: value => value,
    paymentOptionsFromRule_: rule => rule?.options || [], supaMarkTradeDirty_: id => dirty.push(id),
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../paymentLedger.js'), 'utf8'), context);
  return { context, row, props, writes, dirty };
}
const projection = (overrides = {}) => ({ tradeId: '261020-001', billedAmount: 100, paidAmount: 40, balance: 60, credit: 0, status: '부분입금', revision: 2, reviewRequired: false, ...overrides });
const cardProjection = (overrides = {}) => projection({ method: '카드결제', paidAmount: 100, balance: 0, status: '입금완료', ...overrides });

test('confirmed card receipt fills K/L between payment method J and canonical payment status M', () => {
  const h = harness();
  const result = h.context.applyPaymentLedgerProjection_([cardProjection()]);
  assert.equal(result.applied.length, 1);
  assert.deepEqual(h.row.slice(9, 13), ['카드결제', '미발행', '발행완료', '입금완료']);
});

test('same-revision repair fills missing proof metadata even when J/M are already current', () => {
  const h = harness(100, '입금완료', false, { method: '카드결제' });
  h.props['PAYMENT_REV_261020-001'] = '2';
  h.context.applyPaymentLedgerProjection_([cardProjection()]);
  assert.deepEqual(h.writes, [[2, 11, '미발행'], [2, 12, '발행완료']]);
  assert.deepEqual(h.dirty, ['261020-001']);
  h.context.applyPaymentLedgerProjection_([cardProjection()]);
  assert.equal(h.writes.length, 2, 'retry must not repeat completed metadata writes');
  assert.equal(h.dirty.length, 1);
});

test('partial card payment fills receipt metadata without turning the balance into paid', () => {
  const h = harness();
  h.context.applyPaymentLedgerProjection_([cardProjection({ paidAmount: 40, balance: 60, status: '부분입금' })]);
  assert.deepEqual(h.row.slice(9, 13), ['카드결제', '미발행', '발행완료', '부분입금']);
});

test('card approval advances only the default unissued proof state', () => {
  const h = harness(100, '미입금', false, { method: '카드결제', proof: '미발행', issue: '미발행' });
  h.context.applyPaymentLedgerProjection_([cardProjection()]);
  assert.equal(h.row[11], '발행완료');
});

test('existing invoice instructions and formulas survive card receipt projection', () => {
  for (const options of [
    { proof: '세금계산서', issue: '발행요청' },
    { proof: '현금영수증', issue: '' },
    { proof: '', issue: '전송실패' },
    { proof: '', issue: '취소' },
    { proof: '', issue: '발행요청' },
    { proof: '', issue: '', formulas: { 11: '=IF(TRUE,"","")' } },
    { proof: '', issue: '', formulas: { 12: '=IF(TRUE,"","")' } },
  ]) {
    const h = harness(100, '미입금', false, { method: '카드결제', ...options });
    const before = h.row.slice(10, 12);
    h.context.applyPaymentLedgerProjection_([cardProjection()]);
    assert.deepEqual(h.row.slice(10, 12), before);
    assert.equal(h.writes.some(write => write[1] === 11 || write[1] === 12), false);
  }
});

test('card proof defaults require actual positive card receipts and compatible payment method', () => {
  for (const overrides of [{ method: null }, { method: '현금' }, { paidAmount: 0, status: '미입금' }]) {
    const h = harness();
    h.context.applyPaymentLedgerProjection_([cardProjection(overrides)]);
    assert.deepEqual(h.row.slice(10, 12), ['', '']);
  }
  const h = harness(100, '미입금', false, { method: '계좌이체(VAT포함)' });
  h.context.applyPaymentLedgerProjection_([cardProjection()]);
  assert.deepEqual(h.row.slice(9, 12), ['계좌이체(VAT포함)', '', '']);
});

test('proof dropdown mismatch rejects the projection before any sheet or revision write', () => {
  const h = harness(100, '미입금', false, { validation: { 12: ['발행요청'] } });
  const result = h.context.applyPaymentLedgerProjection_([cardProjection()]);
  assert.equal(result.rejected[0]?.reason, 'card_proof_validation');
  assert.deepEqual(h.writes, []);
  assert.deepEqual(h.props, {});
});
test('snapshot reads E/I/M and preserves blank amount as unknown', () => {
  const h = harness('');
  const account = h.context.getPaymentLedgerSnapshot_(['261020-001']).accounts[0];
  assert.equal(account.trade_id, '261020-001');
  assert.equal(account.billed_amount, null);
  assert.equal(account.customer_name, '고객');
  assert.equal(account.deposit_status, '미입금');
  assert.equal(h.writes.length, 0);
});
test('partial projection writes correct M row and is idempotent', () => {
  const h = harness();
  assert.equal(h.context.applyPaymentLedgerProjection_([projection()]).applied.length, 1);
  assert.deepEqual(h.writes, [[2, 13, '부분입금']]);
  assert.equal(h.context.applyPaymentLedgerProjection_([projection()]).applied.length, 1);
  assert.equal(h.writes.length, 1);
  assert.equal(h.dirty.length, 1);
});
test('changed onsite amount rejects obsolete projection without write', () => {
  const h = harness(200);
  assert.equal(h.context.applyPaymentLedgerProjection_([projection()]).rejected[0].reason, 'amount_changed');
  assert.equal(h.writes.length, 0);
});
test('late revision and uncertain opening balance cannot overwrite ledger', () => {
  const h = harness(); h.props['PAYMENT_REV_261020-001'] = '3';
  assert.equal(h.context.applyPaymentLedgerProjection_([projection()]).rejected[0].reason, 'stale_revision');
  assert.equal(h.context.applyPaymentLedgerProjection_([projection({ revision: 4, reviewRequired: true })]).rejected[0].reason, 'review_required');
  assert.equal(h.writes.length, 0);
});
test('historical duplicate quarantines only its account and does not block unrelated projection', () => {
  const h = harness(100, '미입금', true);
  const snapshot = h.context.getPaymentLedgerSnapshot_();
  assert.equal(snapshot.success, true);
  assert.equal(snapshot.accounts.length, 2);
  assert.equal(snapshot.accounts[0].billed_amount, 100);
  assert.equal(snapshot.accounts[1].billed_amount, null);
  assert.equal(snapshot.accounts[1].deposit_status, '거래ID 중복 확인필요');
  const result = h.context.applyPaymentLedgerProjection_([projection(), projection({ tradeId: '260406-010', billedAmount: 50 })]);
  assert.equal(result.applied.length, 1);
  assert.equal(result.rejected[0].reason, 'duplicate_trade_id');
  assert.deepEqual(h.writes, [[2, 13, '부분입금']]);
});
test('incomplete or impossible historical checkout dates stay unknown', () => {
  const { context } = harness();
  assert.equal(context.paymentLedgerDate_('2026'), null);
  assert.equal(context.paymentLedgerDate_('2026-02-30'), null);
  assert.equal(context.paymentLedgerDate_('2026-10-20T10:00:00+09:00'), '2026-10-20');
});
