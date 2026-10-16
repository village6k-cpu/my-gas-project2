const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const canonical = 'NANLUX Evoke 1200B';
const alias = '난룩스 이보크 1200B';
const start = new Date('2026-10-18T22:00:00+09:00');
const end = new Date('2026-10-19T22:00:00+09:00');
const equipmentRows = [['조명', 'LGT-011', '조명', canonical, 1, 1, 0, 0, '정상', '', 1, 50000]];
const links = [{ source_name: alias, equipment_id: 'LGT-011', equipment_name: canonical }];
function env({ rows = equipmentRows, aliasLinks = links } = {}) {
  const cache = {};
  const equipmentSheet = {
    getSheetId: () => 10, getLastRow: () => rows.length + 1,
    getRange: () => ({ getValues: () => rows })
  };
  const c = {
    CacheService: { getScriptCache: () => ({ get: k => cache[k] || null, put: (k, v) => cache[k] = v }) },
    SpreadsheetApp: { getActiveSpreadsheet: () => ({ getSheetByName: n => n === '장비마스터' ? equipmentSheet : null }) },
    SUPA_CFG_: () => ({}), supaToken_: () => 'fixture-token'
  };
  vm.createContext(c);
  for (const name of ['inventoryRisk.js', 'inventoryRiskMonitor.js', 'inventoryIdentity.js', 'inventorySupply.js', 'checkAvailability.js']) {
    const file = path.join(__dirname, '..', name);
    if (fs.existsSync(file)) vm.runInContext(fs.readFileSync(file, 'utf8'), c);
  }
  c.inventoryRiskDbRows_ = (_cfg, _token, table) => table === 'inventory_identity_aliases' ? aliasLinks : [];
  c.getDashboardCachedJson_ = (_key, _ttl, make) => make();
  c.parseDT = (d, t) => new Date(d + 'T' + t + ':00+09:00');
  return { c, equipmentSheet };
}
function meta() {
  const info = { total: 1, maintenance: 0, category: '조명', equipmentId: 'LGT-011', canonicalName: canonical, aliases: [alias] };
  return { equipment: { [canonical]: info, [alias]: info }, categories: {} };
}
const occupied = (name = alias) => ({ equipment: name, qty: 1, startDT: new Date('2026-10-14T12:00:00+09:00'), endDT: new Date('2026-10-19T03:00:00+09:00'), status: '대기' });
const schedule = (id, name, set = name) => [id, '260915-006', set, name, 1, '2026-10-14', '12:00', '2026-10-19', '03:00', '대기', '', 50000];
const plain = value => JSON.parse(JSON.stringify(value));

test('an English request consumes the already booked Korean alias of the same asset', () => {
  const { c } = env();
  const r = c.inventorySupplyPlan_([{ name: canonical, qty: 1 }], start, end, meta(), [occupied()]);
  assert.equal(r.ok, false);
  assert.equal(r.conflicts[0].available, 0);
});

test('two spellings in one plan cannot each reserve the same last unit', () => {
  const { c } = env();
  assert.equal(c.inventorySupplyPlan_([{ name: canonical, qty: 1 }, { name: alias, qty: 1 }], start, end, meta(), []).ok, false);
});

test('the verified alias resolves to the master ID without making another stock record', () => {
  const { c, equipmentSheet } = env();
  const found = c.findEquipment(alias, equipmentSheet);
  assert.equal(found?.equipmentId, 'LGT-011');
  assert.equal(found?.canonicalName, canonical);
  assert.equal(found?.total, 1);
  assert.equal(equipmentRows.length, 1);
});

test('dashboard metadata and selective row reads include reservations under verified aliases', () => {
  const { c, equipmentSheet } = env();
  const m = c.buildDashboardEquipmentMeta_(equipmentSheet);
  assert.equal(m.equipment[alias]?.equipmentId, 'LGT-011');
  c.getDashboardCacheJson_ = () => null;
  c.putDashboardCacheJson_ = () => {};
  c.getDashboardAvailabilityRowsCacheKey_ = () => 'fixture';
  c.getDashboardAvailabilityRowIndex_ = () => ({ [alias]: [2] });
  c.readDashboardScheduleRows_ = (_sheet, rows) => rows.map(() => schedule('old', alias));
  assert.equal(c.findDashboardScheduleRowsForEquipments_({}, 2, [canonical]).length, 1);
});

test('historical schedule reads count the stock-backed kit header but not an explicit duplicate body', () => {
  const { c } = env();
  const rows = [schedule('header', alias), schedule('body', canonical, alias)];
  const physical = c.buildDashboardScheduleData_(rows, [canonical]);
  assert.equal(physical.length, 1);
  assert.equal(physical[0].equipment, canonical);
  assert.equal(physical[0].equipmentId, 'LGT-011');
  const headerOnly = c.buildDashboardScheduleData_([rows[0]], [canonical]);
  assert.equal(headerOnly.length, 1);
});

