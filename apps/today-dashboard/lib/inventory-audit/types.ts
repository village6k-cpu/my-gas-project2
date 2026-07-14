export interface CountBuckets {
  countNormal: number;
  countMaintenance: number;
  countDamaged: number;
  countConditionUnknown: number;
}

export type IdentificationStatus = "confirmed" | "uncertain" | "unlisted";

export type RentalMatchStatus =
  | "matched"
  | "ambiguous"
  | "unmatched"
  | "none";

export interface AuditObservation extends CountBuckets {
  id: string;
  equipmentId: string | null;
  temporaryCode: string | null;
  location: string;
  missingComponents: string[];
  note: string;
  identificationStatus: IdentificationStatus;
}

export interface SnapshotItem {
  equipmentId: string;
  ledgerStockTotal: number;
  ledgerStockMaintenance: number;
  ledgerState: string;
  ledgerOpenIssues: unknown[];
  ledgerUpdatedAt: string;
  activeRentalQty: number;
  rentalMatchStatus: RentalMatchStatus;
}

export type AuditDecisionKind = "apply_audit" | "keep_ledger" | "recount";

export type AuditResolution =
  | "existing_equipment"
  | "create_equipment"
  | "not_inventory";

export interface AuditDecision {
  decision?: AuditDecisionKind;
  resolution?: AuditResolution | null;
  finalStockTotal?: number | null;
  finalStockMaintenance?: number | null;
  finalState?: string | null;
  finalOpenIssues?: unknown[];
  otherConfirmedOffsiteQty?: number;
  reviewNote?: string;
}

export interface LedgerVersion {
  updatedAt: string;
}

export interface LocationAggregate extends CountBuckets {
  physicalTotal: number;
  observationCount: number;
}

export interface ObservationAggregate {
  totals: CountBuckets;
  physicalTotal: number;
  observationCount: number;
  byLocation: Record<string, LocationAggregate>;
  missingComponents: string[];
  identificationStatuses: IdentificationStatus[];
}

export type ReconciliationClassification =
  | "match"
  | "quantity_difference"
  | "condition_or_component_issue"
  | "uncertain_or_unlisted"
  | "uncounted"
  | "ambiguous_rental";

export interface ReconciledItem {
  equipmentId: string;
  classification: ReconciliationClassification;
  physicalTotal: number | null;
  candidateTotal: number | null;
  matchedActiveRentalQty: number;
  otherConfirmedOffsiteQty: number;
  aggregate: ObservationAggregate;
}
