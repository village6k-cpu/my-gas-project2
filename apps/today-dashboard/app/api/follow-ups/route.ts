import { NextRequest, NextResponse } from "next/server";
import { getAuthedUser, isAuthedRequest as requireUser } from "@/lib/server/authCache";
import { dedupeFollowUpItems, duplicateFollowUpIdsForItem, duplicateFollowUpIdsForItems, shouldHideLowValueActiveItem, summarize } from "@/lib/followups/logic";

// 후속조치(카톡 AI봇) 보드 API — ai_follow_up_items(public 스키마).
// 로그인 게이트(사용자 토큰 검증, 공유 authCache) + DB는 service-role(서버 전용, 브라우저 노출 없음).
const SUPA_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const TABLE = process.env.SUPABASE_FOLLOW_UP_TABLE || "ai_follow_up_items";
// The shipped owner UI speaks only the v2 inbox contract. Keep the legacy route
// solely as an explicit rollback; an omitted deployment variable must not make
// the API return a different successful payload that the UI cannot render.
const V2_DASHBOARD_ENABLED = process.env.WORK_ORCHESTRATOR_V2_DASHBOARD_ENABLED !== "0";

const FIELDS =
  "id,follow_up_key,job_id,room_key,customer_name,type,priority,status,title,summary,recommended_action,suggested_reply_draft,evidence,blocking_reason,due_hint,decision_classification,decision_confidence,created_at,updated_at,completed_at";

// 중복 판정(dashboardSemanticKeys/isLowInformationDiagnosticItem)이 실제로 읽는 필드만 —
// suggested_reply_draft 등 큰 텍스트 컬럼을 후보 500건 조회에서 뺀다.
// ⚠️ evidence는 combinedFollowUpText가 의미키 계산에 사용하므로 제외 금지.
const DEDUPE_FIELDS = "id,follow_up_key,room_key,customer_name,type,title,summary,recommended_action,evidence";

const V2_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const V2_UTC_MS = /^(?!0000)[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/;
const V2_VIEWS = new Set(["now", "snoozed", "completed"]);
const V2_CATEGORIES = new Set(["schedule", "quote", "settlement", "customer", "operations"]);
const V2_PRIORITIES = new Set(["p0", "urgent", "normal", "low"]);
const V2_STATES = new Set(["open", "in_progress", "snoozed", "resolved", "dismissed"]);
const V2_TAXONOMY: Record<string, { category: string; label: string }> = {
  reservation_review: { category: "schedule", label: "예약 확인" },
  schedule_check: { category: "schedule", label: "스케줄 확인" },
  schedule_register: { category: "schedule", label: "스케줄 등록" },
  schedule_change: { category: "schedule", label: "스케줄 변경" },
  return_extension: { category: "schedule", label: "반납·연장" },
  quote_send: { category: "quote", label: "견적서 발송" },
  price_review: { category: "quote", label: "가격·할인 확인" },
  payment_check: { category: "settlement", label: "입금·결제 확인" },
  tax_invoice: { category: "settlement", label: "세금계산서 발행" },
  contract_document: { category: "settlement", label: "계약·서류 처리" },
  reply_needed: { category: "customer", label: "고객 답변 필요" },
  human_review: { category: "operations", label: "기타 사람 확인" },
  damage_repair: { category: "operations", label: "파손·수리" },
  sheet_duplicate_check: { category: "operations", label: "중복 확인" },
};
const V2_ITEM_KEYS = [
  "id", "version", "category", "workType", "workTypeLabel", "priority", "state",
  "title", "summary", "recommendedAction", "dueAt", "snoozedUntil", "firstOpenedAt", "updatedAt",
];
const V2_CURSOR_KEYS = ["p0Rank", "overdueRank", "priorityRank", "openedAt", "id"];

/* eslint-disable @typescript-eslint/no-explicit-any */
async function supaFetch(pathAndQuery: string, init: RequestInit = {}): Promise<any> {
  const key = SERVICE_KEY || ANON!;
  const res = await fetch(`${SUPA_URL}/rest/v1/${pathAndQuery}`, {
    ...init,
    // Supabase REST가 매달릴 때 라우트가 무한 대기하지 않게 상한 — 초과 시 기존 catch가 500으로 전달
    signal: AbortSignal.timeout(15_000),
    headers: { apikey: key, authorization: `Bearer ${key}`, "content-type": "application/json", ...(init.headers || {}) },
  });
  const txt = await res.text();
  let data: any = null;
  if (txt) {
    try { data = JSON.parse(txt); } catch { data = txt; }
  }
  if (!res.ok) {
    const e: any = new Error(`Supabase ${res.status}`);
    e.detail = data;
    throw e;
  }
  return data;
}

function isRecord(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: unknown, expected: string[]): value is Record<string, any> {
  if (!isRecord(value)) return false;
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  return actual.length === sorted.length && actual.every((key, index) => key === sorted[index]);
}

function canonicalTimestamp(value: unknown, nullable = false): string | null {
  if (value === null && nullable) return null;
  if (typeof value !== "string" || !V2_UTC_MS.test(value)) throw new Error("v2 response invalid");
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== value) throw new Error("v2 response invalid");
  return value;
}

