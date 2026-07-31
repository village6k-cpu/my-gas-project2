import { NextRequest, NextResponse } from "next/server";
import { isAuthedRequest as isAuthed } from "@/lib/server/authCache";
import { getInventoryAuditServiceClient } from "@/lib/server/inventoryAuditDb";

export const maxDuration = 60;

// 기존 GAS 웹앱(구글시트 DB) 프록시 — 서버측 호출로 CORS 회피 + 키 은닉 + 캐시.
const GAS_URL =
  process.env.GAS_API_URL ??
  "https://script.google.com/macros/s/AKfycbyRff4-lLXmne-iPIEf87x4-CH_5wb-Uv5dCGymELLrpiKluhg2gDdLdVP4Y0MmxnnT/exec";
const GAS_KEY = process.env.GAS_API_KEY ?? "village2026";

function completionDoneValue(value: unknown): boolean {
  return value === true || value === 1 || value === "1" || value === "true";
}

/**
 * 완료 버튼의 원격 정본 저장. 직원 클릭을 반출 수량 기준선 생성과 묶지 않는다.
 * 로그인된 앱 서버가 거래 완료 상태만 한 번 저장하고, GAS는 시트/속성만 갱신한다.
 * 따라서 GAS UrlFetch 일일 한도와 무관하며 장비 품목 저장도 이 버튼을 기다리지 않는다.
 */
async function persistCompletionAuthority_(
  action: "toggleSetup" | "toggleReturn",
  body: Record<string, unknown>,
): Promise<{
  done: boolean;
  doneAt: string | null;
  revision: number;
  contractStatus?: string;
}> {
  const tradeId = String(body.tid ?? "").trim();
  if (!/^\d{6}-\d{3}$/.test(tradeId)) throw new Error("invalid trade id");
  const done = completionDoneValue(body.done);
  const client = getInventoryAuditServiceClient();
  const confirmedDoneAt = String(body.remoteDoneAt ?? body.doneAt ?? "").trim();
  const doneAt = done ? (confirmedDoneAt || new Date().toISOString()) : null;
  const confirmedContractStatus = String(body.remoteContractStatus ?? body.contractStatus ?? "").trim();
  const revision = Number(body.completionRevision);
  if (!Number.isSafeInteger(revision) || revision <= 0) throw new Error("invalid completion revision");
  const { data, error } = await client.rpc("apply_trade_completion", {
    p_trade_id: tradeId,
    p_kind: action === "toggleSetup" ? "setup" : "return",
    p_done: done,
    p_done_at: doneAt,
    p_contract_status: confirmedContractStatus || (done ? "반납완료" : "반출"),
    p_revision: revision,
  });
  if (error || !data || typeof data !== "object" || Array.isArray(data)) {
    throw error ?? new Error("completion CAS readback failed");
  }
  const saved = data as Record<string, unknown>;
  const savedRevision = Number(saved.revision);
  if (typeof saved.done !== "boolean" || !Number.isSafeInteger(savedRevision) || savedRevision < revision) {
    throw new Error("invalid completion CAS result");
  }
  return {
    done: saved.done,
    doneAt: saved.done ? String(saved.doneAt ?? doneAt) : null,
    revision: savedRevision,
    ...(action === "toggleReturn" ? { contractStatus: String(saved.contractStatus || (saved.done ? "반납완료" : "반출")) } : {}),
  };
}

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

