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
    this.writeCount = 0;
  }
  getLastRow() {
    return this.rows.length + 1;
  }
  getRange(row, col, numRows, numCols) {
    assert.equal(row, 2);
    assert.equal(col, 1);
    assert.ok(numCols === 1 || numCols === 18);
    const rows = this.rows.slice(0, numRows);
    return new FakeRange(numCols === 1 ? rows.map((item) => [item[0]]) : rows);
  }
  deleteRows(row, count) {
    this.writeCount += 1;
    this.rows.splice(row - 2, count);
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
  '레거시 진단 헬퍼는 같은 고객/일정의 변경 후보를 식별할 수 있다'
);

assert.deepEqual(
  context._selectAuthorizedConfirmRequestReplacementGroups_(null),
  [],
  '직원확정 fence가 없으면 식별된 stale 후보도 자동 삭제 권한이 없어야 한다'
);
const exactFenceGroup = { reqID: 'RQ-old', rows: [2, 3] };
assert.deepEqual(
  context._selectAuthorizedConfirmRequestReplacementGroups_({ group: exactFenceGroup }),
  [exactFenceGroup],
  '직원확정 fence가 가리키는 exact RQ만 교체 권한을 가져야 한다'
);

assert.equal(
  context._findDuplicateConfirmRequest_(staleSheet, baseReq, [
    { name: '어퓨처 600X', qty: 1 },
    { name: '소니 90mm 매크로', qty: 1 }
  ]).reqID,
  'RQ-old',
  '최상위 장비와 수량이 완전히 같으면 기존 RQ를 중복으로 재사용해야 한다'
);

const partialSheet = new FakeSheet([
  requestRow({
    reqID: 'RQ-partial', start: '2026-09-07', startTime: '08:00', end: '', endTime: '',
    equip: '소니 A7S3 바디세트', qty: 1, name: '김성윤', phone: '010-6323-3116'
  })
]);
const completeInquiry = {
  예약자명: '김성윤', 연락처: '010-6323-3116',
  반출일: '2026-09-07', 반출시간: '08:00', 반납일: '2026-09-08', 반납시간: '08:00'
};
assert.equal(
  context._findDuplicateConfirmRequest_(partialSheet, completeInquiry, [{ name: '소니 A7S3 바디세트', qty: 1 }]),
  null,
  'a completed inquiry must not leave an exact partial duplicate unchanged'
);
assert.deepEqual(
  context._findCompletableConfirmRequestGroups_(partialSheet, completeInquiry, [{ name: '소니 A7S3 바디세트', qty: 1 }])
    .map((group) => group.reqID),
  ['RQ-partial'],
  'one compatible partial inquiry must be selected for in-place schedule completion'
);
assert.deepEqual(
  context._findCompletableConfirmRequestGroupsForInsert_(
    partialSheet,
    completeInquiry,
    [{ name: '소니 A7S3 바디세트', qty: 1 }],
    { group: { reqID: 'RQ-exact-authorized-target' } }
  ),
  [],
  'an exact staff-confirmed replacement must never complete or mutate a different partial RQ'
);

const registeredSheet = new FakeSheet([
  requestRow({ reqID: 'RQ-registered', equip: '어퓨처 600X', qty: 1, name: '김재우', phone: '010-6403-9315', register: '등록', status: '등록완료', tradeId: '260622-999' })
]);
assert.deepEqual(
  context._findReplaceableConfirmRequestGroups_(registeredSheet, baseReq, [{ name: '소니 90mm 매크로', qty: 1 }]),
  [],
  '거래ID/등록완료가 있는 RQ는 자동 삭제하면 안 된다'
);

function pendingFence({ requestId = 'RQ-260824-008', expectedBefore, expectedSetComponents, expectedPeriod } = {}) {
  return {
    target_scope: 'pending_request',
    request_id: requestId,
    expected_before: expectedBefore || [{ name: '소니 FE 28-135mm', quantity: 1 }],
    expected_set_components: expectedSetComponents || [],
    expected_period: expectedPeriod || {
      start_date: '2026-08-27', start_time: '06:00',
      end_date: '2026-08-27', end_time: '18:00'
    }
  };
}

