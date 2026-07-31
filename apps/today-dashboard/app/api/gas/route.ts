import { NextRequest, NextResponse } from "next/server";
import { createHash } from "node:crypto";
import { isAuthedRequest as isAuthed } from "@/lib/server/authCache";
import { getInventoryAuditServiceClient } from "@/lib/server/inventoryAuditDb";

export const maxDuration = 60;

// 기존 GAS 웹앱(구글시트 DB) 프록시 — 서버측 호출로 CORS 회피 + 키 은닉 + 캐시.
const GAS_URL =
  process.env.GAS_API_URL ??
  "https://script.google.com/macros/s/AKfycbyRff4-lLXmne-iPIEf87x4-CH_5wb-Uv5dCGymELLrpiKluhg2gDdLdVP4Y0MmxnnT/exec";
const GAS_KEY = process.env.GAS_API_KEY ?? "village2026";

type CheckoutBaselineItem = {
  scheduleId: string;
  name: string;
  qty: number;
  setName: string;
  isHeader: boolean;
  isComponent: boolean;
  onsite: boolean;
};

function checkoutDoneValue(value: unknown): boolean {
  return value === true || value === 1 || value === "1" || value === "true";
}

function checkoutDbScheduleId(tradeId: string, scheduleId: string): string {
  return scheduleId.startsWith(`${tradeId}-`) ? scheduleId : `${tradeId}-${scheduleId}`;
}

function normalizeCheckoutBaselineItems_(tradeId: string, raw: unknown): CheckoutBaselineItem[] {
  let values: unknown = raw;
  if (typeof values === "string") {
    try { values = JSON.parse(values); } catch { values = []; }
  }
  if (!Array.isArray(values) || values.length === 0 || values.length > 200) {
    throw new Error("invalid checkout baseline items");
  }
  const seen = new Set<string>();
  const items = values.map((entry) => {
    const item = entry && typeof entry === "object" ? entry as Record<string, unknown> : {};
    const scheduleId = String(item.scheduleId ?? "").trim();
    const name = String(item.name ?? "").trim();
    const qty = Number(item.qty);
    if (!scheduleId || !name || !Number.isInteger(qty) || qty <= 0 || seen.has(scheduleId)) {
      throw new Error("invalid checkout baseline item");
    }
    seen.add(scheduleId);
    return {
      scheduleId,
      name,
      qty,
      setName: String(item.setName ?? "").trim(),
      isHeader: item.isHeader === true,
      isComponent: item.isComponent === true,
      onsite: item.onsite === true,
    };
  });
  return items.sort((left, right) => left.scheduleId < right.scheduleId ? -1 : left.scheduleId > right.scheduleId ? 1 : 0);
}

function checkoutBaselineFingerprint_(tradeId: string, items: CheckoutBaselineItem[]): string {
  const canonical = items.map((item) => ({
    scheduleId: item.scheduleId,
    name: item.name,
    qty: item.qty,
    setName: item.setName,
    isHeader: item.isHeader,
    isComponent: item.isComponent,
    onsite: item.onsite,
  }));
  return createHash("sha256").update(`${tradeId}\n${JSON.stringify(canonical)}`, "utf8").digest("hex");
}

function checkoutBaselineMatches_(item: CheckoutBaselineItem, row: Record<string, unknown>): boolean {
  return Number(row.taken_qty) === item.qty &&
    String(row.name ?? "").trim() === item.name &&
    String(row.set_name ?? "").trim() === item.setName &&
    (row.is_set_header === true) === item.isHeader &&
    (row.is_component === true) === item.isComponent &&
    (row.onsite === true) === item.onsite;
}

function checkoutStructureMatches_(item: CheckoutBaselineItem, row: Record<string, unknown>): boolean {
  return Number(row.qty) === item.qty &&
    String(row.name ?? "").trim() === item.name &&
    String(row.set_name ?? "").trim() === item.setName &&
    (row.is_set_header === true) === item.isHeader &&
    (row.is_component === true) === item.isComponent &&
    (row.onsite === true) === item.onsite;
}

/**
 * 반출 기준선/완료의 원격 정본 저장. GAS의 UrlFetch 일일 한도와 분리하기 위해
 * 로그인된 Vercel 서버가 service-role로 직접 저장하고, DB의 write-once trigger와
 * 저장 후 전체 readback으로 기존 기준선 삭제·변조를 모두 실패-폐쇄한다.
 */
