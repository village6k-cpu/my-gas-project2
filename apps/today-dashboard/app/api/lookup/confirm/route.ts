/**
 * 토스 프론트 플러그인 대비 — 결제완료 처리 API (뼈대)
 *
 * POST /api/lookup/confirm
 * Body: { tradeId: string, paidAmount?: number, method?: string }
 *
 * 역할:
 *   1) 토큰 검증 (x-lookup-token)
 *   2) tradeId 유효성 확인
 *   3) GAS updatePayment 호출 → 시트 '입금완료' 기록 → Supabase 90초 동기
 *
 *  GAS 계약 확정: action=updatePayment, params { tid, method:'카드결제' }
 *      (checkAvailability.js updateTradePaymentMethod(tid, method))
 *      → 거래내역 J열 결제수단='카드결제'
 *      → 부수효과(applyTradePaymentSideEffects_)로 K/L/M = 미발행/발행완료/입금완료
 *      → Supabase village.trades 90초 내 동기 → 이후 /api/lookup 에서 제외됨.
 *      ⚠️ method !== '카드결제' 이면 입금완료 부수효과가 안 찍힘(결제수단만 변경).
 *
 * 남은 TODO (토스 단말기 운영 전환 시):
 *   - 토스→우리 서버 인증(현 x-lookup-token → 토스 서명·HMAC·IP 화이트리스트)
 *   - 멱등성: 동일 paymentKey 중복 confirm 차단(현재 입금완료 재설정은 무해)
 *   - 실제 결제금액 vs 예약금액 검증 (초과 결제 차단)
 *   - 부분결제 처리 (현재 DB에 잔액 컬럼 없음 → 설계 필요)
 */

import { NextRequest, NextResponse } from "next/server";
import { gasPost } from "@/lib/server/gasPublic";

export const runtime = "nodejs";

// ── 환경변수 ──────────────────────────────────────────────────────
const LOOKUP_TOKEN = process.env.LOOKUP_TOKEN;

// 토스 프론트 플러그인은 plugin-dev/plugin origin에서 실행되어 preflight가 발생한다.
const LOOKUP_CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
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

// ── 요청 바디 타입 ────────────────────────────────────────────────
interface ConfirmBody {
  tradeId?: string;
  paidAmount?: number;
  method?: string;
  paymentKey?: string; // 토스 결제키 — 멱등성/로그용
  approvalNumber?: string; // 카드 승인번호 — 로그/대사용
}

// ── 핸들러 ────────────────────────────────────────────────────────
export async function POST(req: NextRequest): Promise<NextResponse> {
  // 1) 토큰 검증
  const tokenErr = checkToken(req);
  if (tokenErr) return tokenErr;

  // 2) 바디 파싱
  let body: ConfirmBody = {};
  try {
    body = await req.json();
  } catch {
    return lookupJson({ error: "요청 바디가 JSON이 아닙니다." }, { status: 400 });
  }

  const { tradeId, paidAmount, paymentKey, approvalNumber } = body;

  if (!tradeId || typeof tradeId !== "string" || !tradeId.trim()) {
    return lookupJson({ error: "tradeId가 필요합니다." }, { status: 400 });
  }

  // 프론트 플러그인은 카드 단말 결제이므로 '카드결제'.
  // ⚠️ GAS updateTradePaymentMethod는 method === '카드결제'일 때만
  //    applyTradePaymentSideEffects_로 M열 입금상태='입금완료'를 찍는다.
  //    다른 값/빈 값이면 결제수단만 바뀌고 입금완료 처리가 안 됨.
  const method = (body.method && body.method.trim()) || "카드결제";

  // 3) GAS updatePayment 호출 → 시트 결제수단='카드결제' → 부수효과로 입금완료
  //    실제 계약: action=updatePayment, params { tid, method }
  try {
    const gasPayload: Record<string, unknown> = {
      action: "updatePayment",
      tid: tradeId.trim(),
      method,
    };

    const result = await gasPost(gasPayload);

    return lookupJson({
      ok: true,
      tradeId: tradeId.trim(),
      method,
      paidAmount: paidAmount ?? null,
      paymentKey: paymentKey ?? null,
      approvalNumber: approvalNumber ?? null,
      message: "결제수단 '카드결제' 반영 — 입금완료 처리됨. Supabase 동기까지 최대 90초.",
      gasResult: result,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[lookup/confirm] GAS 호출 오류:", msg);
    return lookupJson(
      { error: "결제 처리 중 오류: " + msg },
      { status: 502 }
    );
  }
}
