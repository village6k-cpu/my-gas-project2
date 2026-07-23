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
  getDisplayValues() {
    return this.values.map((row) => row.map((value) => String(value ?? '')));
  }
}

class FakeSheet {
  constructor(rows) {
    this.rows = rows;
  }
  getLastRow() {
    return this.rows.length;
  }
  getRange(row, col, numRows, numCols) {
    const values = [];
    for (let r = 0; r < numRows; r++) {
      const out = [];
      for (let c = 0; c < numCols; c++) out.push((this.rows[row - 1 + r] || [])[col - 1 + c] || '');
      values.push(out);
    }
    return new FakeRange(values);
  }
}

const makeRow = (values = {}) => {
  const row = Array(18).fill('');
  for (const [col, value] of Object.entries(values)) row[Number(col) - 1] = value;
  return row;
};

const context = { console };
vm.runInNewContext(source, context);

const req = {
  예약자명: '전찬영',
  연락처: '010-6317-4066',
  반출일: '2026-06-23',
  반출시간: '11:00',
  반납일: '2026-06-23',
  반납시간: '17:00'
};

const exactSheet = new FakeSheet([
  makeRow(),
  makeRow({ 1: 'RQ-1', 2: '2026-06-23', 3: '11:00', 4: '2026-06-23', 5: '17:00', 6: '소니 A7S3 바디세트', 7: 2, 11: '전찬영', 12: '010-6317-4066' }),
  makeRow({ 1: 'RQ-1', 6: '소니 CF-A 160', 7: 2, 17: '[세트]소니 A7S3 바디세트' }),
  makeRow({ 1: 'RQ-1', 6: '셔틀러에이스 M (75볼)', 7: 3 }),
]);
let duplicate = context._findDuplicateConfirmRequest_(exactSheet, req, [
  { name: '셔틀러에이스 M (75볼)', qty: 3 },
  { name: '소니 A7S3 바디세트', qty: 2 },
]);
assert.strictEqual(duplicate.reqID, 'RQ-1', 'exact top-level signature should reuse existing request');
let staleGroups = context._findReplaceableConfirmRequestGroups_(exactSheet, req, [
  { name: '셔틀러에이스 M (75볼)', qty: 3 },
  { name: '소니 A7S3 바디세트', qty: 2 },
]);
assert.strictEqual(staleGroups.length, 0);

const staleSheet = new FakeSheet([
  makeRow(),
  makeRow({ 1: 'RQ-OLD', 2: '2026-06-23', 3: '11:00', 4: '2026-06-23', 5: '17:00', 6: '셔틀러에이스 M (75볼)', 7: 1, 11: '전찬영', 12: '010-6317-4066' }),
]);
duplicate = context._findDuplicateConfirmRequest_(staleSheet, req, [
  { name: '소니 A7S3 바디세트', qty: 2 },
  { name: '셔틀러에이스 M (75볼)', qty: 3 },
  { name: 'DJI 마이크 미니2', qty: 1 },
  { name: '소니 GM 70-200mm II', qty: 2 },
]);
staleGroups = context._findReplaceableConfirmRequestGroups_(staleSheet, req, [
  { name: '소니 A7S3 바디세트', qty: 2 },
  { name: '셔틀러에이스 M (75볼)', qty: 3 },
  { name: 'DJI 마이크 미니2', qty: 1 },
  { name: '소니 GM 70-200mm II', qty: 2 },
]);
assert.strictEqual(duplicate, null, 'different top-level signature is not a duplicate');
assert.strictEqual(staleGroups.length, 1, 'unfinalized same customer/time request should be replaced');
assert.strictEqual(staleGroups[0].reqID, 'RQ-OLD');

const finalizedSheet = new FakeSheet([
  makeRow(),
  makeRow({ 1: 'RQ-FINAL', 2: '2026-06-23', 3: '11:00', 4: '2026-06-23', 5: '17:00', 6: '셔틀러에이스 M (75볼)', 7: 1, 11: '전찬영', 12: '010-6317-4066', 16: '260623-001' }),
]);
duplicate = context._findDuplicateConfirmRequest_(finalizedSheet, req, [
  { name: '소니 A7S3 바디세트', qty: 2 },
  { name: '셔틀러에이스 M (75볼)', qty: 3 },
]);
staleGroups = context._findReplaceableConfirmRequestGroups_(finalizedSheet, req, [
  { name: '소니 A7S3 바디세트', qty: 2 },
  { name: '셔틀러에이스 M (75볼)', qty: 3 },
]);
assert.strictEqual(duplicate, null);
assert.strictEqual(staleGroups.length, 0, 'finalized/trade-ID rows must not be auto-deleted');

