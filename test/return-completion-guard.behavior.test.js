const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');

function loadTypeScriptModule(relativePath) {
  const ts = require(path.join(root, 'apps/today-dashboard/node_modules/typescript'));
  const filename = path.join(root, relativePath);
  const source = fs.readFileSync(filename, 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
    fileName: filename,
  }).outputText;
  const mod = new Module(filename, module);
  mod.filename = filename;
  mod.paths = Module._nodeModulePaths(path.dirname(filename));
  mod._compile(compiled, filename);
  return mod.exports;
}

const status = loadTypeScriptModule('apps/today-dashboard/lib/domain/status.ts');

function checkoutBaselineHarness(existingItems) {
  const source = fs.readFileSync(path.join(root, 'supabaseSync.js'), 'utf8');
  const start = source.indexOf('function supaCaptureCheckoutBaseline_');
  const endMarker = source.indexOf('\n}\n\n/**', start);
  assert.ok(start >= 0 && endMarker > start, 'supaCaptureCheckoutBaseline_ source must be extractable');
  const writes = [];
  const context = {
    SUPA_CFG_: () => ({ url: 'test' }),
    supaGetCheckoutBaselineState_: () => ({ ok: true, started: existingItems.length > 0, items: existingItems }),
    markDashboardCheckoutBaselineStarted_: () => {},
    supaUpsert_: (_cfg, table, rows, conflict) => {
      writes.push({ table, rows, conflict });
      return true;
    },
  };
  vm.runInNewContext(`${source.slice(start, endMarker + 2)}\nthis.capture = supaCaptureCheckoutBaseline_;`, context);
  return { capture: context.capture, writes };
}

function trade(returnCounts, equipments) {
  return {
    tradeId: '260710-003',
    returnCounts,
    equipments,
  };
}

const body = { scheduleId: 'BODY', name: '소니 FX9 바디', qty: 1, takenQty: 1, checkoutState: 'taken' };
const sdi = { scheduleId: 'SDI', name: 'SDI 롱라인', qty: 6, takenQty: 6, checkoutState: 'taken' };

test('불변 반출 기준선 도입 전의 닫힌 카드는 소급해서 확인필요로 되살리지 않는다', () => {
  const legacy = {
    tradeId: '260101-001',
    checkoutAt: '2026-01-01T09:00:00+09:00',
    returnAt: '2026-01-01T18:00:00+09:00',
    contractStatus: '반납완료',
    setupDone: true,
    returnDone: true,
    returnCounts: {},
    riskWarnings: [],
    equipments: [{ scheduleId: 'LEGACY', name: '과거 장비', qty: 3, checkoutState: 'taken' }],
  };

  assert.deepEqual(status.returnCompletionBlockers(legacy), []);
  assert.equal(status.attentionReason(legacy, '2026-07-14'), null);
  assert.equal(status.cardDone(legacy, '2026-07-14', 'checkin'), true);
});

test('반출 6개 중 5개만 확인하면 SDI 롱라인 1개 미확인으로 완료를 차단한다', () => {
  assert.equal(typeof status.returnCompletionBlockers, 'function', 'returnCompletionBlockers가 필요합니다');
  const blockers = status.returnCompletionBlockers(
    trade(
      {
        BODY: { good: 1, damaged: 0, lost: 0 },
        SDI: { good: 5, damaged: 0, lost: 0 },
      },
      [body, sdi],
    ),
  );
  assert.deepEqual(blockers, [
    {
      scheduleId: 'SDI',
      name: 'SDI 롱라인',
      expected: 6,
      accounted: 5,
      missing: 1,
      over: 0,
    },
  ]);
});

test('정상 5개와 분실 1개로 반출 6개가 모두 설명되면 수량 완료를 허용한다', () => {
  assert.equal(typeof status.returnCompletionBlockers, 'function', 'returnCompletionBlockers가 필요합니다');
  const blockers = status.returnCompletionBlockers(
    trade({ SDI: { good: 5, damaged: 0, lost: 1 } }, [sdi]),
  );
  assert.deepEqual(blockers, []);
});

