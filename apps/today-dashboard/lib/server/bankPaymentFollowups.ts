import { paymentDb, paymentBalances } from "./paymentLedger";

type Row = Record<string, any>;
const DAY = 86_400_000;
const KST = 9 * 3_600_000;
const ACTIVE = ["open", "snoozed"];
const formatMoney = (value: number) => value.toLocaleString("ko-KR") + "원";
const normalize = (value: unknown) => String(value ?? "").normalize("NFKC").replace(/[\s().\-_]/g, "").toLowerCase();

export function planBankPaymentFollowup(work: Row, account: Row, receipts: Row[]) {
  const payload = work.payload ?? {};
  const tradeId = payload.business_key;
  if (work.work_type !== "payment_check" || !ACTIVE.includes(work.state) ||
      payload.action_family !== "payment_reconcile" || !/^\d{6}-\d{3}$/.test(tradeId ?? "") ||
      payload.follow_up_task_key !== "payment-check:" + tradeId || account?.trade_id !== tradeId ||
      Object.keys(work.pending_action ?? {}).length || ["취소", "계약누락"].includes(account.contract_status)) return null;

  const text = [work.title, payload.owner_request_summary].join(" ").normalize("NFKC");
  if (!/입금|계좌\s*이체/.test(text)) return null;
  const names = [...new Set([...text.matchAll(/(?:^|\s)([가-힣]{2,5}?)(?:님)?\s+(?:명의|이름)(?:으?로)?\s*(?:입금|이체)/g)].map(m => m[1]))];
  if (names.length > 1) return null;
  const payer = names[0] || account.payer_name || account.customer_name;
  const payerName = normalize(payer);
  if (payerName.length < 2) return null;

  const opened = Date.parse(work.first_opened_at);
  if (!Number.isFinite(opened)) return null;
  const midnight = Math.floor((opened + KST) / DAY) * DAY - KST;
  const day = /어제/.test(text) ? midnight - DAY : midnight;
  const candidates = receipts.filter(receipt => {
    const at = Date.parse(receipt.occurred_at);
    const sender = String(receipt.raw?.remark1 ?? "").normalize("NFKC").trim();
    const samePayer = [sender, sender.replace(/\s*\([^()]+\)\s*$/, "")].some(value => normalize(value) === payerName);
    return receipt.source === "bank" && receipt.status === "active" && !receipt.review_reason &&
      at >= day && at < day + DAY && samePayer;
  });
  const linked = candidates.filter(receipt => (receipt.allocations ?? []).some(
    (allocation: Row) => allocation.trade_id === tradeId && allocation.amount > 0,
  ));
  const paid = account.billed_amount > 0 && account.balance === 0 && account.status === "입금완료" &&
    !account.review_required && account.revision === account.projected_revision;
  if (linked.length && paid) {
    return { state: "confirmed", tradeId, payer, receiptIds: linked.map(row => row.id), amount: account.paid_amount };
  }
  const available = candidates.filter(row => row.allocated_amount === 0 && row.remaining_amount === row.amount);
  if (candidates.length !== 1 || available.length !== 1) return null;
  const receipt = available[0];
  return { state: "candidate", tradeId, payer, receiptIds: [receipt.id], amount: receipt.amount,
    reason: account.billed_amount == null ? "청구액 확인 필요"
      : receipt.amount !== account.balance ? "입금액과 예약 잔액이 달라 확인 필요" : "입금 원본을 예약에 연결할지 확인 필요" };
}

export async function recheckBankPaymentFollowups({ dryRun = false } = {}) {
  const db = paymentDb();
  const since = new Date(Date.now() - 3 * DAY).toISOString();
  const [work, bank] = await Promise.all([
    db.schema("public").from("work_items_v2").select("id,version,work_type,state,first_opened_at,title,summary,payload,pending_action")
      .eq("work_type", "payment_check").in("state", ACTIVE).gte("first_opened_at", since)
      .order("first_opened_at", { ascending: true }).order("id").limit(200),
    db.from("payment_receipt_balances").select("id,source,status,amount,raw,allocated_amount,remaining_amount,review_reason,occurred_at,allocations")
      .eq("source", "bank").gte("occurred_at", new Date(Date.now() - 5 * DAY).toISOString()).order("id").limit(1000),
  ]);
  if (work.error || bank.error) throw new Error("입금 확인 후속조치 자료를 읽지 못했습니다.");
  if ((bank.data?.length ?? 0) >= 1000 || (work.data?.length ?? 0) >= 200) throw new Error("입금 확인 범위를 초과했습니다.");
  const items = work.data ?? [];
  const ids = [...new Set(items.map(row => String(row.payload?.business_key ?? "")).filter(id => /^\d{6}-\d{3}$/.test(id)))];
  const accounts = new Map((await paymentBalances(ids, db)).map(row => [row.trade_id, row]));
  let confirmed = 0, candidates = 0;
  for (const item of items) {
    const previous = item.payload?.bank_receipt_review;
    const plan = planBankPaymentFollowup(item, accounts.get(item.payload?.business_key) ?? {}, bank.data ?? [])
      ?? (previous?.state === "candidate" ? { ...previous, state: "review", receiptIds: [], amount: null,
        reason: "현재 연결할 입금 원본을 하나로 좁히지 못했습니다. 수납 내역 재확인 필요" } : null);
    if (!plan) continue;
    const evidence = { ...plan, kind: "bank_receipt_recheck" };
    if (previous && previous.state === plan.state && previous.tradeId === plan.tradeId && previous.payer === plan.payer &&
        previous.amount === plan.amount && previous.reason === plan.reason &&
        JSON.stringify(previous.receiptIds) === JSON.stringify(plan.receiptIds)) continue;
    const isConfirmed = plan.state === "confirmed";
    if (!dryRun) {
      const detail = isConfirmed
        ? `입금 원본과 장부 반영을 확인했습니다. 수납액 ${formatMoney(plan.amount)}, 잔액 0원.`
        : plan.state === "candidate" ? `${plan.payer} 명의 ${formatMoney(plan.amount)} 입금 원본을 찾았습니다. ${plan.reason}.` : plan.reason;
      const payload = { ...item.payload, bank_receipt_review: evidence, owner_problem_summary: detail,
        owner_next_action_summary: isConfirmed ? "수납 상태 확인 완료" : plan.reason };
      const result = await db.schema("public").from("work_items_v2").update({
        summary: detail, payload, version: item.version + 1, updated_at: new Date().toISOString(),
        ...(isConfirmed ? { state: "resolved", automation_state: "succeeded", resolution_kind: "bank_receipt_verified",
          resolution_evidence: evidence, resolved_at: new Date().toISOString(), resolved_by: "automation", snoozed_until: null } : {}),
      }).eq("id", item.id).eq("version", item.version).in("state", ACTIVE).select("id").maybeSingle();
      if (result.error) throw new Error("입금 확인 후속조치를 갱신하지 못했습니다.");
      if (!result.data) continue;
    }
    if (isConfirmed) confirmed++;
    else candidates++;
  }
  return { checked: items.length, confirmed, candidates, dryRun };
}
