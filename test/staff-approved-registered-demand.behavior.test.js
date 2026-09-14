'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { pathToFileURL } = require('node:url');
const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'checkAvailability.js'), 'utf8');
const supplySource = fs.readFileSync(path.join(root, 'inventorySupply.js'), 'utf8');
const { normalizeCorrectionInput } = require('../scripts/windows/village-registered-trade-correction.js');

function functionSource(name) {
  const from = source.indexOf('function ' + name + '(');
  assert.ok(from >= 0, name);
  const next = source.indexOf('\nfunction ', from + 1);
  return source.slice(from, next < 0 ? undefined : next);
}
function plain(value) { return JSON.parse(JSON.stringify(value)); }

class Sheet {
  constructor(rows) { this.rows = rows.map(row => [...row]); this.writes = 0; }
  getLastRow() { return this.rows.length; }
  insertRowsAfter(index, count) { this.rows.splice(index, 0, ...Array.from({ length: count }, () => [])); }
  getRange(row, column, rowCount = 1, columnCount = 1) {
    const sheet = this;
    const read = () => Array.from({ length: rowCount }, (_, y) =>
      Array.from({ length: columnCount }, (_, x) => sheet.rows[row - 1 + y]?.[column - 1 + x] ?? ''));
    const range = {
      getValues: read,
      getDisplayValues: () => read().map(values => values.map(String)),
      getValue: () => read()[0][0],
      getNumberFormats: () => read().map(values => values.map(() => '@')),
      getNumberFormat: () => '@',
      setNumberFormat() { return range; },
      setNumberFormats() { return range; },
      setValues(values) {
        sheet.writes++;
        values.forEach((valuesRow, y) => valuesRow.forEach((value, x) => {
          sheet.rows[row - 1 + y] ||= [];
          sheet.rows[row - 1 + y][column - 1 + x] = value;
        }));
        return range;
      },
      setValue(value) { return range.setValues([[value]]); }
    };
    return range;
  }
}

const TRADE = '260913-001';
const OLD = ['2026-09-14', '09:00', '2026-09-15', '09:00'];
const NEW = ['2026-09-16', '09:00', '2026-09-17', '09:00'];

