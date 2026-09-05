const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

function section(source, start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, `${start} section not found`);
  return source.slice(from, to);
}

// 실측: GAS 웹앱 왕복은 가벼운 함수도 2.5~3.5초. 단건 removeEquip으로 N개를 빼면
// N배로 늘고, 그 동안 앱이 같은 거래의 다른 변경을 전부 막아 업무가 멈췄다.
// 배치는 왕복·잠금·계약서 재생성 예약을 각각 1회로 묶는다.
function harness({ rows: initialRows, checkoutStarted = false, outerLockHeld = false }) {
  const gas = read('checkAvailability.js');
  const helpers = section(gas, 'function normalizeDashboardMutationId_', '\nfunction dashboardSetupCanonicalResult_');
  const body = section(gas, 'function resolveDashboardRemovalRows_', '\n/** "yyyy-MM-dd"');

  let rows = initialRows.map((r) => r.slice());
  const values = new Map();
  const props = {
    getProperty: (k) => (values.has(k) ? values.get(k) : null),
    setProperty: (k, v) => values.set(k, String(v)),
    deleteProperty: (k) => values.delete(k),
    getProperties: () => Object.fromEntries(values),
  };
  const calls = { deletes: [], projections: [], regens: [], triggerLockStates: [], lockTries: 0, invalidations: 0 };
  let lockHeld = outerLockHeld;

  const sheet = {
    getLastRow: () => rows.length + 1,
    getRange: () => ({ getValues: () => rows.map((r) => r.slice()) }),
  };

  const context = {
    Date,
    JSON,
    Math,
    Object,
    Array,
    String,
    Number,
    DASHBOARD_MUTATION_LOG_PREFIX_: 'dashboardMutationLog_v2_',
    DASHBOARD_MUTATION_LOG_TTL_MS_: 30 * 60 * 1000,
    CacheService: { getScriptCache: () => ({ get: () => '1', put() {} }) },
    PropertiesService: { getScriptProperties: () => props },
    LockService: {
      getScriptLock: () => ({
        tryLock() { calls.lockTries += 1; lockHeld = true; return true; },
        releaseLock() { lockHeld = false; },
      }),
    },
    SpreadsheetApp: {
      getActiveSpreadsheet: () => ({ getSheetByName: (n) => (n === '스케줄상세' ? sheet : null) }),
    },
    dashboardTradeMutationLeaseError_: () => null,
    isDashboardTradeCheckoutStarted_: () => checkoutStarted,
    invalidateDashboardReturnInspectionForTrade_: () => { calls.invalidations += 1; return {}; },
    deleteDashboardRowsDescending_: (_sheet, deleteRows) => {
      calls.deletes.push(Array.from(deleteRows));
      for (const row of deleteRows) rows.splice(row - 2, 1);
    },
    scheduleDashboardStructureProjectionUnderLock_: (tid, payload) => {
      assert.equal(lockHeld, true, '구조 투영 예약은 잠금 안에서 일어나야 한다');
      calls.projections.push({ tid, payload });
    },
    scheduleContractRegenUnderLock_: (tid) => calls.regens.push(tid),
    invalidateDashboardCache() {},
    invalidateTimelineCache() {},
    ensureDashboardStructureProjectionTrigger_: () => calls.triggerLockStates.push(lockHeld),
    ensureContractRegenTrigger_: () => calls.triggerLockStates.push(lockHeld),
  };
  vm.runInNewContext(
    `${helpers}\n${body}\nthis.batch = dashboardRemoveEquipmentBatch; this.single = dashboardRemoveEquipment;`,
    context,
  );
  return { context, calls, rowsNow: () => rows };
}

const TRADE = '260810-001';
const ROWS = [
  [`${TRADE}-01`, TRADE, 'FX6 세트', 'FX6 세트'],
  [`${TRADE}-02`, TRADE, 'FX6 세트', 'FX6 바디'],
  [`${TRADE}-03`, TRADE, 'FX6 세트', '배터리'],
  [`${TRADE}-04`, TRADE, '삼각대', '삼각대'],
  [`${TRADE}-05`, TRADE, '모니터', '모니터'],
  [`${TRADE}-06`, TRADE, '조명', '조명'],
];

test('여러 품목을 한 번의 잠금·한 번의 계약서 재생성 예약으로 제외한다', () => {
  const { context, calls, rowsNow } = harness({ rows: ROWS });
  const res = context.batch(TRADE, [
    { scheduleId: `${TRADE}-04` },
    { scheduleId: `${TRADE}-05` },
    { scheduleId: `${TRADE}-06` },
  ], { mutationId: 'remove:batch-1' });

  assert.equal(res.success, true);
  assert.equal(res.removedRows, 3);
  assert.equal(calls.lockTries, 1, '왕복 1회 = 잠금 1회여야 한다');
  assert.equal(calls.deletes.length, 1, '시트 삭제도 1회로 묶여야 한다');
  assert.equal(calls.regens.length, 1, '계약서 재생성 예약이 품목마다 쌓이면 안 된다');
  assert.equal(calls.projections.length, 1);
  assert.deepEqual(rowsNow().map((r) => r[0]), [`${TRADE}-01`, `${TRADE}-02`, `${TRADE}-03`]);
});

