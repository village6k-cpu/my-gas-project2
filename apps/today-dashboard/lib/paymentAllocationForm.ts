export type Allocation = { tradeId: string; amount: number };
export type AllocationDraft = { tradeId: string; amount: string };

export function validateAllocationDraft(receiptAmount: number, rows: AllocationDraft[], previous: Allocation[], note: string) {
  const allocations: Allocation[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const tradeId = row.tradeId.trim();
    if (!tradeId) return { error: "연결할 예약을 선택해 주세요.", allocations, total: 0 };
    if (seen.has(tradeId)) return { error: "같은 예약은 한 번만 연결할 수 있습니다.", allocations, total: 0 };
    seen.add(tradeId);
    if (!/^\d+$/.test(row.amount.trim()) || !Number.isSafeInteger(Number(row.amount))) {
      return { error: "배분 금액은 0원 이상의 정수로 입력해 주세요.", allocations, total: 0 };
    }
    const amount = Number(row.amount);
    if (amount > 0) allocations.push({ tradeId, amount });
  }
  const total = allocations.reduce((sum, row) => sum + row.amount, 0);
  if (!Number.isSafeInteger(total) || total > receiptAmount) return { error: "배분 합계가 수납 금액을 초과합니다.", allocations, total };
  const reduced = previous.some((old) => (allocations.find((row) => row.tradeId === old.tradeId)?.amount || 0) < old.amount);
  if (reduced && !note.trim()) return { error: "기존 배분을 줄이거나 해제할 때는 정정 사유를 입력해 주세요.", allocations, total };
  if (!previous.length && !allocations.length) return { error: "연결할 예약과 배분 금액을 입력해 주세요.", allocations, total };
  return { error: "", allocations, total };
}

export function isCancelledReceipt(status: string) {
  return /cancel|void|refund|취소|환불/i.test(status);
}

export function suggestedAllocation(receiptRemaining: number, tradeBalance: number) {
  return Math.max(0, Math.min(receiptRemaining, tradeBalance));
}

export function validateOpeningBalance(value: string, note: string, revision: number) {
  if (!/^\d+$/.test(value.trim()) || !Number.isSafeInteger(Number(value))) return { error: "기존 수납 금액은 0원 이상의 정수로 입력해 주세요.", amount: 0 };
  if (note.trim().length < 5) return { error: "확인 근거 또는 정정 사유를 5자 이상 입력해 주세요.", amount: Number(value) };
  if (!Number.isSafeInteger(revision) || revision < 1) return { error: "예약의 최신 기준을 다시 불러와 주세요.", amount: Number(value) };
  return { error: "", amount: Number(value) };
}

export function allocationBalanceError(allocations: Allocation[], previous: Allocation[], trades: { tradeId: string; billedAmount: number | null; paidAmount: number; reviewRequired: boolean }[]) {
  for (const allocation of allocations) {
    const trade = trades.find((value) => value.tradeId === allocation.tradeId);
    if (!trade) return "연결할 예약의 잔액을 확인할 수 없습니다. 상단 검색을 비우고 최신 내역을 불러와 주세요.";
    if (trade.reviewRequired) return "기존 수납 기준 확인이 필요한 예약입니다. 먼저 아래 예약별 잔액에서 기준을 확인해 주세요.";
    if (trade.billedAmount === null) return "청구 금액이 확인되지 않은 예약은 연결할 수 없습니다.";
    const previousAmount = previous.find((value) => value.tradeId === allocation.tradeId)?.amount || 0;
    if (allocation.amount > Math.max(trade.billedAmount - trade.paidAmount + previousAmount, 0)) {
      return "예약 잔액보다 많이 배분할 수 없습니다. 초과한 금액은 미배분으로 남겨 주세요.";
    }
  }
  return "";
}
