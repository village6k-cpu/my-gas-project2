const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const routePath = path.join(
  __dirname,
  "..",
  "app",
  "api",
  "inventory-audits",
  "[sessionId]",
  "mirror",
  "route.ts",
);

function readRoute() {
  return fs.readFileSync(routePath, "utf8");
}

test("mirror route is owner-only before params, configuration, or database work", () => {
  const source = readRoute();
  const auth = source.indexOf("requireInventoryOwner(req)");
  assert.notEqual(auth, -1);

  for (const operation of [
    "await params",
    "getInventoryAuditServiceClient()",
    "getInventoryAuditMirrorConfig()",
    '.from("inventory_audit_sessions")',
    '"claim_inventory_audit_mirror"',
    "runInventoryAuditMirror(",
  ]) {
    const index = source.indexOf(operation);
    assert.notEqual(index, -1, `${operation} must exist`);
    assert.ok(auth < index, `${operation} must happen only after owner auth`);
  }
});

test("mirror route validates UUID and approved state before acquiring the lease", () => {
  const source = readRoute();
  const uuid = source.indexOf("isInventoryAuditMirrorUuid(sessionId)");
  const approved = source.indexOf('session.status !== "approved"');
  const claim = source.indexOf('"claim_inventory_audit_mirror"');

  assert.ok(uuid !== -1 && approved !== -1 && claim !== -1);
  assert.ok(uuid < approved);
  assert.ok(approved < claim);
  assert.match(source, /params:\s*Promise<\{\s*sessionId:\s*string\s*\}>/);
  assert.match(source, /status:\s*409[\s\S]*mirror_unapproved|mirror_unapproved[\s\S]*409/);
});

test("mirror route uses claim/complete/fail RPCs and never mutates approved ledger truth", () => {
  const source = readRoute();

  for (const rpc of [
    "claim_inventory_audit_mirror",
    "complete_inventory_audit_mirror",
    "fail_inventory_audit_mirror",
  ]) {
    assert.match(source, new RegExp(`\\.rpc\\(\\s*\"${rpc}\"`));
  }
  assert.doesNotMatch(source, /from\(["']equipment_ledger["']\)[\s\S]{0,120}\.(?:update|insert|upsert|delete)\(/);
  assert.doesNotMatch(source, /approve_inventory_audit/);
  assert.doesNotMatch(source, /mirror_status["']?\)\.update|\.update\([\s\S]{0,120}mirror_status/);
});

test("mirror route returns only sanitized 200/202/409/502/503/504 outcomes", () => {
  const source = readRoute();

  assert.match(source, /export const maxDuration = (?:40|45|50|60)/);
  for (const status of [200, 202, 409]) {
    assert.match(source, new RegExp(`,\\s*${status},?\\s*\\)`));
  }
  for (const status of [502, 503, 504]) {
    assert.match(source, new RegExp(`return\\s+${status};`));
  }
  assert.match(source, /sanitizeInventoryAuditMirrorError/);
  assert.doesNotMatch(source, /error\.message|String\(error\)|JSON\.stringify\(error\)/);
  assert.doesNotMatch(source, /req\.nextUrl\.searchParams|req\.url|[?&]key=/);
});

test("failure bookkeeping cannot replace the sanitized route response with a thrown database error", () => {
  const source = readRoute();

  assert.match(
    source,
    /if \(client && attemptToken\) \{\s*try \{[\s\S]*?await client\.rpc\(\s*"fail_inventory_audit_mirror"[\s\S]*?\}\s*catch \{/,
  );
});
