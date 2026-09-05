import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire, registerHooks } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const require = createRequire(import.meta.url);
const ts = require("typescript");
const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const routePath = path.join(appRoot, "app/api/follow-ups/route.ts");
const AUTH_USER_ID = "550e8400-e29b-41d4-a716-446655440000";
const authCacheHooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    const result = nextResolve(specifier, context);
    return result.url.endsWith(".ts") || result.url.includes(".ts?")
      ? { ...result, format: "module-typescript" }
      : result;
  },
});
const realAuthCache = await import("../lib/server/authCache.ts");

test.after(() => authCacheHooks.deregister());

function loadRoute({
  authed = true,
  enabled = "1",
  omitEnabled = false,
  serviceKey = "service-role-key",
  anonKey = "anon-key",
  authModule = {
    getAuthedUser: async () => (authed ? { id: AUTH_USER_ID } : null),
    isAuthedRequest: async () => authed,
  },
  fetchImpl = async () => response([]),
} = {}) {
  const source = readFileSync(routePath, "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    fileName: routePath,
  }).outputText;
  const module = { exports: {} };
  const responseJson = (body, init = {}) => ({
    status: init.status || 200,
    body,
    async json() { return body; },
  });
  const env = {
    NEXT_PUBLIC_SUPABASE_URL: "https://unit.test",
    NEXT_PUBLIC_SUPABASE_ANON_KEY: anonKey,
    SUPABASE_SERVICE_ROLE_KEY: serviceKey,
  };
  if (!omitEnabled) env.WORK_ORCHESTRATOR_V2_DASHBOARD_ENABLED = enabled;
  const context = {
    module,
    exports: module.exports,
    process: { env },
    require(specifier) {
      if (specifier === "next/server") return { NextResponse: { json: responseJson } };
      if (specifier === "@/lib/server/authCache") return authModule;
      if (specifier === "@/lib/followups/logic") return {
        dedupeFollowUpItems: (items) => items,
        duplicateFollowUpIdsForItem: () => [],
        duplicateFollowUpIdsForItems: () => [],
        shouldHideLowValueActiveItem: () => false,
        summarize: (items) => ({ total: items.length, open: items.length, urgent: 0, high: 0, byType: [] }),
      };
      throw new Error(`unexpected import: ${specifier}`);
    },
    fetch: fetchImpl,
    AbortSignal: { timeout: () => undefined },
    URL,
    encodeURIComponent,
    Array,
    Map,
    Set,
    String,
    Number,
    Math,
    JSON,
    Date,
    Error,
    Promise,
    Buffer,
  };
  vm.runInNewContext(compiled, context, { filename: routePath });
  return module.exports;
}

function response(data, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() { return JSON.stringify(data); },
  };
}

function getRequest(status = "active") {
  return { nextUrl: new URL(`https://dashboard.test/api/follow-ups?status=${status}`) };
}

function getV2Request(query = "view=now") {
  return { nextUrl: new URL(`https://dashboard.test/api/follow-ups?${query}`) };
}

async function readBody(result) {
  return JSON.parse(JSON.stringify(await result.json()));
}

test("v2 GET rejects an unauthenticated request before config or database access", async () => {
  let fetchCalls = 0;
  const { GET } = loadRoute({ authed: false, fetchImpl: async () => { fetchCalls += 1; throw new Error("must not fetch"); } });

  const result = await GET(getV2Request());

  assert.equal(result.status, 401);
  assert.deepEqual(await readBody(result), { error: "인증 필요" });
  assert.equal(fetchCalls, 0);
});

