const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require.resolve('../checkAvailability.js'), 'utf8');
const code = source.slice(source.indexOf('function updateTradePaymentMethod('), source.indexOf('function applyTradePaymentSideEffects_('));
function run(found, applied) {
  const dirty = []; const writes = []; const releases = [];
  const sheet = {
    getLastRow: () => 2, getLastColumn: () => 13,
    getRange: (row, col) => ({
      getDisplayValues: () => row === 1 ? [['거래ID']] : [[found ? 'T1' : 'T2']],
      setValue: value => writes.push({ row, col, value })
    })
  };
  const ctx = vm.createContext({
    getTradePaymentOptions_: () => ['카드결제'],
    claimDashboardAuxMutation_: () => 'claim',
    releaseDashboardAuxMutation_: claim => releases.push(claim),
    PropertiesService: { getScriptProperties: () => ({ getProperty: () => 'configured' }) },
    SpreadsheetApp: { openByUrl: () => ({ getSheetByName: () => sheet }) },
    _findHeaderCol_: () => 5,
    applyTradePaymentSideEffects_: () => ({ applied, warning: applied ? '' : '입금상태 드롭다운 오류' }),
    invalidateDashboardTradeExtraCache_: () => {}, touchDashboardSearchCacheVersion_: () => {},
    invalidateDashboardCache: () => {}, supaMarkTradeDirty_: id => dirty.push(id)
  });
  vm.runInContext(code, ctx);
  const result = ctx.updateTradePaymentMethod('T1', '카드결제');
  assert.deepEqual(releases, ['claim']);
  return { result, dirty, writes };
}
let r = run(true, true);
assert.equal(r.result.success, true); assert.deepEqual(r.dirty, ['T1']);
assert.deepEqual(r.writes, [{row:2, col:10, value:'카드결제'}]);
r = run(false, true);
assert.equal(r.result.success, false); assert.deepEqual(r.dirty, []);
r = run(true, false);
assert.equal(r.result.wroteSheet, true); assert.equal(r.result.success, false);
assert.match(r.result.warning, /드롭다운/); assert.deepEqual(r.dirty, ['T1']);
console.log('card payment mirror and partial-write checks passed');
