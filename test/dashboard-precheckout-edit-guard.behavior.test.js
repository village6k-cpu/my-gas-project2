const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'checkAvailability.js'), 'utf8');

function loadGuard(properties, durableResult) {
  const start = source.indexOf('function isDashboardTradeCheckoutStarted_');
  const end = source.indexOf('\n}\n\nfunction dashboardAddEquipments', start);
  assert.ok(start >= 0 && end > start, 'checkout guard source must be extractable');

  let durableCalls = 0;
  const context = {
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (key) => properties[key] ?? null,
      }),
    },
    CacheService: {
      getScriptCache: () => ({ get: () => null, put() {}, remove() {} }),
    },
    Logger: { log() {} },
    findDashboardRowsByValue_: (_sheet, column) => column === 1 || column === 2 ? [2] : [],
    supaGetCheckoutBaselineState_: () => {
      durableCalls += 1;
      return durableResult;
    },
  };
  vm.runInNewContext(`${source.slice(start, end + 2)}\nthis.guard = isDashboardTradeCheckoutStarted_;`, context);
  return { guard: context.guard, durableCalls: () => durableCalls };
}

function spreadsheet({ contractStatus = '예약', scheduleStatus = '대기' } = {}) {
  return {
    getSheetByName(name) {
      const row = name === '계약마스터'
        ? ['260715-007', '', '', '', '', '', '', '', '', contractStatus]
        : ['260715-007', '', '', '', '', '', '', '', scheduleStatus];
      return {
        getLastRow: () => 2,
        getRange: () => ({ getDisplayValues: () => [row] }),
      };
    },
  };
}

test('반출 전 거래 편집은 외부 기준선 조회 장애와 무관하게 즉시 허용한다', () => {
  const { guard, durableCalls } = loadGuard({}, { ok: false, error: 'temporary auth failure' });
  assert.equal(guard(spreadsheet(), '260715-007'), false);
  assert.equal(durableCalls(), 0, 'global edit lock must not perform a Supabase HTTP lookup');
});

// 계약 변경: '헤이빌리 카드 저장 잠금 제거' 시리즈 이후 편집 잠금 기준은
// 반출 시작이 아니라 반납완료다. 반출중 거래는 현장 즉시 저장을 위해 편집이 허용되고,
// 반출 시점 데이터 보존은 Supabase 반출 기준선 스냅샷이 담당한다.
test('반납완료 영구 표식이 있으면 완료 체크를 다시 열어도 편집을 차단한다', () => {
  const { guard, durableCalls } = loadGuard(
    { 'returnDone_260715-007': '1' },
    { ok: true, started: false, items: [] },
  );
  assert.equal(guard(spreadsheet(), '260715-007'), true);
  assert.equal(durableCalls(), 0);
});

test('계약 상태가 반납완료면 영구 표식 없이도 편집을 차단한다', () => {
  const contract = loadGuard({}, { ok: true, started: false, items: [] });
  assert.equal(contract.guard(spreadsheet({ contractStatus: '반납완료' }), '260715-007'), true);
});

test('반출중 거래는 현장 즉시 저장을 위해 편집이 허용된다', () => {
  const contract = loadGuard({}, { ok: true, started: false, items: [] });
  assert.equal(contract.guard(spreadsheet({ contractStatus: '반출중' }), '260715-007'), false);
  const schedule = loadGuard({}, { ok: true, started: false, items: [] });
  assert.equal(schedule.guard(spreadsheet({ scheduleStatus: '반출중' }), '260715-007'), false);
});

test('Supabase 기준선 저장 성공 경로는 영구 표식을 함께 기록한다', () => {
  const supabase = fs.readFileSync(path.join(root, 'supabaseSync.js'), 'utf8');
  assert.match(
    supabase,
    /function supaCaptureCheckoutBaseline_[\s\S]*markDashboardCheckoutBaselineStarted_\(tid\)/,
  );
});

test('새 기준선은 로컬 영구 표식을 먼저 확보한 뒤 Supabase에 기록한다', () => {
  const supabase = fs.readFileSync(path.join(root, 'supabaseSync.js'), 'utf8');
  const start = supabase.indexOf('function supaCaptureCheckoutBaseline_');
  const end = supabase.indexOf('\n}\n\n/**', start);
  const capture = supabase.slice(start, end + 2);
  assert.ok(
    capture.lastIndexOf('markDashboardCheckoutBaselineStarted_(tid)') < capture.indexOf("supaUpsert_(cfg, 'schedule_items'"),
    'baseline marker must exist before the durable row is written',
  );
});

test('편집 가드는 전체 시트를 읽지 않고 거래ID 행만 조회한다', () => {
  const start = source.indexOf('function isDashboardTradeCheckoutStarted_');
  const end = source.indexOf('\n}\n\nfunction dashboardAddEquipments', start);
  const guard = source.slice(start, end + 2);
  // 반납완료 판정은 계약마스터 J열만으로 충분해 스케줄상세 조회는 제거됐다.
  // 남은 조회도 반드시 거래ID 행 단위여야 하며 전체 범위 스캔으로 되돌아가면 안 된다.
  assert.match(guard, /findDashboardRowsByValue_\(master, 1,/);
  assert.doesNotMatch(guard, /getRange\(2, 1, master\.getLastRow\(\) - 1, 10\)/);
  assert.doesNotMatch(guard, /getRange\(2, 2, sched\.getLastRow\(\) - 1, 9\)/);
});
