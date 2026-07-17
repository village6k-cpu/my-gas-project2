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
  const baselineAt = fn.indexOf("supaGetCheckoutBaselineState_(context.tradeId)");
  const lockAt = fn.indexOf("lock.waitLock(");
  assert.ok(contextAt >= 0 && lockAt > contextAt, "행 조회는 잠금 밖(앞)에서 해야 한다");
  assert.ok(baselineAt >= 0 && lockAt > baselineAt, "Supabase 기준선 HTTP 조회는 잠금 밖(앞)에서 해야 한다");
  assert.match(fn, /isDashboardTradeCheckoutStarted_\(/, "로컬 마커로 반출 전 거래는 HTTP 조회를 생략해야 한다");
  assert.match(fn, /lock\.waitLock\(20000\)/, "제외/현장추가의 긴 잠금과 겹쳐도 5초 만에 죽지 않아야 한다");
  assert.doesNotMatch(fn, /lock\.waitLock\(5000\)/);
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
