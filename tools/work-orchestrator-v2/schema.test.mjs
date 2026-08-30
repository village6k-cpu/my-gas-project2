import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const migrationsDirectory = join(import.meta.dirname, '..', '..', 'supabase', 'migrations');
const migrationFiles = readdirSync(migrationsDirectory)
  .filter((name) => /^\d+_work_orchestrator_v2_foundation\.sql$/.test(name));

test('foundation migration enforces the private service-role schema contract', () => {
  assert.equal(migrationFiles.length, 1, 'exactly one foundation migration must exist');
  const sql = readFileSync(join(migrationsDirectory, migrationFiles[0]), 'utf8');

  for (const table of ['message_notification_receipts', 'work_items_v2', 'digest_runs', 'digest_message_parts']) {
    assert.match(sql, new RegExp(`create table public\\.${table}`, 'i'));
    assert.match(sql, new RegExp(`alter table public\\.${table} enable row level security`, 'i'));
    assert.match(sql, new RegExp(`revoke all on table public\\.${table} from public, anon, authenticated`, 'i'));
    assert.match(sql, new RegExp(`grant select, insert, update, delete on table public\\.${table} to service_role`, 'i'));
  }
  assert.match(sql, /unique\s*\(source_event_key\)/i);
  assert.match(sql, /notification_state in \('pending','delivering','delivered','failed','cleanup_pending','deleted'\)/i);
  assert.match(sql, /state in \('open','in_progress','snoozed','resolved','dismissed'\)/i);
  assert.match(sql, /part_kind in \('ordinary','daily_reminder'\)/i);
  assert.match(sql, /delivery_state in \('planned','delivering','delivered','failed'\)/i);
  assert.match(sql, /cleanup_state in \('idle','deleting','deleted','already_absent','failed'\)/i);
  assert.match(sql, /payload_hash.*\^\[0-9a-f\]\{64\}\$/i);
  assert.match(sql, /unique\s*\(digest_run_id,\s*part_kind,\s*part_number\)/i);
  assert.match(sql, /unique\s*\(digest_run_id,\s*client_message_id\)/i);
  assert.match(sql, /security invoker/i);
  assert.match(sql, /set search_path = ''/i);
  assert.match(sql, /revoke execute on function public\.claim_message_notification_receipt/i);
  assert.doesNotMatch(sql, /create policy/i);
});

test('foundation migration defines private atomic work and digest RPC contracts', () => {
  assert.equal(migrationFiles.length, 1, 'exactly one foundation migration must exist');
  const sql = readFileSync(join(migrationsDirectory, migrationFiles[0]), 'utf8');
  const functions = [
    'is_effective_p0_ack_v2',
    'upsert_work_item_v2',
    'request_work_item_action_v2',
    'list_actionable_work_v2',
    'claim_digest_run_v2',
    'prepare_digest_parts_v2',
    'claim_digest_part_delivery_v2',
    'mark_digest_part_delivered_v2',
    'mark_digest_part_failed_v2',
    'finalize_digest_run_v2',
    'fail_digest_run_v2',
    'list_digest_cleanup_backlog_v2',
    'claim_digest_part_cleanup_v2',
    'record_digest_part_cleanup_v2'
  ];

  for (const functionName of functions) {
    assert.match(sql, new RegExp(`create function public\\.${functionName}\\(`, 'i'));
    assert.match(sql, new RegExp(
      `create function public\\.${functionName}\\([\\s\\S]*?security invoker set search_path = ''`,
      'i'
    ));
    assert.match(sql, new RegExp(`revoke execute on function public\\.${functionName}\\(`, 'i'));
    assert.match(sql, new RegExp(`grant execute on function public\\.${functionName}\\(`, 'i'));
  }

  assert.match(sql, /on conflict do nothing/i, 'partial active-key races use target-free conflict handling');
  assert.doesNotMatch(sql, /on conflict\s*\(\s*work_key\s*\)/i, 'partial index is not used as a full unique target');
  assert.match(sql, /for update/i, 'work and digest rows are locked before mutation');
  assert.match(sql, /jsonb_array_elements\(p_item_snapshot\)/i);
  assert.match(sql, /jsonb_array_elements\(v_run\.item_snapshot\)/i);
  assert.match(sql, /w\.version\s*=\s*\(s\.entry->>'version'\)::integer/i);
  assert.match(sql, /w\.state in \('open','in_progress','snoozed'\)/i);
  assert.match(sql, /lease_token uuid/i);
  assert.match(sql, /pg_advisory_xact_lock\s*\(\s*hashtextextended/i);
  assert.match(sql, /isfinite\s*\(/i, 'all RPC timestamps reject infinity');
  assert.match(sql, /count\(distinct \(entry->>'id'\)::uuid\)/i, 'snapshot UUID duplicates use canonical UUID identity');
  assert.match(sql, /previous_digest_id/i);
  assert.match(sql, /previous_cleanup_state/i);
  assert.match(
    sql,
    /create function public\.list_digest_cleanup_backlog_v2\([\s\S]*?p_limit[^;]*?between 1 and 10[\s\S]*?state in \('delivered','replaced'\)/i,
    'cleanup backlog is finite and keeps confirmed replaced successors eligible'
  );
  assert.match(
    sql,
    /create function public\.list_digest_cleanup_backlog_v2\([\s\S]*?limit p_limit[\s\S]*?limit 50/i,
    'cleanup backlog bounds both successor runs and exact parts per successor'
  );
  assert.match(
    sql,
    /create function public\.claim_digest_part_cleanup_v2\([\s\S]*?v_row\.state not in \('delivered','replaced'\)[\s\S]*?v_row\.delivered_at is null[\s\S]*?v_row\.manifest_prepared_at is null/i,
    'cleanup claim accepts only confirmed delivered or replaced successors'
  );
  assert.match(
    sql,
    /create function public\.record_digest_part_cleanup_v2\([\s\S]*?v_row\.state not in \('delivered','replaced'\)[\s\S]*?v_row\.delivered_at is null[\s\S]*?v_row\.manifest_prepared_at is null/i,
    'cleanup settlement uses the same confirmed-successor predicate'
  );
  assert.match(sql, /manifest_prepared_at/i);
  assert.match(sql, /delivery_attempts.*between 0 and 3/is);
  assert.match(sql, /cleanup_token uuid/i);
  assert.match(sql, /cleanup_expires_at timestamptz/i);
  assert.match(sql, /state in \('building','delivering','failed'\)/i, 'expired delivering runs are reclaimable');
  assert.doesNotMatch(
    sql,
    /create function public\.finalize_digest_run_v2\([\s\S]*?p_item_snapshot/i,
    'finalization cannot accept a caller-provided snapshot or representative coordinate'
  );
  assert.doesNotMatch(sql, /create function public\.record_digest_cleanup_v2\(/i);
  assert.match(sql, /slack_message_ts.*\^\[0-9\]/i);
  assert.match(
    sql,
    /left\s*\(\s*p_payload->>'p0_acknowledged_at'\s*,\s*4\s*\)\s*=\s*'0000'/i,
    'the shared acknowledgement helper explicitly rejects year zero'
  );
});
