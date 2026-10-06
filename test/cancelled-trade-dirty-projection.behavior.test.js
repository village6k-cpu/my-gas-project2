const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '..', 'supabaseSync.js'), 'utf8');
const start = source.indexOf('function flushDirtyToSupabase()');
const body = source.slice(start, source.indexOf('\n/** 거래ID 배열', start));
const TID = '261005-008';

function fixture({ cancelOk = true, authorityOk = true, checkoutStarted = false } = {}) {
  const key = 'SUPA_DIRTY_v2_' + TID;
  const values = new Map([[key, 'revision-1']]);
  const calls = [];
  let locked = false;
  const props = {
    getProperties: () => Object.fromEntries(values),
    getProperty: (k) => values.get(k),
    deleteProperty: (k) => values.delete(k),
  };
  const context = {
    SUPA_DIRTY_PREFIX_: 'SUPA_DIRTY_v2_',
    Logger: { log() {} },
    PropertiesService: { getScriptProperties: () => props },
    LockService: { getScriptLock: () => ({ tryLock: () => { locked = true; return true; }, releaseLock: () => { locked = false; } }) },
    rescueDashboardAsyncWorkerTriggers_() {},
    SUPA_CFG_: () => ({ url: 'https://example.invalid', apikey: 'test' }),
    migrateLegacySupaDirtyProperties_() {},
    buildSupabaseTrades_: () => ({ trades: [], items: [], cancelledTradeIds: [TID] }),
    supaGetCheckoutAuthorityStates_: () => ({ ok: authorityOk, states: { [TID]: { started: checkoutStarted } } }),
    supaCancelTrade_(tid) {
      assert.equal(locked, false, '취소 DB 호출은 전역 잠금 밖에서 실행해야 한다');
      calls.push(tid);
      return { ok: cancelOk };
    },
  };
  vm.createContext(context);
  vm.runInContext(body, context);
  return { run: () => context.flushDirtyToSupabase(), calls, values, key };
}

test('1분 동기화가 취소 상태와 DB 점유 삭제를 함께 반영한 뒤 dirty를 지운다', () => {
  const f = fixture(); f.run();
  assert.deepEqual(f.calls, [TID]);
  assert.equal(f.values.has(f.key), false);
});

test('취소 DB 반영이 실패하면 dirty를 남겨 다음 주기에 재시도한다', () => {
  const f = fixture({ cancelOk: false }); f.run();
  assert.deepEqual(f.calls, [TID]);
  assert.equal(f.values.has(f.key), true);
});

for (const scenario of [{ checkoutStarted: true }, { authorityOk: false }]) {
  test('반출됐거나 반출 권한 확인이 실패하면 점유를 삭제하지 않는다: ' + JSON.stringify(scenario), () => {
    const f = fixture(scenario); f.run();
    assert.deepEqual(f.calls, []);
    assert.equal(f.values.has(f.key), true);
  });
}
