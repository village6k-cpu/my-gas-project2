'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.resolve(__dirname, '..', 'checkAvailability.js'), 'utf8');
const start = source.indexOf('function _insertAndCheckRequest(');
const end = source.indexOf('\nfunction _assertConfirmRequestEditableRows_', start);
assert.ok(start >= 0 && end > start);

function row(reqID, equipment) {
  const value = Array(18).fill('');
  value[0] = reqID;
  value[1] = '2026-09-07';
  value[2] = '07:00';
  value[3] = '2026-09-07';
  value[4] = '19:00';
  value[5] = equipment;
  value[6] = 1;
  value[10] = '테스트 고객';
  value[11] = '010-1111-2222';
  value[12] = '일반';
  return value;
}

class Range {
  constructor(sheet, rowIndex, columnIndex, numRows, numColumns) {
    this.sheet = sheet;
    this.rowIndex = rowIndex;
    this.columnIndex = columnIndex;
    this.numRows = numRows;
    this.numColumns = numColumns;
  }
  selected() {
    return Array.from({ length: this.numRows }, (_, rowOffset) => {
      const sourceRow = this.sheet.rows[this.rowIndex + rowOffset] || Array(18).fill('');
      return sourceRow.slice(this.columnIndex, this.columnIndex + this.numColumns);
    });
  }
  getValues() { return structuredClone(this.selected()); }
  getDisplayValues() {
    return this.selected().map((values) => values.map((value) => String(value ?? '')));
  }
  getDisplayValue() { return String(this.selected()[0]?.[0] ?? ''); }
  setNumberFormat() { return this; }
  setDataValidation() { return this; }
  clearDataValidations() { return this; }
  setFontWeight() { return this; }
  setBackground() { return this; }
  setValue(value) { return this.setValues([[value]]); }
  setValues(values) {
    for (let r = 0; r < values.length; r += 1) {
      while (this.sheet.rows.length <= this.rowIndex + r) this.sheet.rows.push(Array(18).fill(''));
      for (let c = 0; c < values[r].length; c += 1) {
        this.sheet.rows[this.rowIndex + r][this.columnIndex + c] = values[r][c];
      }
    }
    return this;
  }
}

class Sheet {
  constructor(rows) { this.rows = rows; }
  getLastRow() { return this.rows.length + 1; }
  getRange(rowNumber, columnNumber, numRows = 1, numColumns = 1) {
    return new Range(this, rowNumber - 2, columnNumber - 1, numRows, numColumns);
  }
  deleteRow(rowNumber) { this.rows.splice(rowNumber - 2, 1); }
}