function normalizeDatabaseTimestamp(value: unknown, nullable = false): string | null {
  if (value === null && nullable) return null;
  if (typeof value !== "string" || !value || value.length > 100) throw new Error("v2 response invalid");
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new Error("v2 response invalid");
  return parsed.toISOString();
}

function validateCursor(value: unknown) {
  if (!exactKeys(value, V2_CURSOR_KEYS)
    || !Number.isSafeInteger(value.p0Rank) || value.p0Rank < 0 || value.p0Rank > 1
    || !Number.isSafeInteger(value.overdueRank) || value.overdueRank < 0 || value.overdueRank > 1
    || !Number.isSafeInteger(value.priorityRank) || value.priorityRank < 0 || value.priorityRank > 3
    || typeof value.id !== "string" || !V2_UUID.test(value.id)) throw new Error("invalid cursor");
  const openedAt = canonicalTimestamp(value.openedAt);
  return { p0Rank: value.p0Rank, overdueRank: value.overdueRank, priorityRank: value.priorityRank, openedAt, id: value.id };
}

function decodeCursor(value: string | null) {
  if (value === null) return null;
  if (!/^[A-Za-z0-9_-]+$/.test(value) || value.length > 1000) throw new Error("invalid cursor");
  const bytes = Buffer.from(value, "base64url");
  if (bytes.length > 750 || bytes.toString("base64url") !== value) throw new Error("invalid cursor");
  return validateCursor(JSON.parse(bytes.toString("utf8")));
}

function encodeCursor(value: unknown) {
  if (value === null) return null;
  return Buffer.from(JSON.stringify(validateCursor(value)), "utf8").toString("base64url");
}

function validateV2Item(value: unknown, view: string, category: string | null, now: string) {
  if (!exactKeys(value, V2_ITEM_KEYS)
    || typeof value.id !== "string" || !V2_UUID.test(value.id)
    || !Number.isSafeInteger(value.version) || value.version < 1
    || typeof value.workType !== "string" || !V2_TAXONOMY[value.workType]
    || V2_TAXONOMY[value.workType].category !== value.category
    || V2_TAXONOMY[value.workType].label !== value.workTypeLabel
    || !V2_PRIORITIES.has(value.priority) || !V2_STATES.has(value.state)
    || typeof value.title !== "string" || !value.title || value.title !== value.title.trim() || value.title.length > 300
    || typeof value.summary !== "string" || value.summary.length > 2000
    || typeof value.recommendedAction !== "string" || value.recommendedAction.length > 1200) {
    throw new Error("v2 response invalid");
  }
  const dueAt = canonicalTimestamp(value.dueAt, true);
  const snoozedUntil = canonicalTimestamp(value.snoozedUntil, true);
  const firstOpenedAt = canonicalTimestamp(value.firstOpenedAt);
  const updatedAt = canonicalTimestamp(value.updatedAt);
  if (category !== null && value.category !== category) throw new Error("v2 response invalid");
  if (view === "now" && (!new Set(["open", "in_progress", "snoozed"]).has(value.state)
    || value.state === "snoozed" && (snoozedUntil === null || Date.parse(snoozedUntil) > Date.parse(now)))) {
    throw new Error("v2 response invalid");
  }
  if (view === "snoozed" && (value.state !== "snoozed" || snoozedUntil === null || Date.parse(snoozedUntil) <= Date.parse(now))) {
    throw new Error("v2 response invalid");
  }
  if (view === "completed" && !new Set(["resolved", "dismissed"]).has(value.state)) throw new Error("v2 response invalid");
  return {
    id: value.id,
    version: value.version,
    category: value.category,
    workType: value.workType,
    workTypeLabel: value.workTypeLabel,
    priority: value.priority,
    state: value.state,
    title: value.title,
    summary: value.summary,
    recommendedAction: value.recommendedAction,
    dueAt,
    snoozedUntil,
    firstOpenedAt,
    updatedAt,
  };
}

