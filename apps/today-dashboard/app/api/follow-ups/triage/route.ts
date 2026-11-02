import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { getAuthedUser } from "@/lib/server/authCache";
import { ARCHIVE_KIND, ACTIVE_STATES, parseRestore, triageItem } from "@/lib/followups/triage.mjs";

export const dynamic = "force-dynamic";
function db() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("unavailable");
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: (url, init) => fetch(url, { ...init, cache: "no-store", signal: AbortSignal.timeout(15000) }) } });
}
const fields = "id,version,room_key,title,summary,state,payload,updated_at,resolved_at,resolution_kind";
const response = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
export async function GET(req: NextRequest) {
  if (!await getAuthedUser(req)) return response({ error: "인증 필요" }, 401);
  const mode = req.nextUrl.searchParams.get("mode") || "critical";
  const offset = Number(req.nextUrl.searchParams.get("offset") || 0);
  const search = (req.nextUrl.searchParams.get("q") || "").trim();
  if (!["critical", "archive"].includes(mode) || !Number.isSafeInteger(offset) || offset < 0 || offset > 100000 || search.length > 100) return response({ error: "잘못된 조회" }, 400);
  try {
    const client = db();
    let query = client.from("work_items_v2").select(fields, { count: "exact" });
    query = mode === "critical" ? query.in("state", ACTIVE_STATES).eq("payload->>owner_triage", "critical") : query.eq("state", "dismissed").eq("resolution_kind", ARCHIVE_KIND);
    if (search) query = query.ilike("title", `%${search.replace(/[\\%_]/g, "")}%`);
    // All rows in a page use deterministic ordering, including equal timestamps.
    const { data, count, error } = await query.order("updated_at", { ascending: false }).order("id").range(offset, offset + 49);
    if (error) throw error;
    return response({ ok: true, items: (data || []).map(triageItem), total: count || 0, nextOffset: offset + 50 < (count || 0) ? offset + 50 : null });
  } catch { return response({ error: "확인 목록을 불러오지 못했습니다" }, 503); }
}
export async function PATCH(req: NextRequest) {
  const user = await getAuthedUser(req);
  if (!user) return response({ error: "인증 필요" }, 401);
  let input;
  try { input = parseRestore(await req.json()); } catch { return response({ error: "잘못된 복원 요청" }, 400); }
  try {
    const client = db();
    const { data: old, error: readError } = await client.from("work_items_v2").select("resolution_evidence").eq("id", input.id).eq("version", input.expectedVersion).eq("state", "dismissed").eq("resolution_kind", ARCHIVE_KIND).maybeSingle();
    if (readError) throw readError;
    if (!old) return response({ error: "이미 변경된 카드입니다. 새로고침해 주세요." }, 409);
    const now = new Date().toISOString();
    const { data, error } = await client.from("work_items_v2").update({ state: "open", resolution_kind: null, resolved_at: null, resolved_by: null,
      snoozed_until: null, actionable_at: now, updated_at: now, last_activity_at: now, version: input.expectedVersion + 1,
      resolution_evidence: { ...old.resolution_evidence, restored_from_owner_archive: { at: now, by: `heybilli:${user.id}` } },
    }).eq("id", input.id).eq("version", input.expectedVersion).eq("state", "dismissed").eq("resolution_kind", ARCHIVE_KIND).select("id");
    if (error) { if (error.code === "23505") return response({ error: "같은 업무가 이미 진행 중입니다." }, 409); throw error; }
    if (!data?.length) return response({ error: "이미 변경된 카드입니다. 새로고침해 주세요." }, 409);
    return response({ ok: true });
  } catch { return response({ error: "카드를 복원하지 못했습니다" }, 503); }
}
