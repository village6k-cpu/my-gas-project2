import type { Phase } from "@/lib/domain/types";

// 반출/반납 메모 출처 태그 — 어느 카드에서 보든 "언제 적은 메모인지" 구분한다.
// 색은 카드 상태 배지와 동일 계열(반출=파랑, 반납=초록)로 통일.

export function memoPhaseLabel(phase: Phase): string {
  return phase === "checkout" ? "반출" : "반납";
}

export function MemoTag({ phase, shared = false, className = "" }: { phase: Phase; shared?: boolean; className?: string }) {
  const tone = shared
    ? "bg-line/40 text-ink-soft ring-line"
    : phase === "checkout"
      ? "bg-checkout-bg text-checkout-fg ring-checkout-ring"
      : "bg-checkin-bg text-checkin-fg ring-checkin-ring";
  return (
    <span className={`shrink-0 rounded px-1 py-0.5 text-[10px] font-bold ring-1 ${tone} ${className}`}>
      {shared ? "공통" : memoPhaseLabel(phase)}
    </span>
  );
}

export type ItemMemoEntry = { phase: Phase; text: string; shared?: boolean };

/**
 * 품목의 반출/반납 특이사항을 각각의 출처와 함께 돌려준다 (빈 메모 제외).
 * 예전 미러링 데이터(양쪽 텍스트 동일)는 출처를 알 수 없으므로 '공통' 하나로 합쳐 보여준다.
 */
export function itemMemoEntries(e: { memoCheckout?: string; memoCheckin?: string }): ItemMemoEntry[] {
  const checkout = String(e.memoCheckout || "").trim();
  const checkin = String(e.memoCheckin || "").trim();
  if (checkout && checkin && checkout === checkin) return [{ phase: "checkout", text: checkout, shared: true }];
  const entries: ItemMemoEntry[] = [];
  if (checkout) entries.push({ phase: "checkout", text: checkout });
  if (checkin) entries.push({ phase: "checkin", text: checkin });
  return entries;
}
