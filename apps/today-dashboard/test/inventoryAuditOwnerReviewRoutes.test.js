const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const ROOT = path.join(__dirname, "..");
const ROUTES = [
  "app/api/inventory-audits/[sessionId]/review/route.ts",
  "app/api/inventory-audits/[sessionId]/decisions/route.ts",
  "app/api/inventory-audits/[sessionId]/rental-exceptions/route.ts",
  "app/api/inventory-audits/[sessionId]/approve/route.ts",
  "app/api/inventory-audits/[sessionId]/recount/route.ts",
];

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), "utf8");
}

test("owner review routes exist and authorize before reads or writes", () => {
  for (const route of ROUTES) {
    assert.equal(fs.existsSync(path.join(ROOT, route)), true, route);
    const source = read(route);
    const authIndex = source.indexOf("requireInventoryOwner(req)");
    assert.notEqual(authIndex, -1, route);
    for (const operation of ["req.json()", "getInventoryAuditServiceClient()", ".rpc(", "loadInventoryAuditReview("]) {
      const operationIndex = source.indexOf(operation);
      if (operationIndex !== -1) {
        assert.ok(authIndex < operationIndex, `${route} performs ${operation} before owner auth`);
      }
    }
    assert.match(source, /params:\s*Promise<\{\s*sessionId:\s*string\s*\}>/);
  }
});

test("owner actions use the atomic database contracts", () => {
  assert.match(read(ROUTES[1]), /save_inventory_audit_review/);
  assert.match(read(ROUTES[2]), /resolve_inventory_audit_rental_group/);
  assert.match(read(ROUTES[3]), /approve_inventory_audit/);
  assert.match(read(ROUTES[4]), /request_inventory_audit_recount/);
  assert.match(read(ROUTES[0]), /loadInventoryAuditReview/);
});

test("inventory UI exposes owner review without adding a separate app", () => {
  const review = read("components/inventory-audit/InventoryAuditReview.tsx");
  const mvp = read("components/inventory-audit/InventoryAuditMvp.tsx");
  assert.match(review, /대여명 불일치/);
  assert.match(review, /실사 적용/);
  assert.match(review, /기존 원장 유지/);
  assert.match(review, /재실사/);
  assert.match(review, /기준 재고 확정/);
  assert.match(mvp, /ownerQueue/);
  assert.match(mvp, /InventoryAuditReview/);
  assert.match(mvp, /사장님 검토/);
});
