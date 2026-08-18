const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const source = fs.readFileSync(path.resolve(__dirname, '..', 'checkAvailability.js'), 'utf8');

function extractFunction(name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} must exist`);
  let depth = 0;
  let opened = false;
  for (let i = start; i < source.length; i += 1) {
    if (source[i] === '{') {
      depth += 1;
      opened = true;
    } else if (source[i] === '}') {
      depth -= 1;
      if (opened && depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`unterminated function: ${name}`);
}

class FakeRange {
  constructor(sheet, row, col, numRows = 1, numCols = 1) {
    this.sheet = sheet;
    this.row = row;
    this.col = col;
    this.numRows = numRows;
    this.numCols = numCols;
  }

  getValues() {
    return Array.from({ length: this.numRows }, (_, rowOffset) =>
      Array.from({ length: this.numCols }, (_, colOffset) =>
        this.sheet.cell(this.row + rowOffset, this.col + colOffset),
      ),
    );
  }

  getDisplayValues() {
    return this.getValues().map((row) => row.map((value) => String(value == null ? '' : value)));
  }

  setValue(value) {
    this.sheet.setCell(this.row, this.col, value);
    return this;
  }

  setValues(values) {
    values.forEach((rowValues, rowOffset) => {
      rowValues.forEach((value, colOffset) => {
        this.sheet.setCell(this.row + rowOffset, this.col + colOffset, value);
      });
    });
    return this;
  }

  setNumberFormat() {
    return this;
  }
}

class FakeSheet {
  constructor(rows) {
    this.rows = rows.map((row) => row.slice());
    this.writeCount = 0;
    this.insertCount = 0;
  }

  getLastRow() {
    return this.rows.length;
  }

  getRange(row, col, numRows, numCols) {
    return new FakeRange(this, row, col, numRows, numCols);
  }

  getMaxRows() {
    return this.rows.length;
  }

  insertRowsAfter(row, count) {
    this.rows.splice(row, 0, ...Array.from({ length: count }, () => []));
    this.insertCount += count;
  }

  cell(row, col) {
    return (this.rows[row - 1] || [])[col - 1] ?? '';
  }

  setCell(row, col, value) {
    while (this.rows.length < row) this.rows.push([]);
    while (this.rows[row - 1].length < col) this.rows[row - 1].push('');
    this.rows[row - 1][col - 1] = value;
    this.writeCount += 1;
  }
}

const context = {
  SpreadsheetApp: { flush() {} },
};
vm.createContext(context);
vm.runInContext(extractFunction('ensureTradeLedgerRowOnSheet_'), context);

function header() {
  return ['날짜', '예약자명', '계약서', '입금자명', '거래ID', '연락처', '발행처', '메모', '결제금액'];
}

const fields = {
  tradeId: '260630-014',
  startDate: '2026-07-02',
  customerName: '김명선',
  phone: '01094593491',
};

const dryRunSheet = new FakeSheet([header()]);
const dryRunResult = context.ensureTradeLedgerRowOnSheet_(dryRunSheet, fields, { dryRun: true });
assert.equal(dryRunResult.created, true, 'dry-run must report that the missing row would be created');
assert.equal(dryRunResult.dryRun, true);
assert.equal(dryRunSheet.writeCount, 0, 'dry-run must not write live ledger cells');
assert.equal(dryRunSheet.insertCount, 0, 'dry-run must not insert live ledger rows');

const createSheet = new FakeSheet([header()]);
const createResult = context.ensureTradeLedgerRowOnSheet_(createSheet, fields, { dryRun: false });
assert.equal(createResult.created, true);
assert.equal(createResult.row, 2);
assert.equal(createSheet.insertCount, 1, 'execute must grow a full ledger sheet only when needed');
assert.equal(createSheet.cell(2, 1), fields.startDate);
assert.equal(createSheet.cell(2, 2), fields.customerName);
assert.equal(createSheet.cell(2, 5), fields.tradeId);
assert.equal(createSheet.cell(2, 6), fields.phone);

const existingRow = ['2026-07-01', '잘못된이름', 'contract-link', '입금자', fields.tradeId, '000', '발행처', '메모', 123000];
const existingSheet = new FakeSheet([header(), existingRow]);
assert.throws(
  () => context.ensureTradeLedgerRowOnSheet_(existingSheet, fields, { dryRun: false, mustExist: true }),
  /identity conflict|정체 불일치/,
  'an existing trade ID owned by different ledger identity must fail closed'
);
assert.equal(existingSheet.getLastRow(), 2, 'existing trade ID must never append a second row');
assert.equal(existingSheet.cell(2, 1), '2026-07-01');
assert.equal(existingSheet.cell(2, 2), '잘못된이름');
assert.equal(existingSheet.cell(2, 5), fields.tradeId);
assert.equal(existingSheet.cell(2, 6), '000');
assert.equal(existingSheet.cell(2, 3), 'contract-link', 'repair must preserve contract URL');
assert.equal(existingSheet.cell(2, 4), '입금자', 'repair must preserve payer name');
assert.equal(existingSheet.cell(2, 9), 123000, 'repair must preserve payment amount');

const duplicateSheet = new FakeSheet([header(), existingRow, existingRow]);
assert.throws(
  () => context.ensureTradeLedgerRowOnSheet_(duplicateSheet, fields, { dryRun: false }),
  /중복/,
  'duplicate trade IDs must fail closed instead of choosing an arbitrary ledger row',
);

const exactRow = [fields.startDate, fields.customerName, 'contract-link', '입금자', fields.tradeId, fields.phone];
const exactSheet = new FakeSheet([header(), exactRow]);
const exactResult = context.ensureTradeLedgerRowOnSheet_(exactSheet, fields, { dryRun: true, mustExist: true });
assert.equal(exactResult.created, false);
assert.equal(exactSheet.writeCount, 0, 'mustExist verification must be read-only');

assert.throws(
  () => context.ensureTradeLedgerRowOnSheet_(new FakeSheet([header()]), fields, { dryRun: true, mustExist: true }),
  /missing|없음/,
  'mustExist must reject a missing authoritative ledger row'
);

console.log('trade-ledger-registration-repair.behavior.test.js OK');
