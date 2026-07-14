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
    "inventory_audit_snapshot_rental_exceptions",
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
    /grant select on village\.inventory_audit_observations to authenticated/i,
  );
  assert.doesNotMatch(
    sql,
    /grant[^;]*(?:insert|update|delete)[^;]*inventory_audit_observations[^;]*authenticated/i,
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
  assert.doesNotMatch(sql, /create policy inventory_audit_observations_owner_draft_(?:insert|update|delete)/i);
  assert.match(sql, /\(select auth\.uid\(\)\)/i);
});

test("rental exceptions are hidden, constrained, and service-role only", () => {
  const sql = readAuditMigration();

  assert.match(sql, /create table village\.inventory_audit_snapshot_rental_exceptions/i);
  assert.match(sql, /unique\s*\(session_id, schedule_id\)/i);
  assert.match(sql, /reported_qty integer not null/i);
  assert.match(sql, /reported_qty >= 0/i);
  for (const reason of [
    "ambiguous_name",
    "unmatched_name",
    "conflicting_checkout_evidence",
    "invalid_quantity",
  ]) {
    assert.match(sql, new RegExp(`'${reason}'`, "i"));
  }
  assert.match(sql, /jsonb_typeof\(candidate_equipment_ids\) = 'array'/i);
  assert.match(sql, /jsonb_typeof\(source_ref\) = 'object'/i);
  assert.match(sql, /inventory_audit_rental_exception_resolution_shape/i);
  assert.match(
    sql,
    /revoke all on village\.inventory_audit_snapshot_rental_exceptions from anon, authenticated/i,
  );
  assert.match(
    sql,
    /grant all on village\.inventory_audit_snapshot_rental_exceptions to service_role/i,
  );
  assert.doesNotMatch(
    sql,
    /create policy[^;]*inventory_audit_snapshot_rental_exceptions/i,
  );
});

test("evidence storage is private and has no browser mutation policy", () => {
  const sql = readAuditMigration();

  assert.match(sql, /inventory-audit-evidence/i);
  assert.match(sql, /insert into storage\.buckets\s*\([^)]*public[^)]*\)/is);
  assert.match(sql, /'inventory-audit-evidence'[\s\S]*false/i);
  assert.doesNotMatch(sql, /\bon\s+conflict\b|\bupsert\b/i);
  assert.doesNotMatch(
    sql,
    /create policy inventory_audit_evidence_(?:select|insert|update|delete)/i,
  );
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
  assert.match(
    sql,
    /request_inventory_audit_recount[\s\S]*from village\.inventory_audit_snapshot_rental_exceptions[\s\S]*for update[\s\S]*unresolved rental exception blocks recount/i,
  );
  assert.match(
    sql,
    /request_inventory_audit_recount[\s\S]*resolved equipment for rental exception is outside the source snapshot/i,
  );
  assert.match(sql, /v_verify_status text/i);
  assert.match(
    sql,
    /jsonb_array_length[\s\S]*open_issues[\s\S]*stock_maint[\s\S]*state[\s\S]*<> '정상'[\s\S]*then 'attention'/i,
  );
  assert.match(sql, /verify_status = v_verify_status/i);
});

