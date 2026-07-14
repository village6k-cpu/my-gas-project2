export type RentalMatchStatus = "matched" | "ambiguous";

export interface RentalLedgerRow {
  equipment_id: string;
  name: string;
  aliases?: unknown;
  state?: string | null;
}

export interface RentalTradeRow {
  trade_id: string;
  contract_status?: string | null;
  return_done?: boolean | null;
}

export interface RentalScheduleItemRow {
  schedule_id: string;
  trade_id: string;
  name?: string | null;
  qty?: number | null;
  taken_qty?: number | null;
  is_set_header?: boolean | null;
  is_component?: boolean | null;
  off_catalog?: boolean | null;
  onsite?: boolean | null;
  checkout_state?: string | null;
}

export interface RentalSnapshotRef {
  trade_id: string;
  schedule_id: string;
  name: string;
  quantity: number;
}

export interface RentalSnapshot {
  equipment_id: string;
  active_rental_qty: number;
  active_rental_refs: RentalSnapshotRef[];
  rental_match_status: RentalMatchStatus;
}

export type RentalSnapshotExceptionReason =
  | "ambiguous_name"
  | "unmatched_name"
  | "conflicting_checkout_evidence"
  | "invalid_quantity";

export interface RentalSnapshotException {
  trade_id: string;
  schedule_id: string;
  raw_name: string;
  normalized_name: string;
  reported_qty: number;
  reason: RentalSnapshotExceptionReason;
  candidate_equipment_ids: string[];
  source_ref: {
    trade_id: string;
    schedule_id: string;
    raw_name: string | null;
    booked_qty: number | null;
    taken_qty: number | null;
    checkout_state: string | null;
    is_component: boolean;
  };
}

export interface RentalSnapshotResult {
  byEquipment: Map<string, RentalSnapshot>;
  exceptions: RentalSnapshotException[];
}

const POSTGRES_INTEGER_MAX = 2_147_483_647;
const MISSING_NAME = "(장비명 없음)";

export function normalizeRentalName(value: unknown): string {
  return typeof value === "string"
    ? value.trim().toLowerCase().replace(/\s+/g, " ")
    : "";
}

function normalizedStatus(value: unknown): string {
  return normalizeRentalName(value).replace(/\s+/g, "");
}

function isActiveLedgerRow(row: RentalLedgerRow): boolean {
  return (
    String(row.equipment_id ?? "").trim() !== "" &&
    String(row.equipment_id).trim() !== "SYS-000" &&
    normalizedStatus(row.state) !== "보관종료"
  );
}

function isActiveTrade(row: RentalTradeRow): boolean {
  if (row.return_done === true) return false;
  const status = normalizedStatus(row.contract_status);
  return !new Set([
    "취소",
    "반납완료",
    "cancelled",
    "canceled",
    "returned",
    "return_done",
  ]).has(status);
}

function isPostgresInteger(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= POSTGRES_INTEGER_MAX
  );
}

function reportedQuantity(
  row: RentalScheduleItemRow,
  checkoutState: string,
): number {
  if (isPostgresInteger(row.taken_qty)) return row.taken_qty;
  if (checkoutState === "taken" && isPostgresInteger(row.qty)) return row.qty;
  return 0;
}