function gasHarness({ item = 'Existing light', total = 1, invalidAllocation = false, missingEquipmentSheet = false } = {}) {
  const token = {};
  const schedule = new Sheet([
    Array(13).fill('header'),
    [TRADE + '-01', TRADE, '', item, 2, ...OLD, '반출중', '수기 메모 유지', 7000, '테스트 예약자']
  ]);
  const contract = new Sheet([Array(12).fill('header'), [TRADE, '', '', '', ...OLD, 1]]);
  const equipment = new Sheet([Array(12).fill('header'),
    ['', '', '', 'Scarce light', total, '', '', '', '', '', '', 7000],
    ['', '', '', 'Existing light', 5, '', '', '', '', '', '', 5000]]);
  const ledger = new Sheet([Array(5).fill('header'), [OLD[0], '', 'https://example.invalid/contract', '', TRADE]]);
  const parseDT = (date, time) => new Date(date + 'T' + time + ':00+09:00');
  const scheduleData = () => schedule.rows.slice(1).map(row => ({
    contractID: row[1], equipment: row[3], qty: row[4], startDT: parseDT(row[5], row[6]),
    endDT: parseDT(row[7], row[8]), status: row[9], note: row[10],
    ...(invalidAllocation ? { equipment: 'Scarce light', supplyError: 'invalid saved allocation' } : {})
  }));
  const ss = { getSheetByName(name) {
    if (name === '스케줄상세') return schedule;
    if (name === '계약마스터') return contract;
    if (name === '장비마스터') return missingEquipmentSheet ? null : equipment;
    if (name === '세트마스터') return {};
    return null;
  }};
  const context = {
    Date, Math, JSON, Object, Array, String, Number, RegExp, Error,
    REGISTERED_STAFF_DEMAND_TOKEN_: token,
    SpreadsheetApp: { getActiveSpreadsheet: () => ss, flush() {},
      openByUrl: () => ({ getSheetByName: () => ledger }) },
    PropertiesService: { getScriptProperties: () => ({ getProperty: () => 'https://example.invalid/ledger' }) },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) },
    Utilities: { formatDate: date => new Date(date).toISOString().slice(0, 10) },
    normalizeDashboardAddEntries_: entries => entries.map(entry => ({ ...entry })),
    findDashboardRowsByValue_: () => [2],
    readDashboardScheduleRows_: () => [[TRADE + '-01']],
    dashboardTradeMutationLeaseError_: () => null,
    dashboardOnsiteRequestFingerprint_: () => 'synthetic-add',
    normalizeDashboardMutationId_: value => value || '',
    isDashboardTradeCheckoutStarted_: () => false,
    invalidateDashboardReturnInspectionForTrade_: () => ({ success: true }),
    buildDashboardSetLookup_: () => ({ items: {}, prices: {}, components: {} }),
    buildDashboardEquipmentMeta_: () => ({ equipment: {
      'Scarce light': { total, maintenance: 0 }, 'Existing light': { total: 5, maintenance: 0 }
    }, categories: { 'Light category': true } }),
    getDashboardAvailabilityScheduleData_: scheduleData,
    getScheduleData: scheduleData,
    parseDT,
    calcRentalDays: () => 1,
    dashboardAddedItemsFromRows_: rows => rows.map(row => ({
      scheduleId: row[0], setName: row[2], name: row[3], qty: row[4],
      isComponent: !!row[2] && row[2] !== row[3]
    })),
    scheduleDashboardStructureProjectionUnderLock_() {}, applyDashboardAddRowFormats_() {},
    supaMarkTradeDirty_() {}, supaMarkScheduleRowsDirty_() {},
    invalidateDashboardCache() {}, invalidateTimelineCache() {}
  };
  const addStart = source.indexOf('function dashboardAddEquipments(');
  const addEnd = source.indexOf('\nvar DASHBOARD_ONSITE_IDEM_PROP_', addStart);
  vm.runInNewContext(supplySource + '\n' + [
    functionSource('buildAvailabilityItems_'),
    functionSource('mergeAvailabilityItems_'),
    functionSource('checkAvailabilityForAddCached_'),
    functionSource('planRegisteredTradeInventory_'),
    source.slice(addStart, addEnd),
    functionSource('changeRegisteredTradeDates')
  ].join('\n'), context);
  const options = { lockAlreadyHeld: true, deferContractRegeneration: true, staffApprovalToken: token };
  const dateArgs = { tradeId: TRADE, newStartDate: NEW[0], startTime: NEW[1],
    newEndDate: NEW[2], endTime: NEW[3], allowConflicts: false };
  return { context, options, dateArgs, schedule, contract, ledger, equipment };
}

test('approved add records the full shortage demand while retaining the real availability result', () => {
  const h = gasHarness();
  const before = h.schedule.rows[1].slice();
  const result = h.context.dashboardAddEquipments(TRADE, [{ name: 'Scarce light', qty: 2 }],
    { ...h.options, rawNames: true, requireExactCatalog: true });
  assert.equal(result.success, true);
  assert.deepEqual(h.schedule.rows[1], before);
  assert.equal(h.schedule.rows[2][3], 'Scarce light');
  assert.equal(h.schedule.rows[2][4], 2);
  assert.equal(result.conflicts[0].requested, 2);
  assert.equal(result.conflicts[0].available, 1);
  assert.ok(result.warnings.some(issue => issue.equipment === 'Scarce light'));
  assert.equal(h.equipment.writes, 0);
});

test('approved add preserves a raw unmapped request and a model-category request without inventing supply', () => {
  for (const name of ['Unmapped approved light', 'Light category']) {
    const h = gasHarness();
    const result = h.context.dashboardAddEquipments(TRADE, [{ name, qty: 2 }],
      { ...h.options, rawNames: true, requireExactCatalog: true });
    assert.equal(result.success, true, name);
    assert.equal(h.schedule.rows[2][3], name);
    assert.equal(h.schedule.rows[2][4], 2);
    assert.equal(h.schedule.rows[2][10], '');
    assert.ok(result.warnings.some(issue => issue.equipment === name));
    assert.equal(h.equipment.writes, 0);
  }
});

