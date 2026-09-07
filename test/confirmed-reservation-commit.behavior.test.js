'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const gas = fs.readFileSync(path.resolve(__dirname, '..', 'checkAvailability.js'), 'utf8');
const api = fs.readFileSync(path.resolve(__dirname, '..', 'sheetAPI.js'), 'utf8');

test('GAS exposes a typed exact-fenced confirmed registration operation instead of a generic 등록 action', () => {
  assert.match(gas, /function\s+commitConfirmedReservation\s*\(/);
  assert.match(gas, /_normalizeConfirmedReservationCommit_/);
  assert.match(gas, /_resolveStaffConfirmedPendingRequestFence_/);
  assert.match(gas, /confirmedReservationFence/);
  assert.match(gas, /readRegisteredTradeCorrectionState_/);
  assert.match(gas, /customerNotificationSent/);
  assert.match(api, /"commitConfirmedReservation"/);
  assert.match(api, /funcName\s*===\s*"commitConfirmedReservation"/);
});

test('registration revalidates the exact desired plan and all four period fields inside registerByReqID lock', () => {
  const start = gas.indexOf('function registerByReqID(');
  const end = gas.indexOf('\nfunction perfLog_', start);
  assert.ok(start >= 0 && end > start);
  const body = gas.slice(start, end);
  assert.match(body, /registerOptions\.confirmedReservationFence/);
  assert.match(body, /_resolveStaffConfirmedPendingRequestFence_/);
  assert.match(body, /expected_before/);
  assert.match(body, /expected_period/);
  assert.ok(
    body.indexOf('_resolveStaffConfirmedPendingRequestFence_') < body.indexOf('_processByReqID'),
    'the exact pending baseline must be checked before availability processing or registration writes'
  );
  const processIndex = body.indexOf('_processByReqID(sheet, triggerRow)');
  const postProcessFenceIndex = body.indexOf('_resolveStaffConfirmedPendingRequestFence_', processIndex);
  const businessGuardIndex = body.indexOf('requestHasDirectRegisterApproval_', processIndex);
  assert.ok(
    processIndex >= 0 && postProcessFenceIndex > processIndex && businessGuardIndex > postProcessFenceIndex,
    'availability processing must be followed by the same exact fence before any registration business path'
  );
});

test('automatic confirmed registration suppresses customer notification without changing the manual default', () => {
  const commitStart = gas.indexOf('function commitConfirmedReservation(');
  const commitEnd = gas.indexOf('\nfunction registerByReqID(', commitStart);
  const registerEnd = gas.indexOf('\nfunction perfLog_', commitEnd);
  assert.ok(commitStart >= 0 && commitEnd > commitStart && registerEnd > commitEnd);

  const commitBody = gas.slice(commitStart, commitEnd);
  const registerBody = gas.slice(commitEnd, registerEnd);
  assert.match(commitBody, /suppressCustomerNotification:\s*true/);
  assert.match(registerBody, /registerOptions\.suppressCustomerNotification\s*===\s*true/);
  assert.match(registerBody, /if\s*\(\s*!suppressCustomerNotification\s*\)\s*\{[\s\S]*?_postRegisterAlimtalk\s*=\s*\{/);
  assert.match(registerBody, /customerNotificationAttempted:\s*!suppressCustomerNotification/);
});

test('confirmed registration cannot be implemented as a Korean approval keyword router', () => {
  const start = gas.indexOf('function _normalizeConfirmedReservationCommit_');
  const end = gas.indexOf('\nfunction registerByReqID(', start);
  assert.ok(start >= 0 && end > start);
  const body = gas.slice(start, end);
  assert.doesNotMatch(body, /가능합니다|네네|진행할게요|추가해드릴게요/);
  assert.doesNotMatch(body, /staff_confirmation\s*\.\s*match|staff_confirmation\s*\.\s*includes/);
});

test('fast registration reuses a pending RQ only for one exact customer and exact commercial metadata', () => {
  const start = gas.indexOf('function _isMutableConfirmRequestGroup_(');
  const end = gas.indexOf('\nfunction _normalizeStaffConfirmedPendingPlan_(', start);
  assert.ok(start >= 0 && end > start);
  const context = {
    _staffConfirmedSetComponentsEquivalent_: (left, right) => {
      const signature = (rows) => rows
        .map((row) => [row.set_item, row.component_item, Number(row.quantity)].join('\u0001'))
        .sort()
        .join('\u0002');
      return signature(left) === signature(right);
    }
  };
  vm.runInNewContext(
    `${gas.slice(start, end)}\nthis.canReuse = _canReuseConfirmedRegistrationBootstrap_;`,
    context
  );
  const group = {
    name: '테스트 고객', phone: '01011112222', discount: '일반', memo: '', extraRequest: '',
    setComponentItems: [{ set_item: '소니 FX3 바디세트', component_item: '소니 FX3 바디(케이지)', quantity: 1 }],
    registerActions: [], statuses: [], tradeIds: []
  };
  const expected = {
    name: '테스트 고객', phone: '01011112222', discount: '일반', memo: '', extraRequest: '',
    setComponents: [{ set_item: '소니 FX3 바디세트', component_item: '소니 FX3 바디(케이지)', quantity: 1 }]
  };

  assert.equal(context.canReuse(group, expected), true);
  for (const mismatch of [
    { phone: '' },
    { phone: '01099998888' },
    { discount: '학생' },
    { memo: '수동 수정' },
    { extraRequest: '저녁 반납' },
    { setComponents: [] },
    { setComponents: [
      ...expected.setComponents,
      { set_item: '소니 FX3 바디세트', component_item: '추가 구성품', quantity: 1 }
    ] },
    { setComponents: [{ set_item: '소니 FX3 바디세트', component_item: '다른 구성품', quantity: 1 }] },
    { setComponents: [{ set_item: '소니 FX3 바디세트', component_item: '소니 FX3 바디(케이지)', quantity: 2 }] },
    { setSelections: [{ set_item: '소니 FX3 바디세트', component_item: '메모리', selected_item: 'CFexpress' }] }
  ]) {
    assert.equal(context.canReuse(group, { ...expected, ...mismatch }), false);
  }
  assert.equal(context.canReuse({ ...group, statuses: ['등록완료'] }, expected), false);
  assert.equal(context.canReuse({ ...group, tradeIds: ['260907-001'] }, expected), false);
});

test('bootstrap canonical component projection expands quantities and applies one exact selection', () => {
  const start = gas.indexOf('function _normalizeStaffConfirmedPendingPlan_(');
  const end = gas.indexOf('\nfunction _normalizeStaffConfirmedPendingPeriod_(', start);
  assert.ok(start >= 0 && end > start);
  const context = {
    getSetComponents: (setName) => {
      if (setName === '카메라 세트') return [{ name: '바디', qty: 1 }, { name: '배터리', qty: 2 }];
      if (setName === '새 조명 세트') return [{ name: '기본 전구', qty: 1 }];
      return [];
    }
  };
  vm.runInNewContext(
    `${gas.slice(start, end)}\nthis.expand = _confirmedRegistrationBootstrapSetComponents_;`
      + '\nthis.project = _projectStaffConfirmedSetComponents_;'
      + '\nthis.projectDesired = _projectStaffConfirmedDesiredSetComponents_;',
    context
  );

  const baseline = JSON.parse(JSON.stringify(context.expand([
    { name: '카메라 세트', qty: 2 }, { name: '단품', qty: 1 }
  ], {})));
  assert.deepEqual(baseline, [
    { set_item: '카메라 세트', component_item: '바디', quantity: 2 },
    { set_item: '카메라 세트', component_item: '배터리', quantity: 4 }
  ]);
  assert.deepEqual(JSON.parse(JSON.stringify(context.project(baseline, [{
    set_item: '카메라 세트', component_item: '배터리', selected_item: 'V마운트 배터리'
  }]))), [
    { set_item: '카메라 세트', component_item: '바디', quantity: 2 },
    { set_item: '카메라 세트', component_item: 'V마운트 배터리', quantity: 4 }
  ]);

  const desired = JSON.parse(JSON.stringify(context.projectDesired(
    [{ name: '카메라 세트', quantity: 1 }],
    [
      { set_item: '카메라 세트', component_item: '수동 선택 바디', quantity: 1 },
      { set_item: '카메라 세트', component_item: '수동 선택 배터리', quantity: 2 }
    ],
    [
      { name: '카메라 세트', quantity: 2 },
      { name: '새 조명 세트', quantity: 1 }
    ],
    {},
    [{ set_item: '새 조명 세트', component_item: '기본 전구', selected_item: '선택 전구' }]
  )));
  assert.deepEqual(desired, [
    { set_item: '카메라 세트', component_item: '수동 선택 바디', quantity: 2 },
    { set_item: '카메라 세트', component_item: '수동 선택 배터리', quantity: 4 },
    { set_item: '새 조명 세트', component_item: '선택 전구', quantity: 1 }
  ], 'unchanged sets keep exact manual component choices while new sets use current SetMaster projection');
});

function productionCommitContext(overrides = {}) {
  const bootstrapStart = gas.indexOf('function _confirmedReservationBootstrapRequest_(');
  const bootstrapEnd = gas.indexOf('\nfunction _confirmedReservationPlanForFence_(', bootstrapStart);
  const start = gas.indexOf('function commitConfirmedReservation(');
  const end = gas.indexOf('\nfunction registerByReqID(', start);
  assert.ok(bootstrapStart >= 0 && bootstrapEnd > bootstrapStart && start > bootstrapEnd && end > start);
  const scriptLock = {
    held: false, acquisitions: 0, releases: 0,
    tryLock() { this.held = true; this.acquisitions += 1; return true; },
    releaseLock() { assert.equal(this.held, true); this.held = false; this.releases += 1; }
  };
  const userLock = {
    held: false, acquisitions: 0, releases: 0,
    waitLock() { this.held = true; this.acquisitions += 1; },
    releaseLock() { assert.equal(this.held, true); this.held = false; this.releases += 1; }
  };
  const capability = {};
  const normalized = {
    confirmed: true, target_scope: 'pending_request', request_id: 'RQ-260907-001',
    source_evidence: { customer_request: 'request', staff_confirmation: 'confirmation', conversation_revision: 3 },
    expected_before: [{ name: '기존 장비', quantity: 1 }],
    expected_set_components: [],
    set_component_selections: [],
    expected_period: {
      start_date: '2026-09-07', start_time: '07:00', end_date: '2026-09-07', end_time: '19:00'
    },
    desired_after: [{ name: '교체 장비', quantity: 1 }],
    desired_period: {
      start_date: '2026-09-07', start_time: '07:00', end_date: '2026-09-07', end_time: '19:00'
    }
  };
  const sheet = {};
  const context = {
    LockService: { getScriptLock: () => scriptLock, getUserLock: () => userLock },
    SpreadsheetApp: { getActiveSpreadsheet: () => ({ getSheetByName: (name) => name === '확인요청' ? sheet : {} }) },
    CONFIRMED_RESERVATION_LOCK_CAPABILITY_: capability,
    _normalizeConfirmedReservationCommit_: () => structuredClone(normalized),
    _assertConfirmedReservationCatalogPlan_: () => {},
    _resolveStaffConfirmedPendingRequestFence_: () => ({
      group: { reqID: 'RQ-260907-001', rows: [2], setComponentItems: [] },
      expectedSetComponents: []
    }),
    _projectStaffConfirmedSetComponents_: (baseline, selections) => {
      const projected = structuredClone(baseline || []);
      for (const selection of selections || []) {
        const target = projected.find((row) => row.set_item === selection.set_item
          && row.component_item === selection.component_item);
        if (target) target.component_item = selection.selected_item;
      }
      return projected;
    },
    _projectStaffConfirmedDesiredSetComponents_: (_expectedPlan, baseline, _desiredPlan, _setSheet, selections) => {
      const projected = structuredClone(baseline || []);
      for (const selection of selections || []) {
        const target = projected.find((row) => row.set_item === selection.set_item
          && row.component_item === selection.component_item);
        if (target) target.component_item = selection.selected_item;
      }
      return projected;
    },
    _staffConfirmedSetComponentsEquivalent_: (left, right) => JSON.stringify(left) === JSON.stringify(right),
    _confirmedReservationPlanEquivalent_: () => false,
    _confirmedReservationPeriodEquivalent_: () => true,
    _confirmedReservationRegisteredMatchRequest_: () => ({ 예약자명: '테스트 고객' }),
    _findRegisteredTradesForConfirmRequest_: () => [],
    _buildConfirmRequestGroups_: () => [{ reqID: 'RQ-260907-002', rows: [2], setComponentItems: [] }],
    _confirmedReservationReplacementRequest_: () => ({ typed: true }),
    _insertAndCheckRequest: () => ({
      reqID: 'RQ-260907-002', replacedReqIDs: ['RQ-260907-001'], finalSetComponents: []
    }),
    registerByReqID: () => ({ success: true }),
    _confirmedReservationResult_: () => ({ schema: 'village-confirmed-reservation-commit-result/v1', success: true, status: 'ok' }),
    ...overrides
  };
  vm.runInNewContext(
    `${gas.slice(bootstrapStart, bootstrapEnd)}\n${gas.slice(start, end)}\nthis.commitConfirmedReservation = commitConfirmedReservation;`,
    context
  );
  return { context, normalized, sheet, scriptLock, userLock, capability };
}

function productionNormalizeContext() {
  const helperStart = gas.indexOf('function _normalizeStaffConfirmedPendingPlan_(');
  const helperEnd = gas.indexOf('/**\n * typed pending mutation', helperStart);
  const normalizeStart = gas.indexOf('function _normalizeConfirmedReservationCommit_(');
  const normalizeEnd = gas.indexOf('\nfunction _confirmedReservationPlanForFence_', normalizeStart);
  assert.ok(helperStart >= 0 && helperEnd > helperStart);
  assert.ok(normalizeStart >= 0 && normalizeEnd > normalizeStart);
  const context = {};
  vm.runInNewContext(
    `${gas.slice(helperStart, helperEnd)}\n${gas.slice(normalizeStart, normalizeEnd)}\n`
      + 'this.normalize = _normalizeConfirmedReservationCommit_;',
    context
  );
  return context;
}

function confirmedRegistrationFixture(evidenceOverrides = {}) {
  const period = {
    start_date: '2026-09-07', start_time: '07:00',
    end_date: '2026-09-07', end_time: '19:00'
  };
  const plan = [{ name: '소니 FX3 바디세트', quantity: 1 }];
  return {
    confirmed: true,
    target_scope: 'pending_request',
    request_id: 'RQ-260907-001',
    source_evidence: {
      customer_request: '고객의 실제 요청',
      staff_confirmation: '직원의 실제 승인 답변',
      conversation_revision: 3,
      conversation_evidence_hash: 'b'.repeat(64),
      customer_message_ids: ['customer-message-1'],
      staff_message_ids: ['staff-message-2'],
      ...evidenceOverrides
    },
    expected_before: plan,
    expected_set_components: [{
      set_item: '소니 FX3 바디세트', component_item: '소니 FX3 바디(케이지)', quantity: 1
    }],
    set_component_selections: [],
    expected_period: period,
    desired_after: plan,
    desired_period: period
  };
}

function pendingRequestCandidateFixture(overrides = {}) {
  return {
    customer_name: '테스트 고객',
    phone: '010-1111-2222',
    discount_type: '일반',
    memo: '',
    extra_request: '',
    ...overrides
  };
}

test('GAS preserves the exact DOM-bound authorization evidence instead of accepting the legacy three-field proof', () => {
  const context = productionNormalizeContext();
  const normalized = context.normalize(confirmedRegistrationFixture());
  assert.equal(normalized.source_evidence.conversation_evidence_hash, 'b'.repeat(64));
  assert.deepEqual(
    Array.from(normalized.source_evidence.customer_message_ids),
    ['customer-message-1']
  );
  assert.deepEqual(
    Array.from(normalized.source_evidence.staff_message_ids),
    ['staff-message-2']
  );

  for (const invalid of [
    { conversation_evidence_hash: 'B'.repeat(64) },
    { customer_message_ids: [] },
    { staff_message_ids: ['staff message with spaces'] },
    { customer_message_ids: ['same-id'], staff_message_ids: ['same-id'] }
  ]) {
    assert.throws(() => context.normalize(confirmedRegistrationFixture(invalid)), /source_evidence/i);
  }

  const minutePeriod = confirmedRegistrationFixture();
  minutePeriod.expected_period = { ...minutePeriod.expected_period, start_time: '07:30' };
  assert.throws(() => context.normalize(minutePeriod), /period|HH:00|시간/i);
});

test('fast staff authorization may atomically bootstrap the missing confirmation request but never invent an RQ id', () => {
  const context = productionNormalizeContext();
  const fastRegistration = confirmedRegistrationFixture();
  fastRegistration.request_id = null;
  fastRegistration.expected_set_components = [];
  fastRegistration.set_component_selections = [{
    set_item: '소니 FX3 바디세트', component_item: '메모리', selected_item: 'CFexpress Type A 160GB'
  }];
  fastRegistration.pending_request_candidate = pendingRequestCandidateFixture();

  const normalized = context.normalize(fastRegistration);
  assert.equal(normalized.request_id, null);
  assert.deepEqual(
    JSON.parse(JSON.stringify(normalized.pending_request_candidate)),
    fastRegistration.pending_request_candidate
  );

  const missingCandidate = confirmedRegistrationFixture();
  missingCandidate.request_id = null;
  assert.throws(() => context.normalize(missingCandidate), /pending_request_candidate|request_id/i);

  const ambiguousTarget = confirmedRegistrationFixture();
  ambiguousTarget.pending_request_candidate = pendingRequestCandidateFixture();
  assert.throws(() => context.normalize(ambiguousTarget), /pending_request_candidate|request_id/i);

  for (const invalidCandidate of [
    pendingRequestCandidateFixture({ phone: '' }),
    pendingRequestCandidateFixture({ discount_type: '' })
  ]) {
    const unsafeIdentity = structuredClone(fastRegistration);
    unsafeIdentity.pending_request_candidate = invalidCandidate;
    assert.throws(
      () => context.normalize(unsafeIdentity),
      /pending_request_candidate/i,
      'automatic bootstrap needs an exact phone and explicit commercial classification'
    );
  }

  const replacementWithNewSet = confirmedRegistrationFixture();
  replacementWithNewSet.desired_after = [
    ...replacementWithNewSet.desired_after,
    { name: '새 조명 세트', quantity: 1 }
  ];
  replacementWithNewSet.set_component_selections = [{
    set_item: '새 조명 세트', component_item: '기본 전구', selected_item: '선택 전구'
  }];
  assert.doesNotThrow(
    () => context.normalize(replacementWithNewSet),
    'an exact selection for a newly authorized set is validated against its desired SetMaster projection'
  );
});

test('atomic fast registration applies one exact set choice and rechecks before registration', () => {
  const start = gas.indexOf('function _applyConfirmedReservationSetSelections_(');
  const end = gas.indexOf('\nfunction _confirmedReservationPlanForFence_(', start);
  assert.ok(start >= 0 && end > start);
  const requestRows = [
    ['RQ-260907-009', '', '', '', '', '소니 FX3 바디세트', '1', '', '세트', '', '', '', '', '', '', '', ''],
    ['RQ-260907-009', '', '', '', '', '메모리', '1', '확인', '⚠️ 모델 선택 필요', '후보', '', '', '', '', '', '', '[세트]소니 FX3 바디세트']
  ];
  const processCalls = [];
  let flushes = 0;
  const listSheet = {
    getLastRow: () => 2,
    getRange: () => ({ getDisplayValues: () => [['CFexpress Type A 160GB']] })
  };
  const spreadsheet = { getSheetByName: (name) => name === '목록' ? listSheet : null };
  const sheet = {
    getParent: () => spreadsheet,
    getLastRow: () => requestRows.length + 1,
    getRange(row, column, numRows = 1, numColumns = 1) {
      const selected = requestRows.slice(row - 2, row - 2 + numRows)
        .map((source) => source.slice(column - 1, column - 1 + numColumns));
      return {
        getDisplayValues: () => structuredClone(selected),
        getDisplayValue: () => String(requestRows[row - 2][column - 1] || ''),
        setValue(value) { requestRows[row - 2][column - 1] = value; return this; },
        clearContent() {
          for (let r = row - 2; r < row - 2 + numRows; r += 1) {
            for (let c = column - 1; c < column - 1 + numColumns; c += 1) requestRows[r][c] = '';
          }
          return this;
        }
      };
    }
  };
  const context = {
    SpreadsheetApp: { getActiveSpreadsheet: () => spreadsheet, flush: () => { flushes += 1; } },
    _processByReqID: (_sheet, row) => processCalls.push(row)
  };
  vm.runInNewContext(
    `${gas.slice(start, end)}\nthis.applySelections = _applyConfirmedReservationSetSelections_;`,
    context
  );
  const selection = [{
    set_item: '소니 FX3 바디세트', component_item: '메모리', selected_item: 'CFexpress Type A 160GB'
  }];
  const result = context.applySelections(sheet, 'RQ-260907-009', selection);
  assert.deepEqual(JSON.parse(JSON.stringify(result)), { applied: 1 });
  assert.equal(requestRows[1][5], 'CFexpress Type A 160GB');
  assert.equal(requestRows[1][7], '확인');
  assert.equal(requestRows[1][8], '');
  assert.equal(requestRows[1][9], '');
  assert.deepEqual(processCalls, [2]);
  assert.equal(flushes, 2);

  requestRows.push(structuredClone(requestRows[1]));
  requestRows[1][5] = '메모리';
  requestRows[2][5] = '메모리';
  assert.throws(
    () => context.applySelections(sheet, 'RQ-260907-009', selection),
    /exactly one expanded component/i
  );
  assert.equal(requestRows[1][5], '메모리', 'ambiguous targets must be rejected before any write');
  assert.equal(requestRows[2][5], '메모리', 'ambiguous targets must be rejected before any write');
});

test('replacement stages the complete desired set projection and preserves existing manual component choices', () => {
  const start = gas.indexOf('function _applyConfirmedReservationSetSelections_(');
  const end = gas.indexOf('\nfunction _confirmedReservationPlanForFence_(', start);
  assert.ok(start >= 0 && end > start);
  const requestRows = [
    ['RQ-260907-010', '', '', '', '', '카메라 세트', '2', '', '세트', '', '', '', '', '', '', '', ''],
    ['RQ-260907-010', '', '', '', '', '기본 바디', '2', '확인', '', '', '', '', '', '', '', '', '[세트]카메라 세트'],
    ['RQ-260907-010', '', '', '', '', '기본 배터리', '4', '확인', '', '', '', '', '', '', '', '', '[세트]카메라 세트'],
    ['RQ-260907-010', '', '', '', '', '새 조명 세트', '1', '', '세트', '', '', '', '', '', '', '', ''],
    ['RQ-260907-010', '', '', '', '', '기본 전구', '1', '확인', '', '', '', '', '', '', '', '', '[세트]새 조명 세트']
  ];
  const processCalls = [];
  const catalog = ['수동 선택 바디', '수동 선택 배터리', '선택 전구'];
  const listSheet = {
    getLastRow: () => catalog.length + 1,
    getRange: () => ({ getDisplayValues: () => catalog.map((name) => [name]) })
  };
  const spreadsheet = { getSheetByName: (name) => name === '목록' ? listSheet : null };
  const sheet = {
    getParent: () => spreadsheet,
    getLastRow: () => requestRows.length + 1,
    getRange(row, column, numRows = 1, numColumns = 1) {
      const selected = requestRows.slice(row - 2, row - 2 + numRows)
        .map((source) => source.slice(column - 1, column - 1 + numColumns));
      return {
        getDisplayValues: () => structuredClone(selected),
        setValue(value) { requestRows[row - 2][column - 1] = value; return this; },
        clearContent() {
          for (let r = row - 2; r < row - 2 + numRows; r += 1) {
            for (let c = column - 1; c < column - 1 + numColumns; c += 1) requestRows[r][c] = '';
          }
          return this;
        }
      };
    }
  };
  const context = {
    SpreadsheetApp: { flush: () => {} },
    _normalizeStaffConfirmedSetComponents_: (rows) => structuredClone(rows),
    _staffConfirmedSetComponentsEquivalent_: (left, right) => {
      const signature = (rows) => rows.map((value) => JSON.stringify(value)).sort().join('|');
      return signature(left) === signature(right);
    },
    _processByReqID: (_sheet, row) => processCalls.push(row)
  };
  vm.runInNewContext(
    `${gas.slice(start, end)}\nthis.applyExact = _applyConfirmedReservationExactSetComponents_;`,
    context
  );
  const desired = [
    { set_item: '카메라 세트', component_item: '수동 선택 바디', quantity: 2 },
    { set_item: '카메라 세트', component_item: '수동 선택 배터리', quantity: 4 },
    { set_item: '새 조명 세트', component_item: '선택 전구', quantity: 1 }
  ];
  const result = context.applyExact(sheet, 'RQ-260907-010', desired);
  assert.deepEqual(JSON.parse(JSON.stringify(result.finalSetComponents)), desired);
  assert.deepEqual(requestRows.slice(1, 3).map((row) => row[5]), ['수동 선택 바디', '수동 선택 배터리']);
  assert.equal(requestRows[4][5], '선택 전구');
  assert.deepEqual(processCalls, [2]);
});

test('fast registration authoritative readback proves the selected set component reached the registered schedule', () => {
  const start = gas.indexOf('function _confirmedReservationResult_(');
  const end = gas.indexOf('\n// JSON/HTTP로 위조할 수 없는', start);
  assert.ok(start >= 0 && end > start);
  const period = {
    start_date: '2026-09-07', start_time: '07:00',
    end_date: '2026-09-07', end_time: '20:00'
  };
  const normalized = {
    request_id: null,
    expected_set_components: [],
    set_component_selections: [{
      set_item: '소니 FX3 바디세트', component_item: '메모리', selected_item: 'CFexpress Type A 160GB'
    }],
    pending_request_candidate: pendingRequestCandidateFixture(),
    desired_after: [
      { name: '소니 FX3 바디세트', quantity: 1 },
      { name: '소니 GM 70-200mm II', quantity: 1 }
    ],
    desired_period: period
  };
  const state = {
    contract: {
      startDate: period.start_date, startTime: period.start_time,
      endDate: period.end_date, endTime: period.end_time
    },
    schedule: {
      periods: ['2026-09-07|07:00|2026-09-07|20:00'],
      topLevelQuantities: { '소니 FX3 바디세트': 1, '소니 GM 70-200mm II': 1 },
      rows: [{
        scheduleId: '260907-009-02', setName: '소니 FX3 바디세트',
        name: 'CFexpress Type A 160GB', qty: 1, isComponent: true
      }]
    },
    ledger: { rows: 1, startDate: '2026-09-07' }
  };
  const group = {
    reqID: 'RQ-260907-009', rows: [9], statuses: ['등록완료'],
    registerActions: ['등록'], tradeIds: ['260907-009'],
    name: '테스트 고객', phone: '01011112222', discount: '일반', memo: '', extraRequest: '',
    setComponentItems: [{
      set_item: '소니 FX3 바디세트', component_item: 'CFexpress Type A 160GB', quantity: 1
    }]
  };
  const context = {
    SpreadsheetApp: { getActiveSpreadsheet: () => ({ getSheetByName: () => ({}) }) },
    _buildConfirmRequestGroups_: () => [group],
    isRegisterCompletedStatus_: (value) => value === '등록완료',
    readRegisteredTradeCorrectionState_: () => structuredClone(state),
    _registeredTradeTopLevelQuantitySignature_: (value) => JSON.stringify(
      Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
    ),
    _confirmRequestPhoneKey_: (value) => String(value || '').replace(/\D/g, ''),
    _staffConfirmedSetComponentsEquivalent_: (left, right) => JSON.stringify(left) === JSON.stringify(right),
    _confirmedReservationPlanForFence_: (value) => structuredClone(value),
    _confirmedReservationPeriodForFence_: (value) => structuredClone(value)
  };
  vm.runInNewContext(
    `${gas.slice(start, end)}\nthis.readback = _confirmedReservationResult_;`,
    context
  );

  const exactFinalComponents = [{
    set_item: '소니 FX3 바디세트', component_item: 'CFexpress Type A 160GB', quantity: 1
  }];
  const result = context.readback(normalized, 'RQ-260907-009', [], {
    customerNotificationAttempted: false,
    customerNotificationSent: false
  }, exactFinalComponents);
  assert.equal(result.success, true);
  assert.equal(result.effective_request_id, 'RQ-260907-009');

  group.extraRequest = '시트에서 달라진 추가요청';
  assert.throws(
    () => context.readback(normalized, 'RQ-260907-009', [], {
      customerNotificationAttempted: false,
      customerNotificationSent: false
    }, exactFinalComponents),
    /authoritative readback mismatch/i
  );
  group.extraRequest = '';

  state.schedule.rows[0].name = '다른 메모리';
  assert.throws(
    () => context.readback(normalized, 'RQ-260907-009', [], {
      customerNotificationAttempted: false,
      customerNotificationSent: false
    }, exactFinalComponents),
    /authoritative readback mismatch/i
  );
});

test('fast staff authorization creates or reuses one RQ and registers it inside the same locks', () => {
  const harness = productionCommitContext();
  harness.normalized.request_id = null;
  harness.normalized.expected_set_components = [];
  harness.normalized.set_component_selections = [{
    set_item: '교체 장비', component_item: '기본 구성품', selected_item: '선택 구성품'
  }];
  harness.normalized.pending_request_candidate = pendingRequestCandidateFixture();
  const calls = [];
  let requestCreated = false;

  harness.context._insertAndCheckRequest = (request) => {
    calls.push('bootstrap_request');
    assert.equal(harness.scriptLock.held, true);
    assert.equal(harness.userLock.held, true);
    assert.deepEqual(JSON.parse(JSON.stringify(request)), {
      '반출일': '2026-09-07', '반출시간': '07:00',
      '반납일': '2026-09-07', '반납시간': '19:00',
      '장비': [{ '이름': '교체 장비', '수량': 1 }],
      '예약자명': '테스트 고객', '연락처': '010-1111-2222',
      '할인유형': '일반', '비고': '', '추가요청': '',
      '장비명원문보존': true,
      staff_confirmed_registration_bootstrap: true,
      staff_confirmed_set_component_selections: [{
        set_item: '교체 장비', component_item: '기본 구성품', selected_item: '선택 구성품'
      }]
    });
    requestCreated = true;
    return { reqID: 'RQ-260907-009', duplicate: false, replacedReqIDs: [] };
  };
  harness.context._applyConfirmedReservationSetSelections_ = (_sheet, reqID, selections) => {
    calls.push('set_component_selections');
    assert.equal(harness.scriptLock.held, true);
    assert.equal(harness.userLock.held, true);
    assert.equal(reqID, 'RQ-260907-009');
    assert.deepEqual(JSON.parse(JSON.stringify(selections)), [
      { set_item: '교체 장비', component_item: '기본 구성품', selected_item: '선택 구성품' }
    ]);
  };
  harness.context._resolveStaffConfirmedPendingRequestFence_ = (_sheet, fence) => {
    calls.push('exact_rq_fence');
    assert.equal(requestCreated, true, 'the customer inquiry RQ must exist before registration fencing');
    assert.equal(fence.request_id, 'RQ-260907-009');
    assert.deepEqual(JSON.parse(JSON.stringify(fence.expected_before)), [{ name: '교체 장비', quantity: 1 }]);
    return { group: { reqID: 'RQ-260907-009', rows: [9], setComponentItems: [] }, expectedSetComponents: [] };
  };
  harness.context._findRegisteredTradesForConfirmRequest_ = () => {
    calls.push('registered_guard');
    return [];
  };
  harness.context._buildConfirmRequestGroups_ = () => [{
    reqID: 'RQ-260907-009', rows: [9], setComponentItems: [
      { set_item: '교체 장비', component_item: '선택 구성품', quantity: 1 }
    ]
  }];
  harness.context.registerByReqID = (_sheet, row, options) => {
    calls.push('register');
    assert.equal(row, 9);
    assert.equal(options.confirmedReservationFence.request_id, 'RQ-260907-009');
    assert.equal(options.confirmedReservationOperationId, '11111111-2222-4333-8444-555555555555');
    assert.equal(options.preAcquiredScriptLock, harness.scriptLock);
    harness.scriptLock.releaseLock();
    return { success: true };
  };
  harness.context._confirmedReservationResult_ = (normalized, effectiveRequestId) => ({
    schema: 'village-confirmed-reservation-commit-result/v1', success: true, status: 'ok',
    request_id: normalized.request_id, effective_request_id: effectiveRequestId
  });

  const result = harness.context.commitConfirmedReservation({
    registration: {}, operation_id: '11111111-2222-4333-8444-555555555555'
  });
  assert.equal(result.success, true);
  assert.equal(result.request_id, null);
  assert.equal(result.effective_request_id, 'RQ-260907-009');
  assert.deepEqual(calls, [
    'bootstrap_request', 'exact_rq_fence', 'registered_guard', 'registered_guard',
    'set_component_selections', 'exact_rq_fence', 'register'
  ]);
  assert.equal(harness.scriptLock.acquisitions, 1);
  assert.equal(harness.userLock.acquisitions, 1);
});

test('confirmed registration blocks every matching active registered trade before replacement or registration writes', () => {
  let insertCalls = 0;
  let registerCalls = 0;
  const harness = productionCommitContext({
    _findRegisteredTradesForConfirmRequest_: () => ['260907-001', '260907-002'],
    _insertAndCheckRequest: () => { insertCalls += 1; throw new Error('must not insert'); },
    registerByReqID: () => { registerCalls += 1; throw new Error('must not register'); }
  });

  const result = harness.context.commitConfirmedReservation({
    registration: {}, operation_id: '11111111-2222-4333-8444-555555555555'
  });
  assert.equal(result.success, false);
  assert.equal(result.status, 'blocked');
  assert.equal(result.error.type, 'registered_trade_exists');
  assert.equal(insertCalls, 0);
  assert.equal(registerCalls, 0);
  assert.equal(harness.scriptLock.acquisitions, 1);
  assert.equal(harness.scriptLock.releases, 1);
  assert.equal(harness.userLock.acquisitions, 1);
  assert.equal(harness.userLock.releases, 1);
});

test('confirmed registration keeps replacement and registration in one transferred ScriptLock transaction', () => {
  const harness = productionCommitContext();
  let insertCalls = 0;
  let registerCalls = 0;
  harness.context._insertAndCheckRequest = () => {
    insertCalls += 1;
    assert.equal(harness.scriptLock.held, true);
    assert.equal(harness.userLock.held, true);
    return { reqID: 'RQ-260907-002', replacedReqIDs: ['RQ-260907-001'], finalSetComponents: [] };
  };
  harness.context.registerByReqID = (sheet, row, options) => {
    registerCalls += 1;
    assert.equal(harness.scriptLock.held, true);
    assert.equal(harness.userLock.held, true);
    assert.equal(options.preAcquiredScriptLock, harness.scriptLock);
    assert.equal(options.confirmedReservationLockCapability, harness.capability);
    assert.equal(options.forbidRegisteredMerge, true);
    assert.equal(options.suppressCustomerNotification, true);
    harness.scriptLock.releaseLock();
    return { success: true };
  };
  harness.context._resolveStaffConfirmedPendingRequestFence_ = (() => {
    let calls = 0;
    return () => ({
      group: { reqID: calls++ === 0 ? 'RQ-260907-001' : 'RQ-260907-002', rows: [2], setComponentItems: [] },
      expectedSetComponents: []
    });
  })();
  harness.context._confirmedReservationResult_ = () => {
    assert.equal(harness.scriptLock.held, false);
    assert.equal(harness.userLock.held, true);
    return { schema: 'village-confirmed-reservation-commit-result/v1', success: true, status: 'ok' };
  };

  const result = harness.context.commitConfirmedReservation({
    registration: {}, operation_id: '11111111-2222-4333-8444-555555555555'
  });
  assert.equal(result.success, true);
  assert.equal(insertCalls, 1);
  assert.equal(registerCalls, 1);
  assert.equal(harness.scriptLock.acquisitions, 1);
  assert.equal(harness.scriptLock.releases, 1);
  assert.equal(harness.userLock.acquisitions, 1);
  assert.equal(harness.userLock.releases, 1);
});

test('cutover ambiguity preserves the surviving staged RQ identity in the durable receipt evidence', () => {
  const cutoverError = new Error('synthetic cutover response loss');
  cutoverError.code = 'pending_request_cutover_uncertain';
  cutoverError.effectiveRequestId = 'RQ-260907-002';
  cutoverError.replacedReqIDs = ['RQ-260907-001'];
  cutoverError.appliedStages = ['pending_request_replacement'];
  const harness = productionCommitContext({
    _insertAndCheckRequest: () => { throw cutoverError; }
  });
  const result = harness.context.commitConfirmedReservation({
    registration: {}, operation_id: '11111111-2222-4333-8444-555555555555'
  });
  assert.equal(result.status, 'partial_success');
  assert.equal(result.effective_request_id, 'RQ-260907-002');
  assert.deepEqual(JSON.parse(JSON.stringify(result.replaced_request_ids)), ['RQ-260907-001']);
  assert.deepEqual(JSON.parse(JSON.stringify(result.applied_stages)), ['pending_request_replacement']);
  assert.equal(result.error.type, 'pending_request_cutover_uncertain');
});

test('confirmed registration ledger failure becomes terminal human review and never enters the legacy retry queue', () => {
  const start = gas.indexOf('function handleRegistrationLedgerFailure_(');
  const end = gas.indexOf('\nfunction finalizeQueuedRequestFromExistingTrade_', start);
  assert.ok(start >= 0 && end > start, 'the production ledger failure boundary must exist');
  const queued = [];
  const marks = [];
  const statusWrites = [];
  const context = {
    markRequestLedgerPending_: (...args) => marks.push(args),
    enqueuePendingRegister_: (...args) => queued.push(args),
    readRegisteredTradeCorrectionState_: (tradeId, includeLedger) => ({
      tradeId, includeLedger,
      contract: { status: '예약' },
      schedule: { rows: [{ scheduleId: `${tradeId}-01` }] },
      ledger: null
    })
  };
  vm.runInNewContext(
    `${gas.slice(start, end)}\nthis.handle = handleRegistrationLedgerFailure_;`,
    context
  );
  const sheet = {
    getRange(row, column) {
      return {
        setValue(value) { statusWrites.push({ row, column, value }); return this; },
        setBackground() { return this; }
      };
    }
  };
  const allData = [
    ['RQ-260907-001', '', '', '', '', '장비 A', 1, '', '', '', '', '', '', '등록', '', '260907-001'],
    ['RQ-260907-001', '', '', '', '', '장비 B', 1, '', '', '', '', '', '', '등록', '', '260907-001']
  ];

  assert.throws(
    () => context.handle(
      sheet, allData, 'RQ-260907-001', '260907-001', new Error('ledger unavailable'),
      { noAutomaticReplay: true }
    ),
    (error) => error.code === 'trade_ledger_write_failed'
      && error.tradeID === '260907-001'
      && error.authoritativeRegistrationState?.ledger === null
  );
  assert.equal(marks.length, 0, 'confirmed failure must never pass through recoverable 등록대기');
  assert.deepEqual(queued, []);
  assert.equal(statusWrites.length, 2);
  assert.ok(statusWrites.every(({ value }) => String(value).includes('수동확인')));

  context.handle(sheet, allData, 'RQ-260907-002', '260907-002', new Error('legacy'), {});
  assert.equal(marks.length, 1, 'legacy manual registration keeps its existing recovery behavior');
  assert.deepEqual(queued, [['RQ-260907-002', 30000]]);
});
