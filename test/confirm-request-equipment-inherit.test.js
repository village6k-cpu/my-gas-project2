const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'Code.js'), 'utf8');

class FakeRange {
  constructor(sheet, row, col, numRows = 1, numCols = 1) {
    this.sheet = sheet;
    this.row = row;
    this.col = col;
    this.numRows = numRows;
    this.numCols = numCols;
  }

  getValue() {
    return this.sheet.getCell(this.row, this.col);
  }

  setValue(value) {
    this.sheet.setCell(this.row, this.col, value);
    return this;
  }

  getValues() {
    const rows = [];
    for (let r = 0; r < this.numRows; r++) {
      const row = [];
      for (let c = 0; c < this.numCols; c++) {
        row.push(this.sheet.getCell(this.row + r, this.col + c));
      }
      rows.push(row);
    }
    return rows;
  }

  setValues(values) {
    for (let r = 0; r < this.numRows; r++) {
      for (let c = 0; c < this.numCols; c++) {
        this.sheet.setCell(this.row + r, this.col + c, values[r][c]);
      }
    }
    return this;
  }

  getNumberFormats() {
    return Array.from({ length: this.numRows }, () => Array(this.numCols).fill('@'));
  }

  setNumberFormats(formats) {
    this.sheet.lastNumberFormats = { row: this.row, col: this.col, formats };
    return this;
  }
}

class FakeSheet {
  constructor(rows) {
    this.rows = rows;
  }

  getRange(row, col, numRows, numCols) {
    return new FakeRange(this, row, col, numRows, numCols);
  }

  getCell(row, col) {
    return (this.rows[row - 1] && this.rows[row - 1][col - 1]) || '';
  }

  setCell(row, col, value) {
    while (this.rows.length < row) this.rows.push([]);
    while (this.rows[row - 1].length < col) this.rows[row - 1].push('');
    this.rows[row - 1][col - 1] = value;
  }
}

const context = { console };
vm.runInNewContext(source, context);

const makeRow = (values = {}) => {
  const row = Array(18).fill('');
  for (const [col, value] of Object.entries(values)) row[Number(col) - 1] = value;
  return row;
};

const sheet = new FakeSheet([
  makeRow(),
  makeRow({
    1: 'REQ-1779162038641',
    2: '2026. 5. 24',
    3: '10:00',
    4: '2026. 5. 26',
    5: '18:00',
    6: '기존 장비',
    11: '임주환',
    12: '010-0000-0000',
    13: '학생',
    14: '등록',
    15: '등록완료',
    16: '260524-001',
  }),
  makeRow({ 6: '새 장비' }),
  makeRow({ 1: 'MANUAL-ID', 3: '09:00', 6: '다른 장비' }),
]);

context.inheritConfirmRequestContextOnEquipmentEdit_(sheet, 3);
assert.deepStrictEqual(sheet.rows[2].slice(0, 5), [
  'REQ-1779162038641',
  '2026. 5. 24',
  '10:00',
  '2026. 5. 26',
  '18:00',
]);
assert.strictEqual(sheet.rows[2][5], '새 장비', 'F열 장비명은 유지해야 한다');
assert.deepStrictEqual(sheet.rows[2].slice(10, 13), ['임주환', '010-0000-0000', '학생']);
assert.strictEqual(sheet.rows[2][13], '', 'N열 실행 명령은 복사하면 안 된다');
assert.strictEqual(sheet.rows[2][14], '', 'O열 등록상태는 복사하면 안 된다');
assert.strictEqual(sheet.rows[2][15], '260524-001', 'P열 거래ID는 같은 계약 귀속을 위해 복사해야 한다');

context.inheritConfirmRequestContextOnEquipmentEdit_(sheet, 4);
assert.strictEqual(sheet.rows[3][0], 'MANUAL-ID', '이미 입력한 A열 값은 덮어쓰지 않는다');
assert.strictEqual(sheet.rows[3][2], '09:00', '이미 입력한 C열 값은 덮어쓰지 않는다');
assert.strictEqual(sheet.rows[3][1], '2026. 5. 24', '비어 있는 예약 문맥만 채운다');

assert.match(
  source,
  /if \(col === 6 && row >= 3 && e\.range\.getValue\(\)\) \{[\s\S]{0,120}inheritConfirmRequestContextOnEquipmentEdit_\(sheet,\s*row\);/,
  'F열 장비명 입력 onEdit 경로에서 문맥 상속 함수를 호출해야 한다'
);

assert.doesNotMatch(
  source,
  /prevReqID[\s\S]{0,160}startsWith\(["']RQ-["']\)/,
  '확인요청 F열 상속은 바로 위 행 RQ- 접두사에만 묶이면 안 된다'
);

console.log('confirm request equipment inheritance checks passed');
