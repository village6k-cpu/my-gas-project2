const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");
const ts = require("typescript");

const appRoot = path.resolve(__dirname, "..");
const date = "2026-09-12";
const tradeId = "260912-999";
const scheduleId = `${tradeId}-1`;
const copy = (value) => JSON.parse(JSON.stringify(value));
const drain = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

function trade(overrides = {}) {
  return {
    tradeId, customerName: "동기화 테스트", customerPhone: "",
    checkoutAt: "2026-09-12T01:00:00.000Z", returnAt: "2026-09-13T01:00:00.000Z",
    contractStatus: "예약", contractUrl: "https://example.test/contract/original",
    setupDone: false, returnDone: false, kakaoConversationChecked: false,
    photos: [], riskWarnings: [], returnCounts: {},
    equipments: [{ scheduleId, name: "테스트 카메라", qty: 1, checkoutState: "pending" }],
    ...overrides,
  };
}

function detail(checkedCheckout = false, overrides = {}) {
  return {
    tradeId, name: "동기화 테스트", tel: "", contractStatus: "예약",
    contractUrl: "https://example.test/contract/rebuilt",
    setupDone: false, returnDone: false, setupDoneAt: "", returnDoneAt: "",
    equipments: [{ scheduleId, name: "테스트 카메라", qty: 1, setName: "",
      isHeader: false, isComponent: false, checkedCheckout, checkedCheckin: false }],
    cardCautions: [], ...overrides,
  };
}

// Load the complete production store, sync and mapping modules. Only network,
// realtime delivery and browser persistence/timers are controlled by the test.
async function harness(initial = trade(), storage = new Map()) {
  let server = copy(initial);
  let onChange;
  let readGas = async () => ({ checkout: [], checkin: [], items: [], groups: [] });
  const patches = [];
  const modules = new Map();
  const contexts = [];
  const timers = new Map();
  let timerId = 0;
  const setTimer = (fn) => { const id = ++timerId; timers.set(id, fn); return id; };
  const localStorage = {
    getItem: (key) => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, String(value)),
    removeItem: (key) => storage.delete(key),
  };
  const remote = {
    fetchAllTrades: async () => [copy(server)],
    fetchTradesByIds: async (ids) => ids.includes(tradeId) ? [copy(server)] : [],
    fetchNotes: async () => [],
    searchTradesRemote: async () => [copy(server)],
    activeWindowStartYmd: () => "2026-08-01",
    subscribeChanges: (cb) => { onChange = cb; },
    persistTrade: async () => {}, // insert-ignore cannot alter an existing row
    persistTradeFieldPatch: async (id, patch) => {
      assert.equal(id, tradeId);
      patches.push(copy(patch));
      const mapper = load(path.join(appRoot, "lib/data/mappers.ts"));
      server = mapper.tradeFromRow({ ...mapper.tradeToRow(server), ...copy(patch) }, server.equipments);
    },
  };
  function load(filename) {
    if (modules.has(filename)) return modules.get(filename);
    const relative = path.relative(appRoot, filename).replaceAll("\\", "/");
    if (relative === "lib/supabase/client.ts") return { isSupabase: true, supabase: null };
    if (relative === "lib/data/remote.ts") return remote;
    if (relative === "lib/data/apiClient.ts") return {
      gasFetch: async (query) => {
        const body = await readGas(new URLSearchParams(query));
        return { json: async () => copy(body) };
      },
    };
    if (relative === "lib/data/writeback.ts") return {
      writeBackEnabled: true, setGasWriteFailureHandler() {},
      gasMutation: async (action) => { throw new Error(`unexpected mutation: ${action}`); },
    };
    if (relative === "lib/data/photoUploadQueue.ts") return {};
    const exports = {};
    modules.set(filename, exports);
    const fromFile = createRequire(filename);
    const context = {
      exports, console, URL, URLSearchParams, Date, Math,
      setTimeout: setTimer, clearTimeout: (id) => timers.delete(id),
      setInterval: setTimer, clearInterval: (id) => timers.delete(id),
      require(specifier) {
        if (!specifier.startsWith(".")) return fromFile(specifier);
        const target = path.resolve(path.dirname(filename), specifier);
        const resolved = [target, `${target}.ts`, `${target}.tsx`, `${target}.js`]
          .find((file) => fs.existsSync(file) && fs.statSync(file).isFile());
        if (!resolved) throw new Error(`cannot resolve ${specifier} from ${filename}`);
        return /\.tsx?$/.test(resolved) ? load(resolved) : fromFile(resolved);
      },
    };
    contexts.push(context);
    let source = fs.readFileSync(filename, "utf8");
    if (relative === "lib/data/store.ts") source += `\n(exports as any).inspect = {
      snapshot: getSnapshot, load: loadRemote, flush: flushRealtimeChanges,
      flushFields: flushTradePersist, subscribe,
    };`;
    vm.runInNewContext(ts.transpileModule(source, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    }).outputText, context, { filename });
    return exports;
  }
  const api = load(path.join(appRoot, "lib/data/store.ts"));
  for (const context of contexts) {
    context.window = { localStorage, setTimeout: setTimer, addEventListener() {} };
    context.document = { hidden: false, addEventListener() {} };
  }
  api.loadDay(date);
  await api.inspect.load();
  await drain();
  return {
    api, patches, storage,
    current: () => api.inspect.snapshot().trades[0],
    gas: (handler) => { readGas = handler; },
    server: () => copy(server),
    async realtime(next) {
      server = copy(next);
      onChange({ table: "trades", tradeId });
      await api.inspect.flush();
      await drain();
    },
    async poll() { await api.pollSheetChangesNow({ mode: "light" }); await drain(); },
  };
}

