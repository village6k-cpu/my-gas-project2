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
  assert.match(flush, /fetchTradesByIds\(safeIds\)/, "pending 거래를 제외한 부분 재조회 경로가 있어야 한다");
  // 전량 수렴(fullResync)은 대량 변경·재연결 시에만 — 기본 경로에서 fetchAllTrades 금지
  const nonFullPath = flush.slice(flush.indexOf("const [changed, notes]"));
  assert.doesNotMatch(nonFullPath, /fetchAllTrades\(\)/, "기본 경로에서 전량 refetch를 하면 안 된다");
});

test("pending 중 realtime 이벤트는 드롭하지 않고 이월한다", () => {
  const store = read("lib/data/store.ts");
  const flush = section(store, "async function flushRealtimeChanges", "\nasync function loadRemoteOnce");
  assert.match(flush, /hasTradeSyncPending/, "pending은 거래 단위로 분리해야 한다");
  assert.match(flush, /blockedIds\.forEach\(\(id\) => realtimeTradeIds\.add\(id\)\)/, "막힌 거래만 큐에 이월해야 한다");
  assert.match(flush, /if \(realtimeTradeIds\.size \|\| realtimeNotesChanged \|\| realtimeNeedsFullResync\)[\s\S]*scheduleRealtimeFlush\(REALTIME_RETRY_MS\)/, "이월분은 재시도 예약해야 한다");
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

test("앱 시작·realtime·폴링은 전체 60일 미완성 거래를 GAS로 훑지 않고 현재 날짜만 보정한다", () => {
  const store = read("lib/data/store.ts");
  assert.doesNotMatch(
    store,
    /repairDashboardDetailsForIncompleteTrades|repairEmptyEquipmentTrades/,
    "화면 진입 때 전체 운영 윈도우를 날짜별로 조회하는 복구 경로를 호출하면 안 된다",
  );
  const load = section(store, "async function loadRemoteOnce", "\nfunction loadRemote");
  assert.match(load, /repairDayDetails\(state\.date[^)]*\{ fresh: false \}/, "첫 로드는 현재 날짜 1회만 캐시 허용 보정해야 한다");
  const poll = section(store, "export async function pollSheetChangesNow", "\n/** 같은 거래의 전체행 upsert를");
  assert.match(poll, /repairDayDetails\(state\.date/, "폴링도 현재 날짜만 보정해야 한다");
});

test("첫 원격 로드 중에는 빈 일정이 아니라 명시적인 로딩 상태를 보여준다", () => {
  const store = read("lib/data/store.ts");
  const today = read("components/TodayView.tsx");
  assert.match(store, /type RemoteStatus = "loading" \| "ready" \| "error"/);
  assert.match(store, /remoteStatus:\s*RemoteStatus/);
  assert.match(store, /remoteStatus:\s*"ready"/, "원격 스냅샷 반영과 함께 준비 상태가 되어야 한다");
  assert.match(today, /data\.remoteStatus === "loading"[\s\S]*일정 불러오는 중/);
  assert.match(today, /data\.remoteStatus === "error"[\s\S]*일정을 불러오지 못했습니다/);
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
  assert.match(checkout, /queueItemCheckWrite\(tradeId, scheduleId, true, previousCheckoutState === "taken"\)/);
  assert.match(checkout, /queueItemCheckWrite\(tradeId, scheduleId, false, previousCheckoutState === "taken"\)/);
  assert.doesNotMatch(checkout, /gasWrite\("toggleItem"/, "재시도 없는 파이어-앤-포겟 금지");
  const queue = section(store, "const ITEM_CHECK_RETRY_DELAYS_MS", "\n// ── 품목별 반출/반납 상태");
  assert.match(queue, /isRetryableLedgerError/, "잠금/네트워크 오류만 재시도해야 한다");
  assert.match(queue, /itemCheckTargets\[key\] !== target \|\| itemCheckMutationIds\[key\] !== mutationId/, "재시도는 최신 목표 상태와 mutation이 이긴다");
  assert.match(queue, /ITEM_CHECK_BATCH_DEBOUNCE_MS = 150/, "빠른 연속 체크는 거래 단위로 짧게 묶어야 한다");
  assert.match(queue, /gasMutation\("toggleItems",[\s\S]*mutationId/, "GAS 배치 writer에 같은 mutationId로 재시도해야 한다");
  assert.match(queue, /ITEM_CHECK_OUTBOX_KEY/, "새로고침 전 최종 체크 목표를 내구 outbox에 보존해야 한다");
  assert.doesNotMatch(queue, /persistItemCheckoutState/, "브라우저의 두 번째 Supabase 쓰기가 서버 순서를 뒤집으면 안 된다");
  assert.match(queue, /clearTimeout\(itemCheckRetryTimers\[key\]\)/, "새 목표가 대기 중 재시도를 선점해야 한다");
  assert.match(queue, /reconcileItemCheckCanonical/, "최종 실패의 낙관 상태는 품목 정본으로 자동 복구해야 한다");
});

test("반출완료 직후 품목 버튼은 조용히 잠기고 완료 확정 경고를 전역 토스트로 띄우지 않는다", () => {
  const store = read("lib/data/store.ts");
  const checklist = read("components/HandoverChecklist.tsx");
  const checkout = section(store, "export function setItemCheckout", "\nexport async function setItemName");
  assert.match(
    checklist,
    /onClick=\{\(\) => setItemCheckout\(t\.tradeId, e\.scheduleId, "excluded"\)\}[\s\S]{0,180}disabled=\{baselineLocked\}/,
    "반출완료가 즉시 표시된 뒤에는 제외 버튼도 체크 버튼과 똑같이 잠겨야 한다",
  );
  assert.doesNotMatch(
    checkout,
    /완료 상태를 확정 중입니다\. 저장이 끝난 뒤 품목을 다시 눌러주세요/,
    "이미 잠긴 품목 클릭을 전역 빨간 토스트로 다시 알리면 다른 화면까지 방해한다",
  );
});

test("시각적 저장 토스트는 실제 거래 잠금을 해제하지 않고, 실제 잠금은 토큰별로 끝난다", () => {
  const store = read("lib/data/store.ts");
  const flash = section(store, "function flashSave", "\nfunction showTransientError");
  assert.doesNotMatch(flash, /set\(\{\s*savingTrades|delete\s+\w+\[tradeId\]/, "420ms 시각 효과가 실제 저장 잠금을 바꾸면 안 된다");

  const lifecycle = section(store, "const activeTradeSaveTokens", "\n/** 응답만 유실된 쓰기는");
  assert.match(lifecycle, /Map<string, Set<number>>/, "거래별 실제 작업 토큰을 보관해야 한다");
  assert.match(lifecycle, /tokens\.add\(id\)/, "시작한 작업 자신의 토큰을 추가해야 한다");
  assert.match(lifecycle, /tokens\.delete\(id\)/, "끝난 작업 자신의 토큰만 제거해야 한다");
  assert.match(lifecycle, /if \(tokens\.size === 0\)/, "다른 작업 토큰이 남아 있으면 카드 잠금을 유지해야 한다");
});

test("같은 거래 GAS 원장 명령만 순서대로 보내고 다른 거래는 서로 막지 않는다", () => {
  const writeback = read("lib/data/writeback.ts");
  assert.match(writeback, /const gasMutationTails = new Map<string, Promise<void>>\(\)/);
  assert.match(writeback, /function mutationTradeKey/);
  assert.match(writeback, /scheduleId\.match\(\/\^\(\\d\{6\}-\\d\{3\}\)-\//, "tid가 없는 품목 요청도 거래 명령열에 들어가야 한다");
  assert.match(writeback, /action === "uploadDashboardPhoto"[\s\S]*return null/, "긴 사진 업로드는 원장 명령열을 막으면 안 된다");
  const enqueue = section(writeback, "function enqueueGasMutation", "\nasync function executeGasMutation");
  assert.match(enqueue, /previous[\s\S]*\.then\(task\)/, "앞 명령 완료 뒤 다음 명령을 시작해야 한다");
  assert.match(enqueue, /gasMutationTails\.set\(tradeKey, tail\)/);
  assert.doesNotMatch(
    enqueue,
    /navigator\.locks\.request|GAS_LEDGER_WEB_LOCK/,
    "느린 거래 하나가 다른 카드·다른 탭의 저장까지 브라우저에서 막으면 안 된다",
  );
  assert.match(writeback, /jitterRetryDelay/, "여러 직원 기기가 같은 시각에 재시도하지 않게 지터가 있어야 한다");
});

test("반출을 누르지 않은 거래도 반납 탭과 같은 날 전체 탭에서 바로 반납 처리할 수 있다", () => {
  const store = read("lib/data/store.ts");
  const card = read("components/ScheduleCard.tsx");
  const status = read("lib/domain/status.ts");
  const ret = section(store, "export async function toggleReturn", "\n/** 응답 유실된 반납완료");
  assert.match(ret, /const hasCheckoutBaseline =/);
  // 기준선 없는 거래는 조용한 자동 force가 아니라 작업자 확인(다이얼로그) 뒤 force로 보낸다.
  // 자동 force는 서버의 모든 반납 검증을 우회해 수량 검수 없이 거래가 닫히는 사고를 냈다.
  assert.match(ret, /needsBaselineConfirm: true/,
    "반출 기준선이 없는 거래는 작업자 확인을 요구해야 한다");
  assert.doesNotMatch(ret, /force = !!opts\?\.force \|\| \(on && !hasCheckoutBaseline\)/,
    "확인 없는 자동 force가 부활하면 안 된다");
  assert.match(card, /needsBaselineConfirm[\s\S]{0,500}toggleReturn\(trade\.tradeId, \{ force: true \}\)/,
    "카드는 확인 다이얼로그 뒤 force 경로로 반납 의도를 보낸다");
  assert.match(card, /if \(p === "both"\) return "checkin"/,
    "같은 날 반출·반납 건의 전체 탭은 setupDone 없이 반납 단계여야 한다");
  assert.match(status, /if \(p === "both"\) return t\.returnDone && returnCompletionBlockers\(t\)\.length === 0/,
    "같은 날 카드 완료 여부도 반출완료와 결합하면 안 된다");
});

test("장비 제외는 앞선 품목 저장 때문에 클릭을 버리지 않고 거래별 원장 큐에 이어 붙인다", () => {
  const store = read("lib/data/store.ts");
  const checkout = section(store, "export function setItemCheckout", "\nexport async function setItemName");
  const remove = section(store, "function removeEquipmentAndRegenerateContract", "\nfunction isSheetBackedScheduleId");
  assert.doesNotMatch(checkout, /plannedFinal[\s\S]*hasTradePending/, "앞선 저장이 있다는 이유로 제외 클릭을 버리면 안 된다");
  assert.doesNotMatch(remove, /hasTradePending\(tradeId\)|hasItemMetadataPatchPending_/, "제외 명령은 앞선 거래별 쓰기 뒤에 자동으로 이어져야 한다");
  assert.match(remove, /putRemoveEquipmentOutbox_\(entry\)[\s\S]*equipments\.filter/,
    "제외 의도를 먼저 영구 보존하고 화면에서 즉시 제거해야 한다");
});

test("품목 특이사항은 로컬 영구 outbox에 먼저 남기고 성공 확인 뒤에만 지운다", () => {
  const store = read("lib/data/store.ts");
  const metadata = section(store, "const ITEM_METADATA_OUTBOX_KEY", "\nfunction unwrapContractMutation");
  assert.match(metadata, /localStorage\.setItem\(ITEM_METADATA_OUTBOX_KEY/);
  assert.match(metadata, /putItemMetadataOutboxPatch_/);
  assert.match(metadata, /await persistScheduleItemPatch[\s\S]*acknowledgeItemMetadataOutboxPatch_/,
    "Supabase 성공 전에는 특이사항 outbox를 지우면 안 된다");
  const replay = section(store, "function replayDurableMutationOutboxes", "\nlet durableMutationOnlineResumeRegistered");
  assert.match(replay, /replayItemMetadataOutbox_/,
    "새로고침·앱 재시작 뒤에도 미전송 특이사항을 자동 복구해야 한다");
});

test("사용자 대기형 변이는 하위·상위 재시도를 중첩하지 않는다", () => {
  const store = read("lib/data/store.ts");
  const retry = section(store, "async function gasMutationRetrying", "\nfunction queueItemCheckWrite");
  assert.match(retry, /return gasMutation\(action, params\)/);
  assert.doesNotMatch(retry, /for \(|setTimeout|delays/, "writeback의 bounded retry 위에 다시 재시도 루프를 쌓으면 안 된다");
});

test("반납 수량 자동 재시도는 저장 스피너와 다른 카드 동작을 영구 점유하지 않는다", () => {
  const store = read("lib/data/store.ts");
  const arm = section(store, "function armReturnCountsPersist", "\nfunction scheduleReturnCountsPersist");
  assert.match(
    arm,
    /finishReturnCountSaves\(tradeId, "error", "⚠️ 반납 수량 저장 지연 — 자동 재시도 중"\)[\s\S]*scheduleReturnCountsRetry_\(tradeId\)/,
    "실패한 사용자 저장 토큰을 끝낸 뒤 백그라운드 재시도로 넘겨야 한다",
  );
  const active = section(store, "export function isTradeMutationActive", "\nfunction finishTradeSave");
  assert.match(active, /activeTradeTransitions\.has\(tradeId\)[\s\S]*pendingRemoveEquipmentTrades\.has\(tradeId\)/);
  assert.doesNotMatch(active, /hasTradePending/, "백그라운드 수량·체크 재시도가 카드 전체를 막으면 안 된다");
});

test("재시작 시 보존된 저장 작업은 한꺼번에 0ms 재생하지 않고 순차적으로 복구한다", () => {
  const store = read("lib/data/store.ts");
  const replay = section(store, "function replayDurableMutationOutboxes", "\nlet durableMutationOnlineResumeRegistered");
  assert.match(store, /const DURABLE_REPLAY_START_MS = 1_500/);
  assert.match(replay, /nextDurableReplayDelay_/);
  assert.doesNotMatch(replay, /armItemCheckBatch\(tradeId, 0\)/);
  assert.doesNotMatch(replay, /commitQueuedItemQty[\s\S]{0,140}\}, 0\)/);
});

test("반출완료는 품목 체크와 수량 debounce의 최신 목표를 모두 drain한 뒤 실행한다", () => {
  const store = read("lib/data/store.ts");
  const setup = section(store, "export async function toggleSetup", "export type ToggleReturnResult");
  const itemBarrierAt = setup.indexOf("flushItemCheckWritesForTrade(tradeId)");
  const qtyBarrierAt = setup.indexOf("flushQueuedItemQtyForTrade(tradeId)");
  const setupGasAt = setup.indexOf('gasMutation("toggleSetup"');
  assert.ok(itemBarrierAt >= 0 && qtyBarrierAt >= 0, "품목 체크와 수량 저장 장벽이 모두 있어야 한다");
  assert.ok(setupGasAt > itemBarrierAt && setupGasAt > qtyBarrierAt, "기준선 고정은 두 장벽 뒤에만 실행해야 한다");
  assert.match(setup, /setupRequestStarted = true;[\s\S]*gasMutation\("toggleSetup"/, "실제 완료 요청이 출발했는지 구분해야 한다");
  assert.match(setup, /setupRequestStarted && isGasOutcomeUnknownError\(e\)/, "선행 drain 실패를 완료 응답 유실로 오인하면 안 된다");
  assert.match(store, /itemCheckTerminalErrors/, "품목 원장 저장 실패를 완료 장벽이 삼키면 안 된다");
  assert.match(store, /qtyCommitFailures/, "수량 원장 저장 실패를 완료 장벽이 삼키면 안 된다");
});

test("GAS의 HTTP 200 HTML/빈 응답은 성공이 아니라 결과 미확정 오류다", () => {
  const writeback = read("lib/data/writeback.ts");
  const execute = section(writeback, "async function executeGasMutation", "\nexport async function gasMutation");
  assert.match(execute, /text = await r\.text\(\)/);
  assert.match(execute, /JSON\.parse\(text\)/);
  assert.match(execute, /유효한 JSON 응답이 아닙니다/);
  assert.match(execute, /new GasMutationError\([^;]+true\)/, "비JSON 2xx는 서버 실행 여부를 모르므로 outcomeUnknown이어야 한다");
  assert.match(execute, /GAS 응답 확인 실패/, "응답 본문 도중 연결이 끊겨도 결과 미확정이어야 한다");
});

test("일반 Supabase 저장은 완료 권한·반납수량·품목 체크를 덮지 않는다", () => {
  const remote = read("lib/data/remote.ts");
  const supa = fs.readFileSync(path.resolve(appRoot, "../..", "supabaseSync.js"), "utf8");
  const persist = section(remote, "export async function persistTrade", "\n/** 반납 체크의 빠른 경로");
  const tradeStructure = section(remote, "function tradeStructureRow", "\nfunction scheduleStructureRow");
  const itemStructure = section(remote, "function scheduleStructureRow", "\n/**");
  for (const field of ["contract_status", "return_done", "return_done_at", "return_counts"]) {
    assert.match(tradeStructure, new RegExp(`delete row\\.${field}`), `${field}는 전용 저장만 써야 한다`);
  }
  assert.match(persist, /upsert\(tradeRow, \{[\s\S]*ignoreDuplicates: true/,
    "누락 거래만 초기 상태로 생성하고 기존 거래는 덮지 않아야 한다");
  assert.match(itemStructure, /delete structural\.checkout_state/, "오래된 전체 품목 스냅샷이 다른 직원의 체크를 덮으면 안 된다");
  assert.doesNotMatch(remote, /export async function persistReturnCompletion/);
  assert.doesNotMatch(remote, /export async function persistItemCheckoutState/);
  const periodic = section(supa, "function buildSupabaseTrades_", "\n/** payload 키 구성이 같은 행끼리");
  assert.doesNotMatch(periodic, /return_done\s*:/, "1분 dirty worker도 반납완료를 덮으면 안 된다");
  assert.doesNotMatch(periodic, /checkout_state\s*:/, "1분 dirty worker도 품목 체크를 덮으면 안 된다");
  assert.match(supa, /function supaSetTradeReturnDone_/);
  assert.match(supa, /function supaSetScheduleItemCheckoutState_/);

  const countPatch = section(remote, "export async function persistReturnCounts", "\n/** 단일 품목 호출도");
  assert.match(countPatch, /return_counts/);
  assert.match(countPatch, /if \(count == null\) delete next\[scheduleId\]/, "무효가 된 반납 상세 키도 CAS로 삭제해야 한다");
  assert.match(countPatch, /JSON\.stringify\(currentRaw\)/, "JSON 이전값을 CAS 조건으로 사용해야 한다");
  assert.match(countPatch, /return_done\.is\.null,return_done\.eq\.false/, "완료와 상세 수량 저장은 서로 원자적으로 배제해야 한다");
  assert.match(countPatch, /for \(let attempt = 0; attempt < RETURN_COUNT_CAS_ATTEMPTS; attempt\+\+\)/);
});

test("반납 행 연타는 항목별 병합 큐로 모으고 완료 직전에만 전체 drain한다", () => {
  const store = read("lib/data/store.ts");
  const remote = read("lib/data/remote.ts");
  const count = section(store, "export async function setReturnCount", "\n// ── 결제·정산");
  assert.match(count, /scheduleReturnCountsPersist\(tradeId, scheduleId, durablePatch\)/,
    "연타는 변경된 품목·필드만 병합 큐에 넣어야 한다");
  assert.match(count, /durablePatch\.reportedMissing = 0/,
    "수량을 직접 수정하면 오래된 자동 누락 표시를 재시작 뒤에도 제거해야 한다");
  const countWriter = section(remote, "export async function persistReturnCounts", "\n/** 단일 품목 호출도");
  assert.match(countWriter, /const currentCount = current\[scheduleId\]/);
  assert.match(countWriter, /\{ \.\.\.currentCount, \.\.\.count \}/,
    "다른 탭의 동일 품목 최신 필드와 CAS 병합해야 한다");
  assert.match(
    count,
    /if \(wasReturnComplete\)[\s\S]*await reopenReturnForCountMutation\([\s\S]{0,220}tradeId,[\s\S]{0,220}reopenMutationId/,
    "완료 거래의 명시적 편집만 관찰 완료시각과 고정 mutationId로 서버를 먼저 재오픈해야 한다",
  );
  assert.match(count, /if \(writeback !== false\) return true/, "일반 완료 체크마다 즉시 전체 flush하면 안 된다");
  assert.match(count, /await flushReturnCountsPersist\(tradeId\)/);

  const ret = section(store, "export async function toggleReturn", "\n// ── 품목 체크 원장 쓰기 신뢰화");
  assert.match(ret, /await flushReturnCountsPersist\(tradeId\)/, "반납완료 전에 모든 수량 패치를 drain해야 한다");
  assert.doesNotMatch(ret, /persistReturnCompletion/, "반납완료는 GAS가 Supabase까지 한 번에 써야 한다");
  assert.match(ret, /mutationId/);
  assert.doesNotMatch(ret, /flushTradePersist\(tradeId\)/, "완료 뒤 stale 전체 거래 저장을 다시 보내면 안 된다");
  const drain = section(store, "async function flushReturnCountsPersist", "\n/** 장비명/수량 변경으로");
  assert.match(drain, /catch \(error\)[\s\S]*scheduleReturnCountsRetry_\(tradeId\)[\s\S]*throw error/, "즉시 drain 실패도 지수 백오프 재시도를 걸어 pending 영구고착과 요청 폭주를 막아야 한다");
});

test("반납/품목의 응답 유실 재시도는 서버 mutation log에서 최신 동작을 보존한다", () => {
  const store = read("lib/data/store.ts");
  const gas = fs.readFileSync(path.resolve(appRoot, "../..", "checkAvailability.js"), "utf8");
  assert.match(store, /createLedgerMutationId\("return"\)/);
  assert.match(store, /queueReturnOutcomeRetry\([\s\S]*mutationId/);
  assert.match(gas, /function beginDashboardMutation_/);
  assert.match(gas, /entry\.state === 'committed' \|\| hasLater/);
  assert.match(gas, /DASHBOARD_MUTATION_LOG_PREFIX_/);
  assert.match(gas, /cleanupExpiredDashboardMutationLogs_/);
});

test("거래 A 저장 중에도 realtime 거래 B는 분리 적용한다", () => {
  const store = read("lib/data/store.ts");
  assert.match(store, /const tradeMutationSeq: Record<string, number>/);
  assert.match(store, /function hasTradePending\(tradeId: string\)/);
  const flush = section(store, "async function flushRealtimeChanges", "\nasync function loadRemoteOnce");
  assert.match(flush, /blockedIds/);
  assert.match(flush, /safeIds/);
  assert.match(flush, /blockedIds\.forEach\(\(id\) => realtimeTradeIds\.add\(id\)\)/);
  assert.match(flush, /tradeMutationSeq\[id\]/, "요청 전후 거래별 세대로 stale 응답을 걸러야 한다");
  const pending = section(store, "function hasPendingPersist", "\nfunction canApplyRemoteSnapshot");
  assert.doesNotMatch(pending, /pendingReturnProjectionTrades/, "브라우저 반납 projection 큐는 제거되어야 한다");
  assert.match(pending, /itemCheckInFlight/, "전체 수렴은 진행 중 품목 체크를 덮으면 안 된다");
  assert.match(pending, /qtyCommitInFlight/, "전체 수렴은 진행 중 수량 변경을 덮으면 안 된다");
});

test("GAS checkout 품목 체크는 HTTP를 잠금 밖에서 처리하고, 배치 경로도 짧게 커밋한다", () => {
  const gas = fs.readFileSync(path.resolve(appRoot, "../..", "checkAvailability.js"), "utf8");
  const fn = section(gas, "function toggleItemCheck(scheduleId", "\nfunction getEquipmentCheckMap_");
  const batch = section(gas, "function toggleItemChecksBatch", "\n/**\n * 개별 장비 행 체크 토글");
  const leaseGuard = section(gas, "function dashboardTradeMutationLeaseError_", "\nvar DASHBOARD_STRUCTURE_QUEUE_PREFIX_");
  const contextAt = fn.indexOf("getDashboardScheduleInspectionContext_(scheduleId)");
  const baselineAt = fn.indexOf("supaGetCheckoutBaselineState_(checkoutTid)");
  const mutationLockAt = Math.max(fn.indexOf("lock.waitLock("), fn.indexOf("lock.tryLock("));
  assert.ok(contextAt >= 0 && mutationLockAt > contextAt, "행 조회는 잠금 밖(앞)에서 해야 한다");
  assert.ok(baselineAt >= 0 && mutationLockAt > baselineAt, "Supabase 기준선 HTTP 조회는 잠금 밖(앞)에서 해야 한다");
  assert.match(fn, /isDashboardTradeCheckoutStarted_\(/, "로컬 마커로 반출 전 거래는 HTTP 조회를 생략해야 한다");
  // 반출 체크는 스케줄ID 접두어에서 거래ID를 직접 유도 — TextFinder 시트 검색을 생략한다
  assert.match(fn, /scheduleId\.match\(\/\^\(\\d\{6\}-\\d\{3\}\)-\/\)/, "반출 체크는 접두어 fast path를 써야 한다");
  assert.match(fn, /if \(phase === 'checkout'\)[\s\S]*props\.(?:setProperty|deleteProperty)[\s\S]*return \{[\s\S]*checked: isDone/, "checkout은 고유 키만 쓰므로 전역 잠금 전에 끝나야 한다");
  assert.match(fn, /dashboardTradeMutationLeaseError_\(/, "품목 체크도 거래 공통 리스 가드를 통과해야 한다");
  assert.match(leaseGuard, /setupClosing_[\s\S]*code: 'BUSY'[\s\S]*retryable: true/,
    "다른 기기의 완료 캡처 중 품목 체크는 재시도해야 한다");
  assert.match(leaseGuard, /checkoutItemMutation_[\s\S]*returnMutation_[\s\S]*activeDashboardReturnProjectionLease_/,
    "권한 전이 중인 품목·반납 요청과 실제 반납 projection HTTP만 충돌을 막아야 한다");
  assert.doesNotMatch(leaseGuard, /activeDashboardMutationLease_\(props, 'dashboardStructureMutation_'/,
    "구조 동기화 backoff가 카드 전체를 막으면 안 된다");
  assert.match(fn, /checkoutMutationLock\.tryLock\(1000\)/, "품목 쓰기와 기준선 시작 경계만 짧게 직렬화해야 한다");
  const checkoutFastAt = fn.indexOf("if (phase === 'checkout')", fn.indexOf("// ── 변이 단계"));
  const fastLockAt = fn.indexOf("lock.tryLock(");
  assert.ok(checkoutFastAt >= 0 && fastLockAt > checkoutFastAt, "checkout fast path가 잠금보다 앞이어야 한다");
  assert.match(fn, /lock\.tryLock\(1000\)/, "반납 증거 무효화도 오래 줄 세우지 말고 busy를 빨리 반환해야 한다");
  assert.match(fn, /retryable: true/);
  const batchHttpAt = batch.indexOf("supaSetScheduleItemCheckoutStatesBatch_");
  const batchReleaseAt = batch.indexOf("lock.releaseLock()");
  assert.ok(batchReleaseAt >= 0 && batchHttpAt > batchReleaseAt, "배치 Supabase HTTP도 claim 잠금을 푼 뒤 실행해야 한다");
  assert.match(batch, /entries\.length > 100/, "비정상 대형 배치를 제한해야 한다");
});

test("GAS 전역 잠금: 무거운 작업이 잠금을 통째로 쥐지 않는다", () => {
  const gas = fs.readFileSync(path.resolve(appRoot, "../..", "checkAvailability.js"), "utf8");
  // toggleReturnDone: 완료 검증(전체 시트 스캔 + Supabase HTTP)은 잠금 앞에서
  const ret = section(gas, "function toggleReturnDone", "function listDashboardCheckoutItemCheckSids_");
  const assertAt = ret.indexOf("assertDashboardReturnComplete_(tid, props)");
  const retLockAt = Math.max(ret.indexOf("lock.waitLock("), ret.indexOf("lock.tryLock("));
  assert.ok(assertAt >= 0 && retLockAt > assertAt, "반납완료 검증은 잠금 밖(앞)이어야 한다");
  assert.match(ret, /lock\.tryLock\(1000\)/);
  assert.match(ret, /retryable: true/);
  assert.match(ret, /skipCompletionCheck: isDone/, "잠금 안에서 무거운 검증을 반복하지 않아야 한다");
  assert.doesNotMatch(ret, /lock\.waitLock\(20000\)/);

  const setup = section(gas, "function toggleSetupDone", "function normalizeDashboardReturnSetKey_");
  const setupReleaseAt = setup.indexOf("transitionLock.releaseLock()");
  const baselineAt = setup.indexOf("supaCaptureCheckoutBaseline_");
  assert.ok(setupReleaseAt >= 0 && baselineAt > setupReleaseAt, "기준선 HTTP 저장은 짧은 경계 잠금을 푼 뒤 실행해야 한다");
  assert.match(setup, /setupClosing_[\s\S]*tryLock\(1000\)/, "다른 기기의 늦은 품목 체크를 막는 closing 표식이 있어야 한다");

  // regenPendingContracts: 잠금은 거래 선점/완료표시에만 쓰고 Drive 재생성은 잠금 밖
  const code = fs.readFileSync(path.resolve(appRoot, "../..", "Code.js"), "utf8");
  const regen = section(code, "function regenPendingContracts()", "var TEMPLATE_SYNC_EDIT_TS_PROP_");
  const claim = section(code, "function claimPendingContractRegen_", "function finishPendingContractRegen_");
  assert.match(claim, /lock\.waitLock\(10000\)/, "거래 선점 경계는 짧은 전역 잠금으로 직렬화해야 한다");
  assert.match(claim, /lock\.releaseLock\(\)/, "거래 선점 뒤에는 반드시 잠금을 풀어야 한다");
  assert.ok(
    claim.indexOf("armContractRegenWatchdogUnderLock_") < claim.indexOf("props.setProperty(claimKey"),
    "hard-timeout 복구 watchdog을 claim 기록보다 먼저 남겨야 한다",
  );
  const claimAt = regen.indexOf("claimPendingContractRegen_");
  const regenerateAt = regen.indexOf("deleteAndRegenerateContract");
  const finishAt = regen.indexOf("finishPendingContractRegen_");
  assert.ok(
    regen.indexOf("armContractRegenRunWatchdog_") < regen.indexOf("ScriptApp.getProjectTriggers()"),
    "one-shot 트리거를 정리하기 전에 실행 전체 watchdog을 먼저 보장해야 한다",
  );
  assert.ok(
    claimAt >= 0 && regenerateAt > claimAt && finishAt > regenerateAt,
    "선점 → 잠금 밖 재생성 → 짧은 완료표시 순서를 지켜야 한다",
  );
  assert.doesNotMatch(regen, /LockService\.getScriptLock\(\)/, "재생성 본문이 외부 I/O 동안 전역 잠금을 직접 보유하면 안 된다");
  const finish = section(code, "function finishPendingContractRegen_", "\n/**\n * hard-timeout 복구용");
  assert.match(
    finish,
    /if \(outcome && outcome\.success\)[\s\S]*deleteProperty\(claim\.editKey\)/,
    "성공한 재생성만 편집 큐를 완료 처리해야 한다",
  );
  assert.match(
    finish,
    /CONTRACT_REGEN_MAX_ATTEMPTS_[\s\S]*Math\.pow\(2, retry\.attempts - 1\)/,
    "일시 Drive 실패는 bounded backoff로 재시도해야 한다",
  );
  assert.match(regen, /Utilities\.sleep\(/, "거래 사이에 인터랙티브 쓰기가 끼어들 틈이 있어야 한다");

  // flushDirtyToSupabase: HTTP 업서트는 잠금 해제 후
  const supa = fs.readFileSync(path.resolve(appRoot, "../..", "supabaseSync.js"), "utf8");
  const flush = section(supa, "function flushDirtyToSupabase", "/** 거래ID 배열");
  const buildAt = flush.indexOf("buildSupabaseTrades_(tids)");
  const releaseAt = flush.indexOf("lock.releaseLock()");
  const upsertAt = flush.indexOf("supaUpsertGrouped_");
  assert.ok(buildAt >= 0 && releaseAt > buildAt && upsertAt > releaseAt, "HTTP 업서트는 잠금 해제 뒤여야 한다");
  assert.match(flush, /p\.getProperty\(dirtyKey\) === snapshot\[dirtyKey\]/, "업서트 중 재변경된 거래의 dirty 마크는 보존해야 한다");
  assert.match(flush, /p\.deleteProperty\(dirtyKey\)/, "성공한 동일 버전 dirty 키만 제거해야 한다");
});

test("반납완료는 잠금 경합을 재시도로 흡수하고 중복 탭을 막는다", () => {
  const store = read("lib/data/store.ts");
  const ret = section(store, "export async function toggleReturn", "\n// ── 품목 체크 원장 쓰기 신뢰화");
  assert.match(
    ret,
    /if \(activeTradeTransitions\.has\(tradeId\) \|\| pendingRemoveEquipmentTrades\.has\(tradeId\)\)/,
    "같은 완료 전환과 아직 확정되지 않은 장비 제외 뒤의 순서 역전을 막아야 한다",
  );
  assert.match(ret, /beginTradeTransition\(tradeId\)/, "재시도 동안 완료 전환과 저장 스피너를 유지해야 한다");
  assert.match(ret, /gasMutationRetrying\("toggleReturn"/, "잠금 경합은 재시도로 흡수해야 한다");
  assert.match(store, /gasMutationRetrying\("updateContractStatus"/, "취소도 같은 재시도를 써야 한다");
  assert.match(store, /gasMutationRetrying\("updateTrade"/, "예약 편집도 같은 재시도를 써야 한다");
});

test("반납완료 버튼은 즉시 반응한다 (낙관 표시 + 백그라운드 확정)", () => {
  const store = read("lib/data/store.ts");
  const ret = section(store, "export async function toggleReturn", "\n// ── 품목 체크 원장 쓰기 신뢰화");
  const optimisticAt = ret.indexOf("returnDone: on");
  const gasAt = ret.indexOf('gasMutationRetrying("toggleReturn"');
  assert.ok(optimisticAt >= 0 && gasAt > optimisticAt, "완료 표시가 GAS 왕복보다 먼저여야 한다");
  // 낙관 반영은 GAS 확정 전 원격 저장 금지(persist=false)
  assert.match(ret, /contractStatus: on \? "반납완료" : "반출",\s*\}\), false\)/, "낙관 반영은 persist=false여야 한다");
  // 응답 유실은 롤백하지 않고 멱등 재시도로 확정한다 (반출완료와 동일 패턴)
  assert.match(ret, /isGasOutcomeUnknownError\(e\)[\s\S]*queueReturnOutcomeRetry/, "결과 미확정은 재확인 큐로 넘긴다");
  assert.match(ret, /RETURN_OUTCOME_MAX_ATTEMPTS/, "재확인은 상한이 있어야 한다");
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

test("확인요청 메뉴: 리스트 캐시 + 카드 응답 패치 + 낙관 UI", () => {
  const gasApi = fs.readFileSync(path.resolve(appRoot, "../..", "sheetAPI.js"), "utf8");
  // GAS 리스트는 60초 캐시하고, 확인요청을 바꾸는 모든 경로가 무효화한다
  assert.match(gasApi, /CONFIRM_LIST_CACHE_KEY_/, "리스트 캐시 키가 있어야 한다");
  assert.match(gasApi, /function invalidateConfirmListCache_/, "무효화 헬퍼가 있어야 한다");
  const invalidateCalls = [...gasApi.matchAll(/invalidateConfirmListCache_\(\)/g)];
  assert.ok(invalidateCalls.length >= 3, "액션/run/registerAsync 경로가 캐시를 무효화해야 한다");
  // 액션 응답에 갱신 카드를 실어 앱이 전체 재조회 없이 그 카드만 교체한다
  assert.match(gasApi, /function confirmActionResponse_/, "액션 응답에 카드를 동봉해야 한다");
  assert.match(gasApi, /buildConfirmPendingItems_\(reqID\)/, "카드는 목록과 같은 빌더로 만든다");

  const view = read("components/ConfirmView.tsx");
  assert.match(view, /applyCardPatch/, "응답 카드로 로컬 패치해야 한다");
  assert.doesNotMatch(view, /const ok = await doAction\(action, reqID\);\s*\n\s*if \(ok\) setTimeout\(load, 600\);/, "액션 후 전체 재조회 대기 금지");
  // 삭제는 낙관 반영(즉시 제거, 실패 시 복원)
  const del = view.slice(view.indexOf("const deleteReq"), view.indexOf("const handleKakaoRequestCreated"));
  const removeAt = del.indexOf("prev.filter((it) => it.reqID !== reqID)");
  const funcAt = del.indexOf('runFunc("deleteRequest"');
  assert.ok(removeAt >= 0 && funcAt > removeAt, "카드 제거가 서버 삭제보다 먼저여야 한다");
});

test("확인요청 편집은 시트처럼 즉시다 — 편집 큐 + 단일 카드 갱신", () => {
  const view = read("components/ConfirmView.tsx");
  // 편집은 로컬 즉시 반영 + reqID별 직렬 큐로 백그라운드 저장
  assert.match(view, /const queueRequestEdit = useCallback/, "편집 큐가 있어야 한다");
  assert.match(view, /drainRequestEdits/, "확인/등록/삭제 전에 대기 편집을 비워야 한다");
  const act = view.slice(view.indexOf("const act = useCallback"), view.indexOf("// 확인요청 삭제"));
  assert.match(act, /await drainRequestEdits\(reqID\)/, "액션 전에 편집 큐를 드레인해야 한다");
  // 저장 후 전체 목록이 아니라 그 카드만 갱신
  assert.match(view, /action=card&reqID=/, "단일 카드 갱신 API를 써야 한다");
  // 편집 중에는 서버 카드가 로컬 편집을 되덮지 않는다
  assert.match(view, /pendingEditCountsRef\.current\.get\(reqID\)\) return/, "저장 중 서버 카드 패치를 막아야 한다");
  // 인라인 편집기는 저장을 기다리지 않고 즉시 닫힌다 (등록 직전 제외 반영은 예외적으로 동기 유지)
  const inline = view.slice(view.indexOf("function InlineItemEditor"), view.indexOf("/** 품목 한 줄만 수정"));
  assert.doesNotMatch(inline, /await runFunc/, "인라인 편집기는 저장을 동기로 기다리면 안 된다");
  assert.match(inline, /queueSave\(/, "인라인 편집기는 편집 큐를 써야 한다");

  const gasApi = fs.readFileSync(path.resolve(appRoot, "../..", "sheetAPI.js"), "utf8");
  assert.match(gasApi, /function doConfirmCard/, "GAS 단일 카드 조회가 있어야 한다");
});

test("거래 카드에서 할인유형 변경 — 낙관 반영 + 계약서 재생성 워커 위임", () => {
  const gas = fs.readFileSync(path.resolve(appRoot, "../..", "checkAvailability.js"), "utf8");
  const fn = section(gas, "function updateTradeDiscountType", "\nfunction updateDashboardContractStatus");
  assert.match(fn, /getRange\(row, 11\)\.setValue\(discountType\)/, "계약마스터 K열을 갱신해야 한다");
  const releaseAt = fn.indexOf("lock.releaseLock()");
  const regenAt = fn.indexOf("scheduleContractRegen(tid)");
  assert.ok(releaseAt >= 0 && regenAt > releaseAt, "재생성 예약은 잠금 밖에서 해야 한다");
  assert.doesNotMatch(fn, /deleteAndRegenerateContract/, "인라인 재생성 금지 — 워커가 처리");

  const gasApi = fs.readFileSync(path.resolve(appRoot, "../..", "sheetAPI.js"), "utf8");
  assert.match(gasApi, /case "updateTradeDiscount"/, "라우팅이 있어야 한다");
  const route = read("app/api/gas/route.ts");
  assert.match(route, /"updateTradeDiscount"/, "프록시 쓰기 화이트리스트에 있어야 한다");

  const store = read("lib/data/store.ts");
  const action = section(store, "export async function setDiscountType", "\nexport async function sendEstimate");
  const optimisticAt = action.indexOf("discountType, contractRegenPending: true");
  const gasAt = action.indexOf('gasMutationRetrying("updateTradeDiscount"');
  assert.ok(optimisticAt >= 0 && gasAt > optimisticAt, "화면 반영이 GAS 왕복보다 먼저여야 한다");
  assert.match(action, /mutateTrade\(tradeId, \(t\) => \(\{ \.\.\.t, \.\.\.previous \}\), false\)/, "실패 시 되돌려야 한다");

  const actions = read("components/TradeActions.tsx");
  assert.match(actions, /DISCOUNT_TYPE_OPTIONS\.map/, "카드에 할인유형 셀렉터가 있어야 한다");
  assert.match(actions, /discountLocked/, "반납완료·취소 후에는 잠가야 한다");
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