// 쓰기 후 캐시 무효화는 선별적으로 — 전체 clear는 반출 작업처럼 연속 쓰기가 이어질 때
// 사진/장비카탈로그/레이더 캐시까지 전멸시켜 모든 읽기가 GAS 콜드로 가는 부작용이 있었다.
// 쓰기의 영향을 받는 화면 데이터(dashboard/timeline 등)만 비우고, 사진 업로드일 때만 사진 캐시도 비운다.
const VOLATILE_ACTION_RE = /(^|&)action=(dashboard|dashboardSearch|dashboardContractExtras|dashboardEquipNames|timeline|operations|scan|search|read|list|info)(&|$)/;
function invalidateCacheForWrite(action: string): void {
  const photoWrite = action === "uploadDashboardPhoto" || action === "deleteDashboardPhoto";
  for (const key of cache.keys()) {
    if (VOLATILE_ACTION_RE.test(key) || (photoWrite && key.includes("dashboardPhoto"))) cache.delete(key);
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
  "toggleItems",
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
  "deleteDashboardPhoto",
  "updateTrade",
  "updateContractStatus",
  "updateTradeDiscount",
  "repairTradeProjection",
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
        // 쓰기 직후 재조회가 쓰기 이전 캐시를 받아 화면이 되돌아 보이지 않도록 관련 읽기 캐시 무효화
        invalidateCacheForWrite(action);
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

  const completionAction = action === "toggleSetup" || action === "toggleReturn";
  // 완료 상태 순서는 GAS mutation 원장이 먼저 결정하고, Supabase 저장은 그 응답을 따른다.
  Object.assign(payload, body, { action, key: GAS_KEY });

  try {
    const r = await fetch(GAS_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      redirect: "follow",
      signal: AbortSignal.timeout(60_000),
    });
    let responseBody = await r.text();
    if (completionAction && r.ok) {
      let confirmed: Record<string, unknown> | null = null;
      try {
        const parsed: unknown = JSON.parse(responseBody);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          confirmed = parsed as Record<string, unknown>;
        }
      } catch { /* 유효하지 않은 GAS 응답은 브라우저가 기존 규칙대로 재시도한다. */ }
      const field = action === "toggleSetup" ? "setupDone" : "returnDone";
      if (confirmed && !confirmed.error && typeof confirmed[field] === "boolean") {
        try {
          // GAS가 수락한 canonical 상태만 Supabase에 쓴다. 반대 순서면 두 탭의 오래된
          // 요청이 늦게 도착해 Supabase만 과거 상태로 되돌리는 분할 성공이 생긴다.
          const authority = await persistCompletionAuthority_(action as "toggleSetup" | "toggleReturn", {
            tid: body.tid,
            done: confirmed[field],
            completionRevision: confirmed.completionRevision,
            remoteDoneAt: confirmed[field]
              ? (confirmed.setupDoneAt ?? confirmed.returnDoneAt ?? confirmed.doneAt ?? "")
              : "",
            remoteContractStatus: confirmed.contractStatus ?? "",
          });
          // 느린 옛 요청이 CAS에서 기각되면 DB가 돌려준 최신 정본으로 브라우저도 수렴한다.
          confirmed[field] = authority.done;
          confirmed.completionRevision = authority.revision;
          confirmed.doneAt = authority.doneAt ?? "";
          if (action === "toggleSetup") confirmed.setupDoneAt = authority.doneAt ?? "";
          else {
            confirmed.returnDoneAt = authority.doneAt ?? "";
            confirmed.contractStatus = authority.contractStatus ?? confirmed.contractStatus;
          }
          responseBody = JSON.stringify(confirmed);
        } catch (error) {
          console.error(`[${action}] remote authority pending`, error);
          return NextResponse.json(
            { error: "완료 상태 저장이 지연되어 자동 재시도 중입니다", code: "REMOTE_RETRY", retryable: true },
            { status: 503 },
          );
        }
      }
    }
    // 쓰기 후에는 관련 읽기 캐시를 무효화해 직후 dashboard/timeline 재조회가 이전 상태를 받지 않게 한다
    if (isWrite) invalidateCacheForWrite(action);
    return new NextResponse(responseBody, {
      status: r.status,
      headers: { "content-type": "application/json", "x-cache": isWrite ? "POST-WRITE" : "POST" },
    });
  } catch (e) {
    if (action === "toggleSetup" || action === "toggleReturn") {
      console.error(`[${action}] GAS confirmation pending`, e);
      return NextResponse.json(
        { error: "완료 상태 저장이 지연되어 자동 재시도 중입니다", code: "REMOTE_RETRY", retryable: true },
        { status: 503 },
      );
    }
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
