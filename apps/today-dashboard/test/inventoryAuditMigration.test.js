const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const dashboardRoot = path.resolve(__dirname, "..");
const migrationsDir = path.join(dashboardRoot, "supabase", "migrations");
const securityCheckPath = path.join(
  dashboardRoot,
  "supabase",
  "inventory-audit-security-check.sql",
);

function readAuditMigration() {
  const matches = fs.existsSync(migrationsDir)
    ? fs
        .readdirSync(migrationsDir)
        .filter((name) => /^\d+_full_inventory_audit\.sql$/.test(name))
    : [];

  assert.equal(
    matches.length,
    1,
    "exactly one CLI-generated full_inventory_audit migration must exist",
  );

  return fs.readFileSync(path.join(migrationsDir, matches[0]), "utf8");
}

test("migration creates the complete inventory-audit data contract", () => {
  const sql = readAuditMigration();

  for (const table of [
    "inventory_audit_sessions",
    "inventory_audit_snapshot_items",
    "inventory_audit_observations",
    "inventory_audit_decisions",
  ]) {
    assert.match(sql, new RegExp(`create table village\\.${table}`, "i"));
    assert.match(
      sql,
      new RegExp(`alter table village\\.${table} enable row level security`, "i"),
    );
  }

  assert.match(sql, /inventory_audit_observation_counts_nonnegative/i);
  assert.match(sql, /inventory_audit_observation_identity_exclusive/i);
  assert.match(sql, /inventory_audit_decision_identity_exclusive/i);
  assert.match(sql, /inventory_audit_decisions_equipment_unique/i);
  assert.match(sql, /inventory_audit_decisions_observation_unique/i);
  assert.match(
    sql,
    /inventory_audit_sessions_full_shop_freeze_check[\s\S]*status <> 'draft'[\s\S]*movement_frozen/i,
  );
  assert.match(sql, /execute function village\.touch_updated_at\(\)/i);
});

test("browser grants and RLS expose only owner metadata and draft observations", () => {
  const sql = readAuditMigration();

  assert.match(
    sql,
    /grant select on village\.inventory_audit_sessions to authenticated/i,
  );
  assert.match(
    sql,
    /grant select, insert, update, delete on village\.inventory_audit_observations to authenticated/i,
  );
  assert.match(
    sql,
    /revoke all on village\.inventory_audit_snapshot_items from anon, authenticated/i,
  );
  assert.match(
    sql,
    /revoke all on village\.inventory_audit_decisions from anon, authenticated/i,
  );
  assert.match(sql, /create policy inventory_audit_sessions_owner_select/is);
  assert.match(sql, /create policy inventory_audit_observations_owner_select/is);
  assert.match(sql, /create policy inventory_audit_observations_owner_draft_insert/is);
  assert.match(sql, /create policy inventory_audit_observations_owner_draft_update/is);
  assert.match(sql, /create policy inventory_audit_observations_owner_draft_delete/is);
  assert.match(sql, /\(select auth\.uid\(\)\)/i);
});

test("evidence storage is private and draft-owner insert-only without upsert", () => {
  const sql = readAuditMigration();

  assert.match(sql, /inventory-audit-evidence/i);
  assert.match(sql, /insert into storage\.buckets\s*\([^)]*public[^)]*\)/is);
  assert.match(sql, /'inventory-audit-evidence'[\s\S]*false/i);
  assert.doesNotMatch(sql, /\bon\s+conflict\b|\bupsert\b/i);
  assert.match(sql, /create policy inventory_audit_evidence_insert/is);
  assert.doesNotMatch(
    sql,
    /create policy inventory_audit_evidence_(?:select|update|delete)/i,
  );
  assert.match(sql, /storage\.foldername\(name\)/i);
  assert.match(sql, /cardinality\(storage\.foldername\(name\)\) = 2/i);
  assert.match(sql, /status = 'draft'/i);
});

test("a security-definer global draft helper gates every authenticated ledger write", () => {
  const sql = readAuditMigration();

  assert.match(
    sql,
    /create function village\.inventory_audit_ledger_writes_allowed\(\)[\s\S]*security definer[\s\S]*set search_path = village, public/i,
  );
  assert.match(
    sql,
    /from village\.inventory_audit_sessions[\s\S]*mode = 'full_shop'[\s\S]*status = 'draft'/i,
  );
  assert.match(
    sql,
    /revoke execute on function village\.inventory_audit_ledger_writes_allowed\(\) from public, anon/i,
  );
  assert.match(
    sql,
    /grant execute on function village\.inventory_audit_ledger_writes_allowed\(\) to authenticated/i,
  );
  assert.match(sql, /drop policy if exists auth_rw on village\.equipment_ledger/i);
  for (const operation of ["select", "insert", "update", "delete"]) {
    assert.match(
      sql,
      new RegExp(`create policy equipment_ledger_authenticated_${operation}`, "i"),
    );
  }
  assert.match(
    sql,
    /\(select village\.inventory_audit_ledger_writes_allowed\(\)\)/i,
  );
});

