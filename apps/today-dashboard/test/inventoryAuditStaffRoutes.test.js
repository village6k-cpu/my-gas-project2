const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const ROOT = path.join(__dirname, "..");
const ROUTES = [
  "app/api/inventory-audits/route.ts",
  "app/api/inventory-audits/start/route.ts",
  "app/api/inventory-audits/[sessionId]/observations/route.ts",
  "app/api/inventory-audits/[sessionId]/submit/route.ts",
  "app/api/inventory-audits/[sessionId]/cancel/route.ts",
];

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), "utf8");
}

test("every staff route authenticates before body, configuration, or database work", () => {
  for (const route of ROUTES) {
    const source = read(route);
    const authIndex = source.indexOf("requireInventoryUser(req)");
    assert.notEqual(authIndex, -1, `${route} must require a verified user`);

    for (const operation of [
      "req.json()",
      "req.text()",
      "getInventoryAuditServiceClient()",
      "loadStaffWorkspace(",
      ".rpc(",
    ]) {
      const operationIndex = source.indexOf(operation);
      if (operationIndex !== -1) {
        assert.ok(
          authIndex < operationIndex,
          `${route} performs ${operation} before verified auth`,
        );
      }
    }
  }
});

test("dynamic handlers await Next 15 session params and call only final service RPCs", () => {
  for (const route of ROUTES.filter((file) => file.includes("[sessionId]"))) {
    assert.match(
      read(route),
      /params:\s*Promise<\{\s*sessionId:\s*string\s*\}>/,
      route,
    );
  }

  const observation = read(
    "app/api/inventory-audits/[sessionId]/observations/route.ts",
  );
  assert.match(observation, /save_inventory_audit_observation/);
  assert.match(observation, /delete_inventory_audit_observation/);
  const submit = read("app/api/inventory-audits/[sessionId]/submit/route.ts");
  const cancel = read("app/api/inventory-audits/[sessionId]/cancel/route.ts");
  assert.equal((submit.match(/submit_inventory_audit/g) || []).length, 1);
  assert.equal((cancel.match(/cancel_inventory_audit/g) || []).length, 1);
});

test("server staff helper is server-only, paginates reads, batches trade items, and calls atomic start once", () => {
  const source = read("lib/server/inventoryAuditStaff.ts");

  assert.match(source, /^import "server-only";/m);
  assert.match(source, /\.range\(/);
  assert.match(source, /\.in\("trade_id",\s*tradeIds/);
  assert.equal((source.match(/\.rpc\("start_inventory_audit"/g) || []).length, 1);
  assert.match(source, /p_rental_snapshot/);
  assert.match(source, /p_rental_exceptions/);
  assert.match(source, /latestCallerSession/);
});

test("staff routes contain no direct ledger mutation or hidden snapshot response field", () => {
  const combined = [
    ...ROUTES.map(read),
    read("lib/server/inventoryAuditStaff.ts"),
  ].join("\n");

  assert.doesNotMatch(
    combined,
    /from\(["']equipment_ledger["']\)[\s\S]{0,100}\.(?:insert|update|upsert|delete)\(/,
  );
  assert.doesNotMatch(combined, /ledger_stock_total|ledger_stock_maint/);
  assert.doesNotMatch(combined, /active_rental_qty|active_rental_refs|rental_match_status/);
});