test('ordinary or forged approval cannot bypass shortage and exact-catalog add checks', () => {
  for (const name of ['Scarce light', 'Unmapped approved light']) {
    const h = gasHarness();
    const result = h.context.dashboardAddEquipments(TRADE, [{ name, qty: 2 }],
      { lockAlreadyHeld: true, deferContractRegeneration: true, rawNames: true, requireExactCatalog: true });
    assert.notEqual(result.success, true);
    assert.equal(h.schedule.writes, 0);
    const forged = h.context.dashboardAddEquipments(TRADE, [{ name, qty: 2 }],
      { ...h.options, staffApprovalToken: {}, rawNames: true, requireExactCatalog: true });
    assert.notEqual(forged.success, true);
    assert.equal(h.schedule.writes, 0);
  }
});

test('approved add still refuses invalid stored supply allocations and an unavailable equipment source', () => {
  for (const config of [{ invalidAllocation: true }, { missingEquipmentSheet: true }]) {
    const h = gasHarness(config);
    const result = h.context.dashboardAddEquipments(TRADE, [{ name: 'Scarce light', qty: 2 }],
      { ...h.options, rawNames: true, requireExactCatalog: true });
    assert.notEqual(result.success, true);
    assert.equal(h.schedule.writes, 0);
  }
});

test('approved date change persists an unmapped item with its exact quantity, status, and manual note', () => {
  const h = gasHarness({ item: 'Unmapped approved light' });
  const result = h.context.changeRegisteredTradeDates(h.dateArgs, h.options);
  assert.equal(result.success, true);
  assert.deepEqual(h.schedule.rows[1].slice(2, 5), ['', 'Unmapped approved light', 2]);
  assert.deepEqual(h.schedule.rows[1].slice(5, 9), NEW);
  assert.deepEqual(h.schedule.rows[1].slice(9, 13), ['반출중', '수기 메모 유지', 7000, '테스트 예약자']);
  assert.ok(result.availabilityWarnings.some(value => value.includes('Unmapped approved light')));
  assert.deepEqual(h.contract.rows[1].slice(4, 8), NEW);
  assert.equal(h.ledger.rows[1][0], NEW[0]);
  assert.equal(h.equipment.writes, 0);
});

test('approved date change keeps a computed stock conflict visible after saving', () => {
  const h = gasHarness({ item: 'Scarce light', total: 0 });
  const result = h.context.changeRegisteredTradeDates(h.dateArgs, h.options);
  assert.equal(result.success, true);
  assert.equal(result.status, 'CHANGED_WITH_CONFLICTS');
  assert.equal(result.conflicts[0].요청수량, 2);
  assert.equal(result.conflicts[0].가용수량, 0);
  assert.deepEqual(h.schedule.rows[1].slice(5, 9), NEW);
});

test('ordinary date changes still reject unresolved identity and shortages before writes', () => {
  const unknown = gasHarness({ item: 'Unmapped approved light' });
  assert.throws(() => unknown.context.changeRegisteredTradeDates(unknown.dateArgs,
    { lockAlreadyHeld: true, deferContractRegeneration: true }), /UNRESOLVED_INVENTORY/);
  assert.equal(unknown.schedule.writes, 0);
  const short = gasHarness({ item: 'Scarce light', total: 0 });
  assert.equal(short.context.changeRegisteredTradeDates(short.dateArgs,
    { lockAlreadyHeld: true, deferContractRegeneration: true }).status, 'CONFLICT');
  assert.equal(short.schedule.writes, 0);
});

test('staff demand approval never permits a nameless schedule row or an invalid new period', () => {
  const h = gasHarness({ item: '' });
  assert.throws(() => h.context.changeRegisteredTradeDates(h.dateArgs, h.options), /UNRESOLVED_INVENTORY/);
  assert.equal(h.schedule.writes, 0);
  const dated = gasHarness();
  assert.throws(() => dated.context.changeRegisteredTradeDates(
    { ...dated.dateArgs, newEndDate: '2026-09-15' }, dated.options), /새 반납일시/);
  assert.equal(dated.schedule.writes, 0);
});

