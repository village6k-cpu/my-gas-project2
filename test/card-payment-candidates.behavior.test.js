const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function run(ledgerRows, contractRows, amount = 23100, tid) {
  const sheet = rows => ({
    getLastRow: () => rows.length + 1,
    getRange: (row, col, count, width) => {
      assert.equal(row, 2); assert.equal(col, 1); assert.equal(count, rows.length);
      assert.ok(width === 10 || width === 13);
      return { getValues: () => rows.map(r => r.slice(0, width)) };
    }
  });
  const context = vm.createContext({
    getVillageTradeSheet_: () => sheet(ledgerRows),
    SpreadsheetApp: { getActiveSpreadsheet: () => ({ getSheetByName: name => {
      assert.equal(name, '계약마스터'); // No schedule, equipment, global search, or cache.
      return sheet(contractRows);
    } }) },
    Utilities: { formatDate: (date, zone, format) => {
      assert.equal(zone, 'Asia/Seoul'); assert.equal(format, 'yyyy-MM-dd');
      return date.toISOString().slice(0, 10);
    } }
  });
  vm.runInContext(fs.readFileSync(require.resolve('../paymentMatching.js'), 'utf8'), context);
  return JSON.parse(JSON.stringify(context.getCardPaymentCandidates_(amount, tid)));
}
const ledger = (id, amount = 23100) => ['', '예약자', '', '', id, '연락처 비공개', '', '', amount, '', '', '', ''];
const contract = id => [id, '예약자', '연락처 비공개', '', '2026-10-10', '', '2026-10-11', '', 1, '반납완료'];

const result = run([ledger('A'), ledger('B', 23200)], [contract('A'), contract('B')]);
assert.deepEqual(result, { checkout: [{ tradeId: 'A', name: '예약자', actualAmount: 23100,
  paymentMethod: '', depositStatus: '', searchDate: '2026-10-10', returnDate: '2026-10-11', contractStatus: '반납완료' }], checkin: [] });
assert.equal(run([ledger('A')], [contract('A')], 23100, 'B').checkout.length, 0);
assert.throws(() => run([ledger('A'), ledger('A')], [contract('A')]), /중복/);
assert.throws(() => run([ledger('A')], [contract('A'), contract('A')]), /중복/);
assert.throws(() => run([], [], 0), /승인금액/);
assert.throws(() => run([], [], 1.5), /승인금액/);
assert.equal(run([ledger('A')], []).checkout.length, 0);
const many = Array.from({length: 160}, (_, i) => String(i));
assert.equal(run(many.map(id => ledger(id)), many.map(contract)).checkout.length, 160);
const paid = ledger('P'); paid[9] = '카드결제'; paid[12] = '입금완료';
const dated = contract('P'); dated[4] = new Date('2026-10-10T00:00:00Z');
assert.equal(run([paid], [dated]).checkout[0].depositStatus, '입금완료');
assert.equal(run([paid], [dated]).checkout[0].searchDate, '2026-10-10');
console.log('card payment candidates: 10 checks passed');