function sourceReference(row: RentalScheduleItemRow) {
  return {
    trade_id: String(row.trade_id ?? "").trim(),
    schedule_id: String(row.schedule_id ?? "").trim(),
    raw_name: typeof row.name === "string" ? row.name : null,
    booked_qty: typeof row.qty === "number" ? row.qty : null,
    taken_qty: typeof row.taken_qty === "number" ? row.taken_qty : null,
    checkout_state:
      typeof row.checkout_state === "string" ? row.checkout_state : null,
    is_component: row.is_component === true,
  };
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function buildRentalSnapshot(
  ledgerRows: RentalLedgerRow[],
  trades: RentalTradeRow[],
  scheduleItems: RentalScheduleItemRow[],
): RentalSnapshotResult {
  const activeLedger = [...ledgerRows]
    .filter(isActiveLedgerRow)
    .sort((left, right) =>
      compareText(
        String(left.equipment_id).trim(),
        String(right.equipment_id).trim(),
      ),
    );
  const nameIndex = new Map<string, Set<string>>();

  for (const row of activeLedger) {
    const equipmentId = String(row.equipment_id).trim();
    const names = [row.name];
    if (Array.isArray(row.aliases)) names.push(...row.aliases);
    for (const value of names) {
      const normalized = normalizeRentalName(value);
      if (!normalized) continue;
      const matches = nameIndex.get(normalized) ?? new Set<string>();
      matches.add(equipmentId);
      nameIndex.set(normalized, matches);
    }
  }

  const activeTradeIds = new Set(
    trades
      .filter(isActiveTrade)
      .map((row) => String(row.trade_id ?? "").trim())
      .filter(Boolean),
  );
  const totals = new Map<
    string,
    { quantity: number; refs: RentalSnapshotRef[] }
  >();
  const conservativeEquipment = new Set<string>();
  const exceptions: RentalSnapshotException[] = [];

  const sortedItems = [...scheduleItems].sort((left, right) => {
    const tradeOrder = compareText(
      String(left.trade_id ?? "").trim(),
      String(right.trade_id ?? "").trim(),
    );
    return tradeOrder !== 0
      ? tradeOrder
      : compareText(
          String(left.schedule_id ?? "").trim(),
          String(right.schedule_id ?? "").trim(),
        );
  });

  for (const row of sortedItems) {
    const tradeId = String(row.trade_id ?? "").trim();
    const scheduleId = String(row.schedule_id ?? "").trim();
    if (!activeTradeIds.has(tradeId) || !scheduleId) continue;
    if (
      row.is_set_header === true ||
      row.off_catalog === true ||
      row.onsite === true
    ) {
      continue;
    }

    const checkoutState = normalizeRentalName(row.checkout_state);
    if (checkoutState === "excluded") continue;
    const hasPositiveTakenQuantity =
      typeof row.taken_qty === "number" && row.taken_qty > 0;
    if (checkoutState !== "taken" && !hasPositiveTakenQuantity) continue;

    const rawName =
      typeof row.name === "string" && row.name.trim() ? row.name.trim() : MISSING_NAME;
    const normalizedName = normalizeRentalName(rawName) || normalizeRentalName(MISSING_NAME);
    const candidates = [...(nameIndex.get(normalizedName) ?? new Set<string>())].sort(
      compareText,
    );
    const bookedQuantityValid =
      isPostgresInteger(row.qty) && row.qty > 0;
    const hasTakenQuantity = row.taken_qty !== null && row.taken_qty !== undefined;
    const takenQuantityValid =
      !hasTakenQuantity ||
      (isPostgresInteger(row.taken_qty) &&
        row.taken_qty > 0 &&
        bookedQuantityValid &&
        row.taken_qty <= row.qty!);

    let exceptionReason: RentalSnapshotExceptionReason | null = null;
    if (checkoutState === "taken" && hasTakenQuantity && row.taken_qty === 0) {
      exceptionReason = "conflicting_checkout_evidence";
    } else if (!bookedQuantityValid || !takenQuantityValid) {
      exceptionReason = "invalid_quantity";
    } else if (hasPositiveTakenQuantity && checkoutState !== "taken") {
      exceptionReason = "conflicting_checkout_evidence";
    } else if (candidates.length === 0) {
      exceptionReason = "unmatched_name";
    } else if (candidates.length > 1) {
      exceptionReason = "ambiguous_name";
    }

    if (exceptionReason) {
      for (const equipmentId of candidates) conservativeEquipment.add(equipmentId);
      exceptions.push({
        trade_id: tradeId,
        schedule_id: scheduleId,
        raw_name: rawName,
        normalized_name: normalizedName,
        reported_qty: reportedQuantity(row, checkoutState),
        reason: exceptionReason,
        candidate_equipment_ids: candidates,
        source_ref: sourceReference(row),
      });
      continue;
    }

    const equipmentId = candidates[0];
    const quantity = hasTakenQuantity ? (row.taken_qty as number) : (row.qty as number);
    const current = totals.get(equipmentId) ?? { quantity: 0, refs: [] };
    current.quantity += quantity;
    current.refs.push({
      trade_id: tradeId,
      schedule_id: scheduleId,
      name: rawName,
      quantity,
    });
    totals.set(equipmentId, current);
  }

  const equipmentIds = new Set<string>([
    ...totals.keys(),
    ...conservativeEquipment,
  ]);
  const byEquipment = new Map<string, RentalSnapshot>();
  for (const equipmentId of [...equipmentIds].sort(compareText)) {
    const total = totals.get(equipmentId) ?? { quantity: 0, refs: [] };
    total.refs.sort((left, right) => {
      const tradeOrder = compareText(left.trade_id, right.trade_id);
      return tradeOrder !== 0
        ? tradeOrder
        : compareText(left.schedule_id, right.schedule_id);
    });
    byEquipment.set(equipmentId, {
      equipment_id: equipmentId,
      active_rental_qty: total.quantity,
      active_rental_refs: total.refs,
      rental_match_status: conservativeEquipment.has(equipmentId)
        ? "ambiguous"
        : "matched",
    });
  }

  exceptions.sort((left, right) => {
    const tradeOrder = compareText(left.trade_id, right.trade_id);
    if (tradeOrder !== 0) return tradeOrder;
    const scheduleOrder = compareText(left.schedule_id, right.schedule_id);
    return scheduleOrder !== 0
      ? scheduleOrder
      : compareText(left.reason, right.reason);
  });

  return { byEquipment, exceptions };
}
