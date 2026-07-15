type FinalCountInput = {
  finalStockTotal?: unknown;
  finalStockMaintenance?: unknown;
};

export type InventoryAuditFinalCounts = {
  finalStockTotal: number;
  finalStockMaintenance: number;
};

function invalidCount(message: string): never {
  const error = new Error(message) as Error & { code: string };
  error.code = "22023";
  throw error;
}

function nonNegativeInteger(value: unknown, label: string): number {
  const parsed =
    typeof value === "string" && /^\d+$/.test(value.trim())
      ? Number(value.trim())
      : value;
  if (typeof parsed !== "number" || !Number.isSafeInteger(parsed) || parsed < 0) {
    invalidCount(`${label}은 0 이상의 정수로 입력해 주세요.`);
  }
  return parsed;
}

export function resolveInventoryAuditFinalCounts(
  input: FinalCountInput,
  fallback: FinalCountInput,
): InventoryAuditFinalCounts {
  const finalStockTotal = nonNegativeInteger(
    input.finalStockTotal ?? fallback.finalStockTotal,
    "최종 총수량",
  );
  const finalStockMaintenance = nonNegativeInteger(
    input.finalStockMaintenance ?? fallback.finalStockMaintenance,
    "정비수량",
  );
  if (finalStockMaintenance > finalStockTotal) {
    invalidCount("정비수량은 최종 총수량보다 클 수 없습니다.");
  }
  return { finalStockTotal, finalStockMaintenance };
}
