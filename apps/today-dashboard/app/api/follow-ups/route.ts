import { NextRequest, NextResponse } from "next/server";
import { getAuthedUser, isAuthedRequest as requireUser } from "@/lib/server/authCache";
import { dedupeFollowUpItems, duplicateFollowUpIdsForItem, duplicateFollowUpIdsForItems, shouldHideLowValueActiveItem, summarize } from "@/lib/followups/logic";

// 후속조치(카톡 AI봇) 보드 API — ai_follow_up_items(public 스키마).
// 로그인 게이트(사용자 토큰 검증, 공유 authCache) + DB는 service-role(서버 전용, 브라우저 노출 없음).
const SUPA_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const TABLE = process.env.SUPABASE_FOLLOW_UP_TABLE || "ai_follow_up_items";
const V2_DASHBOARD_ENABLED = process.env.WORK_ORCHESTRATOR_V2_DASHBOARD_ENABLED === "1";
const V2_TABLE = "work_items_v2";

const FIELDS =
  "id,follow_up_key,job_id,room_key,customer_name,type,priority,status,title,summary,recommended_action,suggested_reply_draft,evidence,blocking_reason,due_hint,decision_classification,decision_confidence,created_at,updated_at,completed_at";

// 중복 판정(dashboardSemanticKeys/isLowInformationDiagnosticItem)이 실제로 읽는 필드만 —
// suggested_reply_draft 등 큰 텍스트 컬럼을 후보 500건 조회에서 뺀다.
// ⚠️ evidence는 combinedFollowUpText가 의미키 계산에 사용하므로 제외 금지.
const DEDUPE_FIELDS = "id,follow_up_key,room_key,customer_name,type,title,summary,recommended_action,evidence";

// v2는 display-safe 컬럼과 명시적 payload scalar만 투영한다. payload 전체나 원문 이벤트,
// work_key, pending_action, resolution_evidence는 대시보드로 읽거나 전달하지 않는다.
const V2_FIELDS = [
  "id",
  "room_key",
  "title",
  "summary",
  "work_type",
  "priority",
  "state",
  "due_at",
  "first_opened_at",
  "updated_at",
  "recommended_action:payload->>recommended_action",
  "blocking_reason:payload->>blocking_reason",
  "due_hint:payload->>due_hint",
].join(",");

const V2_TYPE_TO_LEGACY_TYPE: Record<string, string> = {
  human_review: "reply_needed",
  reply_needed: "reply_needed",
  quote_send: "quote_send",
  tax_invoice: "tax_invoice",
  schedule_check: "schedule_check",
  reservation_review: "reservation_review",
  price_review: "price_review",
  payment_check: "payment_check",
  contract_document: "contract_document",
  return_extension: "return_extension",
  damage_repair: "damage_repair",
  sheet_duplicate_check: "sheet_duplicate_check",
  reservation_review_timeout: "reservation_review",
  automation_error_review: "reply_needed",
};

const V2_PRIORITY_TO_LEGACY_PRIORITY: Record<string, string> = {
  p0: "urgent",
  urgent: "urgent",
  normal: "normal",
  low: "low",
};

const V2_STATE_TO_LEGACY_STATUS: Record<string, string> = {
  open: "open",
  in_progress: "in_progress",
  snoozed: "waiting_internal",
  resolved: "done",
  dismissed: "dismissed",
};

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

function mapV2Item(row: any) {
  const item: Record<string, any> = {
    id: String(row?.id || ""),
    room_key: String(row?.room_key || ""),
    type: V2_TYPE_TO_LEGACY_TYPE[String(row?.work_type || "")] || "reply_needed",
    priority: V2_PRIORITY_TO_LEGACY_PRIORITY[String(row?.priority || "")] || "normal",
    status: V2_STATE_TO_LEGACY_STATUS[String(row?.state || "")] || "open",
    title: String(row?.title || ""),
    summary: String(row?.summary || ""),
    created_at: row?.first_opened_at || null,
    updated_at: row?.updated_at || null,
  };
  for (const field of ["recommended_action", "blocking_reason", "due_hint"] as const) {
    if (typeof row?.[field] === "string" && row[field].trim()) item[field] = row[field];
  }
  return item;
}

async function getV2FollowUps(req: NextRequest) {
  const serviceKey = SERVICE_KEY;
  if (!serviceKey) return NextResponse.json({ error: "work orchestrator unavailable" }, { status: 503 });
  try {
    const sp = req.nextUrl.searchParams;
    const status = sp.get("status") || "active";
    const limit = Math.min(Number(sp.get("limit") || 200) || 200, 500);
    const filters = [`select=${V2_FIELDS}`, `limit=${limit}`, "order=first_opened_at.desc"];
    if (status === "active") filters.push("state=in.(open,in_progress,snoozed)");
    else if (status === "done") filters.push("state=eq.resolved");
    else if (status === "dismissed") filters.push("state=eq.dismissed");
    const res = await fetch(`${SUPA_URL}/rest/v1/${V2_TABLE}?${filters.join("&")}`, {
      signal: AbortSignal.timeout(15_000),
      headers: { apikey: serviceKey, authorization: `Bearer ${serviceKey}`, "content-type": "application/json" },
    });
    if (!res.ok) throw new Error("v2 fetch failed");
    const txt = await res.text();
    if (!txt) throw new Error("v2 response invalid");
    let raw: any;
    try { raw = JSON.parse(txt); } catch { throw new Error("v2 response invalid"); }
    if (!Array.isArray(raw)) throw new Error("v2 response invalid");
    const items = raw.map(mapV2Item);
    return NextResponse.json({ ok: true, source: "work_items_v2", updatedAt: new Date().toISOString(), summary: summarize(items), items });
  } catch {
    return NextResponse.json({ error: "work orchestrator unavailable" }, { status: 503 });
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
    if (!(await getAuthedUser(req))) return NextResponse.json({ error: "인증 필요" }, { status: 401 });
    return NextResponse.json({ error: "work orchestrator v2 is read-only" }, { status: 409 });
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