test("service-only RPCs make start, recount, and approval atomic", () => {
  const sql = readAuditMigration();

  for (const fn of [
    "start_inventory_audit",
    "request_inventory_audit_recount",
    "approve_inventory_audit",
  ]) {
    assert.match(
      sql,
      new RegExp(
        `create function village\\.${fn}\\([\\s\\S]*?returns jsonb[\\s\\S]*?language plpgsql[\\s\\S]*?security definer[\\s\\S]*?set search_path = village, public`,
        "i",
      ),
    );
    assert.match(
      sql,
      new RegExp(`revoke execute on function village\\.${fn}\\(`, "i"),
    );
    assert.match(
      sql,
      new RegExp(`grant execute on function village\\.${fn}\\([\\s\\S]*?to service_role`, "i"),
    );
  }

  assert.match(sql, /insert into village\.inventory_audit_snapshot_items/i);
  assert.match(sql, /parent_session_id/i);
  assert.match(sql, /for update/i);
  assert.match(sql, /ledger_updated_at/i);
  assert.match(sql, /missing audit decision/i);
  assert.match(sql, /unresolved temporary observation/i);
  assert.match(sql, /insert into village\.equipment_ledger/i);
  assert.match(sql, /update village\.equipment_ledger/i);
  assert.match(sql, /insert into village\.equipment_events/i);
  assert.match(sql, /status = 'approved'/i);
  assert.match(sql, /multiple inventory audit decisions target equipment/i);
  assert.match(sql, /unresolved recount decision cannot create child session/i);
  assert.match(sql, /v_verify_status text/i);
  assert.match(
    sql,
    /jsonb_array_length[\s\S]*open_issues[\s\S]*stock_maint[\s\S]*state[\s\S]*<> '정상'[\s\S]*then 'attention'/i,
  );
  assert.match(sql, /verify_status = v_verify_status/i);
});

test("approval compares the exact ledger version captured by the reviewer", () => {
  const sql = readAuditMigration();

  assert.match(sql, /reviewed_ledger_updated_at timestamptz/i);
  assert.match(sql, /inventory_audit_decision_reviewed_ledger_version_check/i);
  assert.match(
    sql,
    /v_decision\.reviewed_ledger_updated_at\s+is distinct from\s+v_ledger\.updated_at/i,
  );
  assert.doesNotMatch(
    sql,
    /v_decision\.reviewed_at\s*<\s*v_ledger\.updated_at/i,
  );
});

test("approval requires one canonical decision for each existing equipment target", () => {
  const sql = readAuditMigration();

  assert.match(sql, /multiple inventory audit decisions target equipment/i);
  assert.match(
    sql,
    /coalesce\(decision_row\.equipment_id, decision_row\.resolved_equipment_id\)/i,
  );
  assert.doesNotMatch(sql, /multiple apply_audit decisions target equipment/i);
});

test("verification metadata comes from an actual relevant observation", () => {
  const sql = readAuditMigration();

  assert.match(sql, /v_observed_at timestamptz/i);
  assert.match(sql, /v_observed_by_email text/i);
  assert.match(sql, /observation\.client_updated_at/i);
  assert.match(
    sql,
    /last_verified_at = case[\s\S]*v_decision\.decision = 'apply_audit'[\s\S]*v_observed_at is not null[\s\S]*then v_observed_at[\s\S]*else last_verified_at/i,
  );
  assert.match(
    sql,
    /last_verified_by = case[\s\S]*then v_observed_by_email[\s\S]*else last_verified_by/i,
  );
  assert.doesNotMatch(sql, /last_verified_at = v_approved_at/i);
});

test("effective status derives from final ledger state even without an observation", () => {
  const sql = readAuditMigration();

  assert.match(sql, /verify_status = v_verify_status/i);
  assert.doesNotMatch(
    sql,
    /verify_status = case[\s\S]*v_observed_at is not null[\s\S]*then v_verify_status/i,
  );
});

test("new equipment verification metadata comes from its source observation", () => {
  const sql = readAuditMigration();
  const createEquipmentLoop = sql.match(
    /for v_decision in\s+select decision_row\.\*[\s\S]*?resolution = 'create_equipment'[\s\S]*?v_created_count := v_created_count \+ 1;/i,
  )?.[0];

  assert.ok(createEquipmentLoop, "create_equipment approval loop must exist");
  assert.match(
    createEquipmentLoop,
    /select observation\.client_updated_at, observation\.observed_by_email/i,
  );
  assert.match(
    createEquipmentLoop,
    /v_verify_status,\s*v_observed_at,\s*v_observed_by_email,\s*v_decision\.final_open_issues/i,
  );
  assert.doesNotMatch(
    createEquipmentLoop,
    /v_verify_status,\s*v_approved_at,\s*btrim\(p_approved_by_email\)/i,
  );
});

test("evidence object leaf is a UUID jpg filename", () => {
  const sql = readAuditMigration();

  assert.match(sql, /storage\.filename\(name\)/i);
  assert.match(
    sql,
    /storage\.filename\(name\)[\s\S]*\[0-9a-f\][\s\S]*\\\.jpg\$/i,
  );
});

test("security verification SQL is read-only and reports every protected surface", () => {
  assert.equal(fs.existsSync(securityCheckPath), true, "security check SQL must exist");
  const sql = fs.readFileSync(securityCheckPath, "utf8");

  assert.match(sql, /pg_class/i);
  assert.match(sql, /pg_policies/i);
  assert.match(sql, /storage\.buckets/i);
  assert.match(sql, /proacl/i);
  assert.doesNotMatch(
    sql,
    /\b(?:insert|update|delete|alter|create|drop|truncate|grant|revoke)\b/i,
  );
});
