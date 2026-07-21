import type { EquipmentItem } from "./types";

/** 화면·반납 검수·재고 점유에서 사용할 현재 사실. 예약 원본은 별도 필드에 보존된다. */
export function equipmentActualName(item: EquipmentItem): string {
  return String(item.actualName || item.name || "").trim();
}

/** null/undefined만 미지정이다. 0은 "실제로 가져가지 않음"이라는 유효한 정정값이다. */
export function equipmentActualTakenQty(item: EquipmentItem): number {
  const value = item.actualTakenQty ?? item.takenQty ?? item.qty;
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.floor(number)) : 0;
}

export function hasEquipmentActualCorrection(item: EquipmentItem): boolean {
  return item.actualName != null || item.actualTakenQty != null;
}