async function persistSetupCompletionAuthority_(body: Record<string, unknown>): Promise<{
  doneAt: string | null;
  baselineFingerprint: string;
}> {
  const tradeId = String(body.tid ?? "").trim();
  if (!/^\d{6}-\d{3}$/.test(tradeId)) throw new Error("invalid trade id");
  const done = checkoutDoneValue(body.done);
  const client = getInventoryAuditServiceClient();

  if (!done) {
    const { data, error } = await client
      .from("trades")
      .update({ setup_done: false, setup_done_at: null })
      .eq("trade_id", tradeId)
      .select("trade_id")
      .maybeSingle();
    if (error || !data) throw error ?? new Error("trade not found");
    return { doneAt: null, baselineFingerprint: "" };
  }

  const items = normalizeCheckoutBaselineItems_(tradeId, body.baselineItems);
  const proposed = new Map(items.map((item) => [checkoutDbScheduleId(tradeId, item.scheduleId), item]));
  const dbIds = [...proposed.keys()];
  // 브라우저가 보낸 구조를 그대로 upsert하면 stale/조작 payload가 가짜 장비 행을 만들 수
  // 있다. 현재 원격 정본에 이미 존재하는 동일 행만 기준선 대상으로 허용한다.
  const { data: currentRows, error: currentRowsError } = await client
    .from("schedule_items")
    .select("schedule_id,name,qty,taken_qty,set_name,is_set_header,is_component,onsite,removed_at")
    .eq("trade_id", tradeId)
    .in("schedule_id", dbIds);
  if (currentRowsError) throw currentRowsError;
  if ((currentRows ?? []).length !== items.length) throw new Error("checkout baseline source count mismatch");
  for (const row of currentRows ?? []) {
    const item = proposed.get(String(row.schedule_id ?? "").trim());
    if (!item || !checkoutStructureMatches_(item, row as Record<string, unknown>)) {
      throw new Error("checkout baseline source mismatch");
    }
    if (row.removed_at && !(Number(row.taken_qty) > 0)) {
      throw new Error("removed checkout item cannot start baseline");
    }
  }
  const { data: existing, error: existingError } = await client
    .from("schedule_items")
    .select("schedule_id,name,taken_qty,set_name,is_set_header,is_component,onsite")
    .eq("trade_id", tradeId)
    .gt("taken_qty", 0);
  if (existingError) throw existingError;
  for (const row of existing ?? []) {
    const item = proposed.get(String(row.schedule_id ?? "").trim());
    if (!item || !checkoutBaselineMatches_(item, row as Record<string, unknown>)) {
      throw new Error("immutable checkout baseline conflict");
    }
  }

  // 구조 필드는 검증에만 쓰고 쓰지 않는다. 부분 upsert는 충돌 판정 전에 NOT NULL
  // 제약을 검사해 name 등이 없는 정상 기존 행도 거절하므로, 같은 수량끼리 묶어
  // 검증된 기존 행만 UPDATE한다. 검증 직후 행이 사라지면 반환 행 수로 실패-폐쇄한다.
  const idsByQty = new Map<number, string[]>();
  for (const item of items) {
    const ids = idsByQty.get(item.qty) ?? [];
    ids.push(checkoutDbScheduleId(tradeId, item.scheduleId));
    idsByQty.set(item.qty, ids);
  }
  for (const [qty, scheduleIds] of idsByQty) {
    const { data: updated, error: baselineError } = await client
      .from("schedule_items")
      .update({ taken_qty: qty, checkout_state: "taken" })
      .eq("trade_id", tradeId)
      .in("schedule_id", scheduleIds)
      .select("schedule_id");
    if (baselineError) throw baselineError;
    if ((updated ?? []).length !== scheduleIds.length) {
      throw new Error("checkout baseline update count mismatch");
    }
  }

  const { data: readback, error: readbackError } = await client
    .from("schedule_items")
    .select("schedule_id,name,taken_qty,set_name,is_set_header,is_component,onsite")
    .eq("trade_id", tradeId)
    .gt("taken_qty", 0);
  if (readbackError) throw readbackError;
  if ((readback ?? []).length !== items.length) throw new Error("checkout baseline readback count mismatch");
  for (const row of readback ?? []) {
    const item = proposed.get(String(row.schedule_id ?? "").trim());
    if (!item || !checkoutBaselineMatches_(item, row as Record<string, unknown>)) {
      throw new Error("checkout baseline readback mismatch");
    }
  }

  const doneAt = new Date().toISOString();
  const { data: saved, error: setupError } = await client
    .from("trades")
    .update({ setup_done: true, setup_done_at: doneAt })
    .eq("trade_id", tradeId)
    .select("trade_id,setup_done,setup_done_at")
    .maybeSingle();
  if (setupError || !saved || saved.setup_done !== true) {
    throw setupError ?? new Error("setup completion readback failed");
  }
  return { doneAt: String(saved.setup_done_at ?? doneAt), baselineFingerprint: checkoutBaselineFingerprint_(tradeId, items) };
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

  if (action === "toggleSetup") {
    try {
      const authority = await persistSetupCompletionAuthority_(body);
      body.remoteConfirmed = true;
      body.baselineFingerprint = authority.baselineFingerprint;
      if (authority.doneAt) body.remoteDoneAt = authority.doneAt;
    } catch (error) {
      // 내부 Supabase/GAS 예외 원문은 직원 화면에 내보내지 않는다. 내구 outbox가 같은
      // mutationId로 자동 재시도하므로 화면에는 짧은 지연 안내만 전달한다.
      console.error("[toggleSetup] remote authority pending", error);
      return NextResponse.json(
        { error: "반출완료 저장이 지연되어 자동 재시도 중입니다", code: "REMOTE_RETRY", retryable: true },
        { status: 503 },
      );
    }
  }
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
    // 쓰기 후에는 관련 읽기 캐시를 무효화해 직후 dashboard/timeline 재조회가 이전 상태를 받지 않게 한다
    if (isWrite) invalidateCacheForWrite(action);
    return new NextResponse(responseBody, {
      status: r.status,
      headers: { "content-type": "application/json", "x-cache": isWrite ? "POST-WRITE" : "POST" },
    });
  } catch (e) {
    if (action === "toggleSetup") {
      console.error("[toggleSetup] GAS confirmation pending", e);
      return NextResponse.json(
        { error: "반출완료 저장이 지연되어 자동 재시도 중입니다", code: "REMOTE_RETRY", retryable: true },
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
