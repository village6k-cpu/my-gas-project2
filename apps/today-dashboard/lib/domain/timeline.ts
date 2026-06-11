// 빌리지 스케줄 타임라인 데이터 — 기존 docs/timeline.html 구조 재현.
// 행 = 예약 막대 1줄. 그룹(세트별/고객별/상태별) 헤더 아래로 쌓임.
import type { Trade } from "./types";
import { stockOf } from "./catalog";

export type GroupMode = "set" | "customer" | "status";
export type StatusKey = "대기" | "반출중" | "반납완료" | "취소" | "기타";

export interface TLItem {
  id: string;
  tradeId: string;
  scheduleId: string;
  contractUrl?: string | null;
  label: string; // 막대 텍스트 (세트명/장비명)
  custName: string;
  status: string;
  statusKey: StatusKey;
  qty: number;
  stock: number;
  category?: string;
  startMs: number; // 자정 절단 ms
  endMs: number;
  checkoutAt: string;
  returnAt: string;
}

export interface TLGroup {
  key: string;
  items: TLItem[];
}

export const DAY = 86400000;

export function dateOnlyMs(iso: string): number {
  const d = new Date(iso);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}
export function daysBetween(aMs: number, bMs: number): number {
  return Math.round((bMs - aMs) / DAY);
}

export function statusKeyOf(status: string): StatusKey {
  if (status === "예약") return "대기";
  if (status === "반출") return "반출중";
  if (status === "반납완료") return "반납완료";
  if (status === "취소") return "취소";
  return "기타";
}

// 상태별 막대 색 (대기 파랑 / 반출중 앰버 / 반납완료 초록 / 취소 회색 / 기타 보라)
// tailwind.config의 checkout/warn/checkin 시맨틱 팔레트와 같은 웜톤 계열 (홈페이지 크림 바탕에 맞춤)
export function statusBar(k: StatusKey): { bar: string; strike?: boolean } {
  switch (k) {
    case "대기":
      return { bar: "bg-[#D8E4F2] text-[#3A6195]" };
    case "반출중":
      return { bar: "bg-[#F2E3BF] text-[#8A6618]" };
    case "반납완료":
      return { bar: "bg-[#DBE7D5] text-[#44703E]" };
    case "취소":
      return { bar: "bg-[#EAE8E3] text-[#8B877E]", strike: true };
    default:
      return { bar: "bg-[#E8E1ED] text-[#6F5990]" };
  }
}

export function buildItems(trades: Trade[]): TLItem[] {
  const out: TLItem[] = [];
  for (const t of trades) {
    if (t.contractStatus === "취소") continue; // 취소 거래는 점유/충돌 계산에서 제외
    for (const e of t.equipments) {
      if (e.isComponent) continue; // 세트 구성품은 세트 막대에 포함
      if (e.checkoutState === "excluded") continue;
      const co = new Date(t.checkoutAt).getTime() + (e.startShiftDays ?? 0) * DAY;
      const ro = new Date(t.returnAt).getTime() + (e.endShiftDays ?? 0) * DAY;
      out.push({
        id: `${t.tradeId}__${e.scheduleId}`,
        tradeId: t.tradeId,
        scheduleId: e.scheduleId,
        contractUrl: t.contractUrl,
        label: e.name,
        custName: t.customerName,
        status: t.contractStatus,
        statusKey: statusKeyOf(t.contractStatus),
        qty: e.isSetHeader ? 1 : e.takenQty ?? e.qty,
        stock: stockOf(e.category),
        category: e.category,
        startMs: dateOnlyMs(new Date(co).toISOString()),
        endMs: dateOnlyMs(new Date(ro).toISOString()),
        checkoutAt: new Date(co).toISOString(),
        returnAt: new Date(ro).toISOString(),
      });
    }
  }
  return out;
}

export function groupItems(items: TLItem[], mode: GroupMode, search: string): TLGroup[] {
  const q = search.trim().toLowerCase();
  const filtered = q
    ? items.filter(
        (it) =>
          it.custName.toLowerCase().includes(q) ||
          it.label.toLowerCase().includes(q) ||
          it.tradeId.toLowerCase().includes(q) ||
          it.status.toLowerCase().includes(q),
      )
    : items;

  const map = new Map<string, TLItem[]>();
  for (const it of filtered) {
    const key = mode === "set" ? it.label : mode === "customer" ? it.custName || "미지정" : it.statusKey;
    (map.get(key) ?? map.set(key, []).get(key)!).push(it);
  }
  const keys = [...map.keys()].sort((a, b) => a.localeCompare(b, "ko"));
  return keys.map((key) => ({ key, items: map.get(key)!.sort((a, b) => a.startMs - b.startMs) }));
}

// 일별 매출 (거래 단가를 예약일수로 분배해 합산)
export function revenueByDay(trades: Trade[], rangeStartMs: number, days: number): number[] {
  const arr = new Array<number>(days).fill(0);
  for (const t of trades) {
    if (t.contractStatus === "취소" || !t.amount) continue;
    const co = dateOnlyMs(t.checkoutAt);
    const ro = dateOnlyMs(t.returnAt);
    const rentalDays = Math.max(1, daysBetween(co, ro) + 1);
    const daily = t.amount / rentalDays;
    for (let d = co; d <= ro; d += DAY) {
      const i = daysBetween(rangeStartMs, d);
      if (i >= 0 && i < days) arr[i] += daily;
    }
  }
  return arr;
}

// 충돌: 같은 장비를 같은 날 동시 점유 합이 재고 초과 → 그 막대들 id
export function computeConflicts(items: TLItem[]): Set<string> {
  const conflict = new Set<string>();
  const byEquip = new Map<string, TLItem[]>();
  for (const it of items) {
    if (it.statusKey === "취소") continue;
    (byEquip.get(it.label) ?? byEquip.set(it.label, []).get(it.label)!).push(it);
  }
  for (const list of byEquip.values()) {
    if (list.length < 2) continue;
    const stock = list[0].stock;
    const points = new Set(list.map((it) => it.startMs));
    for (const day of points) {
      let sum = 0;
      const active: TLItem[] = [];
      for (const it of list)
        if (it.startMs <= day && it.endMs >= day) {
          sum += it.qty;
          active.push(it);
        }
      if (sum > stock) active.forEach((it) => conflict.add(it.id));
    }
  }
  return conflict;
}

