'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const tid = '260827-012';
const row = (suffix) => ({ schedule_id: `${tid}-${suffix}`, trade_id: tid, name: '시네로이드 CFL-800', qty: 2, sort: 22, set_name: '시네로이드 CFL-800', is_set_header: true, is_component: false, category: null });
function fixture() {
  const calls = [];
  const ctx = { Logger: { log() {} }, UrlFetchApp: { fetch(url, opts) { calls.push({ url, ...opts }); return { getResponseCode: () => 201 }; } } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../supabaseSync.js'), 'utf8'), ctx);
  ctx.supaToken_ = () => 'test-token';
  return { calls, run: (rows, ids) => ctx.supaInsertAuthorizedScheduleItems_({ url: 'https://example.invalid', apikey: 'test' }, tid, rows, ids) };
}
test('only exact authorized added IDs can insert, without replacing existing checkout state', () => {
  const f = fixture();
  assert.equal(f.run([row('01'), { ...row('23'), taken_qty: 2, checkout_state: 'taken', actual_name: 'do not copy' }], [`${tid}-23`]), true);
  const req = f.calls[0];
  assert.match(req.headers.Prefer, /resolution=ignore-duplicates/);
  const rows = JSON.parse(req.payload);
  assert.equal(rows.length, 1); assert.equal(rows[0].schedule_id, `${tid}-23`);
  assert.equal(rows[0].checkout_state, 'pending');
  assert.equal('taken_qty' in rows[0], false); assert.equal('actual_name' in rows[0], false);
});
test('missing or wrong-trade added IDs fail before HTTP; an empty grant cannot insert', () => {
  for (const [rows, ids] of [[[], [`${tid}-23`]], [[row('23')], ['260827-013-23']]]) {
    const f = fixture(); assert.equal(f.run(rows, ids), false); assert.equal(f.calls.length, 0);
  }
  const f = fixture(); assert.equal(f.run([row('23')], []), true); assert.equal(f.calls.length, 0);
});
test('queue keeps added IDs across revisions, separate from retired baseline data', () => {
  const state = {};
  const props = { getProperty: (k) => state[k], setProperty: (k, v) => { state[k] = v; } };
  const ctx = { PropertiesService: { getScriptProperties: () => props } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../checkAvailability.js'), 'utf8'), ctx);
  ctx.activeDashboardMutationLease_ = () => null; ctx.supaMarkTradeDirty_ = () => {};
  ctx.scheduleDashboardStructureProjectionUnderLock_(tid, { syncStructure: true, addedScheduleIds: [`${tid}-23`] });
  ctx.scheduleDashboardStructureProjectionUnderLock_(tid, { addedScheduleIds: [`${tid}-23`, `${tid}-24`] });
  const task = JSON.parse(state[ctx.DASHBOARD_STRUCTURE_QUEUE_PREFIX_ + tid]);
  assert.deepEqual(task.addedScheduleIds, [`${tid}-23`, `${tid}-24`]);
  assert.equal(task.revision, 2);
});

test('checkout-started worker inserts authorized rows before patch and retains failed work', () => {
  const state = {};
  const props = { getProperty: (k) => state[k], getProperties: () => ({ ...state }),
    setProperty: (k, v) => { state[k] = v; }, deleteProperty: (k) => { delete state[k]; } };
  const calls = [];
  let insertOk = false;
  const ctx = { PropertiesService: { getScriptProperties: () => props }, Logger: { log() {} },
    ScriptApp: { getProjectTriggers: () => [] }, SpreadsheetApp: { getActiveSpreadsheet: () => ({}) },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../checkAvailability.js'), 'utf8'), ctx);
  Object.assign(ctx, { activeDashboardMutationLease_: () => null, supaMarkTradeDirty_: () => {},
    ensureDashboardStructureProjectionTrigger_: () => {}, isDashboardTradeCheckoutStarted_: () => true,
    SUPA_CFG_: () => ({}), buildSupabaseTrades_: () => ({ trades: [], items: [row('01'), row('23')] }),
    supaInsertAuthorizedScheduleItems_: (cfg, tradeId, rows, ids) => { calls.push(['insert', ...ids]); return insertOk; },
    supaPatchExistingScheduleItems_: () => { calls.push(['patch']); return true; },
    supaUpsertGrouped_: () => { throw new Error('no broad upsert after checkout'); } });
  ctx.scheduleDashboardStructureProjectionUnderLock_(tid, { syncStructure: true, addedScheduleIds: [`${tid}-23`] });
  ctx.flushDashboardStructureProjectionQueue_();
  const key = ctx.DASHBOARD_STRUCTURE_QUEUE_PREFIX_ + tid;
  assert.equal(JSON.parse(state[key]).attempts, 1);
  assert.deepEqual(calls, [['insert', `${tid}-23`]]);
  const task = JSON.parse(state[key]); task.nextAt = 0; state[key] = JSON.stringify(task);
  insertOk = true; calls.length = 0;
  ctx.flushDashboardStructureProjectionQueue_();
  assert.deepEqual(calls, [['insert', `${tid}-23`], ['patch']]);
  assert.equal(state[key], undefined);
});

test('onsite retry after append restores the exact insertion grant before marking done', () => {
  const source = fs.readFileSync(path.join(__dirname, '../checkAvailability.js'), 'utf8');
  const start = source.indexOf('if (reservation.all) {');
  const end = source.indexOf('if (!reservation.none', start);
  const branch = source.slice(start, end);
  const events = [];
  const existingIdem = { state: 'pending' };
  const ctx = { tid, existingIdem, idemRows: [existingIdem], idemProp: 'idempotency', idemHash: 'id',
    reservedRows: [{ scheduleId: `${tid}-23` }], reservation: { all: true, items: [row('23')] },
    PropertiesService: { getScriptProperties: () => ({ setProperty: () => events.push('done') }) },
    scheduleDashboardStructureProjectionUnderLock_: (tradeId, patch) => {
      assert.equal(tradeId, tid); assert.equal(existingIdem.state, 'pending');
      assert.deepEqual(Array.from(patch.addedScheduleIds), [`${tid}-23`]); events.push('queue');
    }, scheduleContractRegenUnderLock_: () => {} };
  vm.runInNewContext(`onsiteMutationWork: { ${branch} }`, ctx);
  assert.deepEqual(events, ['queue', 'done']);
  assert.equal(ctx.addResult.recovered, true);
});
