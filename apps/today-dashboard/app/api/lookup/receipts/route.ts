/**
 * 토스 프론트 플러그인 — 영수증 재출력용 결제완료 예약 조회 API
 *
 * 결제 가능 예약 조회(/api/lookup)와 의도적으로 분리한다.
 * - /api/lookup: 오래된/입금완료 건을 숨겨 오결제를 막는다.
 * - /api/lookup/receipts: 직원이 과거 결제완료 건 영수증을 재출력한다.
 */

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { normalizePhoneLast8 } from "@/lib/server/phoneNormalize";

export const runtime = "nodejs";

const SUPA_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const LOOKUP_TOKEN = process.env.LOOKUP_TOKEN;
const RECEIPT_LIMIT = readLimit("TOSS_FRONT_RECEIPT_LOOKUP_LIMIT", 1000);
const RECEIPT_PAID_DEPOSIT_STATUSES = new Set(["입금완료"]);
const RECEIPT_BLOCKED_CONTRACT_STATUSES = new Set(["취소"]);

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

function makeServiceClient() {
  if (!SUPA_URL) return null;
  const key = SERVICE_KEY ?? ANON_KEY;
  if (!key) return null;
  return createClient(SUPA_URL, key, {
    db: { schema: "village" },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

function readLimit(name: string, fallback: number): number {
  const parsed = Number(process.env[name]);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return Math.min(Math.floor(parsed), 5000);
}

function normalizeStatus(value: unknown): string {
  return String(value ?? "").trim();
}

function isReceiptTrade(t: Row): boolean {
  return (
    RECEIPT_PAID_DEPOSIT_STATUSES.has(normalizeStatus(t.deposit_status)) &&
    !RECEIPT_BLOCKED_CONTRACT_STATUSES.has(normalizeStatus(t.contract_status)) &&
    Number(t.amount) > 0
  );
}

function buildItemSummary(items: Array<{ name: string }>): string | null {
  if (!items || items.length === 0) return null;
  const names = items.map((i) => i.name);
  const preview = names.slice(0, 3);
  const rest = names.length - 3;
  return rest > 0 ? `${preview.join(", ")} 외 ${rest}건` : preview.join(", ");
}

type Row = {
  trade_id: string;
  customer_name: string;
  customer_phone: string | null;
  amount: number | string | null;
  checkout_at: string;
  return_at: string;
  deposit_status: string | null;
  contract_status: string;
  payment_method: string | null;
};

type ReceiptMatch = {
  tradeId: string;
  customerName: string;
  itemSummary: string | null;
  amount: number | null;
  checkoutAt: string;
  returnAt: string;
  depositStatus: string | null;
  paymentMethod: string | null;
};

export async function GET(req: NextRequest): Promise<NextResponse> {
  const tokenErr = checkToken(req);
  if (tokenErr) return tokenErr;

  const sp = req.nextUrl.searchParams;
  const rawPhone = sp.get("phone") ?? "";
  const reservation = sp.get("reservation") ?? "";

  if (!rawPhone && !reservation) {
    return lookupJson(
      { error: "phone 또는 reservation 파라미터가 필요합니다." },
      { status: 400 }
    );
  }

  const sb = makeServiceClient();
  if (!sb) {
    return lookupJson(
      { error: "Supabase 환경변수(SUPABASE_SERVICE_ROLE_KEY 또는 NEXT_PUBLIC_SUPABASE_ANON_KEY) 미설정" },
      { status: 503 }
    );
  }

  try {
    const baseSelect = sb
      .from("trades")
      .select("trade_id, customer_name, customer_phone, amount, checkout_at, return_at, deposit_status, contract_status, payment_method")
      .in("deposit_status", Array.from(RECEIPT_PAID_DEPOSIT_STATUSES))
      .order("checkout_at", { ascending: false })
      .limit(RECEIPT_LIMIT);

    let rows: Row[] = [];
    if (reservation) {
      const { data, error } = await baseSelect.eq("trade_id", reservation.trim());
      if (error) throw error;
      rows = (data ?? []) as Row[];
    } else {
      const { data, error } = await baseSelect;
      if (error) throw error;
      const needle = normalizePhoneLast8(rawPhone);
      rows = ((data ?? []) as Row[]).filter(
        (t) => t.customer_phone && normalizePhoneLast8(t.customer_phone) === needle
      );
    }

    const trades = rows.filter(isReceiptTrade);
    if (trades.length === 0) {
      return lookupJson({ matches: [] });
    }

    const tradeIds = trades.map((t) => t.trade_id);
    const { data: items, error: itemsErr } = await sb
      .from("schedule_items")
      .select("trade_id, name, sort")
      .in("trade_id", tradeIds)
      .order("sort", { ascending: true });
    if (itemsErr) {
      console.warn("[lookup/receipts] schedule_items 조회 실패:", itemsErr.message);
    }

    const itemsByTrade = new Map<string, Array<{ name: string }>>();
    for (const it of items ?? []) {
      const list = itemsByTrade.get(it.trade_id) ?? [];
      list.push({ name: it.name });
      itemsByTrade.set(it.trade_id, list);
    }

    const matches: ReceiptMatch[] = trades.map((t) => ({
      tradeId: t.trade_id,
      customerName: t.customer_name,
      itemSummary: buildItemSummary(itemsByTrade.get(t.trade_id) ?? []),
      amount: t.amount == null ? null : Number(t.amount),
      checkoutAt: t.checkout_at,
      returnAt: t.return_at,
      depositStatus: t.deposit_status,
      paymentMethod: t.payment_method,
    }));

    return lookupJson({ matches });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[lookup/receipts] 조회 오류:", msg);
    return lookupJson({ error: "영수증 조회 중 오류: " + msg }, { status: 502 });
  }
}
