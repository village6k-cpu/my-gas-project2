const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");
const ts = require("typescript");

const appRoot = path.resolve(__dirname, "..");
const version = '2026-09-12T01:00:00.123456+00:00';
const version2 = '2026-09-12T01:00:01.123457+00:00';
const outboxKey = 'heybilly:item-check-outbox:v1';
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

function ack(checked, updatedAt = version2, applied = true) {
  return { results: [{ scheduleId, ok: true, checked, updatedAt, applied }] };
}

test('mapper retains the exact observed row token but never emits it as a metadata write', () => {
  const exports = {};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(appRoot, 'lib/data/mappers.ts'), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS },
  }).outputText, { exports });
  const item = exports.itemFromRow({ schedule_id: scheduleId, trade_id: tradeId, updated_at: version, checkout_state: 'pending' });
  assert.equal(item.checkoutVersion, version);
  assert.equal(exports.itemToRow(item, tradeId, 0).updated_at, undefined);
});

test('new deliberate click freezes the displayed opaque token into the durable outbox and request', async () => {
  const h = await harness();h.mutate(async () => ack(true));
  h.api.setItemCheckout(tradeId, scheduleId, 'taken');
  assert.equal(JSON.parse(h.storage.get(outboxKey))[`${tradeId}|${scheduleId}`].expectedUpdatedAt, version);
  await h.api.inspect.commit(tradeId);
  assert.equal(JSON.parse(h.writes[0].params.items)[0].expectedUpdatedAt, version);
  assert.equal(h.current().equipments[0].checkoutVersion, version2);
  assert.equal(h.storage.has(outboxKey), false);
});

test('only latest unsent same-item intent advances from its own direct applied predecessor ACK', async () => {
  const h = await harness(), a = deferred();h.mutate(async () => a.promise);
  h.api.setItemCheckout(tradeId, scheduleId, 'taken');const first = h.api.inspect.commit(tradeId);await drain();
  h.api.setItemCheckout(tradeId, scheduleId, 'pending');
  h.api.setItemCheckout(tradeId, scheduleId, 'taken');
  const latest = JSON.parse(h.storage.get(outboxKey))[`${tradeId}|${scheduleId}`].mutationId;
  a.resolve(ack(true));await first;
  h.mutate(async () => ack(true, '2026-09-12T01:00:02.123458+00:00'));
  await h.api.inspect.commit(tradeId);
  const sent = JSON.parse(h.writes[1].params.items)[0];
  assert.equal(sent.mutationId, latest);assert.equal(sent.expectedUpdatedAt, version2);assert.equal(sent.done, true);
});

test('converged or uncertain predecessor never rebases its dependent click and never auto-resends it', async () => {
  for (const uncertain of [false, true]) {
    const h = await harness(), a = deferred();h.mutate(async () => a.promise);
    h.api.setItemCheckout(tradeId, scheduleId, 'taken');const first = h.api.inspect.commit(tradeId);await drain();
    h.api.setItemCheckout(tradeId, scheduleId, 'pending');
    a.resolve(uncertain ? { results: [{ scheduleId, ok: false, outcomeUnknown: true, error: 'offline' }] } : ack(true, version2, false));
    await first;await h.api.inspect.commit(tradeId);
    assert.equal(h.writes.length, 1);
    const entry = JSON.parse(h.storage.get(outboxKey))[`${tradeId}|${scheduleId}`];
    assert.equal(entry.expectedUpdatedAt, version);assert.ok(entry.blocked);
  }
});

test('legacy restored outbox never acquires a fresh server baseline or sends automatically', async () => {
  const entry = { tradeId, scheduleId, done: true, mutationId: 'old-v1-intent' };
  const h = await harness(trade(), new Map([[outboxKey, JSON.stringify({ [`${tradeId}|${scheduleId}`]: entry })]]));
  await h.api.inspect.commit(tradeId);
  assert.equal(h.writes.length, 0);assert.equal(h.current().equipments[0].checkoutState, 'pending');
  const stored = JSON.parse(h.storage.get(outboxKey))[`${tradeId}|${scheduleId}`];
  assert.equal(stored.expectedUpdatedAt, undefined);assert.ok(stored.blocked);
});

