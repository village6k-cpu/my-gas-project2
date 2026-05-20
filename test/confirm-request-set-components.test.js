const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'checkAvailability.js'), 'utf8');

class FakeRange {
  constructor(values) {
    this.values = values;
  }

  getValues() {
    return this.values;
  }
}

class FakeSetSheet {
  constructor(rows) {
    this.rows = rows;
  }

  getLastRow() {
    return this.rows.length;
  }

  getLastColumn() {
    return this.rows[0].length;
  }

  getRange(row, col, numRows, numCols) {
    const values = [];
    for (let r = 0; r < numRows; r++) {
      const out = [];
      for (let c = 0; c < numCols; c++) {
        out.push((this.rows[row - 1 + r] || [])[col - 1 + c] || '');
      }
      values.push(out);
    }
    return new FakeRange(values);
  }
}

const context = { console };
vm.runInNewContext(source, context);

const setSheet = new FakeSetSheet([
  ['세트명', '구성장비명', '수량', '비고', '대체가능장비', '가용체크'],
  ['셔틀러 에이스 CF M', '', 2, '', '', ''],
  ['셔틀러 에이스 CF M', '  ', 1, '', '', 'Y'],
  ['셔틀러 에이스 CF M', '셔틀러 에이스 CF M', 1, '', '', 'Y'],
  ['셔틀러 에이스 CF M', '헤드 / 플레이트', 1, '', '', 'N'],
  ['다른 세트', '다른 장비', 1, '', '', 'Y'],
]);

const components = context.getSetComponents('셔틀러 에이스 CF M', setSheet);
assert.strictEqual(
  JSON.stringify(components),
  JSON.stringify([{ name: '셔틀러 에이스 CF M', qty: 1, alt: '' }]),
  '세트마스터 B열이 빈 행은 구성품으로 펼치면 안 된다'
);

assert.match(
  source,
  /var componentName = String\(fCol\[ci\]\[0\] \|\| ""\)\.trim\(\);[\s\S]{0,140}if \(!componentName \|\| !currentSetNames\.has\(belongsTo\)\)/,
  '재확인 시 이미 생성된 빈 세트 구성품 행도 삭제해야 한다'
);

console.log('confirm request set component cleanup checks passed');
