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

test('onsite external support records two items with only one own-stock unit and unchanged price', () => {
  const h = gasHarness();
  const result = h.context.dashboardAddEquipments(TRADE, [{ name: 'Scarce light', qty: 2 }],
    { lockAlreadyHeld: true, deferContractRegeneration: true, rawNames: true, externalSupplyQty: 1 });
  assert.equal(result.success, true, result.error);
  const r = h.schedule.rows[2];
  assert.equal(r[4], 2);
  assert.match(r[10], /\[외부조달\].*1대/);
  const own = h.context.inventorySupplyPhysicalRows_({equipment:r[3],qty:r[4],note:r[10],
    startDT:new Date('2026-09-14T09:00:00+09:00'),endDT:new Date('2026-09-15T09:00:00+09:00')});
  assert.equal(own.length, 1);
  assert.equal(own[0].qty, 1);
  assert.equal(h.equipment.writes, 0);
});
test('ordinary shortage and insufficient external quantity still block writes', () => {
  for (const externalSupplyQty of [0, 1]) {
    const h = gasHarness();
    const result = h.context.dashboardAddEquipments(TRADE, [{ name: 'Scarce light', qty: 3 }],
      { lockAlreadyHeld:true, rawNames:true, externalSupplyQty });
    assert.match(result.error, /가용 불가/);
    assert.equal(h.schedule.writes, 0);
  }
});
test('external quantity must be an integer within a single requested item quantity', () => {
  for (const externalSupplyQty of [-1, 0.5, 3, 'bad', true]) {
    const h = gasHarness({total:10});
    const result = h.context.dashboardAddEquipments(TRADE, [{ name:'Scarce light', qty:2 }],
      { lockAlreadyHeld:true, deferContractRegeneration:true, rawNames:true, externalSupplyQty });
    assert.match(result.error, /외부 지원 수량/);
    assert.equal(h.schedule.writes, 0);
  }
});
test('an external set allocates its components and preserves the catalog price', () => {
  const h = gasHarness({total:0});
  h.context.buildDashboardSetLookup_ = () => ({items:{'Light kit':true},prices:{'Light kit':25000},
    components:{'Light kit':[{name:'Scarce light',qty:2}]}});
  const result = h.context.dashboardAddEquipments(TRADE,[{name:'Light kit',qty:1}],
    {lockAlreadyHeld:true,deferContractRegeneration:true,rawNames:true,externalSupplyQty:1});
  assert.equal(result.success,true,result.error);
  assert.equal(h.schedule.rows[2][11],25000);
  assert.equal(h.schedule.rows[3][4],2);
  assert.match(h.schedule.rows[3][10],/\[외부조달\].*2대/);
});

test('onsite paid and free dry-run paths carry external quantity into physical supply without writes', () => {
  for (const settlementStatus of ['유상', '무상']) {
    const h = gasHarness();
    h.context.buildDashboardSetLookup_ = () => ({items:{'Scarce light':true},prices:{'Scarce light':25000},components:{}});
    vm.runInNewContext('var DASHBOARD_ONSITE_IDEM_PROP_="onsite";\n' + functionSource('dashboardRecordOnsiteAddon') + '\n' + functionSource('dashboardAddedItemsFromRows_'), h.context);
    const result = h.context.dashboardRecordOnsiteAddon(TRADE,[{name:'Scarce light',qty:2}],
      {dryRun:true,rawNames:true,externalSupplyQty:1,settlementStatus});
    assert.equal(result.success,true,result.error);
    assert.match(result.plannedItems[0].supplyNote,/\[외부조달\].*1대/);
    assert.equal(result.supplyPlan.allocations.find(a=>a.source==='external').qty,1);
    assert.equal(h.schedule.writes,0);
  }
});

test('external support changes the idempotency identity while legacy zero remains compatible', () => {
  const crypto = require('node:crypto');
  const h = gasHarness();
  h.context.Utilities = {DigestAlgorithm:{SHA_256:'sha256'},
    computeDigest:(algorithm,text)=>crypto.createHash(algorithm).update(text).digest(),
    base64EncodeWebSafe:bytes=>Buffer.from(bytes).toString('base64url')};
  vm.runInNewContext(functionSource('dashboardOnsiteRequestFingerprint_'),h.context);
  const fingerprint = qty=>h.context.dashboardOnsiteRequestFingerprint_(TRADE,[{name:'Scarce light',qty:2}],{externalSupplyQty:qty});
  assert.equal(fingerprint(undefined),fingerprint(0));
  assert.notEqual(fingerprint(0),fingerprint(1));
  assert.notEqual(fingerprint(1),fingerprint(2));
});

test('retry recovery refuses an external-supply note that no longer matches the reserved row', () => {
  const h = gasHarness();
  const reserved = [{scheduleId:TRADE+'-01',setName:'',name:'Existing light',qty:2,supplyNote:'[외부조달] expected'}];
  vm.runInNewContext(functionSource('inspectDashboardOnsiteReservation_'),h.context);
  let result = h.context.inspectDashboardOnsiteReservation_(TRADE,reserved);
  assert.equal(result.mismatch,true);
  assert.equal(result.all,false);
  h.schedule.rows[1][10] = reserved[0].supplyNote;
  result = h.context.inspectDashboardOnsiteReservation_(TRADE,reserved);
  assert.equal(result.all,true);
  assert.equal(result.items[0].supplyNote,reserved[0].supplyNote);
});
