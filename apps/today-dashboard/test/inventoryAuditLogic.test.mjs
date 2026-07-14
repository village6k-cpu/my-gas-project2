import assert from "node:assert/strict";
import test from "node:test";

import {
  aggregateObservations,
  hasLedgerConflict,
  observationTotal,
  reconcileItem,
} from "../lib/inventory-audit/logic.ts";

const snapshot = {
  equipmentId: "CAM-001",
  ledgerStockTotal: 4,
  ledgerStockMaintenance: 0,
  ledgerState: "active",
  ledgerOpenIssues: [],
  ledgerUpdatedAt: "2026-07-14T09:00:00.000Z",
  activeRentalQty: 2,
  rentalMatchStatus: "matched",
};

function observation(overrides = {}) {
  return {
    id: "obs-1",
    equipmentId: "CAM-001",
    temporaryCode: null,
    location: "A 선반",
    countNormal: 0,
    countMaintenance: 0,
    countDamaged: 0,
    countConditionUnknown: 0,
    missingComponents: [],
    note: "",
    identificationStatus: "confirmed",
    ...overrides,
  };
}

test("observation total sums each mutually exclusive count bucket once", () => {
  assert.equal(
    observationTotal({
      countNormal: 2,
      countMaintenance: 1,
      countDamaged: 3,
      countConditionUnknown: 4,
    }),
    10,
  );
});

test("observations aggregate by location and across the item", () => {
  const aggregate = aggregateObservations([
    observation({ id: "obs-a1", countNormal: 2 }),
    observation({ id: "obs-a2", countMaintenance: 1 }),
    observation({
      id: "obs-b1",
      location: "B 선반",
      countDamaged: 1,
      countConditionUnknown: 2,
    }),
  ]);

  assert.deepEqual(aggregate.totals, {
    countNormal: 2,
    countMaintenance: 1,
    countDamaged: 1,
    countConditionUnknown: 2,
  });
  assert.deepEqual(aggregate.byLocation["A 선반"], {
    countNormal: 2,
    countMaintenance: 1,
    countDamaged: 0,
    countConditionUnknown: 0,
    physicalTotal: 3,
    observationCount: 2,
  });
  assert.deepEqual(aggregate.byLocation["B 선반"], {
    countNormal: 0,
    countMaintenance: 0,
    countDamaged: 1,
    countConditionUnknown: 2,
    physicalTotal: 3,
    observationCount: 1,
  });
  assert.equal(aggregate.physicalTotal, 6);
  assert.equal(aggregate.observationCount, 3);
});

test("explicit zero is counted while no observation is uncounted", () => {
  const uncounted = reconcileItem(snapshot, []);
  const explicitZero = reconcileItem(snapshot, [observation()]);

  assert.equal(uncounted.classification, "uncounted");
  assert.equal(uncounted.physicalTotal, null);
  assert.equal(uncounted.candidateTotal, null);
  assert.equal(explicitZero.physicalTotal, 0);
  assert.equal(explicitZero.candidateTotal, 2);
});

test("candidate total includes only matched rentals and owner-confirmed offsite stock", () => {
  const counted = [observation({ countNormal: 2 })];
  const ownerDecision = { otherConfirmedOffsiteQty: 1 };

  assert.equal(
    reconcileItem(
      { ...snapshot, activeRentalQty: 3, rentalMatchStatus: "matched" },
      counted,
      ownerDecision,
    ).candidateTotal,
    6,
  );
  assert.equal(
    reconcileItem(
      { ...snapshot, activeRentalQty: 3, rentalMatchStatus: "ambiguous" },
      counted,
      ownerDecision,
    ).candidateTotal,
    3,
  );
  assert.equal(
    reconcileItem(
      { ...snapshot, activeRentalQty: 3, rentalMatchStatus: "unmatched" },
      counted,
      ownerDecision,
    ).candidateTotal,
    3,
  );
});

test("maintenance stock contributes to candidate total only once", () => {
  const result = reconcileItem(
    { ...snapshot, ledgerStockTotal: 5, activeRentalQty: 3 },
    [observation({ countNormal: 1, countMaintenance: 1 })],
  );

  assert.equal(result.physicalTotal, 2);
  assert.equal(result.candidateTotal, 5);
});

test("reconciliation classifies matching and quantity-difference items", () => {
  assert.equal(
    reconcileItem(snapshot, [observation({ countNormal: 2 })]).classification,
    "match",
  );
  assert.equal(
    reconcileItem(
      { ...snapshot, ledgerStockTotal: 5 },
      [observation({ countNormal: 2 })],
    ).classification,
    "quantity_difference",
  );
});

test("condition counts and missing components are classified as issues", () => {
  assert.equal(
    reconcileItem(snapshot, [
      observation({ countNormal: 1, countMaintenance: 1 }),
    ]).classification,
    "condition_or_component_issue",
  );
  assert.equal(
    reconcileItem(snapshot, [
      observation({ countNormal: 2, missingComponents: ["바디캡"] }),
    ]).classification,
    "condition_or_component_issue",
  );
});

test("uncertain and unlisted observations are classified before quantity comparison", () => {
  for (const identificationStatus of ["uncertain", "unlisted"]) {
    assert.equal(
      reconcileItem(snapshot, [
        observation({
          equipmentId: identificationStatus === "unlisted" ? null : "CAM-001",
          temporaryCode: "TMP-001",
          identificationStatus,
          countNormal: 1,
        }),
      ]).classification,
      "uncertain_or_unlisted",
    );
  }
});

test("ambiguous and unmatched rental snapshots require rental review", () => {
  const counted = [observation({ countNormal: 2 })];

  for (const rentalMatchStatus of ["ambiguous", "unmatched"]) {
    assert.equal(
      reconcileItem(
        { ...snapshot, rentalMatchStatus },
        counted,
      ).classification,
      "ambiguous_rental",
    );
  }
});

test("ledger conflict is based on the cutoff ledger version", () => {
  assert.equal(
    hasLedgerConflict(snapshot, {
      updatedAt: "2026-07-14T09:00:00.000Z",
    }),
    false,
  );
  assert.equal(
    hasLedgerConflict(snapshot, {
      updatedAt: "2026-07-14T09:01:00.000Z",
    }),
    true,
  );
});
