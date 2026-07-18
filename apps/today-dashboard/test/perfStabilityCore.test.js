const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

// 성능/안정성 전면 점검(2026-07)의 코어 데이터 계층 수정 회귀 방지.
// 핵심 불변식: realtime 변경은 전량 refetch가 아니라 바뀐 거래만 재조회하고,
// pending 중 이벤트는 드롭하지 않고 이월하며, 모든 원격 호출에 타임아웃 상한이 있다.

const appRoot = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(appRoot, file), "utf8");

function section(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.ok(start >= 0 && end > start, `${startMarker} 구현을 찾을 수 있어야 한다`);
  return source.slice(start, end);
}

test("realtime 변경은 바뀐 거래만 재조회한다 (전량 refetch 금지)", () => {
  const store = read("lib/data/store.ts");
  const flush = section(store, "async function flushRealtimeChanges", "\nasync function loadRemoteOnce");
  assert.match(flush, /fetchTradesByIds\(ids\)/, "부분 재조회 경로가 있어야 한다");
  // 전량 수렴(fullResync)은 대량 변경·재연결 시에만 — 기본 경로에서 fetchAllTrades 금지
  const nonFullPath = flush.slice(flush.indexOf("const [changed, notes]"));
  assert.doesNotMatch(nonFullPath, /fetchAllTrades\(\)/, "기본 경로에서 전량 refetch를 하면 안 된다");
});

test("pending 중 realtime 이벤트는 드롭하지 않고 이월한다", () => {
  const store = read("lib/data/store.ts");
  const flush = section(store, "async function flushRealtimeChanges", "\nasync function loadRemoteOnce");
  assert.match(flush, /hasPendingPersist\(\)[\s\S]*?scheduleRealtimeFlush\(REALTIME_RETRY_MS\)/, "pending이면 재시도 예약");
  assert.match(flush, /requeueRealtimeChanges/, "적용 불가 시 변경 큐를 복원해야 한다");
  // persist 완료 지점에서 이월분을 재개하는 훅이 있어야 한다
  assert.match(store, /function maybeResumeRealtimeFlush/);
  const resumeCalls = [...store.matchAll(/maybeResumeRealtimeFlush\(\)/g)];
  assert.ok(resumeCalls.length >= 4, "persist 완료 지점들(거래/반납수량/메모/저장락)에서 재개해야 한다");
});

test("subscribeChanges는 테이블·거래 단위 payload를 전달하고 재연결 시 전체 수렴한다", () => {
  const remote = read("lib/data/remote.ts");
  const sub = section(remote, "export function subscribeChanges", "\n");
  assert.match(remote, /tradeIdFromPayload/, "payload에서 trade_id를 복원해야 한다");
  assert.match(remote, /scheduleId\.match\(\/\^\(\\d\{6\}-\\d\{3\}\)-\/\)/, "DELETE payload는 schedule_id 접두어에서 복원");
  assert.match(remote, /onResync/, "재연결 수렴 콜백이 있어야 한다");
  assert.ok(sub.includes("(change: RemoteChange) => void"));
});

test("fetchAllTrades는 운영 윈도우로 서버 필터링한다 (이력 증가 = 느려짐 구조 제거)", () => {
  const remote = read("lib/data/remote.ts");
  const fetchAll = section(remote, "export async function fetchAllTrades", "\nexport async function fetchTradesByIds");
  assert.match(fetchAll, /return_at\.gte\./, "반납일 기준 윈도우 필터가 있어야 한다");
  assert.match(fetchAll, /return_at\.is\.null/, "반납일 없는 레거시 행은 포함해야 한다");
  // 윈도우 밖 거래의 지연 로드 경로가 존재해야 한다
  assert.match(remote, /export async function searchTradesRemote/);
  assert.match(remote, /export async function fetchTradesOverlappingDate/);
});

