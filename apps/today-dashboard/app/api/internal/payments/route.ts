import { NextRequest, NextResponse } from "next/server";
import { acknowledgePaymentProjections, ingestPayment, paymentBalances, paymentDb, projectPaymentBalances, projectionItem, refreshPaymentAccounts, validPaymentInternalKey } from "@/lib/server/paymentLedger";

export const dynamic = "force-dynamic";
export const maxDuration = 180;
const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
export async function POST(req: NextRequest) {
  if (!validPaymentInternalKey(req.headers.get("x-payment-internal-key"))) return json({ success: false, error: "내부 인증 필요" }, 401);
  try {
    const body = await req.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("요청 형식 오류");
    const db = paymentDb();
    if (body.action === "ingest") {
      const result = await ingestPayment(body, "provider_bridge", {}, db);
      const { receipt: _privateReceipt, ...safe } = result;
      return json(safe);
    }
    if (body.action === "ingestBankBatch") {
      if (!Array.isArray(body.receipts) || body.receipts.length > 50 || body.receipts.some((r: any) => r.source !== "bank")) throw new Error("은행 원본은 50건 이하로 전달해야 합니다.");
      await refreshPaymentAccounts(undefined, undefined, db);
      const results = [];
      for (const receipt of body.receipts) {
        const result = await ingestPayment(receipt, "bank_bridge", { refresh: false, project: false }, db);
        const { receipt: _privateReceipt, ...safe } = result;
        results.push(safe);
      }
      const pending = (await paymentBalances(undefined, db)).filter(a => a.needs_projection).slice(0, 50).map(a => a.trade_id);
      return json({ success: true, results, syncWarnings: await projectPaymentBalances(pending, db) });
    }
    if (body.action === "syncSnapshot") {
      const tids = await refreshPaymentAccounts(undefined, body.accounts, db);
      const balances = await paymentBalances(tids, db);
      const projections = balances.filter(a => a.needs_projection && !a.review_required && a.billed_amount !== null && !["취소", "계약누락"].includes(a.contract_status)).map(projectionItem);
      // GAS가 호출한 요청에는 GAS를 다시 호출하지 않는다. 호출자가 직접 투영 후 ACK한다.
      const snapshotAcknowledgements = balances.map(a => ({
        tradeId: a.trade_id,
        state: a.review_required || a.billed_amount === null || ["취소", "계약누락"].includes(a.contract_status)
          ? "review_held" : a.needs_projection ? "projection_required" : "current",
      }));
      return json({ success: true, projections, snapshotAcknowledgements });
    }
    if (body.action === "ackProjections") {
      if (!Array.isArray(body.applied) || !Array.isArray(body.rejected)) throw new Error("수납 반영 확인 목록 오류");
      await acknowledgePaymentProjections(body.applied, body.rejected, db);
      return json({ success: true });
    }
    if (body.action === "sync") {
      await refreshPaymentAccounts(undefined, undefined, db);
      const pending = (await paymentBalances(undefined, db)).filter(a => a.needs_projection).slice(0, 50).map(a => a.trade_id);
      return json({ success: true, syncWarnings: await projectPaymentBalances(pending, db) });
    }
    throw new Error("지원하지 않는 수납 작업입니다.");
  } catch (error) {
    // 원본 저장 뒤 투영만 실패한 경우 ingest/project 함수가 성공+반영대기를 반환한다.
    // 원본/배분 자체를 확정하지 못한 실패만 재시도하도록 503을 반환한다.
    return json({ success: false, error: error instanceof Error ? error.message : String(error) }, 503);
  }
}
