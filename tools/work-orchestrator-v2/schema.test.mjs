import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const migrationsDirectory = join(import.meta.dirname, '..', '..', 'supabase', 'migrations');
const migrationFiles = readdirSync(migrationsDirectory)
  .filter((name) => /^\d+_work_orchestrator_v2_foundation\.sql$/.test(name));
const noticeCleanupMigrationFiles = readdirSync(migrationsDirectory)
  .filter((name) => /^\d+_work_orchestrator_v2_notice_cleanup\.sql$/.test(name));
const healthAggregateMigrationFiles = readdirSync(migrationsDirectory)
  .filter((name) => /^\d+_work_orchestrator_v2_health_aggregate\.sql$/.test(name));

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
    'capture_notice_cleanup_work_sources_v2',
    'claim_notice_cleanup_batch_v2',
    'link_notice_cleanup_from_receipt_v2',
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
  assert.match(sql, /create table public\.notice_cleanup_work_sources_v2/i);
  assert.match(sql, /minimum_work_version integer not null/i);
  assert.match(sql, /cleanup_work_id uuid/i);
  assert.match(sql, /cleanup_work_version integer/i);
  assert.match(sql, /p_limit[^;]*?between 1 and 25/i);
  assert.match(sql, /for update(?: of receipt)? skip locked/i);
  assert.match(sql, /cleanup_expires_at\s*<=\s*p_now/i);
  assert.match(sql, /snapshot\.entry->>'id'\s*=\s*v_work_id::text[\s\S]*?snapshot\.entry->>'version'\)::integer\s*>=\s*v_work_version/i,
    'final digest eligibility uses the authoritative under-lock ownership recount');
  assert.match(sql, /digest\.delivered_at\s*>=\s*receipt\.created_at/i,
    'a digest delivered before the receipt cannot authorize cleanup of that later receipt');
  assert.match(sql, /count\(\*\)[\s\S]*?source_event_key\s*=\s*any\(work\.source_event_keys\)/i,
    'claim-time reconciliation rechecks exact source-event ownership');
  assert.doesNotMatch(sql, /create trigger link_notice_cleanup_from_work_v2/i,
    'claim-time reconciliation replaces the lossy work-side wakeup trigger');
  assert.match(sql, /public\.is_effective_p0_ack_v2\(/i, 'cleanup reuses canonical P0 acknowledgement semantics');
  assert.match(sql, /public\.digest_runs[\s\S]*?jsonb_array_elements[\s\S]*?state in \('delivered','replaced'\)/i);
  assert.match(sql, /public\.work_items_v2[\s\S]*?source_event_keys/i);
  assert.match(sql, /notification_state\s*=\s*'cleanup_pending'[\s\S]*?cleanup_after\s*<=\s*p_now/i);
  assert.match(sql, /cleanup_expires_at\s*>\s*v_completed_at/i);
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

test('notice cleanup terminal functions lock the exact generation before reading DB time', () => {
  const sql = readFileSync(join(migrationsDirectory, noticeCleanupMigrationFiles[0]), 'utf8');
  for (const terminalName of ['mark_notice_cleanup_deleted_v2', 'mark_notice_cleanup_failed_v2']) {
    const match = sql.match(new RegExp(
      `create function public\\.${terminalName}\\([\\s\\S]*?\\$\\$;`,
      'i'
    ));
    assert.ok(match, `${terminalName} exists`);
    const lockIndex = match[0].search(/select[\s\S]*?into\s+v_row[\s\S]*?for update/i);
    const clockIndex = match[0].search(/v_completed_at\s*:=\s*clock_timestamp\(\)/i);
    assert.ok(lockIndex >= 0 && clockIndex > lockIndex,
      `${terminalName} captures terminal time only after acquiring the row lock`);
  }
});

test('notice cleanup serializes exact source ownership only after a bounded receipt claim', () => {
  const sql = readFileSync(join(migrationsDirectory, noticeCleanupMigrationFiles[0]), 'utf8');
  const claim = sql.match(/create function public\.claim_notice_cleanup_batch_v2\([\s\S]*?\$\$;/i)?.[0];
  const capture = sql.match(/create function public\.capture_notice_cleanup_work_sources_v2\([\s\S]*?\$\$;/i)?.[0];
  assert.ok(claim && capture, 'claim and membership capture functions exist');
  const boundedLock = claim.search(/for update of receipt skip locked\s+limit p_limit/i);
  assert.ok(boundedLock >= 0, 'the claim locks at most p_limit receipt rows before mutation');
  const firstGlobalMutation = claim.search(
    /insert into public\.notice_cleanup_work_sources_v2[\s\S]*?from public\.work_items_v2|update public\.message_notification_receipts as receipt[\s\S]*?from ownership/i
  );
  assert.ok(firstGlobalMutation < 0 || firstGlobalMutation > boundedLock,
    'no global membership backfill or receipt reconciliation runs before the bounded lock');
  for (const body of [claim, capture]) {
    assert.match(body, /pg_advisory_xact_lock\(hashtextextended\(\s*'notice-cleanup-source:'\s*\|\|/i,
      'claim and membership capture share the exact source-key advisory namespace');
    assert.match(body, /91420260901/i, 'claim and membership capture share the exact advisory seed');
  }
  assert.match(capture, /order by source_key/i,
    'multi-key work membership locks are acquired deterministically');
  assert.match(sql, /after insert or delete or update of source_event_keys, version/i,
    'work ownership removal and deletion use the same serialized trigger');
});

test('work source removal and deletion take the same cleanup ownership lock', () => {
  const sql = readFileSync(join(migrationsDirectory, noticeCleanupMigrationFiles[0]), 'utf8');
  const capture = sql.match(/create function public\.capture_notice_cleanup_work_sources_v2\([\s\S]*?\$\$;/i)?.[0];
  assert.ok(capture, 'membership capture function exists');
  assert.match(capture,
    /unnest\(old\.source_event_keys\)[\s\S]*?not \(source_key = any\(new\.source_event_keys\)\)/i,
    'UPDATE removal keys participate in the deterministic advisory-lock set');
  assert.match(sql,
    /create trigger capture_notice_cleanup_work_sources_v2\s+after insert or delete or update of source_event_keys, version/i,
    'DELETE ownership changes invoke the same advisory-lock trigger');
});

test('bounded cleanup candidates acquire every source lock lexically before receipt processing', () => {
  const sql = readFileSync(join(migrationsDirectory, noticeCleanupMigrationFiles[0]), 'utf8');
  const claim = sql.match(/create function public\.claim_notice_cleanup_batch_v2\([\s\S]*?\$\$;/i)?.[0];
  assert.ok(claim, 'claim function exists');
  const boundedRows = claim.search(
    /array_agg\(candidate\.id[\s\S]*?into\s+v_candidate_ids[\s\S]*?for update of receipt skip locked\s+limit p_limit/i
  );
  const orderedLocks = claim.search(
    /for v_source_key in[\s\S]*?select distinct receipt\.source_event_key[\s\S]*?id = any\(v_candidate_ids\)[\s\S]*?order by receipt\.source_event_key/i
  );
  const receiptProcessing = claim.search(
    /for v_row in[\s\S]*?id = any\(v_candidate_ids\)[\s\S]*?array_position\(v_candidate_ids, receipt\.id\)/i
  );
  assert.ok(boundedRows >= 0, 'receipt rows are bounded and locked into one candidate set');
  assert.ok(orderedLocks > boundedRows, 'all distinct source locks are acquired after bounded row locks');
  assert.ok(receiptProcessing > orderedLocks, 'receipt mutation starts only after every source lock is held');
  assert.match(claim.slice(orderedLocks, receiptProcessing),
    /pg_advisory_xact_lock\(hashtextextended\(\s*'notice-cleanup-source:'\s*\|\|\s*v_source_key,\s*91420260901/i);
});

test('cleanup claim never mutates work membership while holding source ownership locks', () => {
  const sql = readFileSync(join(migrationsDirectory, noticeCleanupMigrationFiles[0]), 'utf8');
  const claim = sql.match(/create function public\.claim_notice_cleanup_batch_v2\([\s\S]*?\$\$;/i)?.[0];
  assert.ok(claim, 'claim function exists');
  assert.doesNotMatch(claim,
    /(?:insert\s+into|update|delete\s+from)\s+public\.notice_cleanup_work_sources_v2/i,
    'only the migration backfill and work trigger maintain membership rows');
});

test('additive health migration exposes exactly one private read-only aggregate RPC', () => {
  assert.equal(healthAggregateMigrationFiles.length, 1, 'exactly one additive health aggregate migration must exist');
  const sql = readFileSync(join(migrationsDirectory, healthAggregateMigrationFiles[0]), 'utf8');

  assert.equal(
    (sql.match(/create(?:\s+or\s+replace)?\s+function\s+public\./gi) || []).length,
    2,
    'the migration adds one aggregate RPC and one deterministic read-only action validator'
  );
  assert.match(sql, /create function public\.is_valid_pending_work_action_at_v2\(\s*p_pending jsonb,\s*p_current_version integer,\s*p_now timestamptz\s*\)/i);
  assert.match(sql, /returns boolean language plpgsql stable security invoker set search_path = ''/i);
  const helperSql = sql.slice(
    sql.search(/create function public\.is_valid_pending_work_action_at_v2/i),
    sql.search(/create function public\.read_work_orchestrator_health_v2/i)
  );
  assert.doesNotMatch(helperSql, /\b(?:now|clock_timestamp)\s*\(/i, 'health action validation uses only p_now');
  assert.match(sql, /create function public\.read_work_orchestrator_health_v2\(\s*p_now timestamptz\s*\)/i);
  assert.match(sql, /returns jsonb language plpgsql stable security invoker set search_path = ''/i);
  assert.match(sql, /p_now is null[\s\S]*?not isfinite\(p_now\)[\s\S]*?22023/i);
  assert.match(sql, /revoke execute on function public\.read_work_orchestrator_health_v2\(timestamptz\)\s+from public, anon, authenticated/i);
  assert.match(sql, /grant execute on function public\.read_work_orchestrator_health_v2\(timestamptz\)\s+to service_role/i);
  assert.match(sql, /revoke execute on function public\.is_valid_pending_work_action_at_v2\(jsonb,integer,timestamptz\)\s+from public, anon, authenticated/i);
  assert.match(sql, /grant execute on function public\.is_valid_pending_work_action_at_v2\(jsonb,integer,timestamptz\)\s+to service_role/i);
  assert.doesNotMatch(sql, /security definer|create policy|grant execute[^;]+to (?:public|anon|authenticated)/i);
  assert.doesNotMatch(sql, /\b(insert|update|delete|merge|truncate)\b/i, 'health aggregation remains read-only');

  for (const bucket of [
    'notifications', 'automation', 'work', 'digests', 'cleanup', 'actions', 'leases',
    'notice_cleanup', 'digest_cleanup'
  ]) assert.match(sql, new RegExp(`'${bucket}'`, 'i'));
  for (const table of [
    'message_notification_receipts', 'work_items_v2', 'digest_runs', 'digest_message_parts'
  ]) assert.match(sql, new RegExp(`public\\.${table}`, 'i'));
  assert.match(sql, /lease_expires_at\s*>\s*p_now/i);
  assert.match(sql, /lease_expires_at\s*<=\s*p_now/i);
  assert.match(sql, /reconcile_expires_at/i);
  assert.match(sql, /latest_delivered_eligible_omitted_count/i);
  assert.match(sql, /unacknowledged_p0_missing_alert_count/i);
  assert.match(sql, /stale_conflict_count/i);
  assert.match(sql, /not public\.is_valid_pending_work_action_at_v2\(pending_action, version, p_now\)/i);
  assert.match(sql, /invalid_evidence_count/i);
  const healthFunctionSql = sql.match(
    /create function public\.read_work_orchestrator_health_v2\([\s\S]*?\n\$\$;/i
  )?.[0];
  const invalidEvidenceEnd = healthFunctionSql?.search(/\n\s*with recursive\b/i) ?? -1;
  const invalidEvidencePhase = invalidEvidenceEnd > 0
    ? healthFunctionSql.slice(0, invalidEvidenceEnd)
    : null;
  assert.ok(invalidEvidencePhase, 'the invalid-evidence phase is explicit and bounded');
  const invalidEvidenceScanCounts = Object.fromEntries([
    'message_notification_receipts', 'work_items_v2', 'digest_runs', 'digest_message_parts'
  ].map((table) => [
    table,
    (invalidEvidencePhase.match(new RegExp(`from public\\.${table}\\b`, 'gi')) || []).length
  ]));
  assert.deepEqual(invalidEvidenceScanCounts, {
    message_notification_receipts: 1,
    work_items_v2: 1,
    digest_runs: 1,
    digest_message_parts: 1
  }, 'the invalid-evidence phase scans each base table once');
  for (const timestamp of [
    'created_at', 'actionable_at', 'first_opened_at', 'delivered_at', 'cleanup_after',
    'cleanup_attempted_at', 'updated_at', 'cleanup_expires_at', 'scheduled_at',
    'manifest_prepared_at', 'lease_expires_at'
  ]) assert.match(sql, new RegExp(`isfinite\\([^)]*${timestamp}`, 'i'));
});