test('아예 손대지 않은 반납 품목도 전체 수량을 미확인으로 차단한다', () => {
  assert.equal(typeof status.returnCompletionBlockers, 'function', 'returnCompletionBlockers가 필요합니다');
  const blockers = status.returnCompletionBlockers(trade({}, [sdi]));
  assert.equal(blockers[0].missing, 6);
});

test('반납 합계가 반출 수량보다 많아도 완료를 차단한다', () => {
  assert.equal(typeof status.returnCompletionBlockers, 'function', 'returnCompletionBlockers가 필요합니다');
  const blockers = status.returnCompletionBlockers(
    trade({ SDI: { good: 7, damaged: 0, lost: 0 } }, [sdi]),
  );
  assert.equal(blockers[0].over, 1);
});

test('반출에서 명시적으로 제외된 품목은 반납 완료 검증에서 제외한다', () => {
  assert.equal(typeof status.returnCompletionBlockers, 'function', 'returnCompletionBlockers가 필요합니다');
  const excluded = { ...sdi, checkoutState: 'excluded' };
  assert.deepEqual(status.returnCompletionBlockers(trade({}, [excluded])), []);
});

test('같은 세트명으로 독립 반출된 대표행 둘을 모두 검증해 첫 행 누락을 숨기지 않는다', () => {
  const headers = [
    { scheduleId: 'A', name: '지선', setName: '지선', isSetHeader: true, qty: 1, takenQty: 1, checkoutState: 'taken' },
    { scheduleId: 'B', name: '지선', setName: '지선', isSetHeader: true, qty: 1, takenQty: 1, checkoutState: 'taken' },
  ];
  const blockers = status.returnCompletionBlockers(
    trade({ B: { good: 1, damaged: 0, lost: 0 } }, headers),
  );
  assert.deepEqual(blockers, [{
    scheduleId: 'A', name: '지선', expected: 1, accounted: 0, missing: 1, over: 0,
  }]);
});

test('이미 6개로 고정된 반출 기준선은 현재 시트가 5개로 바뀌어도 절대 덮어쓰지 않는다', () => {
  const baseline = [{
    schedule_id: 'SDI', name: 'SDI 롱라인', qty: 6, taken_qty: 6,
    set_name: null, is_set_header: false, is_component: false,
  }];
  const { capture, writes } = checkoutBaselineHarness(baseline);
  const result = capture('260710-003', [{ scheduleId: 'SDI', name: 'SDI 롱라인', qty: 5 }], true);
  assert.equal(result.ok, false);
  assert.match(result.error, /이미 고정된 반출 기준선/);
  assert.equal(writes.length, 0);
});

test('같은 기준선 재확인은 재사용하고, 현장 추가 품목은 기존 기준선을 건드리지 않고 새 행만 추가한다', () => {
  const baseline = [{
    schedule_id: 'SDI', name: 'SDI 롱라인', qty: 6, taken_qty: 6,
    set_name: null, is_set_header: false, is_component: false,
  }];
  const same = checkoutBaselineHarness(baseline);
  assert.deepEqual(
    JSON.parse(JSON.stringify(same.capture('260710-003', [{ scheduleId: 'SDI', name: 'SDI 롱라인', qty: 6 }], true))),
    { ok: true, count: 1, reused: true },
  );
  assert.equal(same.writes.length, 0);

  const append = checkoutBaselineHarness(baseline);
  const result = append.capture('260710-003', [{ scheduleId: 'ONS-1', name: 'SDI 롱라인', qty: 1, onsite: true }], false);
  assert.equal(result.ok, true);
  assert.equal(append.writes.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(append.writes[0].rows.map((row) => row.schedule_id))), ['ONS-1']);
  assert.equal(append.writes[0].rows[0].taken_qty, 1);
});
