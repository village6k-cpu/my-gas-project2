import type {
  AuditDecision,
  AuditObservation,
  CountBuckets,
  IdentificationStatus,
  LedgerVersion,
  LocationAggregate,
  ObservationAggregate,
  ReconciledItem,
  ReconciliationClassification,
  SnapshotItem,
} from "./types";

const emptyBuckets = (): CountBuckets => ({
  countNormal: 0,
  countMaintenance: 0,
  countDamaged: 0,
  countConditionUnknown: 0,
});

const addBuckets = (target: CountBuckets, row: CountBuckets): void => {
  target.countNormal += row.countNormal;
  target.countMaintenance += row.countMaintenance;
  target.countDamaged += row.countDamaged;
  target.countConditionUnknown += row.countConditionUnknown;
};

export function observationTotal(row: CountBuckets): number {
  return (
    row.countNormal +
    row.countMaintenance +
    row.countDamaged +
    row.countConditionUnknown
  );
}

export function aggregateObservations(
  rows: AuditObservation[],
): ObservationAggregate {
  const totals = emptyBuckets();
  const locations = new Map<string, LocationAggregate>();
  const missingComponents = new Set<string>();
  const identificationStatuses = new Set<IdentificationStatus>();

  for (const row of rows) {
    addBuckets(totals, row);

    const location = locations.get(row.location) ?? {
      ...emptyBuckets(),
      physicalTotal: 0,
      observationCount: 0,
    };
    addBuckets(location, row);
    location.physicalTotal = observationTotal(location);
    location.observationCount += 1;
    locations.set(row.location, location);

    for (const component of row.missingComponents) {
      if (component.trim()) missingComponents.add(component);
    }
    identificationStatuses.add(row.identificationStatus);
  }

  return {
    totals,
    physicalTotal: observationTotal(totals),
    observationCount: rows.length,
    byLocation: Object.fromEntries(locations),
    missingComponents: [...missingComponents],
    identificationStatuses: [...identificationStatuses],
  };
}

function classifyCountedItem(
  snapshot: SnapshotItem,
  aggregate: ObservationAggregate,
  candidateTotal: number,
): ReconciliationClassification {
  if (
    aggregate.identificationStatuses.some((status) => status !== "confirmed")
  ) {
    return "uncertain_or_unlisted";
  }

  if (
    snapshot.rentalMatchStatus === "ambiguous" ||
    snapshot.rentalMatchStatus === "unmatched"
  ) {
    return "ambiguous_rental";
  }

  if (
    aggregate.totals.countMaintenance > 0 ||
    aggregate.totals.countDamaged > 0 ||
    aggregate.totals.countConditionUnknown > 0 ||
    aggregate.missingComponents.length > 0
  ) {
    return "condition_or_component_issue";
  }

  if (candidateTotal !== snapshot.ledgerStockTotal) {
    return "quantity_difference";
  }

  return "match";
}

export function reconcileItem(
  snapshot: SnapshotItem,
  rows: AuditObservation[],
  decision?: AuditDecision,
): ReconciledItem {
  const aggregate = aggregateObservations(rows);
  const matchedActiveRentalQty =
    snapshot.rentalMatchStatus === "matched" ? snapshot.activeRentalQty : 0;
  const otherConfirmedOffsiteQty = decision?.otherConfirmedOffsiteQty ?? 0;

  if (rows.length === 0) {
    return {
      equipmentId: snapshot.equipmentId,
      classification: "uncounted",
      physicalTotal: null,
      candidateTotal: null,
      matchedActiveRentalQty,
      otherConfirmedOffsiteQty,
      aggregate,
    };
  }

  const candidateTotal =
    aggregate.physicalTotal +
    matchedActiveRentalQty +
    otherConfirmedOffsiteQty;

  return {
    equipmentId: snapshot.equipmentId,
    classification: classifyCountedItem(
      snapshot,
      aggregate,
      candidateTotal,
    ),
    physicalTotal: aggregate.physicalTotal,
    candidateTotal,
    matchedActiveRentalQty,
    otherConfirmedOffsiteQty,
    aggregate,
  };
}

export function hasLedgerConflict(
  snapshot: SnapshotItem,
  current: LedgerVersion,
): boolean {
  return current.updatedAt !== snapshot.ledgerUpdatedAt;
}