test('restored versioned intent retains its original token and conflict requires a new deliberate click', async () => {
  const entry = { tradeId, scheduleId, done: true, mutationId: 'old-cas-intent', expectedUpdatedAt: version };
  const initial = trade();initial.equipments[0].checkoutVersion = version2;
  const h = await harness(initial, new Map([[outboxKey, JSON.stringify({ [`${tradeId}|${scheduleId}`]: entry })]]));
  h.mutate(async () => ({ results: [{ scheduleId, ok: false, applied: false, outcomeUnknown: false, code: 'CHECKOUT_CONFLICT', error: 'changed' }] }));
  await h.api.inspect.commit(tradeId);await h.api.inspect.commit(tradeId);
  assert.equal(h.writes.length, 1);assert.equal(JSON.parse(h.writes[0].params.items)[0].expectedUpdatedAt, version);
  h.api.setItemCheckout(tradeId, scheduleId, 'taken');h.mutate(async () => ack(true));await h.api.inspect.commit(tradeId);
  assert.equal(JSON.parse(h.writes[1].params.items)[0].expectedUpdatedAt, version2);
});

test('a restored pending predecessor dependency is quarantined even with a valid version', async () => {
  const entry = { tradeId, scheduleId, done: true, mutationId: 'B', expectedUpdatedAt: version, predecessorMutationId: 'A' };
  const h = await harness(trade(), new Map([[outboxKey, JSON.stringify({ [`${tradeId}|${scheduleId}`]: entry })]]));
  await h.api.inspect.commit(tradeId);assert.equal(h.writes.length, 0);
  assert.ok(JSON.parse(h.storage.get(outboxKey))[`${tradeId}|${scheduleId}`].blocked);
});

test('a click without an observed canonical version fails closed instead of borrowing a future fetch', async () => {
  const initial = trade();delete initial.equipments[0].checkoutVersion;
  const h = await harness(initial);h.api.setItemCheckout(tradeId, scheduleId, 'taken');await h.api.inspect.commit(tradeId);
  assert.equal(h.writes.length, 0);
});

test('GAS detail merge retains the token only with the same canonical item identity', async () => {
  const h = await harness();h.gas(async () => ({ checkout: [detail(false)], checkin: [] }));await h.poll();
  assert.equal(h.current().equipments[0].checkoutVersion, version);
  const changed = h.merge(detail(false, { equipments: [{ scheduleId, name: 'changed identity', qty: 1 }] }));
  assert.equal(changed.equipments[0].checkoutVersion, undefined);
});

test('uncertain current intent retries only the same frozen token and mutation ID', async () => {
  const h = await harness();h.mutate(async () => ({ results: [{ scheduleId, ok: false, outcomeUnknown: true, error: 'offline' }] }));
  h.api.setItemCheckout(tradeId, scheduleId, 'taken');await h.api.inspect.commit(tradeId);
  const first = JSON.parse(h.writes[0].params.items)[0];
  h.mutate(async () => ack(true, version2, false));await h.api.inspect.flushItems(tradeId);
  assert.deepEqual(JSON.parse(h.writes[1].params.items)[0], first);
  assert.equal(h.storage.has(outboxKey), false);
});

test('unversioned success response cannot authorize dependent writes or silently ACK an intent', async () => {
  const h = await harness();h.mutate(async () => ({ results: [{ scheduleId, ok: true, checked: true }] }));
  h.api.setItemCheckout(tradeId, scheduleId, 'taken');await h.api.inspect.commit(tradeId);await h.api.inspect.commit(tradeId);
  assert.equal(h.writes.length, 1);assert.ok(JSON.parse(h.storage.get(outboxKey))[`${tradeId}|${scheduleId}`].blocked);
});

