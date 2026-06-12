import type { Trade } from "../domain/types";

export function shouldRestoreMissingTimelineEquipments(existing: Trade, timeline: Trade): boolean {
  return existing.equipments.length === 0 && timeline.equipments.length > 0;
}

export function mergeTimelineTradeSnapshot(existing: Trade, timeline: Trade): Trade {
  const restoreEquipments = shouldRestoreMissingTimelineEquipments(existing, timeline);

  return {
    ...existing,
    checkoutAt: timeline.checkoutAt,
    returnAt: timeline.returnAt,
    customerName: timeline.customerName,
    customerPhone: timeline.customerPhone || existing.customerPhone,
    amount: existing.amount ?? timeline.amount, // 기존 값(거래내역 실 결제금액) 우선 — 타임라인 단가합으로 덮어쓰지 않음
    equipments: restoreEquipments ? timeline.equipments : existing.equipments,
  };
}
