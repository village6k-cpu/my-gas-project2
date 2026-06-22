const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const source = fs.readFileSync(path.resolve(__dirname, '..', 'checkAvailability.js'), 'utf8');
const start = source.indexOf('function _confirmRequestDateKey_');
const end = source.indexOf('function _collectConfirmRequestResultsByReqID_');
assert.ok(start > 0 && end > start, 'helper function block should be extractable');

const context = {
  Utilities: {
    formatDate(value) {
      if (value instanceof Date) return value.toISOString().slice(0, 10);
      return String(value || '');
    }
  },
  console,
  isFinite
};
vm.createContext(context);
vm.runInContext(source.slice(start, end), context);

class FakeRange {
  constructor(rows) {
    this.rows = rows;
  }
  getValues() {
    return this.rows;
  }
  getDisplayValues() {
    return this.rows.map((row) => row.map((value) => value === null || value === undefined ? '' : String(value)));
  }
}

class FakeSheet {
  constructor(rows) {
    this.rows = rows;
  }
  getLastRow() {
    return this.rows.length + 1;
  }
  getRange(row, col, numRows, numCols) {
    assert.equal(row, 2);
    assert.equal(col, 1);
    assert.equal(numCols, 18);
    return new FakeRange(this.rows.slice(0, numRows));
  }
}

function requestRow({ reqID, start = '2026-06-21', startTime = '21:00', end = '2026-06-22', endTime = '21:00', equip, qty = 1, name = '', phone = '', register = '', status = '', tradeId = '', memo = '' }) {
  const row = Array(18).fill('');
  row[0] = reqID;
  row[1] = start;
  row[2] = startTime;
  row[3] = end;
  row[4] = endTime;
  row[5] = equip;
  row[6] = qty;
  row[10] = name;
  row[11] = phone;
  row[13] = register;
  row[14] = status;
  row[15] = tradeId;
  row[16] = memo;
  return row;
}

const baseReq = {
  예약자명: '김재우',
  연락처: '010-6403-9315',
  반출일: '2026-06-21',
  반출시간: '21:00',
  반납일: '2026-06-22',
  반납시간: '21:00'
};

const staleSheet = new FakeSheet([
  requestRow({ reqID: 'RQ-old', equip: '어퓨처 600X', qty: 1, name: '김재우', phone: '010-6403-9315' }),
  requestRow({ reqID: 'RQ-old', equip: '소니 90mm 매크로', qty: 1 })
]);

assert.equal(
  context._findDuplicateConfirmRequest_(staleSheet, baseReq, [{ name: '소니 90mm 매크로', qty: 1 }]),
  null,
  '부분집합 장비는 중복이 아니라 stale 교체 대상이어야 한다'
);
assert.deepEqual(
  context._findReplaceableConfirmRequestGroups_(staleSheet, baseReq, [{ name: '소니 90mm 매크로', qty: 1 }]).map((group) => group.reqID),
  ['RQ-old'],
  '같은 고객/같은 일정의 장비 변경 후보는 삭제 대상으로 잡아야 한다'
);

assert.equal(
  context._findDuplicateConfirmRequest_(staleSheet, baseReq, [
    { name: '어퓨처 600X', qty: 1 },
    { name: '소니 90mm 매크로', qty: 1 }
  ]).reqID,
  'RQ-old',
  '최상위 장비와 수량이 완전히 같으면 기존 RQ를 중복으로 재사용해야 한다'
);

const registeredSheet = new FakeSheet([
  requestRow({ reqID: 'RQ-registered', equip: '어퓨처 600X', qty: 1, name: '김재우', phone: '010-6403-9315', register: '등록', status: '등록완료', tradeId: '260622-999' })
]);
assert.deepEqual(
  context._findReplaceableConfirmRequestGroups_(registeredSheet, baseReq, [{ name: '소니 90mm 매크로', qty: 1 }]),
  [],
  '거래ID/등록완료가 있는 RQ는 자동 삭제하면 안 된다'
);

console.log('confirm request stale replacement behavior checks passed');