function harness({
  failProcess = false,
  failFlushAfterOldDelete = false,
  mutateOldDuringProcess = null,
  customerDbDiscount = '',
  sanitizeFreeText = (value) => String(value || '')
} = {}) {
  const sheet = new Sheet([row('RQ-old', '기존 장비')]);
  const listSheet = {
    getLastRow: () => 2,
    getRange: () => ({ getValues: () => [['새 장비']] })
  };
  const spreadsheet = {
    getSheetByName(name) {
      if (name === '확인요청') return sheet;
      if (name === '목록') return listSheet;
      return null;
    }
  };
  const deletions = [];
  const events = [];
  const exactComponentCalls = [];
  let oldCutoverAttempted = false;
  let cutoverFlushFailed = false;
  let fenceCalls = 0;
  const fence = {
    group: {
      reqID: 'RQ-old', rows: [2], name: '테스트 고객', phone: '010-1111-2222',
      discount: '일반', memo: '', extraRequest: ''
    },
    expectedBefore: [{ name: '기존 장비', quantity: 1 }],
    expectedSetComponents: [],
    expectedPeriod: {
      start_date: '2026-09-07', start_time: '07:00',
      end_date: '2026-09-07', end_time: '19:00'
    }
  };
  const context = {
    SpreadsheetApp: {
      getActiveSpreadsheet: () => spreadsheet,
      flush: () => {
        if (failFlushAfterOldDelete && oldCutoverAttempted && !cutoverFlushFailed) {
          cutoverFlushFailed = true;
          throw new Error('synthetic old cutover flush loss');
        }
      },
      newDataValidation: () => ({
        requireValueInRange() { return this; },
        setAllowInvalid() { return this; },
        setHelpText() { return this; },
        build() { return {}; }
      })
    },
    Utilities: { formatDate: () => '260907' },
    _normalizeConfirmRequestSchedule_: (request) => ({ ...request }),
    _resolveConfirmRequestPlannedEquipmentName_: (name) => String(name),
    _resolveStaffConfirmedPendingRequestFence_: () => {
      fenceCalls += 1;
      const oldIndex = sheet.rows.findIndex((value) => value[0] === 'RQ-old');
      if (oldIndex < 0) throw new Error('직원확정 대상 확인요청을 정확히 찾을 수 없습니다: RQ-old');
      const currentRow = sheet.rows[oldIndex];
      if (currentRow[5] !== '기존 장비') {
        throw new Error('직원확정 기대 장비 baseline plan이 현재 확인요청과 다릅니다: RQ-old');
      }
      return {
        ...fence,
        group: {
          ...fence.group,
          rows: [oldIndex + 2],
          name: String(currentRow[10] || ''), phone: String(currentRow[11] || ''),
          discount: String(currentRow[12] || ''), memo: String(currentRow[16] || ''),
          extraRequest: String(currentRow[17] || '')
        }
      };
    },
    _confirmRequestPhoneKey_: (value) => String(value || ''),
    _findConfirmRequestCustomerDbMatches_: (_ss, _name, phone) => customerDbDiscount
      ? [{ phone: String(phone || ''), phoneKey: String(phone || ''), discount: customerDbDiscount }]
      : [],
    _bestConfirmRequestCustomerDbDiscount_: () => customerDbDiscount,
    _resolveConfirmRequestDiscountOrBlank_: (value) => String(value || ''),
    _findRegisteredTradeForConfirmRequest_: () => null,
    _findDuplicateConfirmRequest_: () => null,
    _findCompletableConfirmRequestGroupsForInsert_: () => [],
    _reserveNextConfirmRequestId_: () => 'RQ-new',
    _selectAuthorizedConfirmRequestReplacementGroups_: () => [fence.group],
    _deleteConfirmRequestGroups_: (_sheet, groups) => {
      const ids = new Set(groups.map((group) => String(group.reqID)));
      if (ids.has('RQ-old')) oldCutoverAttempted = true;
      let count = 0;
      for (let index = sheet.rows.length - 1; index >= 0; index -= 1) {
        if (!ids.has(String(sheet.rows[index][0]))) continue;
        events.push(`delete:${String(sheet.rows[index][0])}`);
        deletions.push(String(sheet.rows[index][0]));
        sheet.rows.splice(index, 1);
        count += 1;
      }
      return count;
    },
    _sanitizeConfirmRequestFreeText_: sanitizeFreeText,
    _applyConfirmedReservationExactSetComponents_: (_sheet, requestId, components) => {
      events.push('exact-components');
      exactComponentCalls.push({ requestId, components: structuredClone(components) });
    },
    _processByReqID: () => {
      events.push('process');
      if (failProcess) throw new Error('synthetic availability failure');
      if (typeof mutateOldDuringProcess === 'function') mutateOldDuringProcess(sheet.rows);
    },
    console,
    isFinite
  };
  vm.runInNewContext(
    `${source.slice(start, end)}\nthis.insert = _insertAndCheckRequest;`,
    context
  );
  return { context, sheet, deletions, events, exactComponentCalls, getFenceCalls: () => fenceCalls };
}

function replacementRequest() {
  return {
    반출일: '2026-09-07', 반출시간: '07:00',
    반납일: '2026-09-07', 반납시간: '19:00',
    예약자명: '테스트 고객', 연락처: '010-1111-2222', 할인유형: '일반',
    장비: [{ 이름: '새 장비', 수량: 1 }], 비고: '', 추가요청: '',
    staff_confirmed_pending_mutation: {
      target_scope: 'pending_request', request_id: 'RQ-old',
      expected_before: [{ name: '기존 장비', quantity: 1 }],
      expected_set_components: [],
      expected_period: {
        start_date: '2026-09-07', start_time: '07:00',
        end_date: '2026-09-07', end_time: '19:00'
      }
    }
  };
}

test('staff-confirmed replacement keeps the old RQ when staged processing fails', () => {
  const { context, sheet, deletions } = harness({ failProcess: true });
  assert.throws(() => context.insert(replacementRequest()), /synthetic availability failure/);
  assert.deepEqual(sheet.rows.map((value) => value[0]), ['RQ-old']);
  assert.deepEqual(deletions, ['RQ-new'], 'only the staged replacement may be cleaned up');
});

test('staff-confirmed replacement deletes the old RQ only after staged process and readback', () => {
  const { context, sheet, deletions, events, getFenceCalls } = harness();
  const result = context.insert(replacementRequest());
  assert.equal(result.reqID, 'RQ-new');
  assert.deepEqual(sheet.rows.map((value) => value[0]), ['RQ-new']);
  assert.deepEqual(deletions, ['RQ-old']);
  assert.ok(events.indexOf('process') >= 0 && events.indexOf('delete:RQ-old') > events.indexOf('process'));
  assert.equal(getFenceCalls(), 2, 'the old RQ must be fenced again immediately before cutover');
});

test('ambiguous flush after old-RQ cutover never cleans the staged replacement too', () => {
  const { context, sheet, deletions } = harness({ failFlushAfterOldDelete: true });
  let caught;
  try { context.insert(replacementRequest()); } catch (error) { caught = error; }
  assert.match(String(caught?.message || ''), /synthetic old cutover flush loss/);
  assert.equal(caught?.effectiveRequestId, 'RQ-new');
  assert.deepEqual(JSON.parse(JSON.stringify(caught?.replacedReqIDs)), ['RQ-old']);
  assert.deepEqual(JSON.parse(JSON.stringify(caught?.appliedStages)), ['pending_request_replacement']);
  assert.deepEqual(
    sheet.rows.map((value) => value[0]),
    ['RQ-new'],
    'once old cutover was attempted, the staged RQ is the only recoverable copy and must remain'
  );
  assert.deepEqual(deletions, ['RQ-old']);
});

