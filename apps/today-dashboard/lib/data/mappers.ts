// Trade/EquipmentItem ↔ Supabase row (snake_case) 매핑
import type { EquipmentItem, HandoverNote, PhotoMeta, ReturnCount, RiskWarning, Trade } from "../domain/types";

/* eslint-disable @typescript-eslint/no-explicit-any */

export function canonicalOnsiteScheduleId(scheduleId: string, tradeId?: string): string {
  let id = String(scheduleId || "").trim();
  if (!id) return id;
  const tradePrefix = tradeId ? `${tradeId}-` : "";
  if (tradePrefix && id.startsWith(`${tradePrefix}ONS-`)) id = id.slice(tradePrefix.length);
  id = id.replace(/^\d{6}-\d{3}-(ONS-\d+(?:__\d+)?)$/, "$1");
  return id.replace(/__\d+$/, "");
}

function escapeRegExpLiteral(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function isSheetBackedScheduleId(scheduleId: string, tradeId?: string): boolean {
  const id = String(scheduleId || "").trim();
  if (!id) return false;
  const rowSuffix = "\\d+(?:__\\d+)?";
  if (tradeId) return new RegExp(`^${escapeRegExpLiteral(tradeId)}-${rowSuffix}$`).test(id);
  return /^\d{6}-\d{3}-\d+(?:__\d+)?$/.test(id);
}

export function dedupeOnsiteItems(items: EquipmentItem[]): EquipmentItem[] {
  const out: EquipmentItem[] = [];
  const onsiteIndex = new Map<string, number>();
  for (const item of items) {
    if (!item.onsite) {
      out.push(item);
      continue;
    }
    const normalized = { ...item, scheduleId: canonicalOnsiteScheduleId(item.scheduleId) };
    const key = normalized.scheduleId;
    const existingIndex = onsiteIndex.get(key);
    if (existingIndex == null) {
      onsiteIndex.set(key, out.length);
      out.push(normalized);
      continue;
    }
    const existing = out[existingIndex];
    out[existingIndex] = {
      ...existing,
      ...normalized,
      scheduleId: existing.scheduleId,
      qty: Math.max(existing.qty || 1, normalized.qty || 1),
      takenQty: Math.max(existing.takenQty ?? 0, normalized.takenQty ?? 0) || undefined,
      checkoutState: existing.checkoutState === "taken" || normalized.checkoutState === "taken" ? "taken" : normalized.checkoutState,
      memoCheckout: normalized.memoCheckout ?? existing.memoCheckout,
      memoCheckin: normalized.memoCheckin ?? existing.memoCheckin,
    };
  }
  return out;
}

export function itemFromRow(r: any): EquipmentItem {
  return {
    scheduleId: r.onsite ? canonicalOnsiteScheduleId(r.schedule_id, r.trade_id) : r.schedule_id,
    name: r.name,
    qty: r.qty,
    takenQty: r.taken_qty ?? undefined,
    setName: r.set_name ?? undefined,
    isSetHeader: r.is_set_header || undefined,
    isComponent: r.is_component || undefined,
    emphasize: r.emphasize || undefined,
    category: r.category ?? undefined,
    offCatalog: r.off_catalog || undefined,
    onsite: r.onsite || undefined,
    settlement: r.settlement ?? undefined,
    checkoutState: r.checkout_state ?? "pending",
    startShiftDays: r.start_shift_days || undefined,
    endShiftDays: r.end_shift_days || undefined,
    memoCheckout: r.memo_checkout ?? undefined,
    memoCheckin: r.memo_checkin ?? undefined,
  };
}

export function itemToRow(e: EquipmentItem, tradeId: string, sort: number): any {
  const appScheduleId = e.onsite ? canonicalOnsiteScheduleId(e.scheduleId, tradeId) : e.scheduleId;
  const dbScheduleId = appScheduleId.startsWith(`${tradeId}-`) ? appScheduleId : `${tradeId}-${appScheduleId}`;
  return {
    schedule_id: dbScheduleId,
    trade_id: tradeId,
    sort,
    name: e.name,
    qty: e.qty,
    taken_qty: e.takenQty ?? null,
    set_name: e.setName ?? null,
    is_set_header: !!e.isSetHeader,
    is_component: !!e.isComponent,
    emphasize: !!e.emphasize,
    category: e.category ?? null,
    off_catalog: !!e.offCatalog,
    onsite: !!e.onsite,
    settlement: e.settlement ?? null,
    checkout_state: e.checkoutState,
    start_shift_days: e.startShiftDays ?? 0,
    end_shift_days: e.endShiftDays ?? 0,
    memo_checkout: e.memoCheckout ?? null,
    memo_checkin: e.memoCheckin ?? null,
  };
}

export function tradeFromRow(r: any, items: EquipmentItem[]): Trade {
  return {
    tradeId: r.trade_id,
    customerName: r.customer_name,
    customerPhone: r.customer_phone ?? "",
    company: r.company ?? undefined,
    checkoutAt: r.checkout_at,
    returnAt: r.return_at,
    contractStatus: r.contract_status,
    discountType: r.discount_type ?? undefined,
    setupDone: !!r.setup_done,
    setupDoneAt: r.setup_done_at ?? undefined,
    returnDone: !!r.return_done,
    returnDoneAt: r.return_done_at ?? undefined,
    paymentMethod: r.payment_method ?? undefined,
    paymentWarning: !!r.payment_warning,
    depositStatus: r.deposit_status ?? undefined,
    proofType: r.proof_type ?? undefined,
    issueStatus: r.issue_status ?? undefined,
    billingCompany: r.billing_company ?? undefined,
    amount: r.amount != null ? Number(r.amount) : undefined,
    contractUrl: r.contract_url ?? undefined,
    contractRegenPending: !!r.contract_regen_pending,
    estimateSent: !!r.estimate_sent,
    noteCheckout: r.note_checkout ?? undefined,
    noteCheckin: r.note_checkin ?? undefined,
    photos: (r.photos ?? []) as PhotoMeta[],
    riskWarnings: (r.risk_warnings ?? []) as RiskWarning[],
    returnCounts: (r.return_counts ?? {}) as Record<string, ReturnCount>,
    equipments: items,
  };
}

export function tradeToRow(t: Trade): any {
  return {
    trade_id: t.tradeId,
    customer_name: t.customerName,
    customer_phone: t.customerPhone ?? null,
    company: t.company ?? null,
    checkout_at: t.checkoutAt,
    return_at: t.returnAt,
    contract_status: t.contractStatus,
    discount_type: t.discountType ?? null,
    setup_done: t.setupDone,
    setup_done_at: t.setupDoneAt ?? null,
    return_done: t.returnDone,
    return_done_at: t.returnDoneAt ?? null,
    payment_method: t.paymentMethod ?? null,
    payment_warning: !!t.paymentWarning,
    deposit_status: t.depositStatus ?? null,
    proof_type: t.proofType ?? null,
    issue_status: t.issueStatus ?? null,
    billing_company: t.billingCompany ?? null,
    amount: t.amount ?? null,
    contract_url: t.contractUrl ?? null,
    contract_regen_pending: !!t.contractRegenPending,
    estimate_sent: !!t.estimateSent,
    note_checkout: t.noteCheckout ?? null,
    note_checkin: t.noteCheckin ?? null,
    photos: t.photos,
    risk_warnings: t.riskWarnings,
    return_counts: t.returnCounts ?? {},
  };
}

export function noteToRow(n: HandoverNote, position: number): any {
  return { id: n.id, position, body: n.body };
}
