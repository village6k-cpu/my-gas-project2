const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

function harness(amount = 100, status = '미입금') {
  const row = ['', '고객', '', '입금자', '261020-001', '', '', '', amount, '', '', '', status];
  const contract = ['261020-001', '', '', '', '2026-10-20T10:00:00+09:00', '', '', '', '', '예약'];
  const props = {}, writes = [], dirty = [];
  const ledger = { getLastRow: () => 2, getRange: (r, c, n) => n ? { getValues: () => [row.slice()] } : {
    getDataValidation: () => null,
    setValue: value => { row[c - 1] = value; writes.push([r, c, value]); },
  } };
  const context = vm.createContext({
    PropertiesService: { getScriptProperties: () => ({ getProperty: k => props[k], setProperty: (k, v) => { props[k] = v; } }) },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) },
    SpreadsheetApp: { getActiveSpreadsheet: () => ({ getSheetByName: () => ({ getLastRow: () => 2, getRange: () => ({ getValues: () => [contract] }) }) }) },
    getVillageTradeSheet_: () => ledger, cardPaymentDate_: value => value,
    paymentOptionsFromRule_: () => [], supaMarkTradeDirty_: id => dirty.push(id),
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../paymentLedger.js'), 'utf8'), context);
  return { context, row, props, writes, dirty };
}
const projection = (overrides = {}) => ({ tradeId: '261020-001', billedAmount: 100, paidAmount: 40, balance: 60, credit: 0, status: '부분입금', revision: 2, reviewRequired: false, ...overrides });
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