test('registered date changes do not discard a stock-backed header with packing components', () => {
  const { c } = env();
  const rows = [schedule('header', alias), schedule('packing', '헤드 / 발라스터 / 라인*2', alias)];
  const result = c.planRegisteredTradeInventory_(rows.map((values, i) => ({ values, rowNumber: i + 2 })), meta().equipment, { [alias]: true });
  assert.deepEqual(plain(result.itemMap), { [canonical]: 1 });
});

test('an unresolved catalog header with unresolved components stays visible for identity review', () => {
  const { c } = env();
  const snapshot = {
    equipment: [{ id: 'LGT-011', name: canonical, stock: 1, maintenance: 0 }],
    sets: [{ name: alias, components: [{ name: '헤드 / 발라스터 / 라인*2', quantity: 1, tracked: true }] }],
    schedules: [{ id: 'old', tradeId: '260915-006', name: alias, setName: alias, quantity: 1, status: '대기', start: start.toISOString(), end: end.toISOString() }]
  };
  const r = c.buildInventoryRiskReport_(snapshot, { now: '2026-10-16T00:00:00+09:00', turnaroundMinutes: 0 });
  assert.ok(r.alerts.some(a => a.equipment === alias && a.kind === 'catalog_stock_missing'));
});

test('a conflicting exact name and alias never silently pick one physical asset', () => {
  const { c } = env();
  const r = c.inventoryRiskIdentity_([{ id: 'A', name: alias }, { id: 'B', name: canonical, aliases: [alias] }]).resolve(alias);
  assert.equal(r.item, null);
  assert.equal(r.candidates.length, 2);
});

test('genuinely new equipment remains recorded as unresolved demand, not silently mapped or blocked', () => {
  const { c } = env();
  const r = c.inventorySupplyPlan_([{ name: '신규 외부 조달 조명', qty: 1 }], start, end, meta(), []);
  assert.equal(r.ok, true);
  assert.equal(r.warnings.length, 1);
});

test('an alias request also reads the canonical-keyed dashboard schedule cache', () => {
  const { c } = env();
  c.getDashboardAvailabilityScheduleMap_ = () => ({ [canonical]: [[1, start.getTime(), end.getTime(), '대기', '']] });
  assert.equal(c.getDashboardAvailabilityScheduleData_({}, 2, [alias]).length, 1);
});

test('registration evidence binds both catalog spellings to one master ID, not a stock claim', () => {
  const { c } = env();
  assert.equal(typeof c.inventoryIdentityBindings_, 'function');
  const r = c.inventoryIdentityBindings_([{ name: alias, quantity: 1 }, { name: canonical, quantity: 1 }, { name: '신규 조명', quantity: 1 }]);
  assert.equal(r[0].equipmentId, 'LGT-011');
  assert.equal(r[1].equipmentId, 'LGT-011');
  assert.equal(r[2].equipmentId, null);
  assert.equal(r[2].status, 'unresolved');
});

test('a request reuses its identity snapshot instead of repeating sheet lookups for each overlap', () => {
  const { c, equipmentSheet } = env();
  let reads = 0;
  c.SpreadsheetApp = { getActiveSpreadsheet: () => ({ getSheetByName: () => { reads++; return equipmentSheet; } }) };
  for (let i = 0; i < 50; i++) assert.equal(c.inventoryIdentitySame_(alias, canonical), true);
  assert.equal(reads, 1);
});

test('an ambiguous exact name is not downgraded to an allowed unknown by the stock planner', () => {
  const { c, equipmentSheet } = env({ rows: equipmentRows.concat([['조명', 'OTHER', '조명', alias, 1, 1, 0, 0, '정상', '', 1, 50000]]) });
  const m = c.buildDashboardEquipmentMeta_(equipmentSheet);
  const r = c.inventorySupplyPlan_([{ name: alias, qty: 1 }], start, end, m, []);
  assert.equal(r.ok, false);
  assert.equal(r.conflicts[0].code, 'AMBIGUOUS_INVENTORY_IDENTITY');
});

test('selective reads match historical case and spacing by identity without rewriting source rows', () => {
  const { c } = env();
  const spelling = 'Nanlux Evoke 1200B';
  c.getDashboardCacheJson_ = () => null;
  c.putDashboardCacheJson_ = () => {};
  c.getDashboardAvailabilityRowsCacheKey_ = () => 'fixture';
  c.getDashboardAvailabilityRowIndex_ = () => ({ [spelling]: [2] });
  c.readDashboardScheduleRows_ = (_sheet, rows) => rows.map(() => schedule('old', spelling));
  const result = c.findDashboardScheduleRowsForEquipments_({}, 2, [canonical]);
  assert.equal(result.length, 1);
  assert.equal(result[0][3], spelling);
});

