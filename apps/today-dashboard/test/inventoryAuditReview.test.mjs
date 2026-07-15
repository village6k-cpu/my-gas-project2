import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REVIEW_MODULE = path.join(HERE, "../lib/inventory-audit/review.ts");

test("owner review has a pure reconciliation module", () => {
  assert.equal(fs.existsSync(REVIEW_MODULE), true);
  const source = fs.readFileSync(REVIEW_MODULE, "utf8");
  assert.match(source, /export function groupRentalExceptions/);
  assert.match(source, /export function buildInventoryAuditReview/);
});

test("rental exceptions with the same normalized name are one owner decision", async () => {
  const { groupRentalExceptions } = await import("../lib/inventory-audit/review.ts");
  const groups = groupRentalExceptions([
    {
      id: "ex-1",
      raw_name: "소니 CF-A 리더기",
      normalized_name: "소니cfa리더기",
      reported_qty: 1,
      resolution: null,
      resolved_equipment_id: null,
    },
    {
      id: "ex-2",
      raw_name: "소니 CF-A 리더기",
      normalized_name: "소니cfa리더기",
      reported_qty: 2,
      resolution: null,
      resolved_equipment_id: null,
    },
  ]);

  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].exceptionIds, ["ex-1", "ex-2"]);
  assert.equal(groups[0].occurrenceCount, 2);
  assert.equal(groups[0].totalQty, 3);
  assert.equal(groups[0].resolution, null);
});

test("review candidate adds store count, matched rental, and resolved rental exceptions", async () => {
  const { buildInventoryAuditReview } = await import("../lib/inventory-audit/review.ts");
  const review = buildInventoryAuditReview({
    session: { id: "session-1", status: "submitted", started_by_email: "staff@example.com" },
    snapshotRows: [
      {
        equipment_id: "CAM-001",
        name: "카메라",
        major: "촬영",
        category: "카메라",
        ledger_stock_total: 5,
        ledger_stock_maint: 0,
        ledger_state: "정상",
        ledger_open_issues: [{ label: "기존 점검 건" }],
        ledger_updated_at: "2026-07-15T00:00:00.000Z",
        active_rental_qty: 1,
        rental_match_status: "matched",
      },
    ],
    observationRows: [
      {
        id: "obs-1",
        equipment_id: "CAM-001",
        location: "A 선반",
        count_normal: 2,
        count_maintenance: 1,
        count_damaged: 0,
        count_condition_unknown: 0,
        missing_components: ["바디캡"],
        note: "점검 필요",
        identification_status: "confirmed",
      },
    ],
    rentalExceptionRows: [
      {
        id: "ex-1",
        raw_name: "카메라",
        normalized_name: "카메라",
        reported_qty: 2,
        resolution: "existing_equipment",
        resolved_equipment_id: "CAM-001",
      },
    ],
    decisionRows: [],
    ledgerRows: [{ equipment_id: "CAM-001", updated_at: "2026-07-15T00:00:00.000Z" }],
  });

  assert.equal(review.items[0].physicalTotal, 3);
  assert.equal(review.items[0].matchedActiveRentalQty, 1);
  assert.equal(review.items[0].resolvedOffsiteQty, 2);
  assert.equal(review.items[0].candidateTotal, 6);
  assert.equal(review.items[0].finalStockMaintenance, 1);
  assert.equal(review.items[0].defaultDecision, "apply_audit");
  assert.equal(review.items[0].classification, "condition_or_component_issue");
  assert.deepEqual(
    review.items[0].finalOpenIssues.map((issue) => issue.label),
    ["기존 점검 건", "정비중 1개", "누락 구성품: 바디캡", "실사 메모: 점검 필요"],
  );
  assert.equal(review.summary.canApprove, true);
});

test("uncounted stock is explicit and unresolved rental names block approval", async () => {
  const { buildInventoryAuditReview } = await import("../lib/inventory-audit/review.ts");
  const review = buildInventoryAuditReview({
    session: { id: "session-1", status: "submitted", started_by_email: "staff@example.com" },
    snapshotRows: [
      {
        equipment_id: "LENS-001",
        name: "렌즈",
        major: "촬영",
        category: "렌즈",
        ledger_stock_total: 2,
        ledger_stock_maint: 0,
        ledger_state: "정상",
        ledger_open_issues: [],
        ledger_updated_at: "2026-07-15T00:00:00.000Z",
        active_rental_qty: 0,
        rental_match_status: "none",
      },
    ],
    observationRows: [],
    rentalExceptionRows: [
      {
        id: "ex-1",
        raw_name: "렌즈 키트",
        normalized_name: "렌즈키트",
        reported_qty: 1,
        resolution: null,
        resolved_equipment_id: null,
      },
    ],
    decisionRows: [],
    ledgerRows: [{ equipment_id: "LENS-001", updated_at: "2026-07-15T00:00:00.000Z" }],
  });

  assert.equal(review.items[0].classification, "uncounted");
  assert.equal(review.items[0].defaultDecision, "keep_ledger");
  assert.equal(review.summary.uncounted, 1);
  assert.equal(review.summary.unresolvedRentalGroups, 1);
  assert.equal(review.summary.canApprove, false);
});
