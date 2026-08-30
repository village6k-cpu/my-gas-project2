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

  for (const table of ['message_notification_receipts', 'work_items_v2', 'digest_runs']) {
    assert.match(sql, new RegExp(`create table public\\.${table}`, 'i'));
    assert.match(sql, new RegExp(`alter table public\\.${table} enable row level security`, 'i'));
    assert.match(sql, new RegExp(`revoke all on table public\\.${table} from public, anon, authenticated`, 'i'));
    assert.match(sql, new RegExp(`grant select, insert, update, delete on table public\\.${table} to service_role`, 'i'));
  }
  assert.match(sql, /unique\s*\(source_event_key\)/i);
  assert.match(sql, /notification_state in \('pending','delivering','delivered','failed','cleanup_pending','deleted'\)/i);
  assert.match(sql, /state in \('open','in_progress','snoozed','resolved','dismissed'\)/i);
  assert.match(sql, /security invoker/i);
  assert.match(sql, /set search_path = ''/i);
  assert.match(sql, /revoke execute on function public\.claim_message_notification_receipt/i);
  assert.doesNotMatch(sql, /create policy/i);
});

test('foundation migration defines private atomic work and digest RPC contracts', () => {
  assert.equal(migrationFiles.length, 1, 'exactly one foundation migration must exist');
  const sql = readFileSync(join(migrationsDirectory, migrationFiles[0]), 'utf8');
  const functions = [
    'upsert_work_item_v2',
    'request_work_item_action_v2',
    'list_actionable_work_v2',
    'claim_digest_run_v2',
    'finalize_digest_run_v2',
    'fail_digest_run_v2',
    'record_digest_cleanup_v2'
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
  assert.match(sql, /w\.version\s*=\s*\(s\.entry->>'version'\)::integer/i);
  assert.match(sql, /w\.state in \('open','in_progress','snoozed'\)/i);
  assert.match(sql, /lease_token uuid/i);
  assert.match(sql, /pg_advisory_xact_lock\s*\(\s*hashtextextended/i);
  assert.match(sql, /isfinite\s*\(/i, 'all RPC timestamps reject infinity');
  assert.match(sql, /count\(distinct \(entry->>'id'\)::uuid\)/i, 'snapshot UUID duplicates use canonical UUID identity');
  assert.match(sql, /previous_digest_id/i);
  assert.match(sql, /previous_cleanup_state/i);
  assert.match(sql, /slack_message_ts.*\^\[0-9\]/i);
});