function validateInbox(value: unknown, query: { view: string; category: string | null; limit: number; now: string }) {
  if (!exactKeys(value, ["summary", "items", "nextCursor", "omittedCount"])
    || !exactKeys(value.summary, ["now", "snoozed", "completed", "p0", "byCategory"])
    || !exactKeys(value.summary.byCategory, ["schedule", "quote", "settlement", "customer", "operations"])
    || !Array.isArray(value.items) || value.items.length > query.limit
    || !Number.isSafeInteger(value.omittedCount) || value.omittedCount < 0) throw new Error("v2 response invalid");
  const counts = [value.summary.now, value.summary.snoozed, value.summary.completed, value.summary.p0, ...Object.values(value.summary.byCategory)];
  if (counts.some((count) => !Number.isSafeInteger(count) || (count as number) < 0)
    || value.summary.p0 > value.summary.now
    || Object.values(value.summary.byCategory).reduce((sum: number, count: any) => sum + count, 0)
      !== value.summary.now + value.summary.snoozed) throw new Error("v2 response invalid");
  const items = value.items.map((item: unknown) => validateV2Item(item, query.view, query.category, query.now));
  const nextCursor = value.nextCursor === null ? null : validateCursor(value.nextCursor);
  const lastItem = items.at(-1);
  if ((value.omittedCount > 0) !== (nextCursor !== null)
    || value.omittedCount > 0 && items.length !== query.limit
    || nextCursor !== null && (lastItem === undefined || nextCursor.id !== lastItem.id || nextCursor.openedAt !== lastItem.firstOpenedAt)) {
    throw new Error("v2 response invalid");
  }
  return { summary: value.summary, items, nextCursor, omittedCount: value.omittedCount };
}

function parseV2Query(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  if ([...sp.keys()].some((key) => !["view", "category", "limit", "after"].includes(key))) throw new Error("invalid query");
  const view = sp.get("view") || "now";
  const category = sp.get("category");
  const limitText = sp.get("limit") || "100";
  if (!V2_VIEWS.has(view) || category !== null && !V2_CATEGORIES.has(category) || !/^[1-9][0-9]*$/.test(limitText)) {
    throw new Error("invalid query");
  }
  const limit = Number(limitText);
  if (!Number.isSafeInteger(limit) || limit > 200) throw new Error("invalid query");
  return { view, category, limit, after: decodeCursor(sp.get("after")), now: new Date().toISOString() };
}

type V2Action =
  | { type: "progress" | "ack_p0" | "request_resolve" | "dismiss" }
  | { type: "snooze"; snoozedUntil: string };

function sameJson(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right)
      && left.length === right.length
      && left.every((entry, index) => sameJson(entry, right[index]));
  }
  if (!isRecord(left) || !isRecord(right)) return false;
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key, index) => key === rightKeys[index] && sameJson(left[key], right[key]));
}

function parseV2ActionBody(value: unknown, now: string) {
  if (!exactKeys(value, ["action", "expectedVersion", "id"])
    || typeof value.id !== "string" || !V2_UUID.test(value.id)
    || !Number.isSafeInteger(value.expectedVersion) || value.expectedVersion < 1
    || !isRecord(value.action) || typeof value.action.type !== "string") {
    throw new Error("invalid work action");
  }
  const type = value.action.type;
  if (type === "snooze") {
    if (!exactKeys(value.action, ["snoozedUntil", "type"])) throw new Error("invalid work action");
    const snoozedUntil = canonicalTimestamp(value.action.snoozedUntil);
    if (snoozedUntil === null || Date.parse(snoozedUntil) <= Date.parse(now)) throw new Error("invalid work action");
    return { id: value.id, expectedVersion: value.expectedVersion, action: { type, snoozedUntil } as V2Action };
  }
  if (!["progress", "ack_p0", "request_resolve", "dismiss"].includes(type)
    || !exactKeys(value.action, ["type"])) throw new Error("invalid work action");
  return { id: value.id, expectedVersion: value.expectedVersion, action: { type } as V2Action };
}