test("v2 GET uses the real fail-closed authCache user guard when anon auth configuration is missing", async (t) => {
  const priorUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const priorAnon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://auth-misconfigured.unit.test";
  delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  t.after(() => {
    if (priorUrl === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    else process.env.NEXT_PUBLIC_SUPABASE_URL = priorUrl;
    if (priorAnon === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    else process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = priorAnon;
  });

  let fetchCalls = 0;
  const { GET } = loadRoute({
    anonKey: "",
    authModule: realAuthCache,
    fetchImpl: async () => { fetchCalls += 1; throw new Error("must not fetch"); },
  });
  const result = await GET({
    ...getV2Request(),
    headers: new Headers({ authorization: "Bearer unverified-token" }),
  });

  assert.equal(await realAuthCache.getAuthedUser({ headers: new Headers({ authorization: "Bearer unverified-token" }) }), null);
  assert.equal(await realAuthCache.isAuthedRequest({ headers: new Headers({ authorization: "Bearer unverified-token" }) }), true);
  assert.equal(result.status, 401);
  assert.deepEqual(await readBody(result), { error: "인증 필요" });
  assert.equal(fetchCalls, 0);
});

test("v2 GET requires the server service-role key and never falls back to anon", async () => {
  let fetchCalls = 0;
  const { GET } = loadRoute({ serviceKey: "", fetchImpl: async () => { fetchCalls += 1; throw new Error("must not fetch"); } });

  const result = await GET(getV2Request());

  assert.equal(result.status, 503);
  assert.deepEqual(await readBody(result), { error: "후속조치 정보를 불러오지 못했습니다" });
  assert.equal(fetchCalls, 0);
});

test("v2 GET reads only active allowlisted fields with service role and maps them to dashboard items", async () => {
  const after = {
    p0Rank: 0, overdueRank: 1, priorityRank: 1,
    openedAt: "2026-09-05T08:00:00.000Z", id: "11111111-1111-4111-8111-111111111111",
  };
  const nextCursor = {
    p0Rank: 1, overdueRank: 1, priorityRank: 0,
    openedAt: "2026-09-05T08:00:00.000Z", id: "11111111-1111-4111-8111-111111111111",
  };
  const requests = [];
  const { GET } = loadRoute({ fetchImpl: async (url, init) => {
    requests.push({ url, init });
    return response({
      summary: {
        now: 12, snoozed: 4, completed: 38, p0: 2,
        byCategory: { schedule: 5, quote: 3, settlement: 2, customer: 1, operations: 5 },
      },
      items: [{
        id: "11111111-1111-4111-8111-111111111111", version: 7,
        category: "schedule", workType: "schedule_check", workTypeLabel: "스케줄 확인",
        priority: "urgent", state: "open", title: "김OO 촬영 일정 확인",
        summary: "직원이 확인한 안전한 요약", recommendedAction: "후보 일정 하나를 선택",
        dueAt: null, snoozedUntil: null,
        firstOpenedAt: "2026-09-05T08:00:00.000Z", updatedAt: "2026-09-05T08:30:00.000Z",
      }],
      nextCursor,
      omittedCount: 11,
    });
  } });

  const encodedAfter = Buffer.from(JSON.stringify(after), "utf8").toString("base64url");
  const result = await GET({ nextUrl: new URL(`https://dashboard.test/api/follow-ups?view=now&category=schedule&limit=1&after=${encodedAfter}`) });
  const body = await readBody(result);

  assert.equal(result.status, 200);
  assert.equal(body.source, "work_items_v2");
  assert.equal(body.items[0].workType, "schedule_check");
  assert.deepEqual(Object.keys(body.items[0]).sort(), [
    "category", "dueAt", "firstOpenedAt", "id", "priority", "recommendedAction", "snoozedUntil",
    "state", "summary", "title", "updatedAt", "version", "workType", "workTypeLabel",
  ].sort());
  assert.equal(body.nextCursor, Buffer.from(JSON.stringify(nextCursor), "utf8").toString("base64url"));
  assert.equal(body.omittedCount, 11);
  assert.equal(JSON.stringify(body).includes("do-not-expose"), false);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "https://unit.test/rest/v1/rpc/list_heybilli_owner_work_v2");
  assert.equal(requests[0].init.method, "POST");
  assert.deepEqual(JSON.parse(requests[0].init.body), {
    p_now: JSON.parse(requests[0].init.body).p_now,
    p_view: "now", p_category: "schedule", p_limit: 1, p_after: after,
  });
  assert.match(JSON.parse(requests[0].init.body).p_now, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(requests[0].init.headers.apikey, "service-role-key");
  assert.equal(requests[0].init.headers.authorization, "Bearer service-role-key");
});

test("v2 GET fails closed when a successful upstream response is not an array", async () => {
  for (const malformed of [{ error: "upstream detail" }, null, "not-an-array"]) {
    const { GET } = loadRoute({ fetchImpl: async () => response(malformed) });
    const result = await GET(getV2Request());

    assert.equal(result.status, 503);
    assert.deepEqual(await readBody(result), { error: "후속조치 정보를 불러오지 못했습니다" });
  }
});

test("legacy GET remains unchanged when the v2 dashboard flag is off", async () => {
  const requests = [];
  const { GET } = loadRoute({ enabled: "0", serviceKey: "", fetchImpl: async (url, init) => {
    requests.push({ url, init });
    return response([{ id: "legacy-1", status: "open", type: "reply_needed", title: "기존 후속조치" }]);
  } });

  const result = await GET(getRequest());
  const body = await readBody(result);

  assert.equal(result.status, 200);
  assert.equal(Object.hasOwn(body, "source"), false);
  assert.deepEqual(body.items, [{ id: "legacy-1", status: "open", type: "reply_needed", title: "기존 후속조치" }]);
  assert.equal(requests.length, 1);
  assert.match(requests[0].url, /\/ai_follow_up_items\?select=/);
  assert.match(requests[0].url, /status=not\.in\.\(done,dismissed\)/);
  assert.equal(requests[0].init.headers.apikey, "anon-key");
});

test("the deployed owner inbox defaults to v2 when the dashboard flag is absent", async () => {
  const requests = [];
  const { GET } = loadRoute({
    omitEnabled: true,
    fetchImpl: async (url, init) => {
      requests.push({ url, init });
      return response({
        summary: {
          now: 1, snoozed: 0, completed: 0, p0: 0,
          byCategory: { schedule: 1, quote: 0, settlement: 0, customer: 0, operations: 0 },
        },
        items: [{
          id: "11111111-1111-4111-8111-111111111111", version: 7,
          category: "schedule", workType: "schedule_check", workTypeLabel: "스케줄 확인",
          priority: "normal", state: "open", title: "촬영 일정 확인",
          summary: "직원이 확인한 안전한 요약", recommendedAction: "후보 일정 하나를 선택",
          dueAt: null, snoozedUntil: null,
          firstOpenedAt: "2026-09-05T08:00:00.000Z", updatedAt: "2026-09-05T08:30:00.000Z",
        }],
        nextCursor: null,
        omittedCount: 0,
      });
    },
  });

  const result = await GET(getV2Request());
  const body = await readBody(result);

  assert.equal(result.status, 200);
  assert.equal(body.source, "work_items_v2");
  assert.equal(body.items.length, 1);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "https://unit.test/rest/v1/rpc/list_heybilli_owner_work_v2");
  assert.equal(requests[0].init.headers.apikey, "service-role-key");
});

test("v2 PATCH records the exact versioned action with a server-owned Heybilli actor", async () => {
  const requests = [];
  const { PATCH } = loadRoute({ fetchImpl: async (url, init) => {
    requests.push({ url, init });
    return response({ applied: true, row: {
      id: "11111111-1111-4111-8111-111111111111", version: 8,
      title: "김OO 촬영 일정 확인", summary: "직원이 확인한 안전한 요약",
      work_type: "schedule_check", priority: "urgent", state: "open",
      due_at: null, snoozed_until: null, first_opened_at: "2026-09-05T08:00:00.000Z",
      updated_at: "2026-09-05T09:00:00.000Z",
      payload: { requires_human_action: true, recommended_action: "후보 일정 하나를 선택", secret: "do-not-expose" },
      pending_action: {
        type: "progress", action: { type: "progress" }, status: "pending",
        requested_at: "2026-09-05T09:00:00.000Z", requested_by: `heybilli:${AUTH_USER_ID}`, expected_version: 7,
      },
    } });
  } });

  const result = await PATCH({ async json() {
    return { id: "11111111-1111-4111-8111-111111111111", expectedVersion: 7, action: { type: "progress" } };
  } });
  const body = await readBody(result);

  assert.equal(result.status, 200);
  assert.equal(body.item.version, 8);
  assert.equal(JSON.stringify(body).includes("do-not-expose"), false);
  assert.equal(requests[0].url, "https://unit.test/rest/v1/rpc/request_work_item_action_v2");
  assert.deepEqual(JSON.parse(requests[0].init.body), {
    p_id: "11111111-1111-4111-8111-111111111111", p_expected_version: 7,
    p_action: { type: "progress" }, p_requested_by: `heybilli:${AUTH_USER_ID}`,
  });
});

test("v2 PATCH returns conflict for stale work and rejects extra browser-owned actor input", async () => {
  const requests = [];
  const { PATCH } = loadRoute({ fetchImpl: async (url, init) => {
    requests.push({ url, init });
    return response({ applied: false, row: null });
  } });
  const stale = await PATCH({ async json() {
    return { id: "11111111-1111-4111-8111-111111111111", expectedVersion: 7, action: { type: "progress" } };
  } });
  assert.equal(stale.status, 409);
  assert.deepEqual(await readBody(stale), { error: "다른 곳에서 이미 변경되었습니다" });

  const extra = await PATCH({ async json() {
    return {
      id: "11111111-1111-4111-8111-111111111111", expectedVersion: 7,
      action: { type: "progress" }, requestedBy: "UFORGED",
    };
  } });
  assert.equal(extra.status, 400);
  assert.deepEqual(await readBody(extra), { error: "invalid work action" });
  assert.equal(requests.length, 1);
});
