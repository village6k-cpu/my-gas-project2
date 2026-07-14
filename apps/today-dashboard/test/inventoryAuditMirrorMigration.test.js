const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const migrationPath = path.join(
  __dirname,
  "..",
  "supabase",
  "migrations",
  "20260714120000_inventory_audit_mirror_delivery.sql",
);
const securityCheckPath = path.join(
  __dirname,
  "..",
  "supabase",
  "inventory-audit-security-check.sql",
);

function readMigration() {
  return fs.readFileSync(migrationPath, "utf8");
}

function functionBody(sql, name) {
  const start = sql.indexOf(`create function village.${name}(`);
  const end = sql.indexOf(`revoke execute on function village.${name}(`, start);
  assert.notEqual(start, -1, `${name} must exist`);
  assert.notEqual(end, -1, `${name} ACL must exist`);
  return sql.slice(start, end);
}

test("mirror attempts are service-only and sessions expose only sanitized delivery state", () => {
  const sql = readMigration();

  assert.match(sql, /create table village\.inventory_audit_mirror_attempts/i);
  assert.match(sql, /alter table village\.inventory_audit_mirror_attempts enable row level security/i);
  assert.match(sql, /revoke all on village\.inventory_audit_mirror_attempts from public, anon, authenticated/i);
  assert.match(sql, /grant all on village\.inventory_audit_mirror_attempts to service_role/i);
  assert.doesNotMatch(sql, /create policy[^;]*inventory_audit_mirror_attempts/i);

  for (const column of [
    "mirror_attempt_count",
    "mirror_last_attempt_at",
    "mirror_synced_at",
    "mirror_last_error_code",
    "mirror_last_ledger_row_count",
    "mirror_last_sheet_row_count",
    "mirror_last_update_count",
    "mirror_last_append_count",
    "mirror_last_updated_count",
    "mirror_last_appended_count",
  ]) {
    assert.match(sql, new RegExp(`add column ${column}`, "i"));
  }
  assert.doesNotMatch(sql, /raw_error|error_message|error_detail|secret/i);
});

test("claim uses one global two-minute lease for same-session and cross-session callers", () => {
  const sql = readMigration();
  const claim = functionBody(sql, "claim_inventory_audit_mirror");

  assert.match(sql, /inventory_audit_mirror_one_running[\s\S]*where status = 'running'/i);
  assert.match(claim, /pg_advisory_xact_lock[\s\S]*inventory_audit\.mirror/i);
  assert.match(claim, /status = 'running'[\s\S]*lease_expires_at <= v_now[\s\S]*status = 'failed'/i);
  assert.match(
    claim,
    /lease_expires_at[\s\S]{0,500}v_now \+ interval '2 minutes'/i,
  );
  assert.match(claim, /where attempt\.status = 'running'[\s\S]*attempt\.lease_expires_at > v_now/i);
  assert.doesNotMatch(
    claim,
    /where attempt\.session_id = p_session_id[\s\S]{0,120}attempt\.status = 'running'/i,
    "busy detection must be global, not scoped to one session",
  );
  assert.match(claim, /v_session\.status <> 'approved'[\s\S]*'unapproved'/i);
  assert.match(claim, /v_session\.mirror_status = 'synced'[\s\S]*'synced'/i);
  assert.match(claim, /gen_random_uuid\(\)/i);
});

test("complete and fail use exact attempt-token compare-and-swap and cannot roll back approval", () => {
  const sql = readMigration();
  const complete = functionBody(sql, "complete_inventory_audit_mirror");
  const fail = functionBody(sql, "fail_inventory_audit_mirror");

  for (const body of [complete, fail]) {
    assert.match(body, /attempt_token = p_attempt_token/i);
    assert.match(body, /session_id = p_session_id/i);
    assert.match(body, /status = 'running'/i);
    assert.match(body, /get diagnostics v_changed = row_count/i);
    assert.match(body, /v_changed <> 1[\s\S]*'stale'/i);
    assert.doesNotMatch(body, /update village\.equipment_ledger/i);
    assert.doesNotMatch(body, /approve_inventory_audit/i);
    assert.doesNotMatch(body, /set\s+status = 'approved'/i);
  }

  assert.match(complete, /mirror_status = 'synced'/i);
  assert.match(complete, /mirror_synced_at = v_now/i);
  assert.match(fail, /mirror_status = 'failed'/i);
  assert.match(fail, /mirror_last_error_code = v_error_code/i);
  assert.match(fail, /p_error_code[\s\S]*mirror_[a-z_]+/i);
});

test("all mirror RPCs are security definers callable only by service_role", () => {
  const sql = readMigration();
  for (const name of [
    "claim_inventory_audit_mirror",
    "complete_inventory_audit_mirror",
    "fail_inventory_audit_mirror",
  ]) {
    assert.match(
      sql,
      new RegExp(
        `create function village\\.${name}\\([\\s\\S]*?returns jsonb[\\s\\S]*?security definer[\\s\\S]*?set search_path = village, public`,
        "i",
      ),
    );
    assert.match(
      sql,
      new RegExp(`revoke execute on function village\\.${name}\\([\\s\\S]*?from public, anon, authenticated`, "i"),
    );
    assert.match(
      sql,
      new RegExp(`grant execute on function village\\.${name}\\([\\s\\S]*?to service_role`, "i"),
    );
  }
});

test("the read-only security check reports the mirror table and RPC ACLs", () => {
  const sql = fs.readFileSync(securityCheckPath, "utf8");

  assert.match(sql, /inventory_audit_mirror_attempts/i);
  for (const name of [
    "claim_inventory_audit_mirror",
    "complete_inventory_audit_mirror",
    "fail_inventory_audit_mirror",
  ]) {
    assert.match(sql, new RegExp(`'${name}'`, "i"));
  }
  assert.doesNotMatch(
    sql,
    /\b(?:insert|update|delete|alter|create|drop|truncate)\b/i,
  );
});
