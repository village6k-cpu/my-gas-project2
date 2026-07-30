// 반출/반납완료 즉시 확정 UX 회귀 테스트.
// 계약: 클릭 경로는 어떤 네트워크도 기다리지 않고(낙관 표시+내구 outbox+flashSave) 즉시
// 반환하며, 서버 확정·응답 유실 재확인·거절 롤백은 전부 백그라운드 확정 엔진
// (replayCompletionMutationEntry_)이 담당한다. '저장 중' 카드 잠금을 서버 왕복 동안
// 유지하던 이전 방식은 "예전엔 즉시였는데 느려졌다" 민원의 원인이었다.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const appRoot = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(appRoot, file), "utf8");

function sourceFunction(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.ok(start >= 0 && end > start, `${startMarker} 구현을 찾을 수 있어야 한다`);
  return source.slice(start, end);
}

// ── 클릭 경로 하니스: 즉시 반환 + outbox 기록 + 백그라운드 예약 ──
function toggleHarness() {
  const store = read("lib/data/store.ts");
  const source = sourceFunction(store, "export async function toggleSetup", "\nexport type ToggleReturnResult")
    .replace(
      /export async function toggleSetup\(tradeId: string\): Promise<ToggleSetupResult>/,
      "async function toggleSetup(tradeId)",
    );
  const trade = { tradeId: "T-1", setupDone: false, setupDoneAt: null };
  const context = {
    state: { trades: [trade], savingTrades: {}, toast: null },
    isSupabase: false,
    writeBackEnabled: true,
    writeBackDisabledReason: "",
    toastSeq: 0,
    activeTradeTransitions: new Set(),
    pendingRemoveEquipmentTrades: new Set(),
    Error,
    Date,
    console: { error() {} },
    outboxPuts: [],
    scheduled: [],
    flashSaves: [],
    set(patch) { Object.assign(context.state, patch); },
    mutateTrade(tradeId, fn) {
      context.state.trades = context.state.trades.map((row) => (row.tradeId === tradeId ? fn(row) : row));
    },
    putCompletionMutationOutbox(entry) { context.outboxPuts.push(entry); },
    scheduleCompletionMutationReplay_(kind, tradeId, delay) { context.scheduled.push([kind, tradeId, delay]); },
    flashSave(tradeId) { context.flashSaves.push(tradeId); },
    createLedgerMutationId(scope) { return scope + ":m" + (context.outboxPuts.length + 1); },
  };
  vm.runInNewContext(`${source}\nthis.toggleSetup = toggleSetup;`, context);
  return context;
}

test("반출완료 클릭은 서버를 기다리지 않고 즉시 확정 표시와 함께 반환한다", async () => {
  const harness = toggleHarness();
  const result = await harness.toggleSetup("T-1");
  assert.equal(result.ok, true);
  assert.equal(harness.state.trades[0].setupDone, true, "완료 상태가 즉시 표시된다");
  assert.equal(harness.outboxPuts.length, 1, "내구 outbox에 목표가 남는다");
  assert.equal(harness.outboxPuts[0].target, true);
  assert.deepEqual(harness.scheduled[0], ["setup", "T-1", 0], "백그라운드 확정이 즉시 예약된다");
  assert.deepEqual(harness.flashSaves, ["T-1"], "즉시 저장 피드백을 보여준다");
  assert.equal(harness.state.savingTrades["T-1"], undefined, "카드를 서버 왕복 동안 잠그지 않는다");
});

test("빠른 연속 클릭은 최신 의도(해제)가 outbox에 남고 모두 즉시 반환한다", async () => {
  const harness = toggleHarness();
  await harness.toggleSetup("T-1"); // on
  const second = await harness.toggleSetup("T-1"); // off (낙관 상태 기준 반전)
  assert.equal(second.ok, true);
  assert.equal(harness.outboxPuts.length, 2);
  assert.equal(harness.outboxPuts[1].target, false, "최신 사용자 의도가 이긴다");
  assert.equal(harness.scheduled.length, 2, "확정 엔진이 최신 목표로 다시 예약된다");
  assert.equal(harness.state.trades[0].setupDone, false);
});

test("클릭 경로 소스에는 네트워크 대기가 없다 (즉시 확정 계약)", () => {
  const store = read("lib/data/store.ts");
  const setup = sourceFunction(store, "export async function toggleSetup", "\nexport type ToggleReturnResult");
  const ret = sourceFunction(store, "export async function toggleReturn", "\n// ── 품목 체크 원장 쓰기 신뢰화");
  for (const body of [setup, ret]) {
    assert.doesNotMatch(body, /await gasMutation|await flush|beginTradeTransition/, "클릭 경로는 서버·flush·카드 잠금이 없어야 한다");
    assert.match(body, /putCompletionMutationOutbox/, "내구 outbox 기록 필수");
    assert.match(body, /scheduleCompletionMutationReplay_/, "백그라운드 확정 예약 필수");
  }
});

