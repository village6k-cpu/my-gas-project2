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
    amount: timeline.amount ?? existing.amount,
    equipments: restoreEquipments ? timeline.equipments : existing.equipments,
  };
}