test('confirmed external support is stored on a stock-backed kit header with only packing components', () => {
  const { c } = env();
  const rows = [schedule('header', alias), schedule('packing', '헤드 / 발라스터 / 라인*2', alias)];
  c.inventorySupplyApplyRows_(rows, { allocations: [{ requestedName: alias, name: alias, qty: 1, source: 'external', supplier: '확정 외부 지원' }] });
  assert.match(rows[0][10], /외부조달/);
  assert.equal(c.buildDashboardScheduleData_(rows, [canonical]).length, 0);
});

test('an inactive ambiguous historical row cannot stop unrelated current availability', () => {
  const { c } = env({ rows: equipmentRows.concat([['조명', 'OTHER', '조명', alias, 1, 1, 0, 0, '정상', '', 1, 50000]]) });
  const old = schedule('cancelled', alias); old[9] = '취소';
  assert.equal(c.buildDashboardScheduleData_([old, schedule('active', canonical)], [canonical]).length, 1);
});

test('an active ambiguous occupant blocks only its candidate asset family', () => {
  const { c, equipmentSheet } = env({ rows: equipmentRows.concat([['조명', 'OTHER', '조명', alias, 1, 1, 0, 0, '정상', '', 1, 50000]]) });
  const m = c.buildDashboardEquipmentMeta_(equipmentSheet);
  m.equipment['다른 카메라'] = { total: 1 };
  const rows = c.buildDashboardScheduleData_([schedule('ambiguous', alias)]);
  assert.equal(c.inventorySupplyPlan_([{ name: canonical, qty: 1 }], start, end, m, rows).ok, false);
  assert.equal(c.inventorySupplyPlan_([{ name: '다른 카메라', qty: 1 }], start, end, m, rows).ok, true);
});

test('an unavailable alias source preserves demand metadata without claiming stock verified', () => {
  const { c, equipmentSheet } = env();
  c.inventoryRiskDbRows_ = () => { throw new Error('fixture unavailable'); };
  const m = c.buildDashboardEquipmentMeta_(equipmentSheet);
  assert.equal(m.equipment[canonical].equipmentId, 'LGT-011');
  const r = c.inventorySupplyPlan_([{ name: canonical, qty: 1 }], start, end, m, [occupied()]);
  assert.equal(r.ok, false);
  assert.equal(r.conflicts[0].code, 'INVENTORY_IDENTITY_UNAVAILABLE');
});

test('request set-header checks ignore cancelled ambiguous schedule rows before resolving them', () => {
  const { c, equipmentSheet } = env({ rows: equipmentRows.concat([['조명', 'OTHER', '조명', alias, 1, 1, 0, 0, '정상', '', 1, 50000]]) });
  const sheet = { getRange: () => ({ setValue() { return this; }, setBackground() { return this; } }) };
  assert.doesNotThrow(() => c.checkSetHeaderAvail(sheet, 2, canonical, 1, '2026-10-18', '22:00', '2026-10-19', '22:00', [{ ...occupied(), status: '취소' }], equipmentSheet));
});

test('single-item request checks also ignore cancelled ambiguous occupants', () => {
  const { c, equipmentSheet } = env({ rows: equipmentRows.concat([['조명', 'OTHER', '조명', alias, 1, 1, 0, 0, '정상', '', 1, 50000]]) });
  const sheet = { getRange: () => ({ setValue() { return this; }, setBackground() { return this; } }) };
  assert.doesNotThrow(() => c.checkSingleRowWithData(sheet, 2, 'RQ-261016-999', '2026-10-18', '22:00', '2026-10-19', '22:00', canonical, 1, [{ ...occupied(), status: '취소' }], equipmentSheet));
});

test('extending a registered kit does not demand its alias header and explicit body twice', () => {
  const { c, equipmentSheet } = env();
  const values = [['260915-006', '테스트', '', '', '2026-10-14', '12:00', '2026-10-19', '03:00']];
  const rows = [schedule('header', alias), schedule('body', canonical, alias)];
  const range = data => ({ getValues: () => data, getDisplayValues: () => data, setValue() { return this; }, setNumberFormat() { return this; } });
  const contract = { getLastRow: () => 2, getRange: () => range(values) };
  const schedules = { getLastRow: () => 3, getRange: () => range(rows) };
  c.SpreadsheetApp = { getActiveSpreadsheet: () => ({ getSheetByName: name => ({ '계약마스터': contract, '스케줄상세': schedules, '장비마스터': equipmentSheet })[name] }), flush() {} };
  c.getScheduleData = () => [];
  c.regenerateContractById = () => ({ success: true });
  const result = c.extendRegisteredTrade({ tradeId: '260915-006', endDate: '2026-10-20', endTime: '03:00' });
  assert.equal(result.success, true, JSON.stringify(result));
  assert.deepEqual(plain(result.checkedItems), [canonical]);
});