test("원격 호출에 타임아웃 상한이 있다 (요청 1개 hang → 동기화 영구 정지 방지)", () => {
  const api = read("lib/data/apiClient.ts");
  assert.match(api, /AbortSignal\.timeout\(GAS_GET_TIMEOUT_MS\)/);
  assert.match(api, /AbortSignal\.timeout\(GAS_POST_TIMEOUT_MS\)/);
  const client = read("lib/supabase/client.ts");
  assert.match(client, /SUPABASE_FETCH_TIMEOUT_MS/);
  assert.match(client, /global:\s*\{\s*fetch:\s*fetchWithTimeout\s*\}/);
});

test("복구 불가 거래의 dashboard repair는 지수 백오프로 제한된다", () => {
  const sync = read("lib/data/sync.ts");
  assert.match(sync, /REPAIR_BACKOFF_BASE_MS/);
  assert.match(sync, /REPAIR_BACKOFF_MAX_MS/);
  assert.match(sync, /export function resetRepairBackoff/);
  const repair = section(sync, "export async function repairDashboardDetailsForIncompleteTrades", "\n/** 날짜 화면 진입 시");
  assert.match(repair, /repairDue\(/, "백오프가 걸린 거래는 건너뛰어야 한다");
  assert.match(repair, /noteRepairMiss\(/, "복구 실패 시 백오프를 늘려야 한다");
});

test("백그라운드 폴링은 light 모드(좁은 윈도우·캐시 허용)로 돈다", () => {
  const store = read("lib/data/store.ts");
  assert.match(store, /pollCount % 4 === 0 \? "full" : "light"/, "인터벌은 4회 중 1회만 전체 윈도우");
  const poll = section(store, "export async function pollSheetChangesNow", "\n/** 같은 거래의 전체행 upsert를");
  assert.match(poll, /pollInFlight/, "폴링 중복 실행 가드가 있어야 한다");
  assert.match(poll, /fromDays: -7, toDays: 45/, "light 모드는 좁은 timeline 윈도우를 써야 한다");
  const sync = read("lib/data/sync.ts");
  assert.match(sync, /fresh \? "&nocache=1" : ""/, "백그라운드 repair는 캐시를 우회하지 않아야 한다");
});

test("useDashboard는 토스트만 바뀐 emit에 새 스냅샷을 만들지 않는다", () => {
  const store = read("lib/data/store.ts");
  const hook = section(store, "let dashSnapshot", "export function useToast");
  assert.match(hook, /dashSnapshot\.trades !== state\.trades/);
  assert.doesNotMatch(hook, /toast/, "대시보드 스냅샷은 toast에 의존하면 안 된다");
});

test("품목 체크 원장 쓰기는 재시도 큐를 거친다 (잠금 경합 시 조용한 유실 방지)", () => {
  const store = read("lib/data/store.ts");
  const checkout = section(store, "export function setItemCheckout", "\nexport async function setItemName");
  assert.match(checkout, /queueItemCheckWrite\(tradeId, scheduleId, true\)/);
  assert.match(checkout, /queueItemCheckWrite\(tradeId, scheduleId, false\)/);
  assert.doesNotMatch(checkout, /gasWrite\("toggleItem"/, "재시도 없는 파이어-앤-포겟 금지");
  const queue = section(store, "const ITEM_CHECK_RETRY_DELAYS_MS", "\n// ── 품목별 반출/반납 상태");
  assert.match(queue, /isRetryableLedgerError/, "잠금/네트워크 오류만 재시도해야 한다");
  assert.match(queue, /itemCheckTargets\[key\] !== target\) return/, "재시도는 최신 목표 상태가 이긴다");
  assert.match(queue, /clearTimeout\(itemCheckRetryTimers\[key\]\)/, "새 목표가 대기 중 재시도를 선점해야 한다");
});

test("GAS toggleItemCheck는 검증을 잠금 밖에서 하고 잠금 대기를 20초로 늘린다", () => {
  const gas = fs.readFileSync(path.resolve(appRoot, "../..", "checkAvailability.js"), "utf8");
  const fn = section(gas, "function toggleItemCheck", "\nfunction getEquipmentCheckMap_");
  const contextAt = fn.indexOf("getDashboardScheduleInspectionContext_(scheduleId)");
  const baselineAt = fn.indexOf("supaGetCheckoutBaselineState_(checkoutTid)");
  const lockAt = fn.indexOf("lock.waitLock(");
  assert.ok(contextAt >= 0 && lockAt > contextAt, "행 조회는 잠금 밖(앞)에서 해야 한다");
  assert.ok(baselineAt >= 0 && lockAt > baselineAt, "Supabase 기준선 HTTP 조회는 잠금 밖(앞)에서 해야 한다");
  assert.match(fn, /isDashboardTradeCheckoutStarted_\(/, "로컬 마커로 반출 전 거래는 HTTP 조회를 생략해야 한다");
  // 반출 체크는 스케줄ID 접두어에서 거래ID를 직접 유도 — TextFinder 시트 검색을 생략한다
  assert.match(fn, /scheduleId\.match\(\/\^\(\\d\{6\}-\\d\{3\}\)-\/\)/, "반출 체크는 접두어 fast path를 써야 한다");
  assert.match(fn, /lock\.waitLock\(20000\)/, "제외/현장추가의 긴 잠금과 겹쳐도 5초 만에 죽지 않아야 한다");
  assert.doesNotMatch(fn, /lock\.waitLock\(5000\)/);
});

test("GAS 전역 잠금: 무거운 작업이 잠금을 통째로 쥐지 않는다", () => {
  const gas = fs.readFileSync(path.resolve(appRoot, "../..", "checkAvailability.js"), "utf8");
  // toggleReturnDone: 완료 검증(전체 시트 스캔 + Supabase HTTP)은 잠금 앞에서
  const ret = section(gas, "function toggleReturnDone", "function listDashboardCheckoutItemCheckSids_");
  const assertAt = ret.indexOf("assertDashboardReturnComplete_(tid, props)");
  const retLockAt = ret.indexOf("lock.waitLock(");
  assert.ok(assertAt >= 0 && retLockAt > assertAt, "반납완료 검증은 잠금 밖(앞)이어야 한다");
  assert.match(ret, /lock\.waitLock\(20000\)/);
  assert.match(ret, /skipCompletionCheck: isDone/, "잠금 안에서 무거운 검증을 반복하지 않아야 한다");
  assert.doesNotMatch(ret, /lock\.waitLock\(5000\)/);

  // regenPendingContracts: 잠금은 거래 1건 재생성 동안만 + 사이에 틈
  const code = fs.readFileSync(path.resolve(appRoot, "../..", "Code.js"), "utf8");
  const regen = section(code, "function regenPendingContracts", "var TEMPLATE_SYNC_EDIT_TS_PROP_");
  const forAt = regen.indexOf("for (var key in all)");
  const regenLockAt = regen.indexOf("lock.waitLock(");
  assert.ok(forAt >= 0 && regenLockAt > forAt, "재생성 워커는 루프 안에서 거래 단위로만 잠가야 한다");
  assert.match(regen, /Utilities\.sleep\(/, "거래 사이에 인터랙티브 쓰기가 끼어들 틈이 있어야 한다");

  // flushDirtyToSupabase: HTTP 업서트는 잠금 해제 후
  const supa = fs.readFileSync(path.resolve(appRoot, "../..", "supabaseSync.js"), "utf8");
  const flush = section(supa, "function flushDirtyToSupabase", "/** 거래ID 배열");
  const buildAt = flush.indexOf("buildSupabaseTrades_(tids)");
  const releaseAt = flush.indexOf("lock.releaseLock()");
  const upsertAt = flush.indexOf("supaUpsertGrouped_");
  assert.ok(buildAt >= 0 && releaseAt > buildAt && upsertAt > releaseAt, "HTTP 업서트는 잠금 해제 뒤여야 한다");
  assert.match(flush, /after\[tids\[i\]\] === snapshot\[tids\[i\]\]/, "업서트 중 재변경된 거래의 dirty 마크는 보존해야 한다");
});

test("반납완료는 잠금 경합을 재시도로 흡수하고 중복 탭을 막는다", () => {
  const store = read("lib/data/store.ts");
  const ret = section(store, "export async function toggleReturn", "\n// ── 품목 체크 원장 쓰기 신뢰화");
  assert.match(ret, /if \(state\.savingTrades\[tradeId\]\)/, "저장 중 재진입을 막아야 한다");
  assert.match(ret, /beginTradeSave\(tradeId\)/, "재시도 동안 저장 스피너를 유지해야 한다");
  assert.match(ret, /gasMutationRetrying\("toggleReturn"/, "잠금 경합은 재시도로 흡수해야 한다");
  assert.match(store, /gasMutationRetrying\("updateContractStatus"/, "취소도 같은 재시도를 써야 한다");
  assert.match(store, /gasMutationRetrying\("updateTrade"/, "예약 편집도 같은 재시도를 써야 한다");
});

test("반납완료 미확인은 강제 차단이 아니라 작업자 확인 후 통과다 (소프트 가드)", () => {
  const store = read("lib/data/store.ts");
  const ret = section(store, "export async function toggleReturn", "\n// ── 품목 체크 원장 쓰기 신뢰화");
  assert.match(ret, /opts\?: \{ force\?: boolean \}/, "force 옵션이 있어야 한다");
  assert.match(ret, /on && !force \? returnCompletionBlockers/, "force면 미확인 차단을 건너뛴다");
  assert.match(ret, /force \? \{ force: 1 \} : \{\}/, "force가 GAS까지 전달돼야 한다");
  // 반납 상세 수량은 force여도 완료 전에 먼저 내구 저장한다(기록 보존)
  assert.match(ret, /flushReturnCountsPersist\(tradeId\)/, "미확인 내역 기록은 유지돼야 한다");

  const card = read("components/ScheduleCard.tsx");
  assert.match(card, /window\.confirm/, "작업자 확인 다이얼로그를 거쳐야 한다");
  assert.match(card, /toggleReturn\(trade\.tradeId, \{ force: true \}\)/, "확인 후에만 force 재호출한다");

  const gas = fs.readFileSync(path.resolve(appRoot, "../..", "checkAvailability.js"), "utf8");
  const gasRet = section(gas, "function toggleReturnDone", "function listDashboardCheckoutItemCheckSids_");
  assert.match(gasRet, /isDone && !force/, "GAS도 force면 완료 검증을 건너뛴다");
  assert.match(gasRet, /반납완료 강제 처리/, "강제 처리는 로그로 남긴다");
});

test("스테퍼 수량 변경은 낙관 반영 + 디바운스 + 직렬 커밋이다", () => {
  const store = read("lib/data/store.ts");
  const queue = section(store, "export function queueItemQty", "\nasync function commitQueuedItemQty");
  const mutateAt = queue.indexOf("mutateTrade(");
  const timerAt = queue.indexOf("qtyCommitTimers[key] = setTimeout");
  assert.ok(mutateAt >= 0 && timerAt > mutateAt, "화면 반영이 원장 왕복보다 먼저여야 한다");
  const commit = section(store, "async function commitQueuedItemQty", "\n// 품목 메모는");
  assert.match(commit, /if \(qtyCommitInFlight\[key\]\) return/, "같은 품목 커밋은 직렬화돼야 한다");
  assert.match(commit, /fetchTradesByIds\(\[tradeId\]\)/, "실패 시 서버 정본으로 롤백해야 한다");
  const checklist = read("components/HandoverChecklist.tsx");
  assert.match(checklist, /queueItemQty\(t\.tradeId, e\.scheduleId, v\)/, "스테퍼는 낙관 경로를 써야 한다");
});
