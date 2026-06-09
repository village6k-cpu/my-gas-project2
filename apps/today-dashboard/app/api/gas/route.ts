import { NextRequest, NextResponse } from "next/server";

// 기존 GAS 웹앱(구글시트 DB) 프록시 — 서버측 호출로 CORS 회피 + 키 은닉 + 캐시.
const GAS_URL =
  process.env.GAS_API_URL ??
  "https://script.google.com/macros/s/AKfycbyRff4-lLXmne-iPIEf87x4-CH_5wb-Uv5dCGymELLrpiKluhg2gDdLdVP4Y0MmxnnT/exec";
const GAS_KEY = process.env.GAS_API_KEY ?? "village2026";

// 읽기 응답 짧게 캐시(GAS 콜드스타트 완화)
const cache = new Map<string, { at: number; body: string }>();
const TTL = 30_000;
// 읽기 액션 화이트리스트 (캐시됨)
const READ_ACTIONS = new Set(["timeline", "dashboard", "operations", "search", "read", "info", "sheets", "list", "scan", "dashboardSearch", "dashboardContractExtras", "dashboardEquipNames"]);
// 쓰기 액션 화이트리스트 (캐시 안 함). 시트/상태 변경 → 신중.
const WRITE_ACTIONS = new Set(["toggleSetup", "toggleReturn", "toggleItem", "updatePayment", "updateTradeProof", "updateBillingCompany", "sendEstimate"]);

function call(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const action = sp.get("action") ?? "";
  const isWrite = WRITE_ACTIONS.has(action);
  if (!READ_ACTIONS.has(action) && !isWrite) {
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

export async function GET(req: NextRequest) {
  return call(req);
}