const contactBlockedSheet = new FakeSheet([
  makeRow(),
  makeRow({ 1: 'RQ-NO-PHONE', 2: '2026-06-23', 3: '11:00', 4: '2026-06-23', 5: '17:00', 6: '셔틀러에이스 M (75볼)', 7: 1, 11: '전찬영', 15: '❌ 연락처 입력 필요' }),
]);
duplicate = context._findDuplicateConfirmRequest_(contactBlockedSheet, req, [
  { name: '소니 A7S3 바디세트', qty: 2 },
  { name: '셔틀러에이스 M (75볼)', qty: 3 },
]);
staleGroups = context._findReplaceableConfirmRequestGroups_(contactBlockedSheet, req, [
  { name: '소니 A7S3 바디세트', qty: 2 },
  { name: '셔틀러에이스 M (75볼)', qty: 3 },
]);
assert.strictEqual(duplicate, null);
assert.strictEqual(staleGroups.length, 1, 'contact-blocked rows are not finalized and should be replaced after phone is resolved');
assert.strictEqual(staleGroups[0].reqID, 'RQ-NO-PHONE');

const aliasPhoneSheet = new FakeSheet([
  makeRow(),
  makeRow({ 1: 'RQ-ALIAS', 2: '2026-06-23', 3: '11:00', 4: '2026-06-23', 5: '17:00', 6: '셔틀러에이스 M (75볼)', 7: 3, 11: '카카오닉네임', 12: '010-6317-4066' }),
]);
duplicate = context._findDuplicateConfirmRequest_(aliasPhoneSheet, req, [
  { name: '셔틀러에이스 M (75볼)', qty: 3 },
]);
assert.strictEqual(duplicate.reqID, 'RQ-ALIAS', 'same phone must dedupe even when Kakao nickname and reservation name differ');

class FakeSpreadsheet {
  constructor(sheets) {
    this.sheets = sheets;
  }
  getSheetByName(name) {
    return this.sheets[name] || null;
  }
}

const registeredSs = new FakeSpreadsheet({
  '계약마스터': new FakeSheet([
    makeRow(),
    makeRow({ 1: '260624-008', 2: '김찬위', 3: '010-9240-0661', 10: '예약' }),
  ]),
  '스케줄상세': new FakeSheet([
    makeRow(),
    makeRow({ 2: '260624-008', 4: '파보튜브 II 30XR', 6: '2026-06-25' }),
    makeRow({ 2: '260624-008', 4: 'H&Y VND-CPL 67-82mm 가변 ND', 6: '2026-06-25' }),
    makeRow({ 2: '260624-008', 4: '하만카돈', 6: '2026-06-25' }),
    makeRow({ 2: '260624-008', 4: '충전기', 6: '2026-06-25' }),
  ]),
});
assert.strictEqual(
  context.checkDuplicateRequest(
    registeredSs,
    '카카오닉네임',
    '2026-06-25',
    ['파보튜브 II 30XR', 'H&Y VND-CPL 67-82mm 가변 ND', '하만카돈'],
    '01092400661'
  ),
  '260624-008',
  'registered schedule duplicate must be blocked by phone even when name labels differ'
);
assert.strictEqual(
  context.checkDuplicateRequest(
    registeredSs,
    '김찬위',
    '2026-06-25',
    ['파보튜브 II 30XR', 'H&Y VND-CPL 67-82mm 가변 ND', '하만카돈'],
    '010-0000-0000'
  ),
  null,
  'same name with explicitly different phone should not block 동명이인'
);

assert.match(source, /요청ID는 stale 삭제 전에 스캔해서 번호를 재사용하지 않는다/, 'stale replacement must preserve sequential RQ IDs before deletion');

console.log('confirm request stale replacement behavior checks passed');
