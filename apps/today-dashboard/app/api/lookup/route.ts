/**
 * 토스 프론트 플러그인 대비 — 예약 조회 API
 *
 * GET /api/lookup?phone=01012341234       (전화번호 끝 8자리 매칭)
 * GET /api/lookup?reservation=<trade_id>  (거래ID 정확매칭)
 *
 * 보안: x-lookup-token 헤더 == env LOOKUP_TOKEN (서버사이드 가드)
 * TODO: 토스 SDK 승인 후 토스 공식 인증(서명·HMAC 등)으로 교체 예정.
 *
 * village 스키마 PostgREST 노출 필요:
 *   Supabase Dashboard > Settings > API > Exposed schemas 에 'village' 추가
 *   (현재 anon 정책 proto_all 또는 lockdown.sql 실행 여부에 따라 service role 키 필요)
 */

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { normalizePhoneLast8 } from "@/lib/server/phoneNormalize";

export const runtime = "nodejs";

// ── 환경변수 ──────────────────────────────────────────────────────
const SUPA_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const LOOKUP_TOKEN = process.env.LOOKUP_TOKEN;

// 토스 프론트 플러그인은 plugin-dev/plugin origin에서 실행되어 preflight가 발생한다.
const LOOKUP_CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, x-lookup-token",
  "Access-Control-Max-Age": "86400",
};

function lookupJson(body: unknown, init: ResponseInit = {}): NextResponse {
  const headers = new Headers(init.headers);
  for (const [key, value] of Object.entries(LOOKUP_CORS_HEADERS)) {
    headers.set(key, value);
  }
  return NextResponse.json(body, { ...init, headers });
}

export async function OPTIONS(): Promise<NextResponse> {
  return new NextResponse(null, { status: 204, headers: LOOKUP_CORS_HEADERS });
}

// ── 토큰 가드 ─────────────────────────────────────────────────────
function checkToken(req: NextRequest): NextResponse | null {
  if (!LOOKUP_TOKEN) {
    return lookupJson(
      { error: "LOOKUP_TOKEN 환경변수가 설정되지 않았습니다. 서버 관리자에게 문의하세요." },
      { status: 503 }
    );
  }
  const provided = req.headers.get("x-lookup-token") ?? "";
  if (provided !== LOOKUP_TOKEN) {
    return lookupJson({ error: "인증 실패" }, { status: 401 });
  }
  return null;
}

// ── Supabase 서비스클라이언트 (village 스키마) ────────────────────
function makeServiceClient() {
  if (!SUPA_URL) return null;
  // service role 우선(RLS 우회), 없으면 anon 폴백
  const key = SERVICE_KEY ?? ANON_KEY;
  if (!key) return null;
  return createClient(SUPA_URL, key, {
    db: { schema: "village" },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

// ── 응답 타입 ─────────────────────────────────────────────────────
interface LookupMatch {
  tradeId: string;
  customerName: string;
  itemSummary: string | null;
  amount: number | null;
  checkoutAt: string;
  depositStatus: string | null;
}

// ── 품목 요약 (최대 3개 + 나머지) ─────────────────────────────────
function buildItemSummary(items: Array<{ name: string }>): string | null {
  if (!items || items.length === 0) return null;
  const names = items.map((i) => i.name);
  const preview = names.slice(0, 3);
  const rest = names.length - 3;
  return rest > 0 ? `${preview.join(", ")} 외 ${rest}건` : preview.join(", ");
}

// ── 핸들러 ────────────────────────────────────────────────────────
export async function GET(req: NextRequest): Promise<NextResponse> {
  // 1) 토큰 검증
  const tokenErr = checkToken(req);
  if (tokenErr) return tokenErr;

  // 2) 파라미터 파싱
  const sp = req.nextUrl.searchParams;
  const rawPhone = sp.get("phone") ?? "";
  const reservation = sp.get("reservation") ?? "";

  if (!rawPhone && !reservation) {
    return lookupJson(
      { error: "phone 또는 reservation 파라미터가 필요합니다." },
      { status: 400 }
    );
  }

  // 3) Supabase 클라이언트 확인
  const sb = makeServiceClient();
  if (!sb) {
    return lookupJson(
      { error: "Supabase 환경변수(SUPABASE_SERVICE_ROLE_KEY 또는 NEXT_PUBLIC_SUPABASE_ANON_KEY) 미설정" },
      { status: 503 }
    );
  }

  try {
    // 4) 거래 조회
    // ⚠️ 미결제 판정은 JS에서 — PostgREST .neq("deposit_status","입금완료")는
    //    deposit_status=NULL 행을 제외해버림(SQL상 NULL<>'입금완료'=UNKNOWN).
    //    실데이터 다수가 deposit_status NULL(미기록)이고 이건 "미결제"로 봐야 함.
    const baseSelect = sb
      .from("trades")
      .select("trade_id, customer_name, customer_phone, amount, checkout_at, deposit_status, contract_status")
      .order("checkout_at", { ascending: false });

    type Row = {
      trade_id: string;
      customer_name: string;
      customer_phone: string | null;
      amount: number | null;
      checkout_at: string;
      deposit_status: string | null;
      contract_status: string;
    };

    let rows: Row[] = [];
    if (reservation) {
      // 거래ID 정확매칭
      const { data, error } = await baseSelect.eq("trade_id", reservation);
      if (error) throw error;
      rows = (data ?? []) as Row[];
    } else {
      // 전화번호: 전체 로드 후 끝 8자리로 매칭
      // (PostgREST에서 함수 기반 필터가 없어 클라이언트 필터링)
      // TODO: 데이터가 수천 건 이상이면 DB FUNCTION 또는 generated column 고려
      const { data, error } = await baseSelect;
      if (error) throw error;
      const needle = normalizePhoneLast8(rawPhone);
      rows = ((data ?? []) as Row[]).filter(
        (t) => t.customer_phone && normalizePhoneLast8(t.customer_phone) === needle
      );
    }

    // 미결제(입금완료 아님 — NULL 포함) + 미취소
    const trades = rows.filter(
      (t) => t.deposit_status !== "입금완료" && t.contract_status !== "취소"
    );

    if (trades.length === 0) {
      return lookupJson({ matches: [] });
    }

    // 5) 품목 조회 (해당 거래들만)
    const tradeIds = trades.map((t) => t.trade_id);
    const { data: items, error: itemsErr } = await sb
      .from("schedule_items")
      .select("trade_id, name, sort")
      .in("trade_id", tradeIds)
      .order("sort", { ascending: true });
    if (itemsErr) {
      // 품목 조회 실패는 경고만 — 거래 목록은 그대로 반환
      console.warn("[lookup] schedule_items 조회 실패:", itemsErr.message);
    }

    // 6) 품목을 trade_id별로 그룹핑
    const itemsByTrade = new Map<string, Array<{ name: string }>>();
    for (const it of items ?? []) {
      const list = itemsByTrade.get(it.trade_id) ?? [];
      list.push({ name: it.name });
      itemsByTrade.set(it.trade_id, list);
    }

    // 7) 응답 조립
    const matches: LookupMatch[] = trades.map((t) => ({
      tradeId: t.trade_id,
      customerName: t.customer_name,
      itemSummary: buildItemSummary(itemsByTrade.get(t.trade_id) ?? []),
      amount: t.amount,
      checkoutAt: t.checkout_at,
      depositStatus: t.deposit_status,
    }));

    return lookupJson({ matches });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[lookup] 조회 오류:", msg);
    return lookupJson({ error: "조회 중 오류: " + msg }, { status: 502 });
  }
}
