import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

// 기존 GAS 웹앱(구글시트 DB) 프록시 — 서버측 호출로 CORS 회피 + 키 은닉 + 캐시.
const GAS_URL =
  process.env.GAS_API_URL ??
  "https://script.google.com/macros/s/AKfycbyRff4-lLXmne-iPIEf87x4-CH_5wb-Uv5dCGymELLrpiKluhg2gDdLdVP4Y0MmxnnT/exec";
const GAS_KEY = process.env.GAS_API_KEY ?? "village2026";

// 로그인 검증용 (Supabase 설정돼 있을 때만). 설정 없으면 시드/로컬 → 인증 생략.
const SUPA_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPA_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const authClient = SUPA_URL && SUPA_KEY ? createClient(SUPA_URL, SUPA_KEY) : null;

async function isAuthed(req: NextRequest): Promise<boolean> {
  if (!authClient) return true; // Supabase 미설정(로컬/시드) → 통과
  const h = req.headers.get("authorization") ?? "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : "";
  if (!token) return false;
  const { data, error } = await authClient.auth.getUser(token);
  return !error && !!data.user;
}

// 읽기 응답 짧게 캐시(GAS 콜드스타트 완화)
const cache = new Map<string, { at: number; body: string }>();
const TTL = 30_000;
// 읽기 액션 화이트리스트 (GET은 캐시됨)
const READ_ACTIONS = new Set([
  "timeline",
  "dashboard",
  "operations",
  "search",
  "read",
  "info",
  "sheets",
  "list",
  "scan",
  "dashboardSearch",
  "dashboardContractExtras",
  "dashboardEquipNames",
  "dashboardEquipmentCatalog",
  "dashboardPhotoMeta",
  "dashboardPhotos",
  "dashboardPhotosBatch",
]);
// 쓰기 액션 화이트리스트 (캐시 안 함). 시트/상태 변경 → 신중.
const WRITE_ACTIONS = new Set([
  "toggleSetup",
  "toggleReturn",
  "toggleItem",
  "updatePayment",
  "updateTradeProof",
  "updateBillingCompany",
  "sendEstimate",
  "sendStatement",
  "regenerateContract",
  "aiParse",
  "registerAsync",
  "updateEquipQty",
  "updateEquipName",
  "removeEquip",
  "onsiteAddon",
  "uploadDashboardPhoto",
]);

function allowed(action: string): { ok: boolean; isWrite: boolean } {
  const isWrite = WRITE_ACTIONS.has(action);
  return { ok: READ_ACTIONS.has(action) || isWrite, isWrite };
}

async function callGet(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const action = sp.get("action") ?? "";
  const { ok, isWrite } = allowed(action);
  if (!ok) {
    return NextResponse.json({ error: `action '${action}' 미허용` }, { status: 400 });
  }
  const qs = new URLSearchParams(sp);
  qs.set("key", GAS_KEY);
  const url = `${GAS_URL}?${qs.toString()}`;
  const ck = qs.toString();

  if (!isWrite) {
    const hit = cache.get(ck);
    if (hit && Date.now() - hit.at < TTL) {
      return new NextResponse(hit.body, { headers: { "content-type": "application/json", "x-cache": "HIT" } });
    }
  }
  return fetch(url, { redirect: "follow", signal: AbortSignal.timeout(40_000) })
    .then(async (r) => {
      const body = await r.text();
      if (!isWrite) cache.set(ck, { at: Date.now(), body });
      return new NextResponse(body, { headers: { "content-type": "application/json", "x-cache": isWrite ? "WRITE" : "MISS" } });
    })
    .catch((e) => NextResponse.json({ error: "GAS 호출 실패: " + (e instanceof Error ? e.message : String(e)) }, { status: 502 }));
}

async function callPost(req: NextRequest) {
  let body: Record<string, unknown> = {};
  try {
    body = await req.json();
  } catch {
    body = {};
  }
  const sp = req.nextUrl.searchParams;
  const action = String(body.action ?? sp.get("action") ?? "");
  const { ok, isWrite } = allowed(action);
  if (!ok) {
    return NextResponse.json({ error: `action '${action}' 미허용` }, { status: 400 });
  }

  const payload: Record<string, unknown> = {};
  sp.forEach((value, key) => {
    payload[key] = value;
  });
  Object.assign(payload, body, { action, key: GAS_KEY });

  try {
    const r = await fetch(GAS_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      redirect: "follow",
      signal: AbortSignal.timeout(60_000),
    });
    const responseBody = await r.text();
    return new NextResponse(responseBody, {
      headers: { "content-type": "application/json", "x-cache": isWrite ? "POST-WRITE" : "POST" },
    });
  } catch (e) {
    return NextResponse.json({ error: "GAS 호출 실패: " + (e instanceof Error ? e.message : String(e)) }, { status: 502 });
  }
}

export async function GET(req: NextRequest) {
  if (!(await isAuthed(req))) {
    return NextResponse.json({ error: "인증 필요" }, { status: 401 });
  }
  return callGet(req);
}

export async function POST(req: NextRequest) {
  if (!(await isAuthed(req))) {
    return NextResponse.json({ error: "인증 필요" }, { status: 401 });
  }
  return callPost(req);
}
