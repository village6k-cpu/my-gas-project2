/**
 * 토스 프론트 플러그인 — 예약 결제 취소 장부 반영 API
 *
 * Toss 취소 SUCCESS와 로컬 취소 기록을 먼저 확정한 프런트가 호출한다.
 * 이 라우트는 Toss 취소를 실행하지 않고 예약 장부의 입금상태만 "환불"로 바꾼다.
 */

import { NextRequest, NextResponse } from "next/server";
import { gasPost } from "@/lib/server/gasPublic";

export const runtime = "nodejs";

const LOOKUP_TOKEN = process.env.LOOKUP_TOKEN;

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

interface CancelBody {
  tradeId?: string;
  paymentKey?: string;
  amount?: number;
  cancelApprovalNumber?: string;
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const tokenErr = checkToken(req);
  if (tokenErr) return tokenErr;

  let parsed: unknown;
  try {
    parsed = await req.json();
  } catch {
    return lookupJson({ error: "요청 바디가 JSON이 아닙니다." }, { status: 400 });
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return lookupJson({ error: "요청 바디는 JSON 객체여야 합니다." }, { status: 400 });
  }

  const body = parsed as CancelBody;
  const { tradeId, paymentKey, amount, cancelApprovalNumber } = body;
  if (!tradeId || typeof tradeId !== "string" || !tradeId.trim()) {
    return lookupJson({ error: "tradeId가 필요합니다." }, { status: 400 });
  }
  if (!paymentKey || typeof paymentKey !== "string" || !paymentKey.trim()) {
    return lookupJson({ error: "paymentKey가 필요합니다." }, { status: 400 });
  }

  const normalizedTradeId = tradeId.trim();
  const normalizedPaymentKey = paymentKey.trim();

  try {
    const gasResult = await gasPost({
      action: "updateTradeProof",
      tid: normalizedTradeId,
      field: "depositStatus",
      value: "환불",
    });
    const gasError =
      gasResult && typeof gasResult === "object" && "error" in gasResult
        ? String((gasResult as { error?: unknown }).error ?? "")
        : "";
    if (gasError) throw new Error(gasError);

    return lookupJson({
      ok: true,
      tradeId: normalizedTradeId,
      paymentKey: normalizedPaymentKey,
      amount: amount ?? null,
      cancelApprovalNumber: cancelApprovalNumber ?? null,
      depositStatus: "환불",
      gasResult,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[lookup/cancel] GAS 호출 오류:", msg);
    return lookupJson({ error: "환불 장부 반영 중 오류: " + msg }, { status: 502 });
  }
}
