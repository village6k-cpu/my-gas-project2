import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const require = createRequire(import.meta.url);
const ts = require("typescript");
const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const routePath = path.join(appRoot, "app/api/follow-ups/route.ts");

function loadRoute({ authed = true, enabled = "1", serviceKey = "service-role-key", fetchImpl = async () => response([]) } = {}) {
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
  const context = {
    module,
    exports: module.exports,
    process: { env: {
      NEXT_PUBLIC_SUPABASE_URL: "https://unit.test",
      NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon-key",
      SUPABASE_SERVICE_ROLE_KEY: serviceKey,
      WORK_ORCHESTRATOR_V2_DASHBOARD_ENABLED: enabled,
    } },
    require(specifier) {
      if (specifier === "next/server") return { NextResponse: { json: responseJson } };
      if (specifier === "@/lib/server/authCache") return { isAuthedRequest: async () => authed };
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

async function readBody(result) {
  return JSON.parse(JSON.stringify(await result.json()));
}

test("v2 GET rejects an unauthenticated request before config or database access", async () => {
  let fetchCalls = 0;
  const { GET } = loadRoute({ authed: false, fetchImpl: async () => { fetchCalls += 1; throw new Error("must not fetch"); } });

  const result = await GET(getRequest());

  assert.equal(result.status, 401);
  assert.deepEqual(await readBody(result), { error: "인증 필요" });
  assert.equal(fetchCalls, 0);
});

test("v2 GET requires the server service-role key and never falls back to anon", async () => {
  let fetchCalls = 0;
  const { GET } = loadRoute({ serviceKey: "", fetchImpl: async () => { fetchCalls += 1; throw new Error("must not fetch"); } });

  const result = await GET(getRequest());

  assert.equal(result.status, 503);
  assert.deepEqual(await readBody(result), { error: "work orchestrator unavailable" });
  assert.equal(fetchCalls, 0);
});

test("v2 GET reads only active allowlisted fields with service role and maps them to dashboard items", async () => {
  const requests = [];
  const { GET } = loadRoute({ fetchImpl: async (url, init) => {
    requests.push({ url, init });
    return response([{
      id: "v2-1",
      room_key: "room-1",
      title: "반납 일정 확인",
      summary: "내일 10시 반납 확인 필요",
      work_type: "reservation_review_timeout",
      priority: "p0",
      state: "snoozed",
      due_at: "2026-09-01T01:00:00.000Z",
      first_opened_at: "2026-08-31T01:00:00.000Z",
      updated_at: "2026-08-31T02:00:00.000Z",
      recommended_action: "직원에게 반납 일정을 확인하세요",
      blocking_reason: "고객 회신 대기",
      due_hint: "오늘 중",
      work_key: "do-not-expose",
      source_event_keys: ["do-not-expose"],
      pending_action: { secret: "do-not-expose" },
      resolution_evidence: { secret: "do-not-expose" },
      payload: { customer_message: "do-not-expose" },
    }]);
  } });

  const result = await GET(getRequest());
  const body = await readBody(result);

  assert.equal(result.status, 200);
  assert.equal(body.source, "work_items_v2");
  assert.deepEqual(body.items, [{
    id: "v2-1",
    room_key: "room-1",
    type: "reservation_review",
    priority: "urgent",
    status: "waiting_internal",
    title: "반납 일정 확인",
    summary: "내일 10시 반납 확인 필요",
    recommended_action: "직원에게 반납 일정을 확인하세요",
    blocking_reason: "고객 회신 대기",
    due_hint: "오늘 중",
    created_at: "2026-08-31T01:00:00.000Z",
    updated_at: "2026-08-31T02:00:00.000Z",
  }]);
  assert.equal(JSON.stringify(body).includes("do-not-expose"), false);
  assert.equal(requests.length, 1);
  assert.match(requests[0].url, /\/work_items_v2\?select=/);
  assert.match(requests[0].url, /state=in\.\(open,in_progress,snoozed\)/);
  assert.equal(requests[0].init.headers.apikey, "service-role-key");
  assert.equal(requests[0].init.headers.authorization, "Bearer service-role-key");
  assert.equal(requests[0].url.includes("pending_action"), false);
  assert.equal(requests[0].url.includes("resolution_evidence"), false);
  assert.equal(requests[0].url.includes("source_event_keys"), false);
  assert.equal(requests[0].url.includes("work_key"), false);
  assert.match(requests[0].url, /recommended_action:payload->>recommended_action/);
  assert.equal(requests[0].url.includes(",payload,"), false);
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

test("v2 PATCH fails closed before any legacy database call", async () => {
  let fetchCalls = 0;
  const { PATCH } = loadRoute({ fetchImpl: async () => { fetchCalls += 1; throw new Error("must not fetch"); } });

  const result = await PATCH({ async json() { return { id: "v2-1", status: "done" }; } });

  assert.equal(result.status, 409);
  assert.deepEqual(await readBody(result), { error: "work orchestrator v2 is read-only" });
  assert.equal(fetchCalls, 0);
});
