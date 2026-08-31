import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const migrationsDirectory = join(import.meta.dirname, '..', '..', 'supabase', 'migrations');
const migrationFiles = readdirSync(migrationsDirectory)
  .filter((name) => /^\d+_work_orchestrator_v2_foundation\.sql$/.test(name));
const noticeCleanupMigrationFiles = readdirSync(migrationsDirectory)
  .filter((name) => /^\d+_work_orchestrator_v2_notice_cleanup\.sql$/.test(name));

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
  assert.match(sql, /delivery_retry_at timestamptz/i);
  assert.match(
    sql,
    /delivery_error\s*=\s*'rate_limited'[\s\S]*?delivery_retry_at is not null[\s\S]*?isfinite\s*\(\s*delivery_retry_at\s*\)[\s\S]*?delivery_error\s*<>\s*'rate_limited'[\s\S]*?delivery_retry_at is null/i,
    'only rate-limited failed parts carry a finite durable retry timestamp'
  );
  assert.match(sql, /cleanup_state in \('idle','deleting','deleted','already_absent','failed'\)/i);
  assert.match(sql, /generation integer not null default 1 check \(generation > 0\)/i);
  assert.match(sql, /state in \('building','delivering','delivered','failed','diverged','replaced','retired'\)/i);
  assert.match(sql, /unique\s*\(destination_key,\s*scheduled_at,\s*generation\)/i);
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
    'is_processable_pending_work_action_v2',
    'list_pending_work_actions_v2',
    'list_actionable_work_v2',
    'claim_digest_run_v2',
    'claim_divergent_digest_run_v2',
    'prepare_digest_parts_v2',
    'claim_digest_part_delivery_v2',
    'mark_digest_part_delivered_v2',
    'mark_digest_part_failed_v2',
    'mark_digest_generation_diverged_v2',
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
  assert.match(
    sql,
    /request_work_item_action_v2[\s\S]*?pg_advisory_xact_lock[\s\S]*?not exists\s*\([\s\S]*?digest_runs[\s\S]*?state in \('building','delivering','failed'\)[\s\S]*?manifest_prepared_at is not null[\s\S]*?jsonb_array_elements/i,
    'Slack action requests are atomically fenced from unfinished prepared digest snapshots'
  );
  assert.match(
    sql,
    /is_processable_pending_work_action_v2[\s\S]*?v_type not in \('progress','snooze','ack_p0','dismiss'\)[\s\S]*?list_pending_work_actions_v2[\s\S]*?p_limit not between 1 and 50[\s\S]*?order by[\s\S]*?limit p_limit/i,
    'processable pending actions are validated and filtered before the bounded limit'
  );
  assert.match(sql, /jsonb_array_elements\(p_item_snapshot\)/i);
  assert.match(sql, /jsonb_array_elements\(v_run\.item_snapshot\)/i);
  assert.match(sql, /w\.version\s*=\s*\(s\.entry->>'version'\)::integer/i);
  assert.match(sql, /w\.state in \('open','in_progress','snoozed'\)/i);
  assert.match(sql, /lease_token uuid/i);
  assert.match(sql, /pg_advisory_xact_lock\s*\(\s*hashtextextended/i);
  assert.match(
    sql,
    /create function public\.claim_digest_run_v2\([\s\S]*?pg_advisory_xact_lock[\s\S]*?select \* into v_row[\s\S]*?insert into public\.digest_runs/i,
    'the destination advisory transaction lock is acquired before same-slot lookup and insertion'
  );
  assert.match(
    sql,
    /create function public\.claim_divergent_digest_run_v2\([\s\S]*?pg_advisory_xact_lock[\s\S]*?scheduled_at\s*<\s*p_before_scheduled_at[\s\S]*?return public\.claim_digest_run_v2/i,
    'the same destination lock protects selection before the serialized same-slot claim creates the successor'
  );
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
  assert.match(
    sql,
    /prepare_digest_parts_v2[\s\S]*?'manifest_mismatch'[\s\S]*?mark_digest_generation_diverged_v2[\s\S]*?state = 'diverged'[\s\S]*?digest_generation_diverged/i,
    'immutable manifest divergence has a typed no-cleanup successor handoff path'
  );
  assert.match(
    sql,
    /claim_digest_run_v2[\s\S]*?v_row\.state = 'diverged'[\s\S]*?v_row\.generation \+ 1[\s\S]*?v_row\.id/i,
    'a same-slot successor is generation N+1 and durably links to divergent N'
  );
  assert.match(
    sql,
    /list_digest_cleanup_backlog_v2[\s\S]*?with recursive[\s\S]*?previous_digest_id[\s\S]*?state in \('delivered','replaced'\)/i,
    'only a delivered successor exposes its bounded inherited cleanup chain'
  );
  assert.doesNotMatch(
    sql,
    /chain\.depth\s*<\s*50/i,
    'cleanup authorization and retirement never silently hide a chain tail at depth fifty'
  );
  assert.match(
    sql,
    /with recursive cleanup_chain[\s\S]*?uuid\[\][\s\S]*?not\s+[^;]*?=\s*any\s*\(\s*chain\.[a-z_]+\s*\)/i,
    'recursive cleanup traversal terminates by UUID cycle detection'
  );
  assert.match(
    sql,
    /record_digest_part_cleanup_v2[\s\S]*?state = 'retired'[\s\S]*?previous_cleanup_state in \('deleted','already_absent'\)/i,
    'divergent ancestors retire only after their own and inherited cleanup links converge'
  );
  assert.doesNotMatch(sql, /create function public\.(?:claim|record)_digest_generation_part_cleanup_v2\(/i);
  assert.doesNotMatch(sql, /create function public\.retire_digest_generation_v2\(/i);
  assert.match(sql, /delivery_attempts.*between 0 and 3/is);
  assert.match(
    sql,
    /create function public\.claim_digest_part_delivery_v2\([\s\S]*?delivery_retry_at\s*>\s*now\(\)[\s\S]*?return jsonb_build_object\('claimed', false[\s\S]*?delivery_retry_at\s*=\s*null/i,
    'delivery claims preserve attempts before Retry-After and clear the gate only on a real claim'
  );
  assert.match(
    sql,
    /create function public\.mark_digest_part_failed_v2\([\s\S]*?p_failed_at timestamptz[\s\S]*?p_retry_at timestamptz[\s\S]*?p_error = 'rate_limited'[\s\S]*?p_retry_at is null[\s\S]*?interval '1 day'[\s\S]*?p_retry_at is not null/i,
    'failure settlement validates exact bounded Retry-After input and forbids it for other errors'
  );
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

test('additive notice cleanup migration defines a private atomic lease and terminal CAS boundary', () => {
  assert.equal(noticeCleanupMigrationFiles.length, 1, 'exactly one additive notice-cleanup migration must exist');
  const sql = readFileSync(join(migrationsDirectory, noticeCleanupMigrationFiles[0]), 'utf8');
  const functions = [
    'claim_notice_cleanup_batch_v2',
    'link_notice_cleanup_from_receipt_v2',
    'link_notice_cleanup_from_work_v2',
    'mark_notice_cleanup_deleted_v2',
    'mark_notice_cleanup_failed_v2'
  ];

  assert.match(sql, /alter table public\.message_notification_receipts/i);
  assert.match(sql, /cleanup_attempts integer/i);
  assert.match(sql, /cleanup_owner text/i);
  assert.match(sql, /cleanup_token uuid/i);
  assert.match(sql, /cleanup_expires_at timestamptz/i);
  assert.match(sql, /cleanup_attempted_at timestamptz/i);
  assert.match(sql, /cleaned_at timestamptz/i);
  assert.match(sql, /cleanup_already_absent boolean/i);
  assert.match(sql, /cleanup_work_id uuid/i);
  assert.match(sql, /cleanup_work_version integer/i);
  assert.match(sql, /p_limit[^;]*?between 1 and 25/i);
  assert.match(sql, /for update skip locked/i);
  assert.match(sql, /cleanup_expires_at\s*<=\s*p_now/i);
  assert.match(sql, /snapshot\.entry->>'id'\s*=\s*receipt\.cleanup_work_id::text[\s\S]*?snapshot\.entry->>'version'\)::integer\s*=\s*receipt\.cleanup_work_version/i);
  assert.match(sql, /public\.is_effective_p0_ack_v2\(/i, 'cleanup reuses canonical P0 acknowledgement semantics');
  assert.match(sql, /public\.digest_runs[\s\S]*?jsonb_array_elements[\s\S]*?state in \('delivered','replaced'\)/i);
  assert.match(sql, /public\.work_items_v2[\s\S]*?source_event_keys/i);
  assert.match(sql, /notification_state\s*=\s*'cleanup_pending'[\s\S]*?cleanup_after\s*<=\s*p_now/i);
  assert.match(sql, /cleanup_expires_at\s*>\s*v_completed_at/i);
  assert.match(sql, /v_completed_at[^;]*?clock_timestamp\(\)/i);
  assert.doesNotMatch(sql, /p_(?:deleted|failed)_at timestamptz/i,
    'terminal time is owned by the database and cannot be supplied by a caller');

  for (const functionName of functions) {
    assert.match(sql, new RegExp(`create function public\\.${functionName}\\(`, 'i'));
    assert.match(sql, new RegExp(
      `create function public\\.${functionName}\\([\\s\\S]*?security invoker set search_path = ''`,
      'i'
    ));
    assert.match(sql, new RegExp(`revoke execute on function public\\.${functionName}\\(`, 'i'));
    assert.match(sql, new RegExp(`grant execute on function public\\.${functionName}\\(`, 'i'));
  }
  assert.doesNotMatch(sql, /create policy/i);
  assert.doesNotMatch(sql, /conversations\.(?:history|replies)|search\.messages|admin\./i);
});