test('manual edits to the old RQ during staging abort cutover and preserve the latest sheet state', () => {
  const { context, sheet, deletions } = harness({
    mutateOldDuringProcess: (rows) => { rows.find((value) => value[0] === 'RQ-old')[5] = '사용자 수동 변경 장비'; }
  });
  assert.throws(() => context.insert(replacementRequest()), /baseline plan/i);
  assert.deepEqual(sheet.rows.map((value) => [value[0], value[5]]), [['RQ-old', '사용자 수동 변경 장비']]);
  assert.deepEqual(deletions, ['RQ-new']);
});

test('manual customer-term edits during staging abort cutover instead of overwriting the sheet', () => {
  const { context, sheet, deletions } = harness({
    mutateOldDuringProcess: (rows) => { rows.find((value) => value[0] === 'RQ-old')[16] = '사용자가 시트에서 수정한 메모'; }
  });
  assert.throws(() => context.insert(replacementRequest()), /customer terms|고객.*조건/i);
  assert.equal(sheet.rows.length, 1);
  assert.equal(sheet.rows[0][16], '사용자가 시트에서 수정한 메모');
  assert.deepEqual(deletions, ['RQ-new']);
});

test('replacement applies the complete authorized component projection before old-RQ cutover', () => {
  const desiredComponents = [{ set_item: '새 장비', component_item: '선택 구성품', quantity: 1 }];
  const { context, events, exactComponentCalls } = harness();
  const request = replacementRequest();
  request.staff_confirmed_exact_set_components = desiredComponents;
  context.insert(request);
  assert.deepEqual(exactComponentCalls, [{ requestId: 'RQ-new', components: desiredComponents }]);
  assert.ok(events.indexOf('exact-components') < events.indexOf('delete:RQ-old'));
});

test('confirmed bootstrap writes the exact authorized customer terms without DB fallback or truncation', () => {
  const memo = '고객 메모 '.repeat(35).trim();
  const extraRequest = '추가 요청 '.repeat(45).trim();
  const { context, sheet } = harness({
    customerDbDiscount: '단골',
    sanitizeFreeText: (value, maxLength) => String(value || '').slice(0, maxLength)
  });
  const request = replacementRequest();
  delete request.staff_confirmed_pending_mutation;
  request.staff_confirmed_registration_bootstrap = true;
  request['할인유형'] = '';
  request['비고'] = memo;
  request['추가요청'] = extraRequest;

  const result = context.insert(request);
  const inserted = sheet.rows.find((value) => value[0] === result.reqID);
  assert.ok(inserted);
  assert.equal(inserted[12], '', 'blank authorized discount must not be replaced by customer DB fallback');
  assert.equal(inserted[16], memo, 'authorized memo must be stored exactly');
  assert.equal(inserted[17], extraRequest, 'authorized extra request must be stored exactly');
});

test('multi-row old RQ deletion is one contiguous sheet mutation, never row-by-row', () => {
  const deleteStart = source.indexOf('function _deleteConfirmRequestGroups_(');
  const deleteEnd = source.indexOf('\nfunction _collectConfirmRequestResultsByReqID_', deleteStart);
  assert.ok(deleteStart >= 0 && deleteEnd > deleteStart);
  const context = {};
  vm.runInNewContext(
    `${source.slice(deleteStart, deleteEnd)}\nthis.removeGroups = _deleteConfirmRequestGroups_;`,
    context
  );
  const calls = [];
  const sheet = {
    getLastRow: () => 5,
    getRange: () => ({ getDisplayValues: () => [['RQ-old'], ['RQ-old'], ['RQ-new'], ['RQ-new']] }),
    deleteRows: (startRow, rowCount) => calls.push([startRow, rowCount])
  };

  assert.equal(context.removeGroups(sheet, [{ reqID: 'RQ-old' }]), 2);
  assert.deepEqual(calls, [[2, 2]]);
});

test('noncontiguous old RQ rows fail before any deletion', () => {
  const deleteStart = source.indexOf('function _deleteConfirmRequestGroups_(');
  const deleteEnd = source.indexOf('\nfunction _collectConfirmRequestResultsByReqID_', deleteStart);
  const context = {};
  vm.runInNewContext(
    `${source.slice(deleteStart, deleteEnd)}\nthis.removeGroups = _deleteConfirmRequestGroups_;`,
    context
  );
  const calls = [];
  const sheet = {
    getLastRow: () => 4,
    getRange: () => ({ getDisplayValues: () => [['RQ-old'], ['RQ-new'], ['RQ-old']] }),
    deleteRows: (...args) => calls.push(args)
  };

  assert.throws(() => context.removeGroups(sheet, [{ reqID: 'RQ-old' }]), /연속되지 않아/);
  assert.deepEqual(calls, []);
});
