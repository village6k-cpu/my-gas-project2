'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, '../checkAvailability.js'), 'utf8');
function fn(name) {
  const start = source.indexOf('function ' + name + '('), end = source.indexOf('\nfunction ', start + 1);
  assert.ok(start >= 0, name);
  return source.slice(start, end < 0 ? undefined : end);
}
function harness() {
  const rows = [
    ['릴선', '', 1, '', '', '', 5000], ['샌드백', '', 1, '', '', '', ''],
    ['웨건', '', 1, '', '', '', 5000], ['어퓨쳐 600X', '', 1, '', '', '', 35000],
    ['C스탠드', '', 1, '', '', '', 5000], ['넉자 그리드', '', 1, '', '', '', 5000],
    ['소니 FX3 바디세트', '배터리', 3, '', '', 'Y', 50000],
    ['V마운트 배터리', '', 1, '', '', '', 5000], ['CF-A 160', '', 1, '', '', '', 10000],
    ['로데 비디오마이크 프로', '', 1, '', '', '', 10000],
    ['소니 단렌즈(1구)', '', 1, '', '', '', 20000],
    ['어퓨처 스팟마운트', '아이리스', 1, '', '', 'Y', 10000]
  ];
  const c = {getSetMasterRows_: () => rows};
  vm.createContext(c);
  for (const name of ['setMasterProductKey_', 'getSetMasterProductAliases_', 'resolveSetMasterProduct_',
    'resolveSetMasterComponents_', 'parseSetMasterPrice_', 'buildDashboardSetLookup_', 'requireSetMasterPrice_',
    'rentalLightingFixtureNames_', 'rentalAccessoryKind_', 'resolveRentalAccessoryPrice_', 'resolveStaffApprovedRegistrationPrice_',
    'buildAvailabilityItems_', 'getSetComponents', 'dashboardUpdateEquipmentQty']) vm.runInContext(fn(name), c);
  return {c, rows, lookup: c.buildDashboardSetLookup_({})};
}
test('lighting fixture rental makes extension and sandbags free; supports alone do not', () => {
  const {c, lookup} = harness();
  for (const name of ['릴선', '릴선 - 1ea', '샌드백']) {
    assert.equal(c.requireSetMasterPrice_(name, lookup, {names: ['어퓨쳐 600X', name]}), 0);
    assert.throws(() => c.requireSetMasterPrice_(name, lookup), /대여 정책 확인/);
  }
  assert.equal(c.requireSetMasterPrice_('릴선', lookup, {names: ['C스탠드', '넉자 그리드']}), 5000);
  assert.throws(() => c.requireSetMasterPrice_('샌드백', lookup, {names: ['C스탠드']}), /2개 묶음/);
  lookup.prices['릴선'] = 6000;
  assert.equal(c.requireSetMasterPrice_('릴선', lookup, {names: ['릴선']}), 6000);
  assert.throws(() => c.requireSetMasterPrice_('웨건', lookup, {names: ['소니 FX3 바디세트']}), /기간·할인/);
});
test('standalone batteries and memory are prohibited; accompanying charge remains pending, never guessed free', () => {
  const {c, lookup} = harness();
  for (const name of ['970 배터리', 'V마운트 배터리', 'CF-A 160', '소니 CF-A 128']) {
    assert.throws(() => c.resolveStaffApprovedRegistrationPrice_(name, lookup, true, {names: [name]}),
      error => error.code === 'RENTAL_POLICY_RESTRICTED');
    const result = c.resolveStaffApprovedRegistrationPrice_(name, lookup, true, {names: ['소니 FX3 바디세트', name]});
    assert.equal(result.pricingPending, true);
    assert.equal(result.unitPrice, '');
  }
  assert.equal(c.rentalAccessoryKind_('소니 CF-A 리더기(정품)', lookup), '');
  assert.equal(c.rentalAccessoryKind_('V마운트 배터리 충전기', lookup), '');
  assert.equal(c.getSetComponents('소니 FX3 바디세트', {}).length, 1);
  assert.equal(c.requireSetMasterPrice_('소니 FX3 바디세트', lookup), 50000);
});
test('only explicitly approved model exceptions resolve; unapproved Cooke six-lens and broad IR ND stay unresolved', () => {
  const {c, lookup} = harness();
  assert.equal(c.requireSetMasterPrice_('로데 비디오 마이크 프로 +', lookup), 10000);
  assert.equal(c.requireSetMasterPrice_('24 mm gm2 단렌즈', lookup), 20000);
  assert.equal(c.requireSetMasterPrice_('어퓨쳐 spotlight', lookup), 10000);
  for (const name of ['Cooke SP3 full frame 6 LENS SET (FE)', 'IR ND 필터']) {
    assert.throws(() => c.requireSetMasterPrice_(name, lookup), /정식 상품 확인/);
  }
});
test('sales alias preserves the physical main body as an explicit child when master B only contains accessories', () => {
  const {c, lookup} = harness();
  const body = {id: 'LGT023', name: '어퓨처 스팟마운트'}, iris = {id: 'IRIS', name: '아이리스'};
  c.inventoryIdentityCatalog_ = () => ({resolve: name => ({item: name === body.name ? body : name === iris.name ? iris : null})});
  const children = c.resolveSetMasterComponents_('어퓨쳐 spotlight', lookup);
  assert.deepEqual(Array.from(children, x => x.name), ['아이리스', body.name]);
  const demand = c.buildAvailabilityItems_('어퓨쳐 spotlight', 2, children);
  assert.deepEqual(Array.from(demand, x => [x.name, x.qty]), [['아이리스', 2], [body.name, 2]]);
});
test('existing unresolved set cannot increase its header quantity without actual component rows', () => {
  const {c, lookup} = harness();
  const row = ['T-01', 'T', '소니 fx3 바디세트', '소니 fx3 바디세트', 1, '2026-10-20', '10:00', '2026-10-21', '10:00', '대기', '[단가확인필요]', '', '고객'];
  const sched = {getLastRow: () => 2, getRange: () => ({getValues: () => [row], getDisplayValues: () => [row]})};
  let writes = 0;
  c.SpreadsheetApp = {getActiveSpreadsheet: () => ({getSheetByName: name => name === '스케줄상세' ? sched : {}})};
  c.findDashboardRowsByValue_ = () => [2];
  c.parseDT = (date, time) => new Date(date + 'T' + time);
  c.buildDashboardSetLookup_ = () => lookup;
  c.invalidateDashboardReturnInspectionForTrade_ = () => {writes++;};
  const result = c.dashboardUpdateEquipmentQty('T', 'T-01', 2, {dryRun: true});
  assert.equal(result.code, 'CATALOG_COMPONENTS_REVIEW_REQUIRED');
  assert.equal(result.noMutationPerformed, true);
  assert.equal(writes, 0);
});
test('registration stage applies accessory context only from its own request and preserves original names', () => {
  const {c, lookup} = harness();
  const start = source.indexOf('  // 모든 유상 상품의 단가', source.indexOf('function registerByReqID('));
  const end = source.indexOf('\n  if (hasTransferredConfirmedLock)', start);
  const request = (id, name, qty) => [id, '', '', '', '', name, qty, '', '', '', '', '', '', '', '', '', ''];
  c.reqID = 'RQ-1'; c.mergeTargetScheduleRows = []; c.setSheet = {};
  c.mergeSchedulePlan = {writeSourceIndexes: [0]};
  c.buildDashboardSetLookup_ = () => lookup;
  c.allData = [request('RQ-1', '릴선 - 1ea', 2), request('RQ-2', '어퓨쳐 600X', 1)];
  vm.runInContext('function stage(){var directRegisterApproved=true;'+source.slice(start,end)+';return {prices:registrationPrices,notes:registrationPriceNotes};}', c);
  assert.equal(c.stage().prices[0], 5000);
  c.allData[1][0] = 'RQ-1';
  assert.equal(c.stage().prices[0], 0);
  assert.equal(c.stage().notes[0], '[정식상품]릴선');
  assert.equal(c.allData[0][5], '릴선 - 1ea'); assert.equal(c.allData[0][6], 2);
});
