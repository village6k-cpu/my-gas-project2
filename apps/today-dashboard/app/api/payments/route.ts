import { NextRequest, NextResponse } from "next/server";
import { getAuthedUser } from "@/lib/server/authCache";
import { allocatePayment, getPaymentWorkspace, paymentDb, paymentLedgerEnabled, projectPaymentBalances, refreshPaymentAccounts } from "@/lib/server/paymentLedger";

export const dynamic = "force-dynamic";
export const maxDuration = 180;
const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
function failure(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return json({ error: message }, /revision|stale|conflict|payload mismatch/i.test(message) ? 409 : 400);
}
export async function GET(req: NextRequest) {
  if (!await getAuthedUser(req)) return json({ error: "직원 로그인이 필요합니다." }, 401);
  if (!paymentLedgerEnabled()) return json({ error: "수납 관리 전환 준비 중입니다." }, 503);
  try { return json(await getPaymentWorkspace(req.nextUrl.searchParams.get("search") ?? "")); }
  catch (error) { return failure(error); }
}
export async function POST(req: NextRequest) {
  const user = await getAuthedUser(req);
  if (!user) return json({ error: "직원 로그인이 필요합니다." }, 401);
  if (!paymentLedgerEnabled()) return json({ error: "수납 관리 전환 준비 중입니다." }, 503);
  try {
    const body = await req.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("요청 형식 오류");
    if (body.action === "allocate") return json(await allocatePayment(body, user.id));
    if (body.action === "openingBalance") {
      if (!Number.isSafeInteger(body.openingPaid) || body.openingPaid < 0 || String(body.note ?? "").trim().length < 5) throw new Error("기존 수납액과 5자 이상의 확인 근거가 필요합니다.");
      const db = paymentDb();
      await refreshPaymentAccounts([String(body.tradeId)], undefined, db);
      const { data, error } = await db.rpc("payment_set_opening_balance", {
        p_trade_id: body.tradeId, p_opening_paid: body.openingPaid, p_expected_revision: body.expectedRevision,
        p_request_id: body.requestId, p_actor: user.id, p_note: body.note,
      });
      if (error) throw new Error(error.message);
      return json({ ...data, syncWarnings: await projectPaymentBalances([body.tradeId], db) });
    }
    throw new Error("지원하지 않는 수납 작업입니다.");
  } catch (error) { return failure(error); }
}