for (const [state, stale] of [["taken", false], ["pending", true]]) {
  test(`시트 상세 복구는 저장된 장비 ${state} 상태를 과거 체크로 되돌리지 않는다`, async () => {
    const h = await harness(trade({ equipments: [{ scheduleId, name: "테스트 카메라", qty: 1, checkoutState: state }] }));
    h.gas(async () => ({ checkout: [detail(stale)], checkin: [] }));
    await h.poll();
    assert.equal(h.current().contractUrl, "https://example.test/contract/rebuilt", "상세 복구는 계속 적용되어야 한다");
    assert.equal(h.current().equipments[0].checkoutState, state);
  });
}

test("시트 상세 복구는 저장된 반출·반납 완료와 완료 시각을 유지한다", async () => {
  const h = await harness(trade({ setupDone: true, returnDone: true, contractStatus: "반납완료",
    setupDoneAt: "2026-09-12T01:02:00.000Z", returnDoneAt: "2026-09-13T01:03:00.000Z" }));
  h.gas(async () => ({ checkout: [], checkin: [detail()] }));
  await h.poll();
  assert.equal(h.current().setupDone, true);
  assert.equal(h.current().returnDone, true);
  assert.equal(h.current().contractStatus, "반납완료");
  assert.equal(h.current().setupDoneAt, "2026-09-12T01:02:00.000Z");
  assert.equal(h.current().returnDoneAt, "2026-09-13T01:03:00.000Z");
});

for (const source of ["dashboard", "timeline", "search"]) {
  test(`늦은 ${source} 응답은 다른 기기에서 도착한 카카오톡·장비 체크를 되돌리지 않는다`, async () => {
    const h = await harness();
    const started = deferred();
    const response = deferred();
    h.gas(async (query) => {
      const expected = source === "search" ? "dashboardSearch" : source;
      if (query.get("action") !== expected) return { checkout: [], checkin: [], groups: [], items: [] };
      started.resolve();
      return response.promise;
    });
    const pending = source === "search" ? h.api.repairSearchResults("동기화") : h.poll();
    await started.promise;
    const peer = trade({ kakaoConversationChecked: true,
      equipments: [{ scheduleId, name: "테스트 카메라", qty: 1, checkoutState: "taken" }] });
    await h.realtime(peer);
    assert.equal(h.current().kakaoConversationChecked, true);
    response.resolve(source === "timeline" ? {
      groups: [{ i: "cam", c: "테스트 카메라" }],
      items: [{ tid: tradeId, g: "cam", r: 1, q: 1, cn: "동기화 테스트", st: "대기",
        s: Date.parse("2026-09-12T02:00:00Z"), e: Date.parse("2026-09-13T01:00:00Z") }],
    } : { checkout: [detail()], checkin: [] });
    await pending;
    await drain();
    assert.equal(h.current().kakaoConversationChecked, true);
    assert.equal(h.current().equipments[0].checkoutState, "taken");
    await h.realtime(trade());
    assert.equal(h.current().kakaoConversationChecked, false, "다른 직원의 실제 체크 해제는 반영해야 한다");
    assert.equal(h.current().equipments[0].checkoutState, "pending");
  });
}

test("카카오톡 체크와 해제는 해당 열만 저장하며 재시작 후에도 유지한다", async () => {
  const h = await harness();
  h.api.setKakaoConversationChecked(tradeId, true);
  await h.api.inspect.flushFields(tradeId);
  await drain();
  assert.deepEqual(h.patches, [{ kakao_conversation_checked: true }]);
  const restarted = await harness(h.server(), h.storage);
  assert.equal(restarted.current().kakaoConversationChecked, true);
  restarted.api.setKakaoConversationChecked(tradeId, false);
  await restarted.api.inspect.flushFields(tradeId);
  assert.deepEqual(restarted.patches, [{ kakao_conversation_checked: false }]);
  assert.equal(restarted.server().kakaoConversationChecked, false);
});