test('행 번호가 밀리지 않도록 한 스냅샷에서 고르고 내림차순으로 지운다', () => {
  const { context, calls, rowsNow } = harness({ rows: ROWS });
  // 앞 행과 뒤 행을 섞어 요청해도 정확히 그 두 줄만 사라져야 한다.
  context.batch(TRADE, [{ scheduleId: `${TRADE}-04` }, { scheduleId: `${TRADE}-06` }], { mutationId: 'remove:batch-2' });
  assert.deepEqual(calls.deletes[0], [7, 5], '내림차순 삭제여야 행 번호가 안 밀린다');
  assert.deepEqual(rowsNow().map((r) => r[0]), [
    `${TRADE}-01`, `${TRADE}-02`, `${TRADE}-03`, `${TRADE}-05`,
  ]);
});

test('세트 헤더를 제외하면 구성품까지 함께 빠진다 (단건과 같은 규칙)', () => {
  const { context, rowsNow } = harness({ rows: ROWS });
  const res = context.batch(TRADE, [{ scheduleId: `${TRADE}-01` }], { mutationId: 'remove:set' });
  assert.equal(res.removedRows, 3, '세트 헤더 + 구성품 2개');
  assert.deepEqual(rowsNow().map((r) => r[0]), [`${TRADE}-04`, `${TRADE}-05`, `${TRADE}-06`]);
});

test('세트 전체와 그 구성품을 같이 요청해도 중복 삭제하지 않는다', () => {
  const { context, calls } = harness({ rows: ROWS });
  const res = context.batch(TRADE, [
    { scheduleId: `${TRADE}-01` }, // 세트 헤더 → 01,02,03
    { scheduleId: `${TRADE}-03` }, // 구성품 → 03 (이미 포함)
  ], { mutationId: 'remove:overlap' });
  assert.equal(res.removedRows, 3, '겹치는 행을 두 번 세면 엉뚱한 줄이 지워진다');
  assert.deepEqual(calls.deletes[0], [4, 3, 2]);
});

test('이미 빠진 품목이 섞여도 배치 전체를 실패시키지 않는다', () => {
  const { context } = harness({ rows: ROWS });
  const res = context.batch(TRADE, [
    { scheduleId: `${TRADE}-04` },
    { scheduleId: `${TRADE}-99` }, // 존재하지 않음
  ], { mutationId: 'remove:partial' });

  assert.equal(res.success, true);
  assert.equal(res.removedRows, 1);
  const missing = res.results.find((r) => r.scheduleId === `${TRADE}-99`);
  assert.equal(missing.alreadyRemoved, true, '없는 품목은 개별로 알리고 나머지는 처리되어야 한다');
  const done = res.results.find((r) => r.scheduleId === `${TRADE}-04`);
  assert.equal(done.alreadyRemoved, false);
});

test('전부 이미 빠진 요청은 시트를 건드리지 않고 성공으로 수렴한다', () => {
  const { context, calls } = harness({ rows: ROWS });
  const res = context.batch(TRADE, [{ scheduleId: `${TRADE}-98` }], { mutationId: 'remove:none' });
  assert.equal(res.success, true);
  assert.equal(res.allAlreadyRemoved, true);
  assert.equal(calls.deletes.length, 0, '지울 게 없으면 시트 쓰기도 없어야 한다');
  assert.equal(calls.regens.length, 0, '계약서 재생성도 예약하면 안 된다');
});

test('다른 거래의 품목이 섞이면 통째로 거부한다', () => {
  const { context, calls } = harness({ rows: ROWS });
  const res = context.batch(TRADE, [
    { scheduleId: `${TRADE}-04` },
    { scheduleId: '260810-002-01' },
  ], { mutationId: 'remove:mixed' });
  assert.match(String(res.error), /다른 거래의 품목/);
  assert.equal(calls.deletes.length, 0, '거부된 요청이 일부라도 지우면 안 된다');
});

test('이미 반출된 거래는 일괄 제외도 막는다', () => {
  const { context, calls } = harness({ rows: ROWS, checkoutStarted: true });
  const res = context.batch(TRADE, [{ scheduleId: `${TRADE}-04` }], { mutationId: 'remove:locked' });
  assert.match(String(res.error), /이미 반출된 품목/);
  assert.equal(calls.deletes.length, 0);
});

test('반납완료 과거 정정의 내부 capability는 반납 상태를 재오픈하거나 일반 투영을 예약하지 않는다', () => {
  const { context, calls, rowsNow } = harness({ rows: ROWS, checkoutStarted: true, outerLockHeld: true });
  const privateToken = {};
  context.REGISTERED_HISTORICAL_CORRECTION_TOKEN_ = privateToken;
  const res = context.batch(TRADE, [{ scheduleId: `${TRADE}-04` }], {
    lockAlreadyHeld: true,
    deferContractRegeneration: true,
    mutationId: 'remove:historical-correction',
    historicalCorrectionToken: privateToken,
  });

  assert.equal(res.success, true);
  assert.equal(calls.invalidations, 0, '반납완료를 다시 여는 검수 초기화는 금지된다');
  assert.deepEqual(calls.projections, [], 'Supabase의 정확한 과거 정정 단계가 구조 투영을 소유한다');
  assert.equal(rowsNow().some((row) => row[0] === `${TRADE}-04`), false);
});