function safeV2ItemFromActionRow(
  row: unknown,
  request: { id: string; expectedVersion: number; action: V2Action },
  requestedBy: string,
) {
  if (!isRecord(row)
    || row.id !== request.id || row.version !== request.expectedVersion + 1
    || typeof row.work_type !== "string" || !V2_TAXONOMY[row.work_type]
    || !V2_PRIORITIES.has(row.priority) || !new Set(["open", "in_progress", "snoozed"]).has(row.state)
    || typeof row.title !== "string" || !row.title || row.title !== row.title.trim() || row.title.length > 300
    || typeof row.summary !== "string" || row.summary.length > 2000
    || !isRecord(row.payload) || row.payload.requires_human_action !== true
    || !isRecord(row.pending_action)
    || !exactKeys(row.pending_action, ["action", "expected_version", "requested_at", "requested_by", "status", "type"])
    || row.pending_action.status !== "pending"
    || row.pending_action.type !== request.action.type
    || !sameJson(row.pending_action.action, request.action)
    || row.pending_action.requested_by !== requestedBy
    || row.pending_action.expected_version !== request.expectedVersion) {
    throw new Error("v2 response invalid");
  }
  normalizeDatabaseTimestamp(row.pending_action.requested_at);
  const recommendedAction = row.payload.recommended_action === undefined ? "" : row.payload.recommended_action;
  if (typeof recommendedAction !== "string" || recommendedAction.length > 1200
    || recommendedAction && recommendedAction !== recommendedAction.trim()) throw new Error("v2 response invalid");
  const definition = V2_TAXONOMY[row.work_type];
  return {
    id: row.id,
    version: row.version,
    category: definition.category,
    workType: row.work_type,
    workTypeLabel: definition.label,
    priority: row.priority,
    state: row.state,
    title: row.title,
    summary: row.summary,
    recommendedAction,
    dueAt: normalizeDatabaseTimestamp(row.due_at, true),
    snoozedUntil: normalizeDatabaseTimestamp(row.snoozed_until, true),
    firstOpenedAt: normalizeDatabaseTimestamp(row.first_opened_at),
    updatedAt: normalizeDatabaseTimestamp(row.updated_at),
  };
}

async function getV2FollowUps(req: NextRequest) {
  if (!SERVICE_KEY) return NextResponse.json({ error: "후속조치 정보를 불러오지 못했습니다" }, { status: 503 });
  let query;
  try { query = parseV2Query(req); } catch { return NextResponse.json({ error: "invalid query" }, { status: 400 }); }
  try {
    const raw = await supaFetch("rpc/list_heybilli_owner_work_v2", {
      method: "POST",
      body: JSON.stringify({
        p_now: query.now, p_view: query.view, p_category: query.category,
        p_limit: query.limit, p_after: query.after,
      }),
    });
    const result = validateInbox(raw, query);
    return NextResponse.json({
      ok: true, source: "work_items_v2", summary: result.summary, items: result.items,
      nextCursor: encodeCursor(result.nextCursor), omittedCount: result.omittedCount,
    });
  } catch {
    return NextResponse.json({ error: "후속조치 정보를 불러오지 못했습니다" }, { status: 503 });
  }
}

export async function GET(req: NextRequest) {
  if (V2_DASHBOARD_ENABLED) {
    if (!(await getAuthedUser(req))) return NextResponse.json({ error: "인증 필요" }, { status: 401 });
    return getV2FollowUps(req);
  }
  if (!(await requireUser(req))) return NextResponse.json({ error: "인증 필요" }, { status: 401 });
  try {
    const sp = req.nextUrl.searchParams;
    const status = sp.get("status") || "active";
    const limit = Math.min(Number(sp.get("limit") || 200) || 200, 500);
    const filters = [`select=${FIELDS}`, `limit=${limit}`, "order=created_at.desc"];
    if (status === "active") filters.push("status=not.in.(done,dismissed)");
    else if (status && status !== "all") filters.push(`status=eq.${encodeURIComponent(status)}`);
    const raw = await supaFetch(`${TABLE}?${filters.join("&")}`);
    const items = dedupeFollowUpItems(raw).filter((it: any) => status !== "active" || !shouldHideLowValueActiveItem(it));
    return NextResponse.json({ ok: true, updatedAt: new Date().toISOString(), summary: summarize(items), items });
  } catch (e: any) {
    return NextResponse.json({ error: e.message, detail: e.detail ?? null }, { status: 500 });
  }
}

