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

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
}

function toggleHarness(gasRequest) {
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
    Error,
    queuedSetupRetries: [],
    console: { error() {} },
    set(patch) { Object.assign(context.state, patch); },
    beginTradeSave(tradeId) {
      context.state.savingTrades[tradeId] = true;
      return 1;
    },
    finishTradeSave(tradeId) { delete context.state.savingTrades[tradeId]; },
    mutateTrade(tradeId, fn) {
      context.state.trades = context.state.trades.map((row) => row.tradeId === tradeId ? fn(row) : row);
    },
    isGasOutcomeUnknownError(error) { return error?.outcomeUnknown === true; },
    queueSetupOutcomeRetry(...args) { context.queuedSetupRetries.push(args); },
    gasMutation() { return gasRequest.promise; },
  };
  vm.runInNewContext(`${source}\nthis.toggleSetup = toggleSetup;`, context);
  return context;
}

test("반출완료 카드는 네트워크 응답 전에 즉시 완료 상태를 표시한다", () => {
  const store = read("lib/data/store.ts");
  const toggle = sourceFunction(
    store,
    "export async function toggleSetup",
    "\nexport type ToggleReturnResult",
  );
  const optimistic = toggle.indexOf("const optimisticDoneAt");
  const localMutation = toggle.indexOf("mutateTrade(tradeId", optimistic);
  const gasRequest = toggle.indexOf('await gasMutation("toggleSetup"');

  assert.ok(optimistic >= 0, "클릭 즉시 사용할 완료시각을 먼저 만들어야 한다");
  assert.ok(localMutation > optimistic && localMutation < gasRequest, "로컬 완료 상태가 GAS 호출 전에 반영돼야 한다");
  assert.match(
    toggle.slice(localMutation, gasRequest),
    /setupDone:\s*done[\s\S]*setupDoneAt:\s*optimisticDoneAt[\s\S]*,\s*false\s*\)/,
    "낙관적 완료 표시는 서버 저장을 미리 실행하지 않아야 한다",
  );
});

test("반출완료 상태는 GAS만 쓰고 브라우저 전체 저장은 완료 필드를 제외한다", () => {
  const remote = read("lib/data/remote.ts");
  const supa = fs.readFileSync(path.resolve(appRoot, "../..", "supabaseSync.js"), "utf8");
  const persist = sourceFunction(remote, "export async function persistTrade", "\n/** 반납 체크의 빠른 경로");
  const periodic = sourceFunction(supa, "function buildSupabaseTrades_", "\n/** payload 키 구성이 같은 행끼리");
  assert.match(persist, /delete tradeRow\.setup_done/);
  assert.match(persist, /delete tradeRow\.setup_done_at/);
  assert.match(persist, /upsert\(tradeRow/);
  assert.doesNotMatch(periodic, /setup_done(?:_at)?:/, "주기 전체 동기화도 서버 권한 완료 필드를 덮어쓰면 안 된다");
});

test("실행 상태 전이: 느린 GAS 중 즉시 완료되고 성공 후 유지된다", async () => {
  const gas = deferred();
  const harness = toggleHarness(gas);
  const pending = harness.toggleSetup("T-1");
  assert.equal(harness.state.trades[0].setupDone, true);
  assert.equal(harness.state.savingTrades["T-1"], true);
  gas.resolve({ setupDoneAt: "2026-07-16T10:00:00+09:00" });
  assert.equal((await pending).ok, true);
  assert.equal(harness.state.trades[0].setupDone, true);
  assert.equal(harness.state.trades[0].setupDoneAt, "2026-07-16T10:00:00+09:00");
});

test("실행 상태 전이: GAS 실패 때만 즉시 표시를 원래 상태로 되돌린다", async () => {
  const gas = deferred();
  const harness = toggleHarness(gas);
  const pending = harness.toggleSetup("T-1");
  assert.equal(harness.state.trades[0].setupDone, true);
  gas.reject(new Error("원장 저장 실패"));
  const result = await pending;
  assert.equal(result.ok, false);
  assert.equal(result.error, "원장 저장 실패");
  assert.equal(harness.state.trades[0].setupDone, false);
  assert.equal(harness.state.trades[0].setupDoneAt, null);
});

test("실행 상태 전이: GAS 응답만 유실되면 완료를 풀지 않고 같은 상태 재시도를 예약한다", async () => {
  const gas = deferred();
  const harness = toggleHarness(gas);
  const pending = harness.toggleSetup("T-1");
  const timeout = new Error("GAS 호출 실패: signal timed out");
  timeout.outcomeUnknown = true;
  gas.reject(timeout);
  const result = await pending;
  assert.equal(result.ok, true);
  assert.match(result.warning, /서버 응답을 다시 확인 중/);
  assert.equal(harness.state.trades[0].setupDone, true);
  assert.equal(harness.state.savingTrades["T-1"], true);
  assert.equal(harness.queuedSetupRetries.length, 1);
  assert.equal(harness.queuedSetupRetries[0][0], "T-1");
  assert.equal(harness.queuedSetupRetries[0][1], true);
});

test("실행 상태 전이: 저장 중 같은 카드를 다시 눌러 중복 요청하지 않는다", async () => {
  const gas = deferred();
  const harness = toggleHarness(gas);
  const first = harness.toggleSetup("T-1");
  const second = await harness.toggleSetup("T-1");
  assert.equal(second.ok, false);
  assert.equal(second.error, "반출 상태 변경이 이미 진행 중입니다");
  gas.resolve({ setupDoneAt: "2026-07-16T10:00:00+09:00" });
  await first;
});

test("원격 새로고침은 반출완료 GAS 저장 중의 즉시 상태를 덮어쓰지 않는다", () => {
  const store = read("lib/data/store.ts");
  const pending = sourceFunction(store, "function hasPendingPersist", "\nfunction canApplyRemoteSnapshot");
  assert.match(pending, /Object\.keys\(state\.savingTrades\)\.length\s*>\s*0/);
});

test("결과 미확정 진입 뒤에는 서버 목표값 확인 전까지 절대 롤백하지 않는다", () => {
  const store = read("lib/data/store.ts");
  const writeback = read("lib/data/writeback.ts");
  const retry = sourceFunction(store, "function queueSetupOutcomeRetry", "\nfunction mutateTrade");
  assert.match(retry, /await gasMutation\("toggleSetup", \{ tid: tradeId, done \}\)/);
  assert.match(retry, /await fetchSetupCompletion\(tradeId\)/);
  assert.match(retry, /confirmed\.done === done[\s\S]*finishTradeSave/);
  assert.match(retry, /queueSetupOutcomeRetry\(tradeId, done, optimisticDoneAt, saveId, attempt \+ 1\)/);
  assert.doesNotMatch(retry, /setupDone: previousDone|finishTradeSave\([^)]*"error"/);
  assert.match(writeback, /try \{[\s\S]*await gasPost[\s\S]*await[\s\S]*gasFetch[\s\S]*catch \(error\)[\s\S]*new GasMutationError\([^,]+, true\)/);
});