// ── 백그라운드 확정 엔진: 결과 분기 계약 (정적 단언) ──
test("확정 엔진: 성공은 ACK, 거절은 정본 수렴+알림, 지연은 백오프(첫 실패만 토스트)", () => {
  const store = read("lib/data/store.ts");
  const replay = sourceFunction(store, "async function replayCompletionMutationEntry_", "\nfunction replayCompletionMutationOutboxes_");
  // 성공: 서버 확정값 반영 후 ACK + 짧은 저장 피드백
  assert.match(replay, /acknowledgeCompletionMutationOutbox\(latest\.kind, latest\.tradeId, latest\.mutationId\);\s*\n\s*flashSave\(latest\.tradeId\)/,
    "성공 시 ACK와 저장 피드백");
  // 명확한 거절: ACK + 거래 라벨 포함 알림 + 정본 재조회로 롤백 수렴
  assert.match(replay, /if \(!isRetryableLedgerError\(error\)\)[\s\S]{0,700}completionTradeLabel_[\s\S]{0,300}reconcileCompletionMutationCanonical_/,
    "거절은 크게 알리고 정본으로 수렴한다");
  // 응답 유실: 반출은 Supabase 정본 재확인으로 재전송 없이 수렴 가능
  assert.match(replay, /fetchSetupCompletion\(latest\.tradeId\)/, "정본이 이미 목표면 재전송 없이 수렴");
  // 재시도 가능: 낙관 유지 + attempts 기록 + 백오프, 지연 토스트는 첫 실패만
  assert.match(replay, /updateCompletionMutationOutboxAttempts\(latest, attempts\)/);
  assert.match(replay, /attempts === 1[\s\S]{0,200}저장 지연/, "백오프마다 토스트 쌍이 반복되면 안 된다");
  // 카드 잠금 없음
  assert.doesNotMatch(replay, /beginTradeTransition|beginTradeSave/, "확정 엔진도 카드를 잠그지 않는다");
});

