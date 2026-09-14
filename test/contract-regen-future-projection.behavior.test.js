const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const read = name => fs.readFileSync(path.join(__dirname, '..', name), 'utf8').replaceAll('\r\n', '\n');
const section = (source, start, end) => {
  const from = source.indexOf(start), to = source.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, start);
  return source.slice(from, to);
};
const plain = value => JSON.parse(JSON.stringify(value));
const TID = '260914-999', START = '2026-09-18', END = '2026-09-20';

function harness({ fail = false, refillBeforeFinish = false } = {}) {
  const now = Date.parse('2026-09-14T08:00:00Z');
  class FixedDate extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  }
  const values = { [`contractEditTS_${TID}`]: String(now - 10000), '개고생2_URL': 'fixture-ledger' };
  const props = {
    getProperty: key => values[key] || null,
    getProperties: () => ({ ...values }),
    setProperty: (key, value) => { values[key] = value; },
    deleteProperty: key => { delete values[key]; },
  };
  const ledger = { url: '', amount: null };
  const stale = { tradeId: TID, name: 'fixture', contractUrl: '', actualAmount: null, contractRegenPending: true, returnMemo: '', equipments: [] };
  const cache = new Map([[`dashboard_v7_${START}`, stale], [`dashboard_v7_${END}`, stale], ['dashboard_v7_2026-10-02', { untouched: true }]]);
  const sheetRow = [TID, 'fixture', '', '', START, '10:00', END, '10:00', 2, '예약', '일반'];
  const contractSheet = {
    getLastRow: () => 2,
    getRange: (row, col, count = 1, width = 1) => {
      const selected = sheetRow.slice(col - 1, col - 1 + width);
      return { getValues: () => [selected], getDisplayValues: () => [selected] };
    },
  };
  const scheduleSheet = {
    getLastRow: () => 2,
    getRange: () => ({ getValues: () => [[`${TID}-01`, TID, '', 'fixture camera', 1, START, '10:00', END, '10:00', '대기', '']] }),
  };
  const ledgerSheet = {
    getLastRow: () => 2,
    getRange: (_row, col) => ({
      getValues: () => [[TID]],
      getValue: () => col === 3 ? ledger.url : ledger.amount,
      setValue: value => { if (col === 3) ledger.url = value; else ledger.amount = Number(value); },
    }),
  };
  const ss = { getSheetByName: name => name === '계약마스터' ? contractSheet : name === '스케줄상세' ? scheduleSheet : null };
  let projected = null, dirtyCalls = 0;
  const context = {
    Date: FixedDate, JSON, Math, Object, String, Number, Array,
    Logger: { log() {} },
    PropertiesService: { getScriptProperties: () => props },
    CacheService: { getScriptCache: () => ({ remove: key => cache.delete(key) }) },
    SpreadsheetApp: { getActiveSpreadsheet: () => ss, openByUrl: () => ({ getSheetByName: () => ledgerSheet }), flush() {} },
    Utilities: { sleep() {}, formatDate: date => new Date(date.getTime() + 9 * 3600000).toISOString().slice(0, 10) },
    ScriptApp: { getProjectTriggers: () => [] },
    CONTRACT_REGEN_TRIGGER_PROP_: 'trigger', CONTRACT_REGEN_TRIGGER_STALE_MS_: 600000, CONTRACT_REGEN_RETRY_PREFIX_: 'retry:',
    armContractRegenRunWatchdog_: () => true,
    claimPendingContractRegen_: () => ({ claimed: true, tradeId: TID }),
    clearContractRegenWatchdogIfIdle_() {}, replaceOneShotTrigger_() {}, parseContractRegenRetry_: () => ({}),
    invalidateDashboardTradeExtraCache_() {}, invalidateTimelineCache() {}, touchDashboardSearchCacheVersion_() {},
    removeDashboardCacheJson_: (_cache, key) => cache.delete(key),
    parseDT: (date, time) => new Date(`${date}T${time}:00+09:00`),
    getTimelineData: () => ({ groups: [], items: [{ tid: TID, s: Date.parse(`${START}T10:00:00+09:00`), e: Date.parse(`${END}T10:00:00+09:00`) }] }),
    getDashboardData(date) {
      const key = `dashboard_v7_${date}`;
      if (!cache.has(key)) cache.set(key, { ...stale, contractUrl: ledger.url, actualAmount: ledger.amount, contractRegenPending: !!values[`contractEditTS_${TID}`] });
      return { checkout: [cache.get(key)], checkin: [] };
    },
    deleteAndRegenerateContract() {
      if (fail) throw new Error('fixture regeneration failure');
      ledger.url = 'https://example.invalid/new-contract'; ledger.amount = 79200;
      return { linkUpdate: { success: true } };
    },
    finishPendingContractRegen_(_props, _claim, outcome) {
      if (!outcome.success) return { pending: true, nextAt: now + 3000 };
      // A concurrent reader can cache pending=true between document creation and
      // queue completion. Completion must invalidate this cache before dirty push.
      if (refillBeforeFinish) context.getDashboardData(START);
      delete values[`contractEditTS_${TID}`];
      return { success: true };
    },
    supaMarkTradeDirty_() { dirtyCalls++; projected = plain(context.buildSupabaseTrades_([TID])); },
    setTradeAmountValue_: (range, amount) => range.setValue(amount),
  };
  vm.createContext(context);
  const code = read('Code.js'), gas = read('checkAvailability.js'), gen = read('generatecontract.js'), supa = read('supabaseSync.js');
  vm.runInContext([
    section(gas, 'function dashboardDateKey_', '/**\n * 거래ID 반출세팅'),
    section(code, 'function scheduleContractRegenUnderLock_', '/** queue 표식'),
    section(code, 'function regenPendingContracts()', '// ─────────────────'),
    section(gen, 'function clearDirectContractRegenPending_', 'function getGeneratedContractSummary_'),
    section(gen, 'function updateContractLink(', 'function '),
    section(supa, 'function buildSupabaseTrades_', '/** payload 키 구성이'),
  ].join('\n'), context);
  return { context, cache, values, ledger, get projected() { return projected; }, get dirtyCalls() { return dirtyCalls; } };
}

