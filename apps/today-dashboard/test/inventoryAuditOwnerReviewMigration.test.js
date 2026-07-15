const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const MIGRATION = path.join(
  __dirname,
  "../supabase/migrations/20260715090000_inventory_audit_owner_review.sql",
);

test("owner review migration saves a complete decision set atomically", () => {
  assert.equal(fs.existsSync(MIGRATION), true);
  const sql = fs.readFileSync(MIGRATION, "utf8");
  assert.match(sql, /^begin;/im);
  assert.match(sql, /create function village\.save_inventory_audit_review/i);
  assert.match(sql, /from village\.inventory_audit_sessions[\s\S]*for update/i);
  assert.match(sql, /status not in \('submitted', 'in_review'\)/i);
  assert.match(sql, /jsonb_array_length\(p_decisions\)/i);
  assert.match(sql, /count\(distinct decision_input\.equipment_id\)/i);
  assert.match(sql, /delete from village\.inventory_audit_decisions/i);
  assert.match(sql, /insert into village\.inventory_audit_decisions/i);
  assert.match(sql, /reviewed_ledger_updated_at/i);
  assert.match(sql, /set status = 'in_review'/i);
  assert.match(sql, /commit;$/im);
});

test("rental exception group resolution is owner-attributed and snapshot-bound", () => {
  const sql = fs.readFileSync(MIGRATION, "utf8");
  assert.match(sql, /create function village\.resolve_inventory_audit_rental_group/i);
  assert.match(sql, /p_exception_ids uuid\[\]/i);
  assert.match(sql, /inventory_audit_snapshot_items/i);
  assert.match(sql, /reviewed_by = p_reviewer/i);
  assert.match(sql, /reviewed_by_email = btrim\(p_reviewer_email\)/i);
  assert.match(sql, /revoke execute on function village\.save_inventory_audit_review/i);
  assert.match(sql, /revoke execute on function village\.resolve_inventory_audit_rental_group/i);
  assert.match(sql, /grant execute[\s\S]*to service_role/i);
});
