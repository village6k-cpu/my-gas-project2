import { NextRequest, NextResponse } from "next/server";
import { isAuthedRequest as isAuthed } from "@/lib/server/authCache";

export const maxDuration = 60;

// 기존 GAS 웹앱(구글시트 DB) 프록시 — 서버측 호출로 CORS 회피 + 키 은닉 + 캐시.
const GAS_URL =
  process.env.GAS_API_URL ??
  "https://script.google.com/macros/s/AKfycbyRff4-lLXmne-iPIEf87x4-CH_5wb-Uv5dCGymELLrpiKluhg2gDdLdVP4Y0MmxnnT/exec";
const GAS_KEY = process.env.GAS_API_KEY ?? "village2026";

// 읽기 응답 짧게 캐시(GAS 콜드스타트 완화)
const cache = new Map<string, { at: number; body: string }>();
const TTL = 30_000;
// 캐시 키가 검색어·날짜별로 무한히 늘어나므로 상한 필수 (authCache의 pruneCache 패턴)
const MAX_CACHE_SIZE = 200;

function pruneCache(now: number): void {
  // 1) 만료 엔트리 먼저 제거
  for (const [key, entry] of cache) {
    if (now - entry.at > TTL) cache.delete(key);
  }
  // 2) 여전히 상한 초과면 오래된 삽입 순서대로 제거 (Map은 삽입 순서 보존)
  while (cache.size > MAX_CACHE_SIZE) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

// GAS는 스크립트 오류를 200 상태의 {error:...} JSON이나 HTML 페이지로 반환하기도 한다.
// 그런 본문을 30초 캐시하면 모든 폴링에 에러가 재배포되므로 정상 JSON만 캐시한다.
function isCacheableBody(body: string): boolean {
  try {
    const parsed: unknown = JSON.parse(body);
    return !(parsed && typeof parsed === "object" && "error" in parsed);
  } catch {
    return false;
  }
}
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
  "radar",
  "equipRadar",
  "autopilot",
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
  "sendPayAppPaymentLink",
  "regenerateContract",
  "aiParse",
  "registerAsync",
  "updateEquipQty",
  "updateEquipName",
  "removeEquip",
  "onsiteAddon",
  "uploadDashboardPhoto",
  "updateTrade",
  "updateContractStatus",
]);

const STAFF_RUN_FUNCTIONS = new Set(["getMyPageLink"]);

function allowed(action: string, func?: string): { ok: boolean; isWrite: boolean } {
  if (action === "run" && STAFF_RUN_FUNCTIONS.has(String(func || ""))) return { ok: true, isWrite: false };
  const isWrite = WRITE_ACTIONS.has(action);
  return { ok: READ_ACTIONS.has(action) || isWrite, isWrite };
}

async function callGet(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const action = sp.get("action") ?? "";
  const func = sp.get("func") ?? "";
  const { ok, isWrite } = allowed(action, func);
  if (!ok) {
    return NextResponse.json({ error: `action '${action}' 미허용` }, { status: 400 });
  }
  // nocache=1 — 복구 경로(repairDashboardDateDetails 등)가 신선한 데이터를 요구할 때.
  // 프록시 캐시 조회/저장은 건너뛰되, GAS 자체 CacheService 우회용이므로 파라미터는 GAS로 그대로 전달한다.
  const noCacheParam = sp.get("nocache");
  const noCache = noCacheParam === "1" || noCacheParam === "true";
  const qs = new URLSearchParams(sp);
  qs.set("key", GAS_KEY);
  const url = `${GAS_URL}?${qs.toString()}`;
  const ck = qs.toString();

  if (!isWrite && !noCache) {
    const hit = cache.get(ck);
    if (hit) {
      if (Date.now() - hit.at < TTL) {
        return new NextResponse(hit.body, { headers: { "content-type": "application/json", "x-cache": "HIT" } });
      }
      cache.delete(ck); // 만료 엔트리는 즉시 비워 힙에 눌러앉지 않게 한다
    }
  }
  return fetch(url, { redirect: "follow", signal: AbortSignal.timeout(40_000) })
    .then(async (r) => {
      const body = await r.text();
      if (isWrite) {
        // 쓰기 직후 재조회가 쓰기 이전 캐시를 받아 화면이 되돌아 보이지 않도록 읽기 캐시 전체 무효화
        cache.clear();
      } else if (r.ok && !noCache && isCacheableBody(body)) {
        cache.set(ck, { at: Date.now(), body });
        if (cache.size > MAX_CACHE_SIZE) pruneCache(Date.now());
      }
      // 업스트림 상태 그대로 전파 — 클라이언트(writeback.ts r.ok 검사)가 실패를 구분할 수 있게
      return new NextResponse(body, {
        status: r.status,
        headers: { "content-type": "application/json", "x-cache": isWrite ? "WRITE" : "MISS" },
      });
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
  const func = String(body.func ?? sp.get("func") ?? "");
  const { ok, isWrite } = allowed(action, func);
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
    // 쓰기 후에는 읽기 캐시를 무효화해 직후 dashboard/timeline 재조회가 이전 상태를 받지 않게 한다
    if (isWrite) cache.clear();
    return new NextResponse(responseBody, {
      status: r.status,
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