test("start snapshots matched rentals and hidden rental exceptions atomically", () => {
  const sql = readAuditMigration();

  assert.match(
    sql,
    /create function village\.start_inventory_audit\([\s\S]*p_rental_snapshot jsonb[\s\S]*p_rental_exceptions jsonb[\s\S]*returns jsonb/i,
  );
  assert.doesNotMatch(
    sql,
    /p_rental_(?:snapshot|exceptions) jsonb default/i,
    "all five start arguments must be required so the obsolete four-argument call cannot resolve through defaults",
  );
  assert.match(
    sql,
    /insert into village\.inventory_audit_snapshot_rental_exceptions/i,
  );
  assert.match(
    sql,
    /jsonb_to_recordset\(p_rental_exceptions\)/i,
  );
  assert.doesNotMatch(
    sql,
    /(?:revoke|grant) execute on function village\.start_inventory_audit\(uuid, text, boolean, jsonb\)/i,
  );
  assert.match(
    sql,
    /drop function if exists village\.start_inventory_audit\(uuid, text, boolean, jsonb\)/i,
  );
  assert.match(
    sql,
    /revoke execute on function village\.start_inventory_audit\(uuid, text, boolean, jsonb, jsonb\) from public, anon, authenticated/i,
  );
  assert.match(
    sql,
    /grant execute on function village\.start_inventory_audit\(uuid, text, boolean, jsonb, jsonb\) to service_role/i,
  );
});

test("service-only observation save and delete use session locks and compare-and-swap", () => {
  const sql = readAuditMigration();

  for (const fn of [
    "save_inventory_audit_observation",
    "delete_inventory_audit_observation",
  ]) {
    assert.match(
      sql,
      new RegExp(
        `create function village\\.${fn}\\([\\s\\S]*?returns jsonb[\\s\\S]*?security definer[\\s\\S]*?set search_path = village, public`,
        "i",
      ),
    );
    assert.match(
      sql,
      new RegExp(
        `revoke execute on function village\\.${fn}\\([\\s\\S]*?from public, anon, authenticated`,
        "i",
      ),
    );
    assert.match(
      sql,
      new RegExp(
        `grant execute on function village\\.${fn}\\([\\s\\S]*?to service_role`,
        "i",
      ),
    );
  }

  assert.match(
    sql,
    /save_inventory_audit_observation[\s\S]*from village\.inventory_audit_sessions[\s\S]*for update/i,
  );
  assert.match(sql, /p_expected_client_updated_at/i);
  assert.match(sql, /client_updated_at is distinct from p_expected_client_updated_at/i);
  assert.match(sql, /using errcode = '40001'/i);
  assert.match(
    sql,
    /save_inventory_audit_observation[\s\S]*evidence_refs[\s\S]*v_existing\.evidence_refs/i,
  );
  assert.match(
    sql,
    /delete_inventory_audit_observation[\s\S]*client_updated_at is distinct from p_expected_client_updated_at/i,
  );
});

test("submit and cancel serialize transitions and are service-role only", () => {
  const sql = readAuditMigration();

  for (const fn of ["submit_inventory_audit", "cancel_inventory_audit"]) {
    assert.match(
      sql,
      new RegExp(
        `create function village\\.${fn}\\([\\s\\S]*?returns jsonb[\\s\\S]*?security definer[\\s\\S]*?set search_path = village, public`,
        "i",
      ),
    );
    assert.match(
      sql,
      new RegExp(
        `${fn}[\\s\\S]*pg_advisory_xact_lock[\\s\\S]*from village\\.inventory_audit_sessions[\\s\\S]*for update`,
        "i",
      ),
    );
  }

  assert.match(sql, /p_pending_observation_writes[^,)]*integer/i);
  assert.match(sql, /p_pending_evidence_uploads[^,)]*integer/i);
  assert.match(
    sql,
    /submit_inventory_audit[\s\S]*jsonb_array_elements\(observation\.evidence_refs\)[\s\S]*pending/i,
  );
  assert.match(
    sql,
    /submit_inventory_audit[\s\S]*status = 'submitted'[\s\S]*'reused', true/i,
  );
  assert.match(
    sql,
    /cancel_inventory_audit[\s\S]*status = 'cancelled'[\s\S]*'reused', true/i,
  );
});

test("evidence reservation RPCs are idempotent and submission-visible", () => {
  const sql = readAuditMigration();

  for (const fn of [
    "reserve_inventory_audit_evidence",
    "complete_inventory_audit_evidence",
  ]) {
    assert.match(
      sql,
      new RegExp(
        `create function village\\.${fn}\\([\\s\\S]*?returns jsonb[\\s\\S]*?security definer[\\s\\S]*?set search_path = village, public`,
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

  assert.match(
    sql,
    /reserve_inventory_audit_evidence[\s\S]*p_session_id::text[\s\S]*p_observation_id::text[\s\S]*p_evidence_id::text \|\| '\.jpg'/i,
  );
  assert.match(
    sql,
    /reserve_inventory_audit_evidence[\s\S]*'status', 'pending'/i,
  );
  assert.match(
    sql,
    /complete_inventory_audit_evidence[\s\S]*'status', 'uploaded'/i,
  );
  assert.match(sql, /jsonb_array_elements\(v_observation\.evidence_refs\)/i);
});

test("approval refuses unresolved or invalid rental exceptions", () => {
  const sql = readAuditMigration();

  assert.match(
    sql,
    /approve_inventory_audit[\s\S]*inventory_audit_snapshot_rental_exceptions[\s\S]*unresolved rental exception blocks approval/i,
  );
  assert.match(
    sql,
    /resolved equipment for rental exception is outside the session snapshot/i,
  );
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

  assert.match(
    sql,
    /reserve_inventory_audit_evidence\([\s\S]*p_evidence_id uuid/i,
  );
  assert.match(
    sql,
    /p_session_id::text\s*\|\|\s*'\/'\s*\|\|\s*p_observation_id::text\s*\|\|\s*'\/'\s*\|\|\s*p_evidence_id::text\s*\|\|\s*'\.jpg'/i,
  );
});

test("security verification SQL is read-only and reports every protected surface", () => {
  assert.equal(fs.existsSync(securityCheckPath), true, "security check SQL must exist");
  const sql = fs.readFileSync(securityCheckPath, "utf8");

  assert.match(sql, /pg_class/i);
  assert.match(sql, /pg_policies/i);
  assert.match(sql, /storage\.buckets/i);
  assert.match(sql, /proacl/i);
  assert.match(sql, /inventory_audit_snapshot_rental_exceptions/i);
  for (const fn of [
    "save_inventory_audit_observation",
    "delete_inventory_audit_observation",
    "submit_inventory_audit",
    "cancel_inventory_audit",
    "reserve_inventory_audit_evidence",
    "complete_inventory_audit_evidence",
  ]) {
    assert.match(sql, new RegExp(fn, "i"));
  }
  assert.doesNotMatch(
    sql,
    /\b(?:insert|update|delete|alter|create|drop|truncate|grant|revoke)\b/i,
  );
});