test("스냅샷 게이트: 확정 대기 거래는 원격 스냅샷이 낙관 완료를 덮지 않는다", () => {
  const store = read("lib/data/store.ts");
  assert.match(store, /completionOutboxPending/, "확정 대기 게이트가 있어야 한다");
  assert.match(store, /hasTradeSyncPending[\s\S]{0,220}completionOutboxPending\.has\(tradeId\)/,
    "거래 단위 스냅샷 가드에 포함되어야 한다");
  // 메모리 미러: setItem 실패(프라이빗 모드/쿼터)에도 전송이 유실되지 않는다
  assert.match(store, /completionOutboxMemory/, "탭 메모리 미러가 있어야 한다");
  assert.match(store, /catch \{\s*\n\s*return Object\.fromEntries\(completionOutboxMemory\)/,
    "storage 실패 시에도 메모리 미러로 재생 가능해야 한다");
});

test("반출완료 상태는 GAS만 쓰고 브라우저 전체 저장은 완료 필드를 제외한다", () => {
  const remote = read("lib/data/remote.ts");
  const supa = fs.readFileSync(path.resolve(appRoot, "../..", "supabaseSync.js"), "utf8");
  const persist = sourceFunction(remote, "export async function persistTrade", "\n/** 반납 체크의 빠른 경로");
  const structure = sourceFunction(remote, "function tradeStructureRow", "\nfunction scheduleStructureRow");
  const periodic = sourceFunction(supa, "function buildSupabaseTrades_", "\n/** payload 키 구성이 같은 행끼리");
  assert.match(persist, /upsert\(tradeRow, \{[\s\S]*ignoreDuplicates: true/,
    "신규 행은 완전한 최초 상태로 만들되 기존 행은 덮지 않아야 한다");
  assert.match(structure, /delete row\.setup_done/);
  assert.match(structure, /delete row\.setup_done_at/);
  assert.match(structure, /delete row\.return_done/);
  assert.doesNotMatch(periodic, /setup_done(?:_at)?:/, "주기 전체 동기화도 서버 권한 완료 필드를 덮어쓰면 안 된다");
});

// ── 확정 엔진 실행형 하니스: 거절 롤백·재시도 백오프를 실제로 구동한다 ──
function replayHarness({ gasImpl, retryable = false }) {
  const store = read("lib/data/store.ts");
  const source = sourceFunction(store, "async function replayCompletionMutationEntry_", "\nfunction replayCompletionMutationOutboxes_")
    .replace("async function replayCompletionMutationEntry_(entry: CompletionMutationOutboxEntry): Promise<void>", "async function replayEntry(entry)")
    .replace(/ as Trade\["contractStatus"\]/g, "");
  const trade = { tradeId: "T-1", customerName: "김테스트", setupDone: false, setupDoneAt: null, returnDone: false, returnDoneAt: null, contractStatus: "예약", equipments: [] };
  const entry = { kind: "setup", tradeId: "T-1", target: true, mutationId: "m1", optimisticDoneAt: "2026-07-30T10:00:00+09:00", createdAt: Date.now(), attempts: 0 };
  const outbox = { "setup|T-1": entry };
  const context = {
    Date, Math, String, Object, Promise, Error, JSON,
    console: { error() {} },
    state: { trades: [trade] },
    isSupabase: true,
    completionMutationReplayInFlight: new Set(),
    completionDeferralToastShown: new Set(),
    completionOutboxPending: new Set(["T-1"]),
    activeTradeTransitions: new Set(),
    COMPLETION_MUTATION_OUTBOX_TTL_MS: 25 * 60 * 1000,
    acks: [], reconciles: [], toasts: [], schedules: [], attemptsUpdates: [], flashes: [],
    completionMutationOutboxEntryKey: (kind, tid) => `${kind}|${tid}`,
    readCompletionMutationOutbox: () => ({ ...outbox }),
    hasTradePending: () => false,
    mutateTrade(tradeId, fn) { context.state.trades = context.state.trades.map((t) => (t.tradeId === tradeId ? fn(t) : t)); },
    flushItemCheckWritesForTrade: async () => {},
    flushQueuedItemQtyForTrade: async () => {},
    flushReturnCountsPersist: async () => trade,
    returnCompletionBlockers: () => [],
    gasMutation: gasImpl,
    requireCompletionMutationResult_(res, field) {
      if (!res || typeof res !== "object" || typeof res[field] !== "boolean") {
        const err = new Error("확정 응답 없음"); err.retryable = true; throw err;
      }
      return res;
    },
    isRetryableLedgerError: () => retryable,
    fetchSetupCompletion: async () => { const err = new Error("정본 조회 실패"); throw err; },
    acknowledgeCompletionMutationOutbox(kind, tid, mid) { context.acks.push([kind, tid, mid]); delete outbox[`${kind}|${tid}`]; },
    reconcileCompletionMutationCanonical_: async (tid) => {
      context.reconciles.push(tid);
      // 정본 재조회는 서버 상태(미완료)로 되돌린다
      context.mutateTrade(tid, (t) => ({ ...t, setupDone: false, setupDoneAt: null }));
    },
    showTransientError(text) { context.toasts.push(text); },
    scheduleCompletionMutationReplay_(kind, tid, delay) { context.schedules.push([kind, tid, delay]); },
    updateCompletionMutationOutboxAttempts(e, attempts) { context.attemptsUpdates.push(attempts); outbox["setup|T-1"] = { ...e, attempts }; },
    completionKindLabel_: (kind) => (kind === "setup" ? "반출완료" : "반납완료"),
    completionTradeLabel_: (tid) => `김테스트(${tid})`,
    flashSave(tid) { context.flashes.push(tid); },
  };
  vm.runInNewContext(`${source}\nthis.replayEntry = replayEntry;`, context);
  return { context, entry };
}

test("확정 엔진 실행: 명확한 거절은 ACK 후 정본 재조회로 낙관 표시를 되돌리고 크게 알린다", async () => {
  const { context, entry } = replayHarness({
    gasImpl: async () => { throw new Error("반납완료 차단: 미확인 품목"); },
    retryable: false,
  });
  await context.replayEntry(entry);
  assert.equal(context.acks.length, 1, "거절은 outbox를 ACK한다");
  assert.deepEqual(context.reconciles, ["T-1"], "정본 재조회로 수렴한다");
  assert.equal(context.state.trades[0].setupDone, false, "낙관 완료 표시가 서버 상태로 되돌아간다");
  assert.ok(context.toasts.some((t) => t.includes("김테스트") && t.includes("거절됨")), "거래 라벨과 함께 크게 알린다");
  assert.equal(context.schedules.length, 0, "거절은 재시도하지 않는다");
});

test("확정 엔진 실행: 재시도 가능 오류는 낙관 유지 + 백오프 재예약, 지연 토스트는 첫 실패만", async () => {
  const { context, entry } = replayHarness({
    gasImpl: async () => { const e = new Error("다른 변경 작업 처리 중"); e.retryable = true; throw e; },
    retryable: true,
  });
  await context.replayEntry(entry);
  assert.equal(context.acks.length, 0, "재시도 가능 오류는 ACK하지 않는다");
  assert.equal(context.state.trades[0].setupDone, true, "낙관 완료 표시를 유지한다");
  assert.deepEqual(context.attemptsUpdates, [1]);
  assert.equal(context.schedules.length, 1, "백오프 재예약");
  assert.equal(context.toasts.filter((t) => t.includes("저장 지연")).length, 1, "첫 실패만 지연 안내");
  // 두 번째 실패: attempts 2, 추가 지연 토스트 없음
  const second = { ...entry, attempts: 1 };
  await context.replayEntry(second);
  assert.equal(context.toasts.filter((t) => t.includes("저장 지연")).length, 1, "반복 토스트 금지");
});

test("확정 엔진 실행: 성공은 서버 확정값 반영 + ACK + 저장 피드백", async () => {
  const { context, entry } = replayHarness({
    gasImpl: async () => ({ setupDone: true, setupDoneAt: "2026-07-30 10:00:05" }),
    retryable: false,
  });
  await context.replayEntry(entry);
  assert.equal(context.acks.length, 1);
  assert.equal(context.state.trades[0].setupDone, true);
  assert.equal(context.state.trades[0].setupDoneAt, "2026-07-30 10:00:05", "서버 확정 시각을 반영한다");
  assert.deepEqual(context.flashes, ["T-1"]);
  assert.equal(context.reconciles.length, 0);
});
