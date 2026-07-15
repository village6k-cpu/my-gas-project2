type DbRow = Record<string, unknown>;

export type InventoryAuditReviewDecision =
  | "apply_audit"
  | "keep_ledger"
  | "recount";

export type InventoryAuditReviewClassification =
  | "approved"
  | "match"
  | "quantity_difference"
  | "condition_or_component_issue"
  | "uncounted"
  | "ambiguous_rental";

export type InventoryAuditRentalGroup = {
  key: string;
  rawName: string;
  exceptionIds: string[];
  occurrenceCount: number;
  totalQty: number;
  resolution: "existing_equipment" | "not_inventory" | null;
  resolvedEquipmentId: string | null;
};

export type InventoryAuditReviewItem = {
  equipmentId: string;
  name: string;
  major: string | null;
  category: string | null;
  ledgerStockTotal: number | null;
  ledgerStockMaintenance: number;
  ledgerState: string;
  ledgerOpenIssues: unknown[];
  ledgerUpdatedAt: string;
  currentLedgerUpdatedAt: string;
  classification: InventoryAuditReviewClassification;
  physicalTotal: number | null;
  matchedActiveRentalQty: number;
  resolvedOffsiteQty: number;
  candidateTotal: number | null;
  finalStockMaintenance: number;
  finalState: string;
  finalOpenIssues: Array<{ label: string }>;
  locations: string[];
  defaultDecision: InventoryAuditReviewDecision;
  savedDecision: InventoryAuditReviewDecision | null;
  reviewNote: string;
  checkpointApprovedAt: string | null;
  checkpointApprovedByEmail: string | null;
};

export type InventoryAuditReview = {
  session: {
    id: string;
    status: string;
    startedByEmail: string;
  };
  summary: {
    total: number;
    counted: number;
    uncounted: number;
    matching: number;
    differences: number;
    issues: number;
    unresolvedRentalGroups: number;
    temporaryObservationCount: number;
    savedDecisionCount: number;
    checkpointApproved: number;
    checkpointReady: number;
    canCheckpoint: boolean;
    canApprove: boolean;
  };
  items: InventoryAuditReviewItem[];
  rentalGroups: InventoryAuditRentalGroup[];
};

