import { createHash, timingSafeEqual } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { gasPost } from "./gasPublic";
import { getVillageGasInternalKey } from "./gasInternalKey.mjs";

export const paymentLedgerEnabled = () => process.env.PAYMENT_LEDGER_ENABLED === "true";
export function validPaymentInternalKey(value: string | null) {
  if (!value) return false;
  const expected = getVillageGasInternalKey();
  return value.length === expected.length && timingSafeEqual(Buffer.from(value), Buffer.from(expected));
}
export function paymentDb() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("수납 서버 연결 설정이 없습니다.");
  return createClient(url, key, { db: { schema: "village" }, auth: { persistSession: false } });
}
type Row = Record<string, any>;
type Db = ReturnType<typeof paymentDb>;
function checked<T>(result: { data: T; error: { message: string } | null }): T {
  if (result.error) throw new Error(result.error.message);
  return result.data;
}
function keyFor(prefix: string, value: unknown) {
  return prefix + ":" + createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
export async function allPaymentRows(table: string, db = paymentDb()): Promise<Row[]> {
  const rows: Row[] = [];
  for (let offset = 0; offset < 50000; offset += 1000) {
    const data = checked(await db.from(table).select("*").order(table.includes("account") ? "trade_id" : "id").range(offset, offset + 999));
    rows.push(...(data ?? []));
    if (!data || data.length < 1000) return rows;
  }
  throw new Error("수납 조회 범위를 초과했습니다. 관리자 확인이 필요합니다.");
}
export async function refreshPaymentAccounts(tids?: string[], supplied?: Row[], db = paymentDb()) {
  let accounts = supplied;
  if (!accounts) {
    const result = await gasPost({ action: "paymentLedgerSnapshot", ...(tids ? { tids } : {}) }) as Row;
    if (result?.success !== true || !Array.isArray(result.accounts)) throw new Error(result?.error || "현재 청구액을 확인하지 못했습니다.");
    accounts = result.accounts;
  }
  if (!Array.isArray(accounts)) throw new Error("청구액 목록 오류");
  if (tids) {
    const observed = new Set(accounts.map(a => String(a.trade_id)));
    if (tids.some(id => !observed.has(id))) throw new Error("장부에서 예약을 찾지 못했습니다. 수납 관리에서 확인해주세요.");
  }
  checked(await db.rpc("payment_refresh_accounts", { p_accounts: accounts }));
  return accounts.map(a => String(a.trade_id));
}
export async function paymentBalances(tids?: string[], db = paymentDb()) {
  if (!tids) return allPaymentRows("payment_account_balances", db);
  if (!tids.length) return [];
  return checked(await db.from("payment_account_balances").select("*").in("trade_id", tids)) ?? [];
}
export function projectionItem(a: Row) {
  return { tradeId: a.trade_id, billedAmount: a.billed_amount, paidAmount: a.paid_amount,
    balance: a.balance, credit: a.credit, status: a.status, revision: a.revision,
    reviewRequired: a.review_required, method: a.payment_method === "카드" ? "카드결제" : null };
}
export async function acknowledgePaymentProjections(applied: Row[], rejected: Row[], db = paymentDb()) {
  for (const row of applied) {
    if (!row.tradeId || !Number.isSafeInteger(row.revision)) throw new Error("수납 반영 확인값 오류");
    checked(await db.from("payment_accounts").update({ projected_revision: row.revision, projection_error: null })
      .eq("trade_id", row.tradeId).eq("revision", row.revision));
  }
  for (const row of rejected) {
    checked(await db.from("payment_accounts").update({ projection_error: String(row.reason || "반영 대기") }).eq("trade_id", row.tradeId));
  }
}
export async function projectPaymentBalances(tids?: string[], db = paymentDb()) {
  const accounts = (await paymentBalances(tids, db)).filter(a => a.needs_projection && !a.review_required && a.billed_amount !== null && a.contract_status !== "취소" && a.contract_status !== "계약누락");
  if (!accounts.length) return [];
  const warnings: string[] = [];
  for (let offset = 0; offset < accounts.length; offset += 50) {
    const batch = accounts.slice(offset, offset + 50);
    try {
      const result = await gasPost({ action: "paymentLedgerProjection", items: batch.map(projectionItem) }) as Row;
      if (result?.success !== true || !Array.isArray(result.applied)) throw new Error(result?.error || "장부 반영 확인 실패");
      await acknowledgePaymentProjections(result.applied, result.rejected ?? [], db);
      for (const row of result.rejected ?? []) warnings.push(`${row.tradeId}: ${row.reason}`);
      // 직원 화면용 복사본에도 동일 잔액 상태를 반영한다. 동시 변경은 revision 재조회로 보호한다.
      for (const applied of result.applied) {
        const current = (await paymentBalances([applied.tradeId], db))[0];
        if (current?.revision === applied.revision) {
          checked(await db.from("trades").update({ deposit_status: current.status }).eq("trade_id", applied.tradeId));
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      warnings.push(message);
      await acknowledgePaymentProjections([], batch.map(a => ({ tradeId: a.trade_id, reason: message })), db);
      break; // 원본/배분은 커밋되어 있다. 실패는 다음 동기화에서 재시도한다.
    }
  }
  return warnings;
}
function normalizedName(value: unknown) { return String(value ?? "").replace(/[\s()㈜.\-_]/g, "").toLowerCase(); }
export function receiptCandidates(receipt: Row, accounts: Row[]) {
  const name = normalizedName(receipt.payer_name);
  const at = Date.parse(receipt.occurred_at);
  return accounts.filter(a => {
    if (a.review_required || a.billed_amount == null || a.balance <= 0 || ["취소", "계약누락"].includes(a.contract_status)) return false;
    if (receipt.source === "bank") {
      return [a.payer_name, a.customer_name].some(v => {
        const candidate = normalizedName(v);
        return candidate.length >= 2 && name.includes(candidate);
      });
    }
    const checkout = Date.parse(a.checkout_at ?? "");
    return a.balance === receipt.remaining_amount && Number.isFinite(checkout) && Math.abs(at - checkout) <= 2 * 86400000;
  });
}
export async function allocatePayment(input: Row, actor: string, allowOverpay = false, db = paymentDb()) {
  if (!Array.isArray(input.allocations) || typeof input.requestId !== "string" || !input.requestId.trim()) throw new Error("배분 요청 형식 오류");
  const allocations = input.allocations.map((a: Row) => ({ trade_id: String(a.tradeId ?? a.trade_id ?? "").trim(), amount: a.amount }));
  if (allocations.some((a: Row) => !a.trade_id || !Number.isSafeInteger(a.amount) || a.amount < 0)) throw new Error("배분 금액은 0원 이상의 정수여야 합니다.");
  const tids = [...new Set(allocations.map((a: Row) => a.trade_id))] as string[];
  // 제거된 연결의 상태도 갱신해야 한다.
  const before = checked(await db.from("payment_allocations").select("trade_id").eq("receipt_id", input.receiptId)) ?? [];
  const affected = [...new Set([...tids, ...before.map(a => String(a.trade_id))])];
  await refreshPaymentAccounts(affected, undefined, db);
  const result = checked(await db.rpc("payment_set_allocations", {
    p_receipt_id: input.receiptId, p_allocations: allocations,
    p_expected_revision: input.expectedRevision, p_request_id: input.requestId,
    p_actor: actor, p_note: String(input.note ?? ""), p_allow_overpay: allowOverpay,
  }));
  const syncWarnings = await projectPaymentBalances(affected, db);
  return { ...result, syncWarnings };
}
export function receiptTime(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    const d = new Date(value < 100000000000 ? value * 1000 : value);
    return Number.isFinite(d.getTime()) ? d.toISOString() : null;
  }
  let text = String(value ?? "").trim();
  if (/^\d{10}$|^\d{13}$/.test(text)) return receiptTime(Number(text));
  if (/^\d{14}$/.test(text)) text = `${text.slice(0,4)}-${text.slice(4,6)}-${text.slice(6,8)}T${text.slice(8,10)}:${text.slice(10,12)}:${text.slice(12,14)}+09:00`;
  if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d+)?$/.test(text)) text = text.replace(" ", "T") + "+09:00";
  const d = new Date(text);
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

/** 단말의 실제 승인 원본은 먼저 보존한다. 장부 반영 실패가 승인 원본을 지우지 않는다. */
export async function recordFrontPayment(input: Row) {
  const db = paymentDb();
  const sourceId = String(input.paymentKey ?? "").trim();
  if (!sourceId) throw new Error("결제 원본 키가 필요합니다.");
  const tradeId = String(input.tradeId ?? "").trim();
  const alias = checked(await db.from("payment_receipt_aliases").select("receipt_id,financial_identity").eq("source", "front").eq("source_id", sourceId).maybeSingle());
  const existing = alias ? checked(await db.from("payment_receipts").select("*").eq("id", alias.receipt_id).single()) as Row : null;
  const actualTime = receiptTime(input.timestamp) || receiptTime(alias?.financial_identity?.occurred_at);
  const result = await ingestPayment({ source: "front", sourceId, amount: input.paidAmount,
    occurredAt: actualTime || existing?.occurred_at || new Date().toISOString(),
    approvalNumber: input.approvalNumber || alias?.financial_identity?.approval_number || null,
    merchantId: input.merchantId || alias?.financial_identity?.merchant_id || null,
    payerName: input.customerName || "", status: input.cancelled ? "cancelled" : "active",
    reviewReason: actualTime ? null : "승인 시각 확인 필요",
    raw: { tradeId, approvalTimeEstimated: !actualTime },
  }, "front_terminal", { auto: false, project: false, refresh: false }, db);
  let receipt = result.receipt;
  if (input.cancelled) {
    const tids = (receipt.allocations ?? []).map((a: Row) => a.trade_id);
    if (!tids.length && tradeId && !tradeId.startsWith("manual-")) {
      await refreshPaymentAccounts([tradeId], undefined, db);
      const account = (await paymentBalances([tradeId], db))[0];
      if (account?.opening_paid > 0 && Date.parse(receipt.occurred_at) <= Date.parse(account.baseline_at)) {
        checked(await db.rpc("payment_require_review", { p_trade_id: tradeId,
          p_request_id: `historical-cancel:${receipt.id}:${tradeId}`,
          p_note: "전환 이전 카드 승인이 취소되었습니다. 기초 수납에 포함된 금액을 확인해주세요." }));
        return { ok: true, receiptId: receipt.id, pendingReview: true,
          syncWarnings: ["기존 카드 승인 취소: 수납 관리에서 기초 수납 확인이 필요합니다."] };
      }
    }
    return { ok: true, receiptId: receipt.id, syncWarnings: await projectPaymentBalances(tids, db) };
  }
  if (tradeId && !tradeId.startsWith("manual-") && !receipt.review_reason && receipt.status === "active") {
    const allocations = receipt.allocations ?? [];
    if (allocations.length === 0) {
      await allocatePayment({ receiptId: receipt.id, expectedRevision: receipt.revision,
        allocations: [{ tradeId, amount: receipt.amount }], requestId: `front:${sourceId}`,
        note: "단말에서 선택한 예약의 카드 승인 원본 연결" }, "front_terminal", true, db);
      receipt = checked(await db.from("payment_receipt_balances").select("*").eq("id", receipt.id).single()) as Row;
    } else if (!allocations.some((a: Row) => a.trade_id === tradeId)) {
      throw new Error("이 결제는 다른 예약에 연결되어 있습니다. 수납 관리에서 확인해주세요.");
    }
  }
  const tids = (receipt.allocations ?? []).map((a: Row) => a.trade_id);
  const syncWarnings = await projectPaymentBalances(tids, db);
  return { ok: true, receiptId: receipt.id, pendingReview: !!receipt.review_reason,
    allocatedAmount: receipt.allocated_amount, unallocatedAmount: receipt.remaining_amount, syncWarnings };
}

export async function getPayablePaymentBalances(tids: string[]) {
  const db = paymentDb();
  await refreshPaymentAccounts(tids, undefined, db);
  const accounts = await paymentBalances(tids, db);
  // 승인 저장 후 배분이 실패/대기한 예약은 다시 청구하지 않는다.
  const unresolved = checked(await db.from("payment_receipt_balances").select("explicit_trade_id,remaining_amount,status")
    .eq("status", "active").gt("remaining_amount", 0)) ?? [];
  const blocked = new Set(unresolved.map(r => r.explicit_trade_id).filter(Boolean));
  return accounts.filter(a => !blocked.has(a.trade_id) && !a.review_required && !["취소", "계약누락"].includes(a.contract_status) && Number.isSafeInteger(a.balance) && a.balance > 0);
}
export async function ingestPayment(input: Row, actor: string, options: { refresh?: boolean; project?: boolean; auto?: boolean } = {}, db = paymentDb()) {
  if (!["bank", "toss", "front"].includes(input.source) || !String(input.sourceId ?? "").trim()) throw new Error("수납 원본 ID가 필요합니다.");
  if (!Number.isSafeInteger(input.amount) || input.amount <= 0) throw new Error("수납액은 양수 정수여야 합니다.");
  const occurredAt = receiptTime(input.occurredAt);
  if (!occurredAt) throw new Error("승인/입금 시각을 확인할 수 없습니다.");
  const receipt = {
    source: input.source, source_id: String(input.sourceId).trim(), amount: input.amount,
    occurred_at: occurredAt, payer_name: String(input.payerName ?? ""),
    approval_number: input.approvalNumber || null, merchant_id: input.merchantId || null,
    status: input.status === "cancelled" ? "cancelled" : "active", raw: input.raw ?? {}, review_reason: input.reviewReason || null,
  };
  const result = checked(await db.rpc("payment_ingest_receipt", {
    p_receipt: receipt, p_request_id: keyFor("ingest", receipt), p_actor: actor,
  }));
  if (options.refresh !== false) await refreshPaymentAccounts(undefined, undefined, db);
  let stored = checked(await db.from("payment_receipt_balances").select("*").eq("id", result.receiptId).single()) as Row;
  const accounts = await paymentBalances(undefined, db);
  const cutover = Date.parse(process.env.PAYMENT_LEDGER_CUTOVER_AT ?? "");
  const newReceipt = Number.isFinite(cutover) && Date.parse(occurredAt) >= cutover;
  if (options.auto !== false && stored.source === "bank" && stored.revision === 1 && stored.status === "active" && !stored.review_reason && stored.allocated_amount === 0 && newReceipt) {
    const candidates = receiptCandidates(stored, accounts);
    if (candidates.length === 1 && stored.remaining_amount <= candidates[0].balance) {
      checked(await db.rpc("payment_set_allocations", {
        p_receipt_id: stored.id, p_allocations: [{ trade_id: candidates[0].trade_id, amount: stored.amount }],
        p_expected_revision: stored.revision, p_request_id: `auto:${stored.id}`,
        p_actor: "automatic_unique_candidate", p_note: "현재 잔액과 유일한 입금 후보 확인", p_allow_overpay: false,
      }));
      stored = checked(await db.from("payment_receipt_balances").select("*").eq("id", stored.id).single()) as Row;
    }
  }
  const tids = (stored.allocations ?? []).map((a: Row) => a.trade_id);
  const syncWarnings = options.project === false ? [] : await projectPaymentBalances(tids, db);
  return { success: true, receiptId: stored.id, revision: stored.revision,
    status: stored.status === "cancelled" ? "cancelled" : stored.remaining_amount === 0 ? "allocated" : "unmatched",
    duplicate: result.duplicate, reviewReason: stored.review_reason, syncWarnings, receipt: stored };
}
export async function getPaymentWorkspace(search = "", refresh = true) {
  const db = paymentDb();
  if (refresh) await refreshPaymentAccounts(undefined, undefined, db);
  const pending = (await paymentBalances(undefined, db)).filter(a => a.needs_projection).slice(0, 50).map(a => a.trade_id);
  const syncWarnings = await projectPaymentBalances(pending, db);
  const [accounts, receipts] = await Promise.all([paymentBalances(undefined, db), allPaymentRows("payment_receipt_balances", db)]);
  const needle = normalizedName(search);
  const trades = accounts.map(a => ({ tradeId: a.trade_id, customerName: a.customer_name || "", billedAmount: a.billed_amount,
    paidAmount: a.paid_amount, openingPaid: a.opening_paid, reviewRequired: a.review_required,
    balance: a.balance, credit: a.credit, status: a.status, revision: a.revision }));
  const filtered = receipts.filter(r => !needle || normalizedName([r.payer_name, r.source_id, ...(r.allocations ?? []).map((a: Row) => a.trade_id)].join(" ")).includes(needle) || receiptCandidates(r, accounts).some(a => normalizedName(a.trade_id + a.customer_name).includes(needle)));
  return {
    receipts: filtered.sort((a, b) => Date.parse(b.occurred_at) - Date.parse(a.occurred_at)).map(r => ({
      id: r.id, source: r.source, sourceId: r.source_id, amount: r.amount, allocatedAmount: r.allocated_amount,
      unallocatedAmount: r.remaining_amount, occurredAt: r.occurred_at, payerName: r.payer_name || "",
      status: r.status, revision: r.revision, reviewReason: r.review_reason,
      allocations: (r.allocations ?? []).map((a: Row) => ({ tradeId: a.trade_id, amount: a.amount })),
      candidates: receiptCandidates(r, accounts).map(a => a.trade_id),
    })), trades,
    counts: { unmatched: receipts.filter(r => r.status === "active" && r.remaining_amount > 0 && r.allocated_amount === 0).length,
      partial: receipts.filter(r => r.status === "active" && r.remaining_amount > 0 && r.allocated_amount > 0).length,
      credit: accounts.filter(a => a.credit > 0).length },
    syncWarnings: [...syncWarnings, ...accounts.filter(a => a.projection_error).map(a => `${a.trade_id}: ${a.projection_error}`)],
  };
}
