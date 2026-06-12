import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

// 확인요청 관리 프록시 — GAS Schedule API(list/확인/등록/보류/거절/발송승인 + run/func) 프록시. 로그인 게이트.
const GAS_URL =
  process.env.GAS_API_URL ??
  "https://script.google.com/macros/s/AKfycbyRff4-lLXmne-iPIEf87x4-CH_5wb-Uv5dCGymELLrpiKluhg2gDdLdVP4Y0MmxnnT/exec";
const GAS_KEY = process.env.GAS_API_KEY ?? "village2026";
const SUPA_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const authClient = SUPA_URL && ANON ? createClient(SUPA_URL, ANON) : null;

async function requireUser(req: NextRequest): Promise<boolean> {
  if (!authClient) return true;
  const h = req.headers.get("authorization") ?? "";
  const t = h.startsWith("Bearer ") ? h.slice(7) : "";
  if (!t) return false;
  const { data, error } = await authClient.auth.getUser(t);
  return !error && !!data.user;
}

const ACTIONS = new Set(["확인", "등록", "보류", "거절", "발송승인"]);
const FUNCS = new Set(["updateRequest", "updateRequestItem", "excludeEquipFromRequest", "deleteRequest", "insertAndCheckRequest"]);

// 등록(registerByReqID)은 계약서 생성 포함 시 1분 이상 걸릴 수 있어 함수 수명을 늘린다.
// (요금제 한도보다 짧게 잘리면 그 경우에도 GAS 쪽 등록은 계속 진행됨)
export const maxDuration = 120;

async function callGas(params: Record<string, string>): Promise<NextResponse> {
  const qs = new URLSearchParams(params);
  qs.set("key", GAS_KEY);
  const r = await fetch(`${GAS_URL}?${qs.toString()}`, { redirect: "follow", signal: AbortSignal.timeout(110_000) });
  const body = await r.text();
  return new NextResponse(body, { headers: { "content-type": "application/json" } });
}

// 목록 (action=list, scan)
export async function GET(req: NextRequest) {
  if (!(await requireUser(req))) return NextResponse.json({ error: "인증 필요" }, { status: 401 });
  const action = req.nextUrl.searchParams.get("action") || "list";
  if (action !== "list" && action !== "scan") return NextResponse.json({ error: "미허용 action" }, { status: 400 });
  try {
    return await callGas({ action });
  } catch (e) {
    return NextResponse.json({ error: "GAS 호출 실패: " + (e instanceof Error ? e.message : String(e)) }, { status: 502 });
  }
}

// 액션 (확인/등록/보류/거절/발송승인 + run)
export async function POST(req: NextRequest) {
  if (!(await requireUser(req))) return NextResponse.json({ error: "인증 필요" }, { status: 401 });
  const body = await req.json().catch(() => ({} as Record<string, unknown>));
  const action = String((body as { action?: string }).action || "");
  try {
    if (action === "run") {
      const func = String((body as { func?: string }).func || "");
      if (!FUNCS.has(func)) return NextResponse.json({ error: `미허용 func: ${func}` }, { status: 400 });
      const rawArgs = (body as { args?: unknown }).args;
      const args = typeof rawArgs === "string" ? rawArgs : JSON.stringify(rawArgs ?? {});
      return await callGas({ action: "run", func, args });
    }
    if (!ACTIONS.has(action)) return NextResponse.json({ error: `미허용 action: ${action}` }, { status: 400 });
    const reqID = String((body as { reqID?: string }).reqID || "");
    if (!reqID) return NextResponse.json({ error: "reqID 필수" }, { status: 400 });
    return await callGas({ action, reqID });
  } catch (e) {
    return NextResponse.json({ error: "GAS 호출 실패: " + (e instanceof Error ? e.message : String(e)) }, { status: 502 });
  }
}