function text(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function nullableText(value: unknown): string | null {
  const result = text(value).trim();
  return result || null;
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function nullableCount(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringList(value: unknown): string[] {
  return list(value).filter((entry): entry is string => typeof entry === "string");
}

export function groupRentalExceptions(
  rows: DbRow[],
): InventoryAuditRentalGroup[] {
  const groups = new Map<string, DbRow[]>();
  for (const row of rows) {
    const key = text(row.normalized_name) || text(row.raw_name) || text(row.id);
    const current = groups.get(key) ?? [];
    current.push(row);
    groups.set(key, current);
  }

  return [...groups.entries()]
    .map(([key, entries]) => {
      const resolutions = new Set(entries.map((row) => nullableText(row.resolution)));
      const equipmentIds = new Set(
        entries.map((row) => nullableText(row.resolved_equipment_id)),
      );
      const consistent = resolutions.size === 1 && equipmentIds.size === 1;
      const resolution = consistent
        ? (nullableText(entries[0]?.resolution) as InventoryAuditRentalGroup["resolution"])
        : null;
      return {
        key,
        rawName: text(entries[0]?.raw_name, key),
        exceptionIds: entries.map((row) => text(row.id)).filter(Boolean),
        occurrenceCount: entries.length,
        totalQty: entries.reduce((sum, row) => sum + count(row.reported_qty), 0),
        resolution,
        resolvedEquipmentId:
          consistent && resolution === "existing_equipment"
            ? nullableText(entries[0]?.resolved_equipment_id)
            : null,
      };
    })
    .sort((a, b) => a.rawName.localeCompare(b.rawName, "ko"));
}

function issueLabels(rows: DbRow[]): Array<{ label: string }> {
  const maintenance = rows.reduce((sum, row) => sum + count(row.count_maintenance), 0);
  const damaged = rows.reduce((sum, row) => sum + count(row.count_damaged), 0);
  const unknown = rows.reduce(
    (sum, row) => sum + count(row.count_condition_unknown),
    0,
  );
  const missing = new Set(
    rows.flatMap((row) => stringList(row.missing_components)).map((value) => value.trim()).filter(Boolean),
  );
  const notes = new Set(rows.map((row) => text(row.note).trim()).filter(Boolean));
  const labels: string[] = [];
  if (maintenance > 0) labels.push(`정비중 ${maintenance}개`);
  if (damaged > 0) labels.push(`파손·격리 ${damaged}개`);
  if (unknown > 0) labels.push(`상태 미확인 ${unknown}개`);
  if (missing.size > 0) labels.push(`누락 구성품: ${[...missing].join(", ")}`);
  for (const note of notes) labels.push(`실사 메모: ${note}`);
  return labels.map((label) => ({ label }));
}

function mergeOpenIssues(
  existingValue: unknown,
  auditIssues: Array<{ label: string }>,
): Array<{ label: string }> {
  const labels = new Set<string>();
  for (const issue of list(existingValue)) {
    if (!issue || typeof issue !== "object" || Array.isArray(issue)) continue;
    const label = text((issue as DbRow).label).trim();
    if (label) labels.add(label);
  }
  for (const issue of auditIssues) labels.add(issue.label);
  return [...labels].map((label) => ({ label }));
}

function classify(
  row: DbRow,
  observationRows: DbRow[],
  candidateTotal: number | null,
  issues: Array<{ label: string }>,
): InventoryAuditReviewClassification {
  if (observationRows.length === 0) return "uncounted";
  if (["ambiguous", "unmatched"].includes(text(row.rental_match_status))) {
    return "ambiguous_rental";
  }
  if (issues.length > 0) return "condition_or_component_issue";
  return candidateTotal === nullableCount(row.ledger_stock_total)
    ? "match"
    : "quantity_difference";
}

export function buildInventoryAuditReview(input: {
  session: DbRow;
  snapshotRows: DbRow[];
  observationRows: DbRow[];
  rentalExceptionRows: DbRow[];
  decisionRows: DbRow[];
  approvalRows?: DbRow[];
  ledgerRows: DbRow[];
}): InventoryAuditReview {
  const rentalGroups = groupRentalExceptions(input.rentalExceptionRows);
  const observationsByEquipment = new Map<string, DbRow[]>();
  for (const row of input.observationRows) {
    const equipmentId = nullableText(row.equipment_id);
    if (!equipmentId) continue;
    const current = observationsByEquipment.get(equipmentId) ?? [];
    current.push(row);
    observationsByEquipment.set(equipmentId, current);
  }

  const resolvedOffsite = new Map<string, number>();
  for (const row of input.rentalExceptionRows) {
    if (row.resolution !== "existing_equipment") continue;
    const equipmentId = nullableText(row.resolved_equipment_id);
    if (!equipmentId) continue;
    resolvedOffsite.set(
      equipmentId,
      (resolvedOffsite.get(equipmentId) ?? 0) + count(row.reported_qty),
    );
  }

  const decisions = new Map(
    input.decisionRows
      .map((row) => [nullableText(row.equipment_id), row] as const)
      .filter((entry): entry is [string, DbRow] => entry[0] !== null),
  );
  const ledgers = new Map(
    input.ledgerRows
      .map((row) => [nullableText(row.equipment_id), row] as const)
      .filter((entry): entry is [string, DbRow] => entry[0] !== null),
  );
  const approvals = new Map(
    (input.approvalRows ?? [])
      .map((row) => [nullableText(row.equipment_id), row] as const)
      .filter((entry): entry is [string, DbRow] => entry[0] !== null),
  );

  const items = input.snapshotRows.map((row): InventoryAuditReviewItem => {
    const equipmentId = text(row.equipment_id);
    const observations = observationsByEquipment.get(equipmentId) ?? [];
    const physicalTotal = observations.length
      ? observations.reduce(
          (sum, observation) =>
            sum +
            count(observation.count_normal) +
            count(observation.count_maintenance) +
            count(observation.count_damaged) +
            count(observation.count_condition_unknown),
          0,
        )
      : null;
    const matchedActiveRentalQty =
      row.rental_match_status === "matched" ? count(row.active_rental_qty) : 0;
    const resolvedOffsiteQty = resolvedOffsite.get(equipmentId) ?? 0;
    const candidateTotal =
      physicalTotal === null
        ? null
        : physicalTotal + matchedActiveRentalQty + resolvedOffsiteQty;
    const auditIssues = issueLabels(observations);
    const classification = classify(row, observations, candidateTotal, auditIssues);
    const finalOpenIssues = mergeOpenIssues(row.ledger_open_issues, auditIssues);
    const saved = decisions.get(equipmentId);
    const savedDecision = saved
      ? (nullableText(saved.decision) as InventoryAuditReviewDecision | null)
      : null;
    const finalStockMaintenance = observations.reduce(
      (sum, observation) =>
        sum +
        count(observation.count_maintenance) +
        count(observation.count_damaged) +
        count(observation.count_condition_unknown),
      0,
    );
    const currentLedgerUpdatedAt = text(
      ledgers.get(equipmentId)?.updated_at,
      text(row.ledger_updated_at),
    );
    const approval = approvals.get(equipmentId);
    const checkpointApprovedAt = nullableText(approval?.approved_at);

    return {
      equipmentId,
      name: text(row.name, equipmentId),
      major: nullableText(row.major),
      category: nullableText(row.category),
      ledgerStockTotal: nullableCount(row.ledger_stock_total),
      ledgerStockMaintenance: count(row.ledger_stock_maint),
      ledgerState: text(row.ledger_state, "정상"),
      ledgerOpenIssues: list(row.ledger_open_issues),
      ledgerUpdatedAt: text(row.ledger_updated_at),
      currentLedgerUpdatedAt,
      classification: checkpointApprovedAt ? "approved" : classification,
      physicalTotal,
      matchedActiveRentalQty,
      resolvedOffsiteQty,
      candidateTotal,
      finalStockMaintenance,
      finalState: text(row.ledger_state, "정상"),
      finalOpenIssues,
      locations: [...new Set(observations.map((observation) => text(observation.location)).filter(Boolean))],
      defaultDecision:
        checkpointApprovedAt
          ? "keep_ledger"
          : savedDecision ?? (classification === "uncounted" ? "keep_ledger" : "apply_audit"),
      savedDecision,
      reviewNote: text(saved?.review_note),
      checkpointApprovedAt,
      checkpointApprovedByEmail: nullableText(approval?.approved_by_email),
    };
  });

  const temporaryObservationCount = input.observationRows.filter(
    (row) => nullableText(row.equipment_id) === null,
  ).length;
  const unresolvedRentalGroups = rentalGroups.filter(
    (group) => group.resolution === null,
  ).length;
  const checkpointApproved = items.filter(
    (item) => item.checkpointApprovedAt !== null,
  ).length;
  const checkpointReady = items.filter(
    (item) => item.physicalTotal !== null && item.checkpointApprovedAt === null,
  ).length;

  return {
    session: {
      id: text(input.session.id),
      status: text(input.session.status),
      startedByEmail: text(input.session.started_by_email),
    },
    summary: {
      total: items.length,
      counted: items.filter((item) => item.classification !== "uncounted").length,
      uncounted: items.filter((item) => item.classification === "uncounted").length,
      matching: items.filter((item) => item.classification === "match").length,
      differences: items.filter((item) => item.classification === "quantity_difference").length,
      issues: items.filter((item) =>
        ["condition_or_component_issue", "ambiguous_rental"].includes(item.classification),
      ).length,
      unresolvedRentalGroups,
      temporaryObservationCount,
      savedDecisionCount: items.filter((item) => item.savedDecision !== null).length,
      checkpointApproved,
      checkpointReady,
      canCheckpoint:
        unresolvedRentalGroups === 0 &&
        temporaryObservationCount === 0 &&
        checkpointReady > 0 &&
        text(input.session.status) === "draft",
      canApprove:
        unresolvedRentalGroups === 0 &&
        temporaryObservationCount === 0 &&
        ["submitted", "in_review"].includes(text(input.session.status)),
    },
    items,
    rentalGroups,
  };
}
