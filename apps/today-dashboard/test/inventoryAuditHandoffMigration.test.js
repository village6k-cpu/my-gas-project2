const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const migrationPath = path.join(
  __dirname,
  "../supabase/migrations/20260715003000_inventory_audit_staff_handoff.sql",
);

test("staff handoff migration removes personal ownership guards from shared audit operations", () => {
  assert.equal(fs.existsSync(migrationPath), true);
  const sql = fs.readFileSync(migrationPath, "utf8");

  for (const functionName of [
    "save_inventory_audit_observation",
    "delete_inventory_audit_observation",
    "submit_inventory_audit",
    "reserve_inventory_audit_evidence",
    "complete_inventory_audit_evidence",
    "abort_inventory_audit_evidence",
    "finalize_inventory_audit_evidence_abort",
  ]) {
    assert.match(sql, new RegExp(functionName));
  }
  assert.match(sql, /session belongs to another user/);
  assert.match(sql, /observation belongs to another session or user/);
  assert.match(sql, /observed_by = p_actor_id/);
  assert.match(sql, /raise exception 'inventory audit handoff migration did not match/);
});