function assertProjection(fixture) {
  assert.equal(fixture.projected.trades.length, 1);
  const row = fixture.projected.trades[0];
  assert.equal(row.amount, 79200);
  assert.equal(row.contract_url, 'https://example.invalid/new-contract');
  assert.equal(row.contract_regen_pending, false);
  for (const key of ['setup_done', 'return_done', 'setup_done_at', 'return_done_at', 'note_checkin']) assert.equal(key in row, false, key);
  for (const item of fixture.projected.items) {
    for (const key of ['checkout_state', 'taken_qty', 'returned_qty', 'actual_name']) assert.equal(key in item, false, key);
  }
  assert.equal(fixture.cache.has(`dashboard_v7_${END}`), false, 'return date also invalidated');
  assert.deepEqual(fixture.cache.get('dashboard_v7_2026-10-02'), { untouched: true });
}

test('enqueue invalidates the future checkout and return dates without touching unrelated dates', () => {
  const f = harness(); f.context.scheduleContractRegenUnderLock_(TID);
  assert.equal(f.cache.has(`dashboard_v7_${START}`), false);
  assert.equal(f.cache.has(`dashboard_v7_${END}`), false);
  assert.equal(f.cache.has('dashboard_v7_2026-10-02'), true);
});

for (const refillBeforeFinish of [false, true]) {
  test(`completed contract projects current future documents after queue clear (interleaved reader=${refillBeforeFinish})`, () => {
    const f = harness({ refillBeforeFinish }); f.context.regenPendingContracts(); assertProjection(f);
    assert.equal(f.dirtyCalls, 1);
  });
}

test('failed contract generation retains pending work and does not publish completion', () => {
  const f = harness({ fail: true }); f.context.regenPendingContracts();
  assert.ok(f.values[`contractEditTS_${TID}`]); assert.equal(f.dirtyCalls, 0);
});

test('direct regeneration invalidates future cache before dirty synchronization', () => {
  const f = harness(); f.ledger.url = 'https://example.invalid/new-contract'; f.ledger.amount = 79200;
  f.context.clearDirectContractRegenPending_(TID); assertProjection(f);
});

test('verified contract link/amount write invalidates future cache before dirty synchronization', () => {
  const f = harness(); delete f.values[`contractEditTS_${TID}`];
  const result = f.context.updateContractLink(TID, 'https://example.invalid/new-contract', 79200, { strict: true });
  assert.equal(result.success, true); assertProjection(f);
});

for (const noteLookupFails of [false, true]) {
  test(`projection repair preserves app notes and physical state (note lookup failure=${noteLookupFails})`, () => {
    const state = {}, saved = [];
    const props = { getProperty: key => state[key], getProperties: () => ({ ...state }), setProperty: (key, value) => { state[key] = value; }, deleteProperty: key => { delete state[key]; } };
    const ctx = { PropertiesService: { getScriptProperties: () => props }, Logger: { log() {} },
      ScriptApp: { getProjectTriggers: () => [] }, SpreadsheetApp: { getActiveSpreadsheet: () => ({}) },
      LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) },
      UrlFetchApp: { fetch: () => ({ getResponseCode: () => noteLookupFails ? 503 : 200, getContentText: () => JSON.stringify([{ trade_id: TID, note_checkin: 'staff edited note' }]) }) },
    };
    vm.runInNewContext(read('supabaseSync.js') + '\n' + read('checkAvailability.js'), ctx);
    Object.assign(ctx, { activeDashboardMutationLease_: () => null, supaMarkTradeDirty_() {},
      ensureDashboardStructureProjectionTrigger_() {}, isDashboardTradeCheckoutStarted_: () => false,
      SUPA_CFG_: () => ({ url: 'https://example.invalid', apikey: 'fixture' }), supaToken_: () => 'fixture',
      buildSupabaseTrades_: () => ({ trades: [{ trade_id: TID, amount: 79200, contract_url: 'https://example.invalid/new-contract', contract_regen_pending: false, note_checkin: 'stale sheet note' }], items: [] }),
      supaInsertAuthorizedScheduleItems_: () => true,
      supaUpsertGrouped_: (_cfg, table, rows) => { saved.push({ table, rows: plain(rows) }); return true; },
    });
    ctx.scheduleDashboardStructureProjectionUnderLock_(TID, { syncStructure: true });
    ctx.flushDashboardStructureProjectionQueue_();
    assert.equal(saved.length, 1);
    const delta = saved[0].rows[0];
    assert.equal('note_checkin' in delta, false, 'stale or unverified sheet notes must not replace an app note');
    const before = { note_checkin: 'staff edited note', setup_done: true, return_done: false, photo_urls: ['manual-photo'] };
    const after = { ...before, ...delta };
    for (const [key, value] of Object.entries(before)) assert.deepEqual(after[key], value);
    assert.equal(after.amount, 79200);
    assert.equal(state[ctx.DASHBOARD_STRUCTURE_QUEUE_PREFIX_ + TID], undefined);
  });
}