test('validated mutation builder carries its evidence through both strict correction boundaries', async () => {
  const { buildRegisteredTradeCorrectionInput, validateStaffConfirmedMutation } =
    await import(pathToFileURL(path.join(root, 'tools/ai-browser-worker/staff-confirmed-mutation.mjs')));
  const mutation = {
    confirmed: true, kind: 'equipment_add', target_scope: 'registered_trade', trade_id: TRADE,
    source_evidence: { customer_request: '추가 조명 두 대 부탁드립니다', staff_confirmation: '네 추가할게요', conversation_revision: 9 },
    expected_period: { start_date: OLD[0], start_time: OLD[1], end_date: OLD[2], end_time: OLD[3] },
    expected_before: [], desired_after: [{ name: 'Unmapped approved light', quantity: 2 }], date_change: null
  };
  const built = buildRegisteredTradeCorrectionInput(mutation, '11111111-2222-4333-8444-555555555555');
  const expectedApproval = { source: 'kakao_staff_confirmed', conversationRevision: 9,
    customerRequest: '추가 조명 두 대 부탁드립니다', staffConfirmation: '네 추가할게요' };
  assert.deepEqual(built.staffApproval, expectedApproval);
  const normalized = normalizeCorrectionInput(built);
  assert.deepEqual(normalized.staffApproval, expectedApproval);
  const c = { Date, Math, JSON, Object, Array, String, Number, RegExp, Error,
    Utilities: { formatDate: date => new Date(date).toISOString().slice(0, 10) } };
  const start = source.indexOf('function normalizeRegisteredTradeCorrection_');
  const end = source.indexOf('\nfunction _registeredTradeSourceRequestPlan_', start);
  vm.runInNewContext(functionSource('normalizeRegisteredTradePriceChanges_') + '\n' + source.slice(start, end), c);
  const { sendEstimate, ...args } = built;
  assert.deepEqual(plain(c.normalizeRegisteredTradeCorrection_(args).staffApproval), expectedApproval);
  assert.equal(validateStaffConfirmedMutation({ ...mutation, staffApproval: expectedApproval }).valid, false);
  assert.throws(() => buildRegisteredTradeCorrectionInput({ ...mutation, confirmed: false }, built.operationId), /invalid/);
  assert.throws(() => normalizeCorrectionInput({ ...built, expectedPeriod: undefined }), /expectedPeriod/);
  assert.throws(() => c.normalizeRegisteredTradeCorrection_({ ...args, expectedPeriod: undefined }), /expectedPeriod/);
  assert.throws(() => normalizeCorrectionInput({ ...built, staffApproval: { ...expectedApproval, source: 'customer' } }), /staffApproval/);
  assert.throws(() => c.normalizeRegisteredTradeCorrection_({ ...args, staffApproval: { ...expectedApproval, conversationRevision: 0 } }), /staffApproval/);
});


const COMPONENT_APPROVAL = { source: 'kakao_staff_confirmed', conversationRevision: 8,
  customerRequest: 'replace the selected component', staffConfirmation: 'confirmed' };

