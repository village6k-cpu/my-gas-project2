import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const ROOT = path.join(import.meta.dirname, "..");
const HELPER = path.join(ROOT, "lib/inventory-audit/ownerFinalCount.ts");

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), "utf8");
}

test("owner final count overrides the audit suggestion and rejects impossible counts", async () => {
  assert.equal(fs.existsSync(HELPER), true, "owner final-count helper is missing");
  const { resolveInventoryAuditFinalCounts } = await import(pathToFileURL(HELPER).href);

  assert.deepEqual(
    resolveInventoryAuditFinalCounts(
      { finalStockTotal: 8, finalStockMaintenance: 2 },
      { finalStockTotal: 5, finalStockMaintenance: 1 },
    ),
    { finalStockTotal: 8, finalStockMaintenance: 2 },
  );
  assert.deepEqual(
    resolveInventoryAuditFinalCounts(
      {},
      { finalStockTotal: 5, finalStockMaintenance: 1 },
    ),
    { finalStockTotal: 5, finalStockMaintenance: 1 },
  );
  assert.throws(
    () => resolveInventoryAuditFinalCounts(
      { finalStockTotal: 1, finalStockMaintenance: 2 },
      { finalStockTotal: 5, finalStockMaintenance: 1 },
    ),
    /정비수량은 최종 총수량보다 클 수 없습니다/,
  );
  assert.throws(
    () => resolveInventoryAuditFinalCounts(
      { finalStockTotal: -1, finalStockMaintenance: 0 },
      { finalStockTotal: 5, finalStockMaintenance: 1 },
    ),
    /0 이상의 정수/,
  );
});

test("both owner approval paths send and consume editable final counts", () => {
  const ui = read("components/inventory-audit/InventoryAuditReview.tsx");
  const decisions = read("app/api/inventory-audits/[sessionId]/decisions/route.ts");
  const checkpoint = read("app/api/inventory-audits/[sessionId]/checkpoint/route.ts");
  const reviewServer = read("lib/server/inventoryAuditReview.ts");

  assert.match(ui, /최종 총수량/);
  assert.match(ui, /정비수량/);
  assert.match(ui, /finalStockTotal/);
  assert.match(ui, /finalStockMaintenance/);
  assert.match(decisions, /resolveInventoryAuditFinalCounts/);
  assert.match(checkpoint, /resolveInventoryAuditFinalCounts/);
  assert.match(reviewServer, /final_stock_total/);
  assert.match(reviewServer, /final_stock_maint/);
});