const setComponentSheet = new FakeSheet([
  requestRow({
    reqID: 'RQ-260824-008', start: '2026-08-27', startTime: '06:00', end: '2026-08-27', endTime: '18:00',
    equip: '소니 FX3 바디세트', qty: 1, name: '테스트 고객', phone: '010-1111-2222'
  }),
  requestRow({
    reqID: 'RQ-260824-008', start: '', startTime: '', end: '', endTime: '',
    equip: '소니 FX3 바디(케이지)', qty: 1, memo: '[세트]소니 FX3 바디세트'
  })
]);
const exactSetFence = pendingFence({
  expectedBefore: [{ name: '소니 FX3 바디세트', quantity: 1 }],
  expectedSetComponents: [{
    set_item: '소니 FX3 바디세트', component_item: '소니 FX3 바디(케이지)', quantity: 1
  }]
});
assert.equal(
  context._resolveStaffConfirmedPendingRequestFence_(setComponentSheet, exactSetFence).group.reqID,
  'RQ-260824-008'
);
assert.throws(
  () => context._resolveStaffConfirmedPendingRequestFence_(setComponentSheet, {
    ...exactSetFence,
    expected_set_components: [{
      set_item: '소니 FX3 바디세트', component_item: '다른 구성품', quantity: 1
    }]
  }),
  /구성품|component/i,
  'same top-level set and period must not hide a stale component baseline'
);

function exactTargetMissingPeriod(component) {
  const period = {
    start: '2026-08-27', startTime: '06:00', end: '2026-08-27', endTime: '18:00'
  };
  period[component] = '';
  return new FakeSheet([requestRow({
    reqID: 'RQ-260824-008', ...period,
    equip: '소니 FE 28-135mm', qty: 1, name: '테스트 고객', phone: '010-1111-2222'
  })]);
}

const dateChangeSheet = new FakeSheet([
  requestRow({
    reqID: 'RQ-260824-008', start: '2026-08-27', startTime: '06:00', end: '2026-08-27', endTime: '18:00',
    equip: '소니 FE 28-135mm', qty: 1, name: '테스트 고객', phone: '010-1111-2222'
  }),
  requestRow({
    reqID: 'RQ-260824-009', start: '2026-08-28', startTime: '07:00', end: '2026-08-28', endTime: '19:00',
    equip: '형제 RQ 장비', qty: 1, name: '테스트 고객', phone: '010-1111-2222'
  })
]);
const exactDateChange = context._resolveStaffConfirmedPendingRequestFence_(dateChangeSheet, pendingFence());
assert.equal(exactDateChange.group.reqID, 'RQ-260824-008', '날짜 변경이어도 typed request ID의 기존 RQ를 선택해야 한다');
assert.equal(context._deleteConfirmRequestGroups_(dateChangeSheet, [exactDateChange.group]), 1);
assert.equal(dateChangeSheet.writeCount, 1);
assert.deepEqual(dateChangeSheet.rows.map((row) => row[0]), ['RQ-260824-009'], '날짜가 같은 다른 RQ가 아니라 exact target만 삭제해야 한다');

const siblingSheet = new FakeSheet([
  requestRow({
    reqID: 'RQ-260824-008', start: '2026-08-27', startTime: '06:00', end: '2026-08-27', endTime: '18:00',
    equip: '소니 FE 28-135mm', qty: 1, name: '테스트 고객', phone: '010-1111-2222'
  }),
  requestRow({
    reqID: 'RQ-260824-010', start: '2026-08-27', startTime: '06:00', end: '2026-08-27', endTime: '18:00',
    equip: '소니 GM 70-200mm II', qty: 1, name: '테스트 고객', phone: '010-1111-2222'
  })
]);
const exactSiblingTarget = context._resolveStaffConfirmedPendingRequestFence_(siblingSheet, pendingFence());
assert.equal(exactSiblingTarget.group.reqID, 'RQ-260824-008');
assert.deepEqual(exactSiblingTarget.group.rows, [2], '같은 고객/기간의 sibling RQ는 exact target 그룹에 포함되면 안 된다');