function componentHarness({ name = 'Scarce light', missingParent = false, ...options } = {}) {
  const h = gasHarness(options);
  const old = h.schedule.rows[1];
  h.schedule.rows = [h.schedule.rows[0],
    [TRADE + '-01', TRADE, 'Cinema Set', 'Cinema Set', 1, ...OLD, '대기', 'parent memo', 9000, '테스트 예약자'],
    [TRADE + '-02', TRADE, 'Cinema Set', old[3], 2, ...OLD, '대기', '  manual memo\nkeep spaces  ', 0, '테스트 예약자'],
    [TRADE + '-03', TRADE, 'Cinema Set', 'Sibling', 1, ...OLD, '대기', 'sibling memo', 0, '테스트 예약자'],
    [TRADE + '-04', TRADE, '', 'Unrelated', 1, ...OLD, '대기', 'other memo', 3000, '테스트 예약자']
  ];
  if (missingParent) h.schedule.rows.splice(1, 1);
  h.context.findDashboardRowsByValue_ = (sheet, column, _last, value) => sheet.rows
    .map((row, index) => index > 0 && row[column - 1] === value ? index + 1 : 0).filter(Boolean);
  h.context.findDashboardScheduleRowsForEquipments_ = sheet => sheet.rows.slice(1).map(row => [...row]);
  h.context.buildDashboardScheduleData_ = rows => rows.map(row => ({
    contractID: row[1], equipment: row[3], qty: row[4], startDT: h.context.parseDT(row[5], row[6]),
    endDT: h.context.parseDT(row[7], row[8]), status: row[9], note: row[10],
    ...(options.invalidAllocation ? { equipment: name, supplyError: 'invalid saved allocation' } : {})
  }));
  const projectionCalls = [];
  h.context.scheduleDashboardStructureProjectionUnderLock_ = (...args) => projectionCalls.push(plain(args));
  vm.runInNewContext([
    functionSource('planRegisteredTradeComponentReplacement_'),
    functionSource('preflightRegisteredTradeComponentReplacement_'),
    functionSource('applyRegisteredTradeComponentReplacement_')
  ].join('\n'), h.context);
  const baseline = { contract: { startDate: OLD[0], startTime: OLD[1], endDate: OLD[2], endTime: OLD[3] },
    schedule: { rows: h.schedule.rows.slice(1).map(row => ({ scheduleId: row[0], setName: row[2], name: row[3], qty: row[4], isComponent: Boolean(row[2]) && row[2] !== row[3] })) } };
  const correction = { tradeId: TRADE, staffApproval: COMPONENT_APPROVAL, dateChange: null,
    remove: [{ scheduleId: TRADE + '-02', expectedName: old[3], expectedQty: 2 }], add: [{ name, qty: 2 }] };
  const plan = h.context.planRegisteredTradeComponentReplacement_(baseline, correction);
  return { ...h, correction, baseline, plan, projectionCalls };
}

test('single approved component replacement changes only the selected name while preserving parent, quantity and all state', () => {
  for (const name of ['Scarce light', 'Unmapped approved monitor']) {
    const h = componentHarness({ name });
    const before = structuredClone(h.schedule.rows);
    const plan = h.context.preflightRegisteredTradeComponentReplacement_(TRADE, h.plan, h.options.staffApprovalToken);
    assert.ok(plan.warnings.some(warning => warning.equipment === name));
    const result = h.context.applyRegisteredTradeComponentReplacement_(TRADE, plan, h.options.staffApprovalToken);
    assert.equal(result.success, true);
    before[2][3] = name;
    assert.deepEqual(h.schedule.rows, before);
    assert.deepEqual(h.projectionCalls, [[TRADE, { syncStructure: true }]]);
    assert.equal(h.equipment.writes, 0);
    assert.throws(() => h.context.applyRegisteredTradeComponentReplacement_(TRADE, plan, h.options.staffApprovalToken), /baseline/i);
  }
});

test('single component replacement fences exact source, parent, quantity, mixed deltas and saved supply', () => {
  const h = componentHarness();
  for (const changes of [
    { staffApproval: null }, { add: [{ name: 'Scarce light', qty: 3 }] },
    { add: [{ name: 'Scarce light', qty: 2 }, { name: 'Another item', qty: 1 }] },
    { dateChange: { newStartDate: '2026-09-16' } },
    { add: [{ name: 'Cinema Set', qty: 2 }] },
    { remove: [{ scheduleId: TRADE + '-02', expectedName: 'Different previous', expectedQty: 2 }] }
  ]) assert.equal(h.context.planRegisteredTradeComponentReplacement_(h.baseline, { ...h.correction, ...changes }), null);
  assert.equal(componentHarness({ missingParent: true }).plan, null);
  const plan = h.context.preflightRegisteredTradeComponentReplacement_(TRADE, h.plan, h.options.staffApprovalToken);
  h.schedule.rows[2][4] = 3;
  assert.throws(() => h.context.applyRegisteredTradeComponentReplacement_(TRADE, plan, h.options.staffApprovalToken), /baseline/i);
  assert.equal(h.schedule.writes, 0);
  for (const options of [{ invalidAllocation: true }, { missingEquipmentSheet: true }]) {
    const bad = componentHarness(options);
    assert.throws(() => bad.context.preflightRegisteredTradeComponentReplacement_(TRADE, bad.plan, bad.options.staffApprovalToken));
    assert.equal(bad.schedule.writes, 0);
  }
  assert.throws(() => h.context.preflightRegisteredTradeComponentReplacement_(TRADE, h.plan, {}), /FORBIDDEN/);
});
