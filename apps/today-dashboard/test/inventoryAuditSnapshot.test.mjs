import assert from "node:assert/strict";
import test from "node:test";

import {
  buildRentalSnapshot,
  normalizeRentalName,
} from "../lib/inventory-audit/snapshot.ts";

const ACTIVE_TRADE = {
  trade_id: "260714-001",
  contract_status: "반출",
  return_done: false,
};

const LEDGER = [
  {
    equipment_id: "CAM-001",
    name: " Sony   A7 IV ",
    aliases: ["A7IV", " a7iv ", "공용 별칭"],
    state: "정상",
  },
  {
    equipment_id: "CAM-002",
    name: "Canon R5",
    aliases: ["공용 별칭"],
    state: "정상",
  },
  {
    equipment_id: "OLD-001",
    name: "Archived Camera",
    aliases: ["보관 종료 별칭"],
    state: "보관종료",
  },
  {
    equipment_id: "SYS-000",
    name: "시스템 행",
    aliases: ["system"],
    state: "정상",
  },
];

function item(overrides = {}) {
  return {
    schedule_id: "260714-001-1",
    trade_id: ACTIVE_TRADE.trade_id,
    name: "A7IV",
    qty: 1,
    taken_qty: null,
    is_set_header: false,
    is_component: false,
    off_catalog: false,
    onsite: false,
    checkout_state: "taken",
    ...overrides,
  };
}

test("rental names use exact trim, lowercase, and collapsed-whitespace normalization", () => {
  assert.equal(normalizeRentalName("  Sony   A7\tIV  "), "sony a7 iv");
  assert.equal(normalizeRentalName("A7-IV"), "a7-iv");
});

test("only valid taken rows from active trades enter confirmed rental totals", () => {
  const trades = [
    ACTIVE_TRADE,
    { trade_id: "CANCELLED", contract_status: "취소", return_done: false },
    { trade_id: "RETURNED", contract_status: "반납완료", return_done: false },
    { trade_id: "DONE", contract_status: "반출", return_done: true },
  ];
  const scheduleItems = [
    item({ schedule_id: "booked-taken", qty: 3, taken_qty: null }),
    item({ schedule_id: "partial-taken", qty: 4, taken_qty: 2 }),
    item({ schedule_id: "component", qty: 1, is_component: true }),
    item({ schedule_id: "pending", checkout_state: "pending", taken_qty: null }),
    item({ schedule_id: "excluded", checkout_state: "excluded", taken_qty: 1 }),
    item({ schedule_id: "onsite", onsite: true, taken_qty: 1 }),
    item({ schedule_id: "off-catalog", off_catalog: true, taken_qty: 1 }),
    item({ schedule_id: "set-header", is_set_header: true, taken_qty: 1 }),
    item({ schedule_id: "cancelled-item", trade_id: "CANCELLED", taken_qty: 1 }),
    item({ schedule_id: "returned-item", trade_id: "RETURNED", taken_qty: 1 }),
    item({ schedule_id: "return-done-item", trade_id: "DONE", taken_qty: 1 }),
    item({ schedule_id: "archived", name: "Archived Camera", taken_qty: 1 }),
    item({ schedule_id: "system", name: "system", taken_qty: 1 }),
  ];

  const result = buildRentalSnapshot(LEDGER, trades, scheduleItems);
  const rental = result.byEquipment.get("CAM-001");

  assert.equal(rental.active_rental_qty, 6);
  assert.equal(rental.rental_match_status, "matched");
  assert.deepEqual(
    rental.active_rental_refs.map((ref) => ref.schedule_id),
    ["booked-taken", "component", "partial-taken"],
  );
  assert.equal(result.byEquipment.has("OLD-001"), false);
  assert.equal(result.byEquipment.has("SYS-000"), false);
  assert.deepEqual(
    result.exceptions.map((row) => [row.schedule_id, row.reason]),
    [
      ["archived", "unmatched_name"],
      ["system", "unmatched_name"],
    ],
  );
});

test("duplicate normalized aliases on the same equipment remain a unique match", () => {
  const result = buildRentalSnapshot(
    LEDGER,
    [ACTIVE_TRADE],
    [item({ schedule_id: "same-equipment-alias", name: "  A7IV  ", qty: 2 })],
  );

  assert.equal(result.byEquipment.get("CAM-001").active_rental_qty, 2);
  assert.equal(result.byEquipment.get("CAM-001").rental_match_status, "matched");
  assert.deepEqual(result.exceptions, []);
});

test("unmatched, ambiguous, conflicting, and invalid rows survive as hidden exceptions", () => {
  const scheduleItems = [
    item({ schedule_id: "unmatched", name: "렌탈 번들 악세사리", qty: 2 }),
    item({ schedule_id: "ambiguous", name: "공용 별칭", qty: 1 }),
    item({
      schedule_id: "conflicting",
      name: "Canon R5",
      qty: 3,
      taken_qty: 2,
      checkout_state: "pending",
    }),
    item({
      schedule_id: "invalid",
      name: "Canon R5",
      qty: 1,
      taken_qty: 2,
      checkout_state: "taken",
    }),
    item({
      schedule_id: "zero-taken-conflict",
      name: "Canon R5",
      qty: 1,
      taken_qty: 0,
      checkout_state: "taken",
    }),
    item({ schedule_id: "confirmed", name: "Canon R5", qty: 1 }),
  ];

  const result = buildRentalSnapshot(LEDGER, [ACTIVE_TRADE], scheduleItems);

  assert.deepEqual(
    result.exceptions.map((row) => [
      row.schedule_id,
      row.reason,
      row.reported_qty,
      row.candidate_equipment_ids,
    ]),
    [
      ["ambiguous", "ambiguous_name", 1, ["CAM-001", "CAM-002"]],
      ["conflicting", "conflicting_checkout_evidence", 2, ["CAM-002"]],
      ["invalid", "invalid_quantity", 2, ["CAM-002"]],
      ["unmatched", "unmatched_name", 2, []],
      ["zero-taken-conflict", "conflicting_checkout_evidence", 0, ["CAM-002"]],
    ],
  );
  assert.equal(
    result.exceptions.find((row) => row.schedule_id === "conflicting")
      .source_ref.checkout_state,
    "pending",
  );
  assert.equal(
    result.exceptions.find((row) => row.schedule_id === "invalid")
      .source_ref.taken_qty,
    2,
  );

  // Confirmed quantity is retained for owner review, but candidate equipment
  // touched by uncertain evidence is never auto-counted as a matched rental.
  assert.equal(result.byEquipment.get("CAM-002").active_rental_qty, 1);
  assert.equal(result.byEquipment.get("CAM-002").rental_match_status, "ambiguous");
  assert.equal(result.byEquipment.get("CAM-001").rental_match_status, "ambiguous");
});

test("every unmatched taken row is preserved and ordering is deterministic", () => {
  const unmatchedRows = Array.from({ length: 56 }, (_, index) =>
    item({
      schedule_id: `unmatched-${String(55 - index).padStart(2, "0")}`,
      name: `번들 이름 ${index}`,
    }),
  );

  const first = buildRentalSnapshot(LEDGER, [ACTIVE_TRADE], unmatchedRows);
  const second = buildRentalSnapshot(LEDGER, [ACTIVE_TRADE], [...unmatchedRows].reverse());

  assert.equal(first.exceptions.length, 56);
  assert.deepEqual(first.exceptions, second.exceptions);
  assert.equal(first.exceptions[0].schedule_id, "unmatched-00");
  assert.equal(first.exceptions.at(-1).schedule_id, "unmatched-55");
});
