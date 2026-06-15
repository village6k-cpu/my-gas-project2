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
 * ⚠️  현재 상태: 뼈대(skeleton).
 *      토스 단말기 결제 후 이 API를 호출하는 실제 포맷·타이밍·인증은
 *      토스 프론트 플러그인 SDK 승인 후 확정됩니다.
 *      그 전까지는 내부 포맷으로만 동작합니다.
 *
 * TODO (토스 SDK 승인 후):
 *   - 토스 결제 콜백 포맷 반영 (paymentKey, orderId, amount 등)
 *   - 토스→우리 서버 인증(서명·HMAC·IP 화이트리스트) 추가
 *   - 멱등성 키(paymentKey) 기반 중복처리 방지
 *   - 실제 결제금액 vs 예약금액 검증 (초과 결제 차단)
 *   - 부분결제 처리 (현재 DB에 잔액 컬럼 없음 → 설계 필요)
 */

import { NextRequest, NextResponse } from "next/server";
import { gasPost } from "@/lib/server/gasPublic";

export const runtime = "nodejs";

// ── 환경변수 ──────────────────────────────────────────────────────
const LOOKUP_TOKEN = process.env.LOOKUP_TOKEN;

// ── 토큰 가드 ─────────────────────────────────────────────────────
function checkToken(req: NextRequest): NextResponse | null {
  if (!LOOKUP_TOKEN) {
    return NextResponse.json(
      { error: "LOOKUP_TOKEN 환경변수가 설정되지 않았습니다. 서버 관리자에게 문의하세요." },
      { status: 503 }
    );
  }
  const provided = req.headers.get("x-lookup-token") ?? "";
  if (provided !== LOOKUP_TOKEN) {
    return NextResponse.json({ error: "인증 실패" }, { status: 401 });
  }
  return null;
}

// ── 요청 바디 타입 ────────────────────────────────────────────────
interface ConfirmBody {
  tradeId?: string;
  paidAmount?: number;
  method?: string;
  // TODO (토스 SDK 승인 후): paymentKey, orderId, status 등 추가
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
    return NextResponse.json({ error: "요청 바디가 JSON이 아닙니다." }, { status: 400 });
  }

  const { tradeId, paidAmount, method } = body;

  if (!tradeId || typeof tradeId !== "string" || !tradeId.trim()) {
    return NextResponse.json({ error: "tradeId가 필요합니다." }, { status: 400 });
  }

  // 3) GAS updatePayment 호출 → 시트 '입금완료' 기록
  //    기존 /api/gas?action=updatePayment 패턴을 따르되, 여기서는 서버→GAS 직접 호출.
  //    GAS updatePayment 함수는 tradeId + depositStatus + (선택) paymentMethod를 받는다.
  //
  //    TODO: GAS updatePayment의 실제 파라미터 키 이름을 확인 후 맞춤
  //          (현재는 기존 /api/gas 라우트의 WRITE_ACTIONS: 'updatePayment' 패턴 준용)
  try {
    const gasPayload: Record<string, unknown> = {
      action: "updatePayment",
      tradeId: tradeId.trim(),
      depositStatus: "입금완료",
    };

    if (method) gasPayload.paymentMethod = method;
    if (paidAmount != null) gasPayload.paidAmount = paidAmount;

    // TODO (토스 SDK 승인 후):
    //   gasPayload.paymentKey = body.paymentKey;   // 토스 결제키 (멱등성)
    //   gasPayload.orderId    = body.orderId;        // 주문번호 (검증용)

    const result = await gasPost(gasPayload);

    return NextResponse.json({
      ok: true,
      tradeId: tradeId.trim(),
      message: "입금완료로 처리되었습니다. Supabase 동기까지 최대 90초 소요.",
      gasResult: result,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[lookup/confirm] GAS 호출 오류:", msg);
    return NextResponse.json(
      { error: "결제 처리 중 오류: " + msg },
      { status: 502 }
    );
  }
}