for (const blocked of [
  {
    label: 'stale expected plan',
    sheet: siblingSheet,
    fence: pendingFence({ expectedBefore: [{ name: '다른 장비', quantity: 1 }] }),
    pattern: /기대.*장비|baseline.*plan/i
  },
  {
    label: 'stale expected period',
    sheet: siblingSheet,
    fence: pendingFence({ expectedPeriod: { start_date: '2026-08-26', start_time: '06:00', end_date: '2026-08-26', end_time: '18:00' } }),
    pattern: /기대.*기간|baseline.*period/i
  },
  {
    label: 'missing target',
    sheet: siblingSheet,
    fence: pendingFence({ requestId: 'RQ-260824-999' }),
    pattern: /찾을 수 없|missing/i
  },
  {
    label: 'missing request id',
    sheet: siblingSheet,
    fence: { ...pendingFence(), request_id: '' },
    pattern: /요청ID|request.id/i
  },
  {
    label: 'nonmutable target',
    sheet: new FakeSheet([requestRow({
      reqID: 'RQ-260824-008', start: '2026-08-27', startTime: '06:00', end: '2026-08-27', endTime: '18:00',
      equip: '소니 FE 28-135mm', qty: 1, name: '테스트 고객', phone: '010-1111-2222', status: '보류'
    })]),
    fence: pendingFence(),
    pattern: /수정할 수 없|mutable/i
  },
  ...[
    ['missing start date', 'start'],
    ['missing start time', 'startTime'],
    ['missing end date', 'end'],
    ['missing end time', 'endTime']
  ].map(([label, component]) => ({
    label,
    sheet: exactTargetMissingPeriod(component),
    fence: pendingFence(),
    pattern: /기대.*기간|baseline.*period/i
  }))
]) {
  const writesBefore = blocked.sheet.writeCount;
  assert.throws(
    () => context._resolveStaffConfirmedPendingRequestFence_(blocked.sheet, blocked.fence),
    blocked.pattern,
    blocked.label
  );
  assert.equal(blocked.sheet.writeCount, writesBefore, `${blocked.label} must cause zero writes`);
}

assert.equal(context._deleteConfirmRequestGroups_(siblingSheet, [exactSiblingTarget.group]), 1);
assert.deepEqual(
  siblingSheet.rows.map((row) => row[0]),
  ['RQ-260824-010'],
  '같은 고객/기간의 sibling RQ는 exact target 교체 후에도 그대로 남아야 한다'
);

const shiftedSheet = new FakeSheet([
  requestRow({
    reqID: 'RQ-260824-008', start: '2026-08-27', startTime: '06:00', end: '2026-08-27', endTime: '18:00',
    equip: '기존 장비', qty: 1, name: '테스트 고객', phone: '010-1111-2222'
  }),
  requestRow({
    reqID: 'RQ-sibling', start: '2026-08-27', startTime: '06:00', end: '2026-08-27', endTime: '18:00',
    equip: '형제 장비', qty: 1, name: '다른 고객', phone: '010-3333-4444'
  })
]);
const staleRowNumberGroup = context._buildConfirmRequestGroups_(shiftedSheet)[0];
shiftedSheet.rows.unshift(requestRow({
  reqID: 'RQ-staged', start: '2026-08-28', startTime: '07:00', end: '2026-08-28', endTime: '19:00',
  equip: '새 장비', qty: 1, name: '테스트 고객', phone: '010-1111-2222'
}));
assert.equal(context._deleteConfirmRequestGroups_(shiftedSheet, [staleRowNumberGroup]), 1);
assert.deepEqual(
  shiftedSheet.rows.map((row) => row[0]),
  ['RQ-staged', 'RQ-sibling'],
  'replacement deletion must rescan exact request IDs after staging shifts row numbers'
);

console.log('confirm request stale replacement behavior checks passed');
