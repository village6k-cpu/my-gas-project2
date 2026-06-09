import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { dedupeFollowUpItems, duplicateFollowUpIdsForItem, shouldHideLowValueActiveItem, summarize } from "@/lib/followups/logic";

// 후속조치(카톡 AI봇) 보드 API — ai_follow_up_items(public 스키마)를 로그인 사용자 토큰으로 읽고/갱신.
// service-role 대신 authenticated RLS 사용 (supabase/followups-rls.sql 적용 필요).
const SUPA_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const TABLE = process.env.SUPABASE_FOLLOW_UP_TABLE || "ai_follow_up_items";
const authClient = SUPA_URL && ANON ? createClient(SUPA_URL, ANON) : null;

const FIELDS =
  "id,follow_up_key,job_id,room_key,customer_name,type,priority,status,title,summary,recommended_action,suggested_reply_draft,evidence,blocking_reason,due_hint,decision_classification,decision_confidence,created_at,updated_at,completed_at";

async function userToken(req: NextRequest): Promise<string | null> {
  const h = req.headers.get("authorization") ?? "";
  const t = h.startsWith("Bearer ") ? h.slice(7) : "";
  if (!authClient) return t || "dev"; // Supabase 미설정(로컬) → 통과
  if (!t) return null;
  const { data, error } = await authClient.auth.getUser(t);
  return !error && data.user ? t : null;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
async function supaFetch(pathAndQuery: string, token: string, init: RequestInit = {}): Promise<any> {
  const res = await fetch(`${SUPA_URL}/rest/v1/${pathAndQuery}`, {
    ...init,
    headers: { apikey: ANON!, authorization: `Bearer ${token}`, "content-type": "application/json", ...(init.headers || {}) },
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

export async function GET(req: NextRequest) {
  const token = await userToken(req);
  if (!token) return NextResponse.json({ error: "인증 필요" }, { status: 401 });
  try {
    const sp = req.nextUrl.searchParams;
    const status = sp.get("status") || "active";
    const limit = Math.min(Number(sp.get("limit") || 200) || 200, 500);
    const filters = [`select=${FIELDS}`, `limit=${limit}`, "order=created_at.desc"];
    if (status === "active") filters.push("status=not.in.(done,dismissed)");
    else if (status && status !== "all") filters.push(`status=eq.${encodeURIComponent(status)}`);
    const raw = await supaFetch(`${TABLE}?${filters.join("&")}`, token);
    const items = dedupeFollowUpItems(raw).filter((it: any) => status !== "active" || !shouldHideLowValueActiveItem(it));
    return NextResponse.json({ ok: true, updatedAt: new Date().toISOString(), summary: summarize(items), items });
  } catch (e: any) {
    return NextResponse.json({ error: e.message, detail: e.detail ?? null }, { status: 500 });
  }
}

export async function PATCH(req: NextRequest) {
  const token = await userToken(req);
  if (!token) return NextResponse.json({ error: "인증 필요" }, { status: 401 });
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
      const rows = await supaFetch(`${TABLE}?id=in.(${ids.map(encodeURIComponent).join(",")})`, token, {
        method: "PATCH",
        headers: { prefer: "return=representation" },
        body: JSON.stringify(patchBody),
      });
      return NextResponse.json({ ok: true, items: Array.isArray(rows) ? rows : [], updatedIds: ids, updatedCount: Array.isArray(rows) ? rows.length : 0 });
    }
    const cur = await supaFetch(`${TABLE}?select=${FIELDS}&id=eq.${encodeURIComponent(id)}`, token);
    const current = Array.isArray(cur) ? cur[0] : null;
    if (!current) return NextResponse.json({ error: "not found" }, { status: 404 });
    const cands = await supaFetch(`${TABLE}?select=${FIELDS}&status=not.in.(done,dismissed)&limit=500&order=created_at.desc`, token);
    const dupIds = duplicateFollowUpIdsForItem(current, cands);
    if (!dupIds.includes(id)) dupIds.push(id);
    const row = await supaFetch(`${TABLE}?id=in.(${dupIds.map(encodeURIComponent).join(",")})`, token, {
      method: "PATCH",
      headers: { prefer: "return=representation" },
      body: JSON.stringify(patchBody),
    });
    return NextResponse.json({ ok: true, item: Array.isArray(row) ? row[0] : row, updatedIds: dupIds, updatedCount: dupIds.length });
  } catch (e: any) {
    return NextResponse.json({ error: e.message, detail: e.detail ?? null }, { status: 500 });
  }
}
