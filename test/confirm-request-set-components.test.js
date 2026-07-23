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

assert.strictEqual(
  context._isCompositeSetAccessoryManifest_('패널 / 발라스터 / 연장라인 / AC라인 / 프레임대'),
  true,
  '여러 동봉 부속품을 한 셀에 적은 구성 문자열은 개별 재고 장비로 오인하면 안 된다'
);
assert.strictEqual(
  context._isCompositeSetAccessoryManifest_('루버 / 실크1 / 실크2'),
  true,
  '짧은 조명 동봉품 목록도 정보성 구성으로 인식해야 한다'
);
assert.strictEqual(
  context._isCompositeSetAccessoryManifest_('18-35 / 50-100'),
  false,
  '실제 렌즈 두 종처럼 재고 확인이 필요한 짧은 숫자 목록은 자동으로 동봉품 처리하면 안 된다'
);

const equipmentSheet = new FakeSetSheet([
  ['분류', '장비ID', '카테고리', '장비명', '총보유수량', '가용수량', '대여중수량', '정비중수량', '상태', '비고', '최근 실사', '단가'],
  ['조명', 'LGT-007', '조명', '어퓨쳐 아마란 F21C', 3, 3, 0, 0, '정상', '', 3, 20000],
  ['조명', 'LGT-008', '조명', '어퓨쳐 아마란 F22C', 2, 2, 0, 0, '정상', '', 2, 35000],
]);
assert.deepStrictEqual(
  JSON.parse(JSON.stringify(context.findEquipmentForSetHeader_('아마란 F21C', equipmentSheet))),
  { name: '어퓨쳐 아마란 F21C', total: 3, 단가: 20000 },
  '세트명과 장비마스터명이 제조사 접두어만 달라도 유일한 본체를 찾아야 한다'
);

assert.match(
  source,
  /var componentName = String\(fCol\[ci\]\[0\] \|\| ""\)\.trim\(\);[\s\S]{0,140}if \(!componentName \|\| !currentSetNames\.has\(belongsTo\)\)/,
  '재확인 시 이미 생성된 빈 세트 구성품 행도 삭제해야 한다'
);

assert.match(
  source,
  /if \(_isSetAccessoryManifestRow_\(sheet, row, 장비명\)\) \{[\s\S]{0,220}기본구성[\s\S]{0,220}return;[\s\S]{0,300}미등록 장비/,
  '세트 동봉품은 미등록 장비 판정보다 먼저 정보행으로 처리해야 한다'
);

console.log('confirm request set component cleanup checks passed');
