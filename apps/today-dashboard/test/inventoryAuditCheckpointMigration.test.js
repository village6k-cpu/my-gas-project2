const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const MIGRATION = path.join(
  __dirname,
  "../supabase/migrations/20260715103000_inventory_audit_checkpoint_approval.sql",
);

test("checkpoint migration records item approvals and locks approved observations", () => {
  assert.equal(fs.existsSync(MIGRATION), true);
  const sql = fs.readFileSync(MIGRATION, "utf8");
  assert.match(sql, /^begin;/im);
  assert.match(sql, /create table village\.inventory_audit_item_approvals/i);
  assert.match(sql, /primary key \(session_id, equipment_id\)/i);
  assert.match(sql, /enable row level security/i);
  assert.match(sql, /revoke all on village\.inventory_audit_item_approvals from public/i);
  assert.match(sql, /grant all on village\.inventory_audit_item_approvals to service_role/i);
  assert.match(sql, /create function village\.protect_approved_inventory_audit_observation/i);
  assert.match(sql, /inventory audit item is already owner-approved/i);
  assert.match(sql, /before insert or update or delete on village\.inventory_audit_observations/i);
});

test("checkpoint approval atomically applies only counted selected equipment", () => {
  const sql = fs.readFileSync(MIGRATION, "utf8");
  assert.match(sql, /create function village\.approve_inventory_audit_items/i);
  assert.match(sql, /v_session\.status <> 'draft'/i);
  assert.match(sql, /jsonb_array_length\(p_items\)/i);
  assert.match(sql, /count\(distinct item_input\.equipment_id\)/i);
  assert.match(sql, /unresolved rental exception blocks checkpoint approval/i);
  assert.match(sql, /inventory_audit_observations[\s\S]*for update/i);
  assert.match(sql, /pending evidence blocks checkpoint approval/i);
  assert.match(sql, /ledger version conflict for equipment/i);
  assert.match(sql, /update village\.equipment_ledger/i);
  assert.match(sql, /'inventory_audit_item_approved'/i);
  assert.match(sql, /insert into village\.inventory_audit_item_approvals/i);
  assert.match(sql, /update village\.inventory_audit_snapshot_items/i);
  assert.match(sql, /remaining_equipment_count/i);
  assert.match(sql, /revoke execute on function village\.approve_inventory_audit_items/i);
  assert.match(sql, /grant execute[\s\S]*to service_role/i);
  assert.match(sql, /commit;$/im);
});

test("rental-name decisions are allowed while the shared audit remains draft", () => {
  const sql = fs.readFileSync(MIGRATION, "utf8");
  assert.match(sql, /create or replace function village\.resolve_inventory_audit_rental_group/i);
  assert.match(sql, /status not in \('draft', 'submitted', 'in_review'\)/i);
});
