import { NextRequest, NextResponse } from "next/server";
import { isAuthedRequest as requireUser } from "@/lib/server/authCache";

// 확인요청 관리 프록시 — GAS Schedule API(list/확인/등록/보류/거절/발송승인 + run/func) 프록시. 로그인 게이트.
const GAS_URL =
  process.env.GAS_API_URL ??
  "https://script.google.com/macros/s/AKfycbyRff4-lLXmne-iPIEf87x4-CH_5wb-Uv5dCGymELLrpiKluhg2gDdLdVP4Y0MmxnnT/exec";
const GAS_KEY = process.env.GAS_API_KEY ?? "village2026";

// 목록(list) 단기 캐시(12초). 등록 직후 3회 재조회(즉시/+3s/+15s) 같은 연속 호출이
// GAS 콜드스타트를 매번 때리지 않도록. 쓰기 액션(POST) 시 무효화한다.
const LIST_TTL = 12_000;
const listCache = new Map<string, { at: number; body: string }>();

const ACTIONS = new Set(["확인", "등록", "registerAsync", "보류", "거절", "발송승인"]);
const FUNCS = new Set(["updateRequest", "updateRequestItem", "excludeEquipFromRequest", "deleteRequest", "insertAndCheckRequest", "recoverPendingRegistrations"]);

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
    if (action === "list") {
      const hit = listCache.get("list");
      if (hit && Date.now() - hit.at < LIST_TTL) {
        return new NextResponse(hit.body, { headers: { "content-type": "application/json", "x-cache": "HIT" } });
      }
      const res = await callGas({ action });
      const body = await res.clone().text();
      if (res.ok) listCache.set("list", { at: Date.now(), body });
      return res;
    }
    return await callGas({ action });
  } catch (e) {
    return NextResponse.json({ error: "GAS 호출 실패: " + (e instanceof Error ? e.message : String(e)) }, { status: 502 });
  }
}

// 쓰기 액션 후에는 목록 캐시를 즉시 무효화해 다음 조회가 최신을 받게 한다.
function invalidateListCache() {
  listCache.delete("list");
}

// 액션 (확인/등록/보류/거절/발송승인 + run)
export async function POST(req: NextRequest) {
  if (!(await requireUser(req))) return NextResponse.json({ error: "인증 필요" }, { status: 401 });
  const body = await req.json().catch(() => ({} as Record<string, unknown>));
  const action = String((body as { action?: string }).action || "");
  invalidateListCache(); // 어떤 쓰기든 목록이 바뀔 수 있으니 캐시 무효화
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