test('batch partial conflict quarantines only that item and preserves the independent applied ACK', async () => {
  const initial = trade(), secondId = `${tradeId}-2`;
  initial.equipments.push({ ...initial.equipments[0], scheduleId: secondId });
  const h = await harness(initial);h.mutate(async () => ({ results: [ack(true).results[0],
    { scheduleId: secondId, ok: false, applied: false, outcomeUnknown: false, code: 'CHECKOUT_CONFLICT', error: 'changed' }] }));
  h.api.setItemCheckout(tradeId, scheduleId, 'taken');h.api.setItemCheckout(tradeId, secondId, 'taken');await h.api.inspect.commit(tradeId);
  assert.equal(h.current().equipments[0].checkoutVersion, version2);assert.equal(h.current().equipments[0].checkoutState, 'taken');
  assert.equal(h.current().equipments[1].checkoutState, 'pending');
  const outbox = JSON.parse(h.storage.get(outboxKey));assert.equal(outbox[`${tradeId}|${scheduleId}`], undefined);assert.ok(outbox[`${tradeId}|${secondId}`].blocked);
});

test('a new click after its item ACK uses that version even while a sibling readback is still pending', async () => {
  const initial = trade(), secondId = `${tradeId}-2`, read = deferred();
  initial.equipments.push({ ...initial.equipments[0], scheduleId: secondId });
  const h = await harness(initial);h.onRead(() => read.promise);
  h.mutate(async () => ({ results: [ack(true).results[0], { scheduleId: secondId, ok: false, outcomeUnknown: false, error: 'changed' }] }));
  h.api.setItemCheckout(tradeId, scheduleId, 'taken');h.api.setItemCheckout(tradeId, secondId, 'taken');
  const first = h.api.inspect.commit(tradeId);await drain();
  assert.equal(h.current().equipments[0].checkoutVersion, version2);
  h.api.setItemCheckout(tradeId, scheduleId, 'pending');
  const queued = JSON.parse(h.storage.get(outboxKey))[`${tradeId}|${scheduleId}`];
  assert.equal(queued.expectedUpdatedAt, version2);assert.equal(queued.predecessorMutationId, undefined);
  read.resolve([copy(initial)]);await first;
});

function trade(overrides = {}) {
  return {
    tradeId, customerName: "동기화 테스트", customerPhone: "",
    checkoutAt: "2026-09-12T01:00:00.000Z", returnAt: "2026-09-13T01:00:00.000Z",
    contractStatus: "예약", contractUrl: "https://example.test/contract/original",
    setupDone: false, returnDone: false, kakaoConversationChecked: false,
    photos: [], riskWarnings: [], returnCounts: {},
    equipments: [{ scheduleId, name: "테스트 카메라", qty: 1, checkoutState: "pending", checkoutVersion: version }],
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
  let canonicalReadHandler;
  const writes=[];let mutationHandler=async()=>({results:[]});
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
    fetchTradesByIds: async (ids) => canonicalReadHandler ? canonicalReadHandler(ids) : (ids.includes(tradeId) ? [copy(server)] : []),
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
      isGasOutcomeUnknownError: error => error?.outcomeUnknown === true,
      gasMutation: async (action, params) => { writes.push({action,params});return mutationHandler(action,params); },
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
    if (relative === "lib/data/sync.ts") source += `\n(exports as any).inspectMerge = mergeDashboard;`;
    if (relative === "lib/data/store.ts") source += `\n(exports as any).inspect = {
      snapshot: getSnapshot, load: loadRemote, flush: flushRealtimeChanges,
      flushFields: flushTradePersist, subscribe, commit: commitItemCheckBatch, replay: replayDurableMutationOutboxes, flushItems: flushItemCheckWritesForTrade,
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
    api, patches, storage, writes, mutate: handler => { mutationHandler=handler; },
    setServer: next => { server=copy(next); },
    onRead: handler => { canonicalReadHandler=handler; },
    current: () => api.inspect.snapshot().trades[0],
    merge: incoming => load(path.join(appRoot, "lib/data/sync.ts")).inspectMerge(api.inspect.snapshot().trades[0], incoming),
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