export async function PATCH(req: NextRequest) {
  if (V2_DASHBOARD_ENABLED) {
    const user = await getAuthedUser(req);
    if (!user) return NextResponse.json({ error: "인증 필요" }, { status: 401 });
    if (!SERVICE_KEY) return NextResponse.json({ error: "후속조치를 변경하지 못했습니다" }, { status: 503 });
    const now = new Date().toISOString();
    let request;
    try {
      request = parseV2ActionBody(await req.json(), now);
    } catch {
      return NextResponse.json({ error: "invalid work action" }, { status: 400 });
    }
    const authUserId = typeof user.id === "string" ? user.id.toLowerCase() : "";
    if (!V2_UUID.test(authUserId)) {
      return NextResponse.json({ error: "후속조치를 변경하지 못했습니다" }, { status: 503 });
    }
    const requestedBy = `heybilli:${authUserId}`;
    try {
      const raw = await supaFetch("rpc/request_work_item_action_v2", {
        method: "POST",
        body: JSON.stringify({
          p_id: request.id,
          p_expected_version: request.expectedVersion,
          p_action: request.action,
          p_requested_by: requestedBy,
        }),
      });
      if (!exactKeys(raw, ["applied", "row"]) || typeof raw.applied !== "boolean") {
        throw new Error("v2 response invalid");
      }
      if (!raw.applied) {
        if (raw.row !== null) throw new Error("v2 response invalid");
        return NextResponse.json({ error: "다른 곳에서 이미 변경되었습니다" }, { status: 409 });
      }
      return NextResponse.json({ ok: true, item: safeV2ItemFromActionRow(raw.row, request, requestedBy) });
    } catch {
      return NextResponse.json({ error: "후속조치를 변경하지 못했습니다" }, { status: 503 });
    }
  }
  if (!(await requireUser(req))) return NextResponse.json({ error: "인증 필요" }, { status: 401 });
  try {
    const body = await req.json().catch(() => ({}));
    const id = String(body.id || "");
    const ids: string[] = Array.isArray(body.ids)
      ? Array.from(new Set((body.ids as any[]).map((v) => String(v || "").trim()).filter(Boolean) as string[])).slice(0, 100)
      : [];
    const status = String(body.status || "");
    const allowed = ["open", "in_progress", "waiting_customer", "waiting_internal", "done", "dismissed"];
    if ((!id && !ids.length) || !allowed.includes(status)) {
      return NextResponse.json({ error: "invalid id/status" }, { status: 400 });
    }
    const patchBody = status === "open" ? { status, completed_at: null } : { status };
    if (ids.length) {
      // 벌크(다중선택·섹션 일괄완료)도 각 항목의 "의미상 중복" 행까지 함께 상태 변경한다.
      // GET은 dedupeFollowUpItems로 대표 1건만 보여주므로, 벌크에서 대표 id만 닫으면
      // 숨어있던 중복 행이 다음 폴링에 '되살아나' 같은 업무를 두 번 처리하게 된다(단건 경로와 통일).
      const cands = await supaFetch(`${TABLE}?select=${DEDUPE_FIELDS}&status=not.in.(done,dismissed)&limit=500&order=created_at.desc`);
      const candList: any[] = Array.isArray(cands) ? cands : [];
      const byId = new Map<string, any>(candList.map((c: any) => [String(c.id), c]));
      const target = new Set<string>(ids);
      // 배치 버전 — id마다 후보 전체의 의미키를 재계산하던 O(ids×후보)를 O(ids+후보)로 낮춘다
      const currents = ids.map((oneId) => byId.get(oneId)).filter(Boolean);
      for (const dup of duplicateFollowUpIdsForItems(currents, candList)) target.add(String(dup));
      const finalIds = Array.from(target).slice(0, 500);
      const rows = await supaFetch(`${TABLE}?id=in.(${finalIds.map(encodeURIComponent).join(",")})`, {
        method: "PATCH",
        headers: { prefer: "return=representation" },
        body: JSON.stringify(patchBody),
      });
      return NextResponse.json({ ok: true, items: Array.isArray(rows) ? rows : [], updatedIds: finalIds, updatedCount: Array.isArray(rows) ? rows.length : 0 });
    }
    // 두 읽기는 서로 독립 — 병렬로 줄여 상태 변경 1건의 순차 REST 3왕복을 2왕복 시간으로 단축
    const [cur, cands] = await Promise.all([
      supaFetch(`${TABLE}?select=${FIELDS}&id=eq.${encodeURIComponent(id)}`),
      supaFetch(`${TABLE}?select=${DEDUPE_FIELDS}&status=not.in.(done,dismissed)&limit=500&order=created_at.desc`),
    ]);
    const current = Array.isArray(cur) ? cur[0] : null;
    if (!current) return NextResponse.json({ error: "not found" }, { status: 404 });
    const dupIds = duplicateFollowUpIdsForItem(current, cands);
    if (!dupIds.includes(id)) dupIds.push(id);
    const row = await supaFetch(`${TABLE}?id=in.(${dupIds.map(encodeURIComponent).join(",")})`, {
      method: "PATCH",
      headers: { prefer: "return=representation" },
      body: JSON.stringify(patchBody),
    });
    return NextResponse.json({ ok: true, item: Array.isArray(row) ? row[0] : row, updatedIds: dupIds, updatedCount: dupIds.length });
  } catch (e: any) {
    return NextResponse.json({ error: e.message, detail: e.detail ?? null }, { status: 500 });
  }
}