test('응답만 유실된 재시도는 같은 mutationId로 수렴하고 두 번 지우지 않는다', () => {
  const { context, calls } = harness({ rows: ROWS });
  const first = context.batch(TRADE, [{ scheduleId: `${TRADE}-04` }, { scheduleId: `${TRADE}-05` }], { mutationId: 'remove:dedupe' });
  assert.equal(first.removedRows, 2);

  const retry = context.batch(TRADE, [{ scheduleId: `${TRADE}-04` }, { scheduleId: `${TRADE}-05` }], { mutationId: 'remove:dedupe' });
  assert.equal(retry.success, true, '재시도가 실패로 보이면 클라이언트가 품목을 되살린다');
  assert.equal(calls.deletes.length, 1, '두 번째 호출이 다른 줄을 지우면 안 된다');
});

test('트리거 예약은 잠금을 놓은 뒤에 한다', () => {
  const { context, calls } = harness({ rows: ROWS });
  context.batch(TRADE, [{ scheduleId: `${TRADE}-04` }], { mutationId: 'remove:trigger' });
  assert.ok(calls.triggerLockStates.length > 0);
  assert.deepEqual(
    calls.triggerLockStates.filter(Boolean),
    [],
    '트리거 I/O를 잠금 안에서 하면 다른 실행이 waitLock에서 줄줄이 실패한다',
  );
});

test('composite caller가 잠금을 보유하면 중첩 잠금과 계약서 재생성 예약을 만들지 않는다', () => {
  const { context, calls, rowsNow } = harness({ rows: ROWS, outerLockHeld: true });
  const res = context.batch(
    TRADE,
    [{ scheduleId: `${TRADE}-04` }],
    { lockAlreadyHeld: true, deferContractRegeneration: true },
  );

  assert.equal(res.success, true);
  assert.equal(calls.lockTries, 0, '바깥 잠금 안에서 ScriptLock을 다시 얻으면 BUSY가 난다');
  assert.deepEqual(calls.regens, [], 'composite가 잠금 해제 후 한 번 재생성하므로 내부 큐는 없어야 한다');
  assert.deepEqual(calls.triggerLockStates, [], '바깥 호출자가 잠금을 푼 뒤 트리거를 깨워야 한다');
  assert.equal(rowsNow().some((row) => row[0] === `${TRADE}-04`), false);
});

test('입력 한도와 필수값을 지킨다', () => {
  const { context } = harness({ rows: ROWS });
  assert.match(String(context.batch('', [{ scheduleId: `${TRADE}-04` }]).error), /tid 필수/);
  assert.match(String(context.batch(TRADE, []).error), /items 필수/);
  const tooMany = Array.from({ length: 101 }, (_, i) => ({ scheduleId: `${TRADE}-${i}` }));
  assert.match(String(context.batch(TRADE, tooMany).error), /최대 100개/);
});

test('items를 JSON 문자열로 받아도 처리한다 (GET 쿼리 경로)', () => {
  const { context } = harness({ rows: ROWS });
  const res = context.batch(TRADE, JSON.stringify([{ scheduleId: `${TRADE}-04` }]), { mutationId: 'remove:json' });
  assert.equal(res.success, true);
  assert.equal(res.removedRows, 1);
});

test('API가 배치 액션과 능력 레지스트리를 노출한다', () => {
  const api = read('sheetAPI.js');
  assert.match(api, /case "removeEquips":/);
  assert.match(api, /dashboardRemoveEquipmentBatch\(/);
  assert.match(api, /id: "equipment\.remove_batch", action: "removeEquips"/);
});

test('same-named set instances are bounded by their own header', () => {
  const duplicateSets = [
    [`${TRADE}-01`, TRADE, 'FX6 set', 'FX6 set'],
    [`${TRADE}-02`, TRADE, 'FX6 set', 'FX6 body'],
    [`${TRADE}-03`, TRADE, 'FX6 set', 'battery'],
    [`${TRADE}-04`, TRADE, 'FX6 set', 'FX6 set'],
    [`${TRADE}-05`, TRADE, 'FX6 set', 'FX6 body'],
    [`${TRADE}-06`, TRADE, 'FX6 set', 'battery'],
  ];
  const { context, rowsNow } = harness({ rows: duplicateSets });
  const result = context.batch(
    TRADE,
    [{ scheduleId: `${TRADE}-01` }],
    { mutationId: 'remove:one-set-instance' },
  );

  assert.equal(result.success, true);
  assert.equal(result.removedRows, 3);
  assert.deepEqual(rowsNow().map((row) => row[0]), [
    `${TRADE}-04`, `${TRADE}-05`, `${TRADE}-06`,
  ]);
});
