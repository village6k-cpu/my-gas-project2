const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

test('앱 저장 계층이 미완료 수량을 검사한 뒤에만 반납완료를 요청한다', () => {
  const store = read('apps/today-dashboard/lib/data/store.ts');
  assert.match(store, /toggleReturn[\s\S]{0,1200}returnCompletionBlockers/);
  assert.match(store, /returnCompletionBlockers[\s\S]{0,500}return[\s\S]{0,1200}gasMutation\("toggleReturn"/);
  assert.match(store, /flushReturnCountsPersist\(tradeId\)[\s\S]{0,1400}gasMutation\("toggleReturn"/);
  assert.match(store, /persistInFlight/);
  assert.match(store, /returnCountPersistInFlight/);
});

test('반납 카드는 차단된 품목과 수량을 보여주고 체크리스트를 다시 연다', () => {
  const card = read('apps/today-dashboard/components/ScheduleCard.tsx');
  assert.match(card, /returnBlockers/);
  assert.match(card, /미확인|초과/);
  assert.match(card, /setOpen\(true\)/);
});

test('GAS 최종 완료 경로도 품목 체크가 끝나지 않으면 계약상태 변경을 거부한다', () => {
  const gas = read('checkAvailability.js');
  assert.match(gas, /function assertDashboardReturnComplete_\(/);
  assert.match(gas, /function setDashboardReturnContractStatus_[\s\S]{0,1800}assertDashboardReturnComplete_/);
  assert.match(gas, /반납완료 차단/);
  assert.match(gas, /groups\[key\]\s*=\s*\{\s*headers:\s*\[\],\s*rows:\s*\[\]\s*\}/);
  assert.match(gas, /groups\[key\]\.headers\.push\(eq\)/);
  const toggleStart = gas.indexOf('function toggleReturnDone');
  const toggleEnd = gas.indexOf('\nfunction ', toggleStart + 20);
  assert.doesNotMatch(gas.slice(toggleStart, toggleEnd), /catch \(lockErr\) \{\}/);
  assert.match(gas, /assertDashboardReturnComplete_[\s\S]{0,1800}취소 표시 품목/);
});

test('계약마스터 J열을 사람이 직접 반납완료로 바꿔도 같은 검증을 거친다', () => {
  const code = read('Code.js');
  assert.match(code, /function handleContractMasterStatusEdit_[\s\S]{0,2200}assertDashboardReturnComplete_/);
  assert.match(code, /assertDashboardReturnComplete_[\s\S]{0,900}setValue\(["']반출["']\)|assertDashboardReturnComplete_[\s\S]{0,900}restoreStatus/);
  assert.match(code, /반납완료 차단/);
});

test('계약마스터 여러 열 붙여넣기가 J열을 포함해도 완료 검증을 우회하지 않는다', () => {
  const code = read('Code.js');
  assert.match(code, /statusEditEndCol/);
  assert.match(code, /col\s*<=\s*10\s*&&\s*statusEditEndCol\s*>=\s*10/);
  assert.match(code, /getRange\(statusStartRow,\s*10,\s*statusRowCount,\s*1\)/);
});

test('날짜가 지났다는 이유만으로 미검수 거래를 반납완료 처리하지 않는다', () => {
  const gas = read('checkAvailability.js');
  const start = gas.indexOf('function markOverdueReturnContracts');
  const end = gas.indexOf('\nfunction ', start + 20);
  const fn = gas.slice(start, end);
  assert.doesNotMatch(fn, /setValue\(['"]반납완료['"]\)/);
  assert.match(fn, /검수|미마감|점검/);
});

test('시트 동기화가 5\/6 같은 부분 반납 수량도 보존한다', () => {
  const sync = read('apps/today-dashboard/lib/data/sync.ts');
  assert.match(sync, /partial|부분/);
  assert.match(sync, /returnCounts\[sid\]\s*=\s*rc/);
  assert.match(sync, /Object\.entries\(base\.returnCounts[\s\S]{0,700}sameReturnEvidenceIdentity[\s\S]{0,300}returnCounts\[sid\]\s*=\s*rc/);
  assert.match(sync, /sameReturnEvidenceIdentity[\s\S]{0,1000}previous\.name[\s\S]{0,1000}previous\.setName/);
  assert.doesNotMatch(sync, /checkedCheckin[\s\S]{0,300}good:\s*e\.takenQty/);
});

test('반출 체크 누락을 반납 완료로 자동 추정하지 않는다', () => {
  const gas = read('checkAvailability.js');
  const start = gas.indexOf('function getDashboardCheckinItemDefault_');
  const end = gas.indexOf('\nfunction ', start + 20);
  const fn = gas.slice(start, end);
  assert.doesNotMatch(fn, /setupDoneForTrade\s*===\s*true\s*&&\s*checkoutChecked\s*!==\s*true/);
  assert.match(fn, /return false/);
});

test('반납 체크는 당시 거래·장비·세트·수량 증거가 현재 행과 같을 때만 유효하다', () => {
  const gas = read('checkAvailability.js');
  assert.match(gas, /function dashboardReturnInspectionToken_[\s\S]{0,1600}tradeId[\s\S]{0,1600}equipName[\s\S]{0,1600}setName/);
  assert.match(gas, /['"]v2\|['"]/);
  assert.match(gas, /function getDashboardCheckinItemDefault_[\s\S]{0,1600}checkinProof/);
  assert.match(gas, /function toggleItemCheck[\s\S]{0,6500}props\.setProperty\(key, context\.token\)/);
  assert.doesNotMatch(gas, /props\.setProperty\(['"]itemCheckProof_/);
});

test('GAS는 브라우저 boolean이 아니라 Supabase에 내구 저장된 상세 수량을 직접 검증한다', () => {
  const gas = read('checkAvailability.js');
  const supa = read('supabaseSync.js');
  assert.match(supa, /function supaGetTradeReturnCounts_/);
  assert.match(supa, /select=trade_id,return_counts/);
  assert.match(supa, /select=schedule_id,name,qty,taken_qty/);
  assert.match(supa, /function supaCaptureCheckoutBaseline_/);
  assert.match(gas, /function assertDashboardReturnComplete_[\s\S]{0,4500}supaGetTradeReturnCounts_/);
  assert.match(gas, /불변 수량 기준선\(taken_qty\)/);
  assert.match(gas, /accounted\s*!==\s*expected/);
  assert.match(gas, /function toggleItemCheck[\s\S]{0,7500}durableCount[\s\S]{0,1600}accounted\s*!==\s*baselineQty/);
});

test('반출 시작 뒤 예약 기준 변경과 범용 스케줄상세 쓰기를 모두 막는다', () => {
  const gas = read('checkAvailability.js');
  const api = read('sheetAPI.js');
  const store = read('apps/today-dashboard/lib/data/store.ts');
  assert.match(gas, /function dashboardUpdateEquipmentQty[\s\S]{0,2600}isDashboardTradeCheckoutStarted_/);
  assert.match(gas, /function dashboardUpdateEquipmentName[\s\S]{0,2600}isDashboardTradeCheckoutStarted_/);
  assert.match(gas, /function addEquipmentToContract[\s\S]{0,1600}isDashboardTradeCheckoutStarted_/);
  assert.match(gas, /function removeEquipmentFromContract[\s\S]{0,1600}isDashboardTradeCheckoutStarted_/);
  assert.doesNotMatch(api, /WRITABLE_SHEETS\s*=\s*\[[^\]]*["']스케줄상세["']/);
  assert.doesNotMatch(store, /takenQty:\s*e\.takenQty\s*!=\s*null\s*\?\s*Math\.min/);
  assert.match(store, /takenQty:\s*e\.takenQty/);
});

test('직접 행 clear/delete는 고아 반납 증거를 찾아 재오픈하고 구조 삭제 트리거를 설치한다', () => {
  const code = read('Code.js');
  const api = read('sheetAPI.js');
  assert.match(code, /function reconcileDashboardOrphanedReturnProofs_/);
  assert.match(code, /function onChangeInstallable[\s\S]{0,1200}REMOVE_ROW[\s\S]{0,1200}reconcileDashboardOrphanedReturnProofs_/);
  assert.match(code, /newTrigger\(["']onChangeInstallable["']\)[\s\S]{0,300}\.onChange\(\)/);
  assert.match(code, /editEndCol\s*>=\s*1/);
  assert.match(api, /["']setupInstallableTrigger["']/);
});

test('반출 기준선 행은 시트에서 사라져도 Supabase prune/delete가 지우지 않는다', () => {
  const supa = read('supabaseSync.js');
  const remote = read('apps/today-dashboard/lib/data/remote.ts');
  assert.match(supa, /taken_qty=is\.null/);
  assert.match(remote, /select\(["']schedule_id,taken_qty["']\)/);
  assert.match(remote, /!\(Number\(row\.taken_qty\)\s*>\s*0\)/);
  assert.match(remote, /delete row\.taken_qty/);
  assert.match(remote, /deleteScheduleItem[\s\S]{0,1800}\.is\(["']taken_qty["'], null\)/);
});

test('반납 증거 해제는 완료 토글과 같은 잠금 안에서 계약을 재오픈한다', () => {
  const gas = read('checkAvailability.js');
  const start = gas.indexOf('function toggleItemCheck');
  const end = gas.indexOf('\nfunction ', start + 20);
  const fn = gas.slice(start, end);
  assert.match(fn, /LockService\.getScriptLock/);
  assert.match(fn, /waitLock/);
  assert.match(fn, /invalidateDashboardReturnInspectionForTrade_/);
  assert.match(fn, /반납 수량 미완료 전환/);
});

test('API나 시트에서 수량·장비명·세트·거래 귀속을 바꾸면 기존 반납 검수와 완료 상태를 무효화한다', () => {
  const gas = read('checkAvailability.js');
  const code = read('Code.js');
  assert.match(gas, /function invalidateDashboardReturnInspectionForTrade_/);
  assert.match(gas, /function dashboardUpdateEquipmentQty[\s\S]{0,7000}invalidateDashboardReturnInspectionForTrade_/);
  assert.match(gas, /function dashboardUpdateEquipmentName[\s\S]{0,7000}invalidateDashboardReturnInspectionForTrade_/);
  assert.match(code, /스케줄상세[\s\S]{0,1800}col\s*<=\s*5[\s\S]{0,1800}editEndCol\s*>=\s*1[\s\S]{0,2200}invalidateDashboardReturnInspectionForTrade_/);
});

test('반출완료는 불변 기준선 저장 성공 뒤에만 화면 상태를 바꾸고 기존 기준선을 덮어쓰지 않는다', () => {
  const gas = read('checkAvailability.js');
  const supa = read('supabaseSync.js');
  const store = read('apps/today-dashboard/lib/data/store.ts');
  const toggleStart = store.indexOf('export async function toggleSetup');
  const toggleEnd = store.indexOf('\nexport type ToggleReturnResult', toggleStart);
  const toggle = store.slice(toggleStart, toggleEnd);
  assert.ok(toggle.indexOf('await gasMutation("toggleSetup"') < toggle.indexOf('mutateTrade(tradeId'));
  assert.match(gas, /supaCaptureCheckoutBaseline_\(tid, checkable, true\)/);
  assert.match(supa, /function supaGetCheckoutBaselineState_/);
  assert.match(supa, /if \(!same\)[\s\S]{0,220}이미 고정된 반출 기준선/);
  assert.match(supa, /if \(!newRows\.length\) \{[\s\S]{0,180}markDashboardCheckoutBaselineStarted_\(tid\)[\s\S]{0,180}reused: true/);
  assert.match(gas, /function toggleItemCheck[\s\S]{0,2600}phase === ['"]checkout['"][\s\S]{0,1200}이미 고정된 반출 기준선/);
});

test('DB도 기준 수량과 장비 정체성·반출 포함 여부를 write-once로 강제한다', () => {
  const migration = read('apps/today-dashboard/supabase/immutable-checkout-baseline.sql');
  assert.match(migration, /coalesce\(old\.taken_qty, 0\) > 0/);
  for (const field of ['schedule_id', 'trade_id', 'taken_qty', 'name', 'set_name', 'is_set_header', 'is_component', 'onsite', 'checkout_state']) {
    assert.match(migration, new RegExp(`new\\.${field} is distinct from old\\.${field}`));
    assert.match(migration, new RegExp(`new\\.${field} := old\\.${field}`));
  }
  assert.match(migration, /before update on village\.schedule_items/);
  assert.match(migration, /insert into village\.checkout_baseline_audit/);
  assert.doesNotMatch(migration, /raise exception/);
});

test('앱 장비명 변경은 원장 성공 뒤에만 적용하고 옛 품목의 반납 수량 증거를 지운다', () => {
  const store = read('apps/today-dashboard/lib/data/store.ts');
  const start = store.indexOf('export async function setItemName');
  const end = store.indexOf('\nexport async function setItemQty', start);
  const fn = store.slice(start, end);
  assert.match(fn, /writeBackEnabled/);
  assert.match(fn, /await gasMutation\("updateEquipName"/);
  assert.match(fn, /returnCounts/);
  assert.match(fn, /returnDone:\s*false/);
});

test('앱 수량 변경도 원장 성공 뒤에만 적용하고 영향받은 세트 구성품까지 재검수한다', () => {
  const store = read('apps/today-dashboard/lib/data/store.ts');
  const start = store.indexOf('export async function setItemQty');
  const end = store.indexOf('\n// 품목 메모', start);
  const fn = store.slice(start, end);
  assert.match(fn, /writeBackEnabled/);
  assert.match(fn, /await gasMutation\("updateEquipQty"/);
  assert.match(fn, /affectedIds/);
  assert.match(fn, /returnCounts/);
  assert.match(fn, /returnDone:\s*false/);
});

test('상세 반납 수량은 부분 저장하고 품목마다 GAS 완료 증거를 만들지 않는다', () => {
  const store = read('apps/today-dashboard/lib/data/store.ts');
  const start = store.indexOf('export async function setReturnCount');
  const end = store.indexOf('\n// ── 결제', start);
  const fn = store.slice(start, end);
  assert.match(fn, /scheduleReturnCountsPersist\(tradeId\)/);
  assert.match(fn, /await flushReturnCountsPersist\(tradeId\)/);
  assert.doesNotMatch(fn, /flushTradePersist\(/);
  assert.doesNotMatch(fn, /gasMutation\(["']toggleItem["']/);
  assert.match(fn, /writeback === false[\s\S]{0,300}returnDone[\s\S]{0,500}gasMutation\("toggleReturn"/);
});

test('품목 추가는 기존 완료를 재오픈하고 반출 시작 뒤 품목 삭제는 금지한다', () => {
  const gas = read('checkAvailability.js');
  const store = read('apps/today-dashboard/lib/data/store.ts');
  assert.match(gas, /function dashboardAddEquipments[\s\S]{0,10000}invalidateDashboardReturnInspectionForTrade_[\s\S]{0,500}스케줄 품목 추가/);
  assert.match(gas, /function dashboardAddEquipment[\s\S]{0,9000}invalidateDashboardReturnInspectionForTrade_[\s\S]{0,500}스케줄 품목 추가/);
  assert.match(gas, /function dashboardRemoveEquipment[\s\S]{0,1800}isDashboardTradeCheckoutStarted_/);
  assert.match(gas, /반출 시작 후에는 품목을 삭제할 수 없습니다/);
  const addMany = gas.slice(gas.indexOf('function dashboardAddEquipments'), gas.indexOf('\nfunction recordOnsiteAddonBackend_', gas.indexOf('function dashboardAddEquipments')));
  const addOne = gas.slice(gas.indexOf('function dashboardAddEquipment'), gas.indexOf('\nfunction dashboardRemoveEquipment', gas.indexOf('function dashboardAddEquipment')));
  assert.match(addMany, /deleteDashboardRowsDescending_[\s\S]{0,900}현장 추가 반출 기준선 저장 실패/);
  assert.match(addOne, /deleteDashboardRowsDescending_[\s\S]{0,900}추가 반출 기준선 저장 실패/);
  const onsiteStart = store.indexOf('export async function addOnsiteItems');
  const onsiteEnd = store.indexOf('\nexport function setOnsiteSettlement', onsiteStart);
  const onsite = store.slice(onsiteStart, onsiteEnd);
  assert.doesNotMatch(onsite, /settlement\s*!==\s*["']유상["']/);
  assert.match(onsite, /if \(!isSupabase\)[\s\S]{0,200}addOnsiteItemsLocal/);
  assert.match(onsite, /if \(!writeBackEnabled\)[\s\S]{0,180}throw new Error/);
  assert.match(gas, /function dashboardRecordOnsiteAddon[\s\S]{0,900}forceZeroPrice:\s*!isPaid/);
});

test('GAS 완료 API의 후속 저장 실패는 계약상태를 보상 복구하고 중복 완료는 이전상태를 덮지 않는다', () => {
  const gas = read('checkAvailability.js');
  assert.match(gas, /function rollbackDashboardReturnContractStatus_/);
  assert.match(gas, /function toggleReturnDone[\s\S]{0,5000}rollbackDashboardReturnContractStatus_/);
  assert.match(gas, /function updateDashboardContractStatus[\s\S]{0,6500}rollbackDashboardReturnContractStatus_/);
  assert.match(gas, /currentStatus\s*&&\s*currentStatus\s*!==\s*['"]반납완료['"]/);
});
