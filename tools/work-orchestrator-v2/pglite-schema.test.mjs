import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';

const migrationsDirectory = join(import.meta.dirname, '..', '..', 'supabase', 'migrations');
const [migrationName] = readdirSync(migrationsDirectory)
  .filter((name) => /^\d+_work_orchestrator_v2_foundation\.sql$/.test(name));
const [noticeCleanupMigrationName] = readdirSync(migrationsDirectory)
  .filter((name) => /^\d+_work_orchestrator_v2_notice_cleanup\.sql$/.test(name));
const [p0DeliveryMigrationName] = readdirSync(migrationsDirectory)
  .filter((name) => /^\d+_work_orchestrator_v2_p0_delivery\.sql$/.test(name));
const [p0ReconciliationMigrationName] = readdirSync(migrationsDirectory)
  .filter((name) => /^\d+_work_orchestrator_v2_p0_reconciliation\.sql$/.test(name));

async function createFoundationDatabase() {
  const db = new PGlite({ extensions: { pgcrypto } });
  await db.exec(`
    create role anon nologin;
    create role authenticated nologin;
    create role service_role nologin;
    create extension if not exists pgcrypto;
  `);
  await db.exec(readFileSync(join(migrationsDirectory, migrationName), 'utf8'));
  return db;
}

async function createNoticeCleanupDatabase() {
  const db = await createFoundationDatabase();
  await db.exec(readFileSync(join(migrationsDirectory, noticeCleanupMigrationName), 'utf8'));
  return db;
}

async function createP0DeliveryDatabase() {
  const db = await createFoundationDatabase();
  assert.ok(p0DeliveryMigrationName, 'the additive P0 delivery migration must exist');
  await db.exec(readFileSync(join(migrationsDirectory, p0DeliveryMigrationName), 'utf8'));
  return db;
}

async function createP0ReconciliationDatabase() {
  const db = await createP0DeliveryDatabase();
  assert.ok(p0ReconciliationMigrationName, 'the additive P0 reconciliation migration must exist');
  await db.exec(readFileSync(join(migrationsDirectory, p0ReconciliationMigrationName), 'utf8'));
  return db;
}

test('foundation migration executes and exposes only service-role access in PostgreSQL', async () => {
  assert.ok(migrationName, 'the CLI-generated foundation migration must exist');
  const db = new PGlite({ extensions: { pgcrypto } });

  try {
    await db.exec(`
      create role anon nologin;
      create role authenticated nologin;
      create role service_role nologin;
      create extension if not exists pgcrypto;
    `);
    await db.exec(readFileSync(join(migrationsDirectory, migrationName), 'utf8'));

    const { rows: tables } = await db.query(`
      select c.relname, c.relrowsecurity
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public'
        and c.relname in ('message_notification_receipts', 'work_items_v2', 'digest_runs', 'digest_message_parts')
      order by c.relname
    `);
    assert.deepEqual(tables.map((row) => row.relname), [
      'digest_message_parts',
      'digest_runs',
      'message_notification_receipts',
      'work_items_v2',
    ]);
    assert.ok(tables.every((row) => row.relrowsecurity === true), 'all v2 tables enable RLS');

    const { rows: tablePrivileges } = await db.query(`
      select c.relname,
        has_table_privilege('anon', c.oid, 'select') as anon_select,
        has_table_privilege('anon', c.oid, 'insert') as anon_insert,
        has_table_privilege('anon', c.oid, 'update') as anon_update,
        has_table_privilege('anon', c.oid, 'delete') as anon_delete,
        has_table_privilege('authenticated', c.oid, 'select') as authenticated_select,
        has_table_privilege('authenticated', c.oid, 'insert') as authenticated_insert,
        has_table_privilege('authenticated', c.oid, 'update') as authenticated_update,
        has_table_privilege('authenticated', c.oid, 'delete') as authenticated_delete,
        has_table_privilege('service_role', c.oid, 'select') as service_role_select,
        has_table_privilege('service_role', c.oid, 'insert') as service_role_insert,
        has_table_privilege('service_role', c.oid, 'update') as service_role_update,
        has_table_privilege('service_role', c.oid, 'delete') as service_role_delete
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public'
        and c.relname in ('message_notification_receipts', 'work_items_v2', 'digest_runs', 'digest_message_parts')
      order by c.relname
    `);
    for (const row of tablePrivileges) {
      assert.deepEqual(
        [row.anon_select, row.anon_insert, row.anon_update, row.anon_delete],
        [false, false, false, false],
        `anon has no CRUD privileges on ${row.relname}`,
      );
      assert.deepEqual(
        [row.authenticated_select, row.authenticated_insert, row.authenticated_update, row.authenticated_delete],
        [false, false, false, false],
        `authenticated has no CRUD privileges on ${row.relname}`,
      );
      assert.deepEqual(
        [row.service_role_select, row.service_role_insert, row.service_role_update, row.service_role_delete],
        [true, true, true, true],
        `service_role has CRUD privileges on ${row.relname}`,
      );
    }

    const { rows: publicTablePrivileges } = await db.query(`
      select count(*)::integer as count
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      cross join lateral aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) as acl
      where n.nspname = 'public'
        and c.relname in ('message_notification_receipts', 'work_items_v2', 'digest_runs', 'digest_message_parts')
        and acl.grantee = 0
        and lower(acl.privilege_type) in ('select', 'insert', 'update', 'delete')
    `);
    assert.equal(Number(publicTablePrivileges[0].count), 0, 'PUBLIC has no v2 table privileges');

    const { rows: functions } = await db.query(`
      select p.oid,
        p.proname,
        p.prosecdef,
        coalesce(array_to_string(p.proconfig, ','), '') as config,
        has_function_privilege('anon', p.oid, 'execute') as anon_execute,
        has_function_privilege('authenticated', p.oid, 'execute') as authenticated_execute,
        has_function_privilege('service_role', p.oid, 'execute') as service_role_execute
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public'
        and p.proname in (
          'touch_work_orchestrator_v2_updated_at',
          'claim_message_notification_receipt',
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
        )
      order by p.proname
    `);
    assert.deepEqual(functions.map((row) => row.proname), [
      'claim_digest_part_cleanup_v2',
      'claim_digest_part_delivery_v2',
      'claim_digest_run_v2',
      'claim_divergent_digest_run_v2',
      'claim_message_notification_receipt',
      'fail_digest_run_v2',
      'finalize_digest_run_v2',
      'is_effective_p0_ack_v2',
      'is_processable_pending_work_action_v2',
      'list_actionable_work_v2',
      'list_digest_cleanup_backlog_v2',
      'list_pending_work_actions_v2',
      'mark_digest_generation_diverged_v2',
      'mark_digest_part_delivered_v2',
      'mark_digest_part_failed_v2',
      'prepare_digest_parts_v2',
      'record_digest_part_cleanup_v2',
      'request_work_item_action_v2',
      'touch_work_orchestrator_v2_updated_at',
      'upsert_work_item_v2',
    ]);
    assert.ok(functions.every((row) => row.prosecdef === false), 'functions are SECURITY INVOKER');
    assert.ok(functions.every((row) => row.config === 'search_path=""'), 'functions set an empty search_path');
    assert.ok(functions.every((row) => row.anon_execute === false));
    assert.ok(functions.every((row) => row.authenticated_execute === false));
    assert.ok(functions.every((row) => row.service_role_execute === true));

    const { rows: publicFunctionPrivileges } = await db.query(`
      select count(*)::integer as count
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      cross join lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) as acl
      where n.nspname = 'public'
        and p.proname in (
          'touch_work_orchestrator_v2_updated_at',
          'claim_message_notification_receipt',
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
        )
        and acl.grantee = 0
        and lower(acl.privilege_type) = 'execute'
    `);
    assert.equal(Number(publicFunctionPrivileges[0].count), 0, 'PUBLIC has no v2 function EXECUTE');

    const { rows: triggers } = await db.query(`
      select t.tgname
      from pg_trigger t
      join pg_class c on c.oid = t.tgrelid
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public'
        and t.tgname in (
          'touch_message_notification_receipts_updated_at',
          'touch_work_items_v2_updated_at',
          'touch_digest_runs_updated_at',
          'touch_digest_message_parts_updated_at'
        )
        and not t.tgisinternal
      order by t.tgname
    `);
    assert.deepEqual(triggers.map((row) => row.tgname), [
      'touch_digest_message_parts_updated_at',
      'touch_digest_runs_updated_at',
      'touch_message_notification_receipts_updated_at',
      'touch_work_items_v2_updated_at',
    ]);

    const acknowledgementCases = [
      ['null payload', null, '2026-08-29T06:00:00.000Z', false],
      ['non-record payload', 'not-a-record', '2026-08-29T06:00:00.000Z', false],
      ['array payload', [], '2026-08-29T06:00:00.000Z', false],
      ['missing acknowledgement', {}, '2026-08-29T06:00:00.000Z', false],
      ['null acknowledgement', { p0_acknowledged_at: null }, '2026-08-29T06:00:00.000Z', false],
      ['array acknowledgement', { p0_acknowledged_at: [] }, '2026-08-29T06:00:00.000Z', false],
      ['malformed acknowledgement', { p0_acknowledged_at: 'not-a-time' }, '2026-08-29T06:00:00.000Z', false],
      ['impossible calendar date', { p0_acknowledged_at: '2026-02-30T00:00:00.000Z' }, '2026-08-29T06:00:00.000Z', false],
      ['year zero', { p0_acknowledged_at: '0000-01-01T00:00:00.000Z' }, '2026-08-29T06:00:00.000Z', false],
      ['negative extended year', { p0_acknowledged_at: '-000001-01-01T00:00:00.000Z' }, '2026-08-29T06:00:00.000Z', false],
      ['positive extended year', { p0_acknowledged_at: '+010000-01-01T00:00:00.000Z' }, '2026-08-29T06:00:00.000Z', false],
      ['minimum supported year', { p0_acknowledged_at: '0001-01-01T00:00:00.000Z' }, '2026-08-29T06:00:00.000Z', true],
      ['normal past acknowledgement', { p0_acknowledged_at: '2026-08-29T05:59:59.999Z' }, '2026-08-29T06:00:00.000Z', true],
      ['normal boundary acknowledgement', { p0_acknowledged_at: '2026-08-29T06:00:00.000Z' }, '2026-08-29T06:00:00.000Z', true],
      ['normal future acknowledgement', { p0_acknowledged_at: '2026-08-29T06:00:00.001Z' }, '2026-08-29T06:00:00.000Z', false],
      ['maximum supported year', { p0_acknowledged_at: '9999-12-31T23:59:59.999Z' }, '9999-12-31T23:59:59.999Z', true]
    ];
    for (const [name, payload, cutoff, expected] of acknowledgementCases) {
      const { rows } = await db.query(`
        select public.is_effective_p0_ack_v2($1::jsonb, $2::timestamptz) as effective
      `, [JSON.stringify(payload), cutoff]);
      assert.equal(rows[0].effective, expected, name);
    }

    const claimInput = [
      'kakao',
      'pglite-event-1',
      'pglite-message-1',
      'pglite-room',
      '2026-08-30T00:00:00.000Z',
      '00000000-0000-0000-0000-000000000001',
      JSON.stringify({ source: 'pglite' }),
    ];
    const claimSql = `
      select public.claim_message_notification_receipt(
        $1, $2, $3, $4, $5::timestamptz, $6::uuid, $7::jsonb
      )->>'created' as created
    `;
    const firstClaim = await db.query(claimSql, claimInput);
    const secondClaim = await db.query(claimSql, claimInput);
    assert.equal(firstClaim.rows[0].created, 'true');
    assert.equal(secondClaim.rows[0].created, 'false');

    await db.query(`
      update public.message_notification_receipts
      set room_key = 'pglite-room-updated', updated_at = '2000-01-01T00:00:00.000Z'
      where source_event_key = 'pglite-event-1'
    `);
    const { rows: receipt } = await db.query(`
      select room_key, updated_at > '2000-01-01T00:00:00.000Z'::timestamptz as trigger_touched
      from public.message_notification_receipts
      where source_event_key = 'pglite-event-1'
    `);
    assert.deepEqual(receipt, [{ room_key: 'pglite-room-updated', trigger_touched: true }]);

    const candidate = {
      work_key: 'room:pglite:payment',
      source_event_keys: ['event-a'],
      room_key: 'room:pglite',
      title: 'Payment review',
      summary: 'Typed review',
      work_type: 'payment_check',
      priority: 'normal',
      state: 'open',
      owner_id: 'UOWNER',
      actionable_at: '2026-08-20T00:00:00.000Z',
      due_at: null,
      snoozed_until: null,
      first_opened_at: '2026-08-20T00:00:00.000Z',
      last_activity_at: '2026-08-20T00:00:00.000Z',
      automation_state: 'needs_human',
      payload: { requires_human_action: true, action_family: 'payment_reconcile' }
    };
    const upsertSql = `select public.upsert_work_item_v2($1::jsonb) as result`;
    const firstWork = await db.query(upsertSql, [JSON.stringify(candidate)]);
    await db.query(`
      update public.work_items_v2
      set digest_inclusion_count = 4,
          consecutive_unhandled_digests = 3,
          next_reminder_at = '2026-08-23T00:00:00.000Z',
          pending_action = '{"type":"progress","status":"pending"}'::jsonb,
          resolution_evidence = '{"preexisting":"audit"}'::jsonb,
          payload = payload || '{"p0_acknowledged_at":"2026-08-21T00:00:00.000Z"}'::jsonb
      where id = $1::uuid
    `, [firstWork.rows[0].result.row.id]);
    const mergedWork = await db.query(upsertSql, [JSON.stringify({
      ...candidate,
      source_event_keys: ['event-a', 'event-b'],
      title: 'Escalated payment review',
      priority: 'p0',
      owner_id: 'OTHER',
      first_opened_at: '2026-08-29T00:00:00.000Z',
      last_activity_at: '2026-08-29T00:00:00.000Z'
    })]);
    assert.equal(firstWork.rows[0].result.created, true);
    assert.equal(firstWork.rows[0].result.applied, true);
    assert.equal(mergedWork.rows[0].result.created, false);
    assert.equal(mergedWork.rows[0].result.applied, true);
    assert.equal(mergedWork.rows[0].result.row.version, 2);
    assert.deepEqual(mergedWork.rows[0].result.row.source_event_keys, ['event-a', 'event-b']);
    assert.equal(mergedWork.rows[0].result.row.priority, 'p0');
    assert.equal(mergedWork.rows[0].result.row.owner_id, 'UOWNER', 'original owner is preserved');
    assert.equal(mergedWork.rows[0].result.row.digest_inclusion_count, 4);
    assert.equal(mergedWork.rows[0].result.row.consecutive_unhandled_digests, 3);
    assert.equal(mergedWork.rows[0].result.row.pending_action.status, 'pending');
    assert.deepEqual(mergedWork.rows[0].result.row.resolution_evidence, { preexisting: 'audit' });
    assert.equal(
      mergedWork.rows[0].result.row.payload.p0_acknowledged_at,
      '2026-08-21T00:00:00.000Z'
    );
    assert.equal(
      new Date(mergedWork.rows[0].result.row.first_opened_at).toISOString(),
      '2026-08-20T00:00:00.000Z'
    );

    const staleLowerPriorityMerge = await db.query(upsertSql, [JSON.stringify({
      ...candidate,
      source_event_keys: ['event-stale'],
      priority: 'low',
      last_activity_at: '2026-08-19T00:00:00.000Z',
      payload: { requires_human_action: true, action_family: 'stale_overwrite' }
    })]);
    assert.equal(staleLowerPriorityMerge.rows[0].result.applied, true);
    assert.equal(staleLowerPriorityMerge.rows[0].result.row.version, 3);
    assert.equal(staleLowerPriorityMerge.rows[0].result.row.priority, 'p0');
    assert.equal(staleLowerPriorityMerge.rows[0].result.row.payload.action_family, 'payment_reconcile');
    assert.equal(staleLowerPriorityMerge.rows[0].result.row.pending_action.status, 'pending');

    const terminalId = staleLowerPriorityMerge.rows[0].result.row.id;
    await db.query(`
      update public.work_items_v2
      set state = 'resolved', version = 4, resolution_kind = 'authoritative',
          resolution_evidence = '{"readback":"confirmed"}'::jsonb,
          resolved_at = '2026-08-29T01:00:00.000Z', resolved_by = 'worker'
      where id = $1::uuid
    `, [terminalId]);
    const terminalRetry = await db.query(upsertSql, [JSON.stringify({ ...candidate, priority: 'urgent' })]);
    assert.equal(terminalRetry.rows[0].result.applied, false);
    assert.equal(terminalRetry.rows[0].result.created, false);
    assert.equal(terminalRetry.rows[0].result.row.state, 'resolved');
    assert.equal(terminalRetry.rows[0].result.row.version, 4);
    assert.deepEqual(terminalRetry.rows[0].result.row.resolution_evidence, { readback: 'confirmed' });
    const { rows: terminalCounts } = await db.query(`
      select count(*)::integer as total,
             count(*) filter (where state in ('open','in_progress','snoozed'))::integer as active
      from public.work_items_v2 where work_key = $1
    `, [candidate.work_key]);
    assert.deepEqual(terminalCounts, [{ total: 1, active: 0 }], 'terminal work is never reopened');

    const p0Candidate = {
      ...candidate,
      work_key: 'room:pglite:p0',
      source_event_keys: ['event-p0'],
      priority: 'p0'
    };
    const p0Work = await db.query(upsertSql, [JSON.stringify(p0Candidate)]);
    await db.query(`
      update public.work_items_v2
      set state = 'snoozed', snoozed_until = '2099-01-01T00:00:00.000Z',
          actionable_at = '2099-01-01T00:00:00.000Z'
      where id = $1::uuid
    `, [p0Work.rows[0].result.row.id]);
    const unacknowledgedP0Merge = await db.query(upsertSql, [JSON.stringify(p0Candidate)]);
    assert.equal(unacknowledgedP0Merge.rows[0].result.row.state, 'open');
    assert.equal(unacknowledgedP0Merge.rows[0].result.row.snoozed_until, null);

    await db.query(`
      update public.work_items_v2
      set state = 'snoozed', snoozed_until = '2099-01-01T00:00:00.000Z',
          actionable_at = '2099-01-01T00:00:00.000Z',
          payload = payload || '{"p0_acknowledged_at":"2026-08-21T00:00:00.000Z"}'::jsonb
      where id = $1::uuid
    `, [p0Work.rows[0].result.row.id]);
    const acknowledgedP0Merge = await db.query(upsertSql, [JSON.stringify(p0Candidate)]);
    assert.equal(acknowledgedP0Merge.rows[0].result.row.state, 'snoozed');
    assert.equal(
      new Date(acknowledgedP0Merge.rows[0].result.row.snoozed_until).toISOString(),
      '2099-01-01T00:00:00.000Z'
    );

    const staleP0Candidate = {
      ...candidate,
      work_key: 'room:pglite:stale-p0',
      source_event_keys: ['event-newer-normal'],
      last_activity_at: '2026-08-29T00:00:00.000Z',
      priority: 'normal'
    };
    const staleP0Work = await db.query(upsertSql, [JSON.stringify(staleP0Candidate)]);
    await db.query(`
      update public.work_items_v2
      set state = 'snoozed', snoozed_until = '2099-01-01T00:00:00.000Z',
          actionable_at = '2099-01-01T00:00:00.000Z'
      where id = $1::uuid
    `, [staleP0Work.rows[0].result.row.id]);
    const staleHigherP0 = await db.query(upsertSql, [JSON.stringify({
      ...staleP0Candidate,
      source_event_keys: ['event-older-p0'],
      last_activity_at: '2026-08-28T00:00:00.000Z',
      priority: 'p0'
    })]);
    assert.equal(staleHigherP0.rows[0].result.row.priority, 'normal');
    assert.equal(staleHigherP0.rows[0].result.row.state, 'snoozed');
    assert.equal(
      new Date(staleHigherP0.rows[0].result.row.snoozed_until).toISOString(),
      '2099-01-01T00:00:00.000Z'
    );

    const actionCandidate = {
      ...candidate,
      work_key: 'room:pglite:action',
      source_event_keys: ['event-action'],
      priority: 'normal'
    };
    const actionWork = await db.query(upsertSql, [JSON.stringify(actionCandidate)]);
    const actionId = actionWork.rows[0].result.row.id;
    const actionSql = `
      select public.request_work_item_action_v2(
        $1::uuid, $2::integer, $3::jsonb, $4::text
      ) as result
    `;
    const staleAction = await db.query(actionSql, [
      actionId, 99, JSON.stringify({ type: 'request_resolve' }), 'UOWNER'
    ]);
    assert.equal(staleAction.rows[0].result.applied, false);
    const appliedAction = await db.query(actionSql, [
      actionId, 1, JSON.stringify({ type: 'request_resolve' }), 'UOWNER'
    ]);
    assert.equal(appliedAction.rows[0].result.applied, true);
    assert.equal(appliedAction.rows[0].result.row.version, 2);
    assert.equal(appliedAction.rows[0].result.row.state, 'open', 'action request cannot resolve work');
    assert.equal(appliedAction.rows[0].result.row.pending_action.status, 'pending');

    await assert.rejects(
      db.query(upsertSql, [JSON.stringify({ ...candidate, state: null })]),
      /invalid work candidate/i
    );
    await assert.rejects(
      db.query(upsertSql, [JSON.stringify({ ...candidate, unreviewed: true })]),
      /invalid work candidate/i
    );
    await assert.rejects(
      db.query(upsertSql, [JSON.stringify({ ...candidate, actionable_at: 'infinity' })]),
      /invalid work candidate/i
    );
    await assert.rejects(
      db.query(actionSql, [actionId, 2, JSON.stringify({ type: 7 }), 'UOWNER']),
      /invalid work action request/i
    );
    await assert.rejects(
      db.query(actionSql, [
        actionId, 2, JSON.stringify({ type: 'progress', unreviewed: true }), 'UOWNER'
      ]),
      /invalid work action request/i
    );
    await assert.rejects(
      db.query(actionSql, [
        staleP0Work.rows[0].result.row.id, 2,
        JSON.stringify({ type: 'snooze', snoozedUntil: '2000-01-01T00:00:00.000Z' }), 'UOWNER'
      ]),
      /invalid work action request/i
    );

    const concurrentCandidate = {
      ...candidate,
      work_key: 'room:pglite:concurrent',
      source_event_keys: ['event-concurrent']
    };
    const concurrent = await Promise.all([
      db.query(upsertSql, [JSON.stringify(concurrentCandidate)]),
      db.query(upsertSql, [JSON.stringify(concurrentCandidate)])
    ]);
    assert.equal(concurrent.filter((result) => result.rows[0].result.created).length, 1);
    const { rows: concurrentRows } = await db.query(`
      select id, version from public.work_items_v2
      where work_key = 'room:pglite:concurrent' and state in ('open','in_progress','snoozed')
    `);
    assert.equal(concurrentRows.length, 1, 'partial unique key converges to one active row');
    assert.equal(concurrentRows[0].version, 2, 'one insert plus one merge each apply exactly once');

    const p0ListRows = [];
    for (const [suffix, acknowledgement, actionableAt] of [
      ['past', '1999-12-31T00:00:00.000Z', '2099-01-01T00:00:00.000Z'],
      ['boundary', '2000-01-01T00:00:00.000Z', '2099-01-02T00:00:00.000Z'],
      ['future', '2000-01-01T00:00:00.001Z', '2099-01-03T00:00:00.000Z'],
      ['missing', null, '2099-01-04T00:00:00.000Z'],
      ['malformed', 'not-a-timestamp', '2099-01-05T00:00:00.000Z']
    ]) {
      const inserted = await db.query(upsertSql, [JSON.stringify({
        ...candidate,
        work_key: `room:pglite:list-${suffix}`,
        source_event_keys: [`event-list-${suffix}`]
      })]);
      await db.query(`
        update public.work_items_v2
        set priority = 'p0', actionable_at = $2::timestamptz,
            payload = case when $3::text is null then payload - 'p0_acknowledged_at'
              else payload || jsonb_build_object('p0_acknowledged_at', $3::text) end
        where id = $1::uuid
      `, [inserted.rows[0].result.row.id, actionableAt, acknowledgement]);
      p0ListRows.push({ suffix, id: inserted.rows[0].result.row.id });
    }
    await db.query(`
      update public.work_items_v2 set priority = 'normal'
      where id <> all($1::uuid[])
    `, [p0ListRows.map((row) => row.id)]);
    const { rows: failClosedP0Result } = await db.query(`
      select public.list_actionable_work_v2($1::timestamptz, $2::integer) as result
    `, ['2000-01-01T00:00:00.000Z', 3]);
    const failClosedP0 = failClosedP0Result[0].result.rows;

    const futureAckCandidate = {
      ...candidate,
      work_key: 'room:pglite:p0-future-ack',
      source_event_keys: ['event-p0-future-ack'],
      priority: 'p0'
    };
    const boundaryAckCandidate = {
      ...candidate,
      work_key: 'room:pglite:p0-boundary-ack',
      source_event_keys: ['event-p0-boundary-ack'],
      priority: 'p0'
    };
    const futureAckWork = await db.query(upsertSql, [JSON.stringify(futureAckCandidate)]);
    const boundaryAckWork = await db.query(upsertSql, [JSON.stringify(boundaryAckCandidate)]);
    await db.query(`
      update public.work_items_v2
      set state = 'snoozed', snoozed_until = now() + interval '2 days',
          actionable_at = now() + interval '2 days',
          payload = payload || jsonb_build_object(
            'p0_acknowledged_at',
            to_char((now() + interval '1 day') at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
          )
      where id = $1::uuid
    `, [futureAckWork.rows[0].result.row.id]);
    await db.query(`
      update public.work_items_v2
      set state = 'snoozed', snoozed_until = now() + interval '2 days',
          actionable_at = now() + interval '2 days',
          payload = payload || jsonb_build_object(
            'p0_acknowledged_at',
            to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
          )
      where id = $1::uuid
    `, [boundaryAckWork.rows[0].result.row.id]);
    const [futureAckMerge, boundaryAckMerge] = await Promise.all([
      db.query(upsertSql, [JSON.stringify(futureAckCandidate)]),
      db.query(upsertSql, [JSON.stringify(boundaryAckCandidate)])
    ]);

    const claimDigestSql = `
      select public.claim_digest_run_v2(
        $1::text, $2::timestamptz, $3::timestamptz, $4::timestamptz, $5::text, $6::integer
      ) as result
    `;
    const prepareSql = `
      select public.prepare_digest_parts_v2(
        $1::uuid, $2::text, $3::uuid, $4::jsonb, $5::jsonb
      ) as result
    `;
    const claimPartSql = `
      select public.claim_digest_part_delivery_v2(
        $1::uuid, $2::uuid, $3::text, $4::uuid
      ) as result
    `;
    const deliverPartSql = `
      select public.mark_digest_part_delivered_v2(
        $1::uuid, $2::uuid, $3::text, $4::uuid, $5::integer,
        $6::text, $7::text, $8::timestamptz
      ) as result
    `;
    const failPartSql = `
      select public.mark_digest_part_failed_v2(
        $1::uuid, $2::uuid, $3::text, $4::uuid, $5::integer, $6::text,
        $7::timestamptz, $8::timestamptz
      ) as result
    `;
    const finalizeSql = `
      select public.finalize_digest_run_v2(
        $1::uuid, $2::text, $3::uuid, $4::timestamptz
      ) as result
    `;
    const claimCleanupSql = `
      select public.claim_digest_part_cleanup_v2(
        $1::uuid, $2::uuid, $3::uuid, $4::text, $5::integer
      ) as result
    `;
    const listCleanupBacklogSql = `
      select public.list_digest_cleanup_backlog_v2($1::text, $2::integer) as result
    `;
    const recordCleanupSql = `
      select public.record_digest_part_cleanup_v2(
        $1::uuid, $2::uuid, $3::uuid, $4::text, $5::uuid,
        $6::integer, $7::text, $8::text
      ) as result
    `;
    const digestArgs = [
      'slack:CINBOX', '2026-08-29T03:00:00.000Z', '2026-08-29T00:00:00.000Z',
      '2026-08-29T03:00:00.000Z', 'bridge:pglite', 120
    ];
    await assert.rejects(db.query(claimDigestSql, [
      'slack:CINBOX', 'infinity', '2026-08-29T00:00:00.000Z',
      '2026-08-29T03:00:00.000Z', 'bridge:pglite', 120
    ]), /invalid digest claim/i);
    const firstDigest = await db.query(claimDigestSql, digestArgs);
    const secondDigest = await db.query(claimDigestSql, digestArgs);
    assert.equal(firstDigest.rows[0].result.claimed, true);
    assert.equal(firstDigest.rows[0].result.created, true);
    assert.equal(secondDigest.rows[0].result.claimed, false);
    assert.equal(firstDigest.rows[0].result.previous_digest, null);
    const digestId = firstDigest.rows[0].result.row.id;
    const originalLeaseToken = firstDigest.rows[0].result.row.lease_token;

    const auditIds = [
      actionId,
      concurrentRows[0].id,
      ...Array.from({ length: 23 }, (_, index) =>
        `90000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`)
    ];
    const snapshot = auditIds.map((id, index) => ({
      id,
      version: index === 0 ? 2 : index === 1 ? 999 : 1,
      inclusionReason: index === 0 ? 'daily_reminder' : 'actionable',
      priority: 'normal'
    }));
    const parts = [
      {
        kind: 'ordinary', partNumber: 1, partCount: 2,
        itemIds: auditIds.slice(0, 24), payloadHash: 'a'.repeat(64)
      },
      {
        kind: 'ordinary', partNumber: 2, partCount: 2,
        itemIds: auditIds.slice(24), payloadHash: 'b'.repeat(64)
      },
      {
        kind: 'daily_reminder', partNumber: 1, partCount: 1,
        itemIds: [actionId], payloadHash: 'c'.repeat(64)
      }
    ];
    await assert.rejects(db.query(prepareSql, [
      digestId, 'bridge:pglite', originalLeaseToken, JSON.stringify(snapshot),
      JSON.stringify([{ ...parts[0], partCount: 1, itemIds: auditIds }])
    ]), /invalid digest manifest/i, '25 work rows cannot fit in one message part');
    await assert.rejects(db.query(prepareSql, [
      digestId, 'bridge:pglite', originalLeaseToken, JSON.stringify(snapshot),
      JSON.stringify([{ ...parts[0], itemIds: [...auditIds.slice(0, 23), auditIds[24]] }, parts[1], parts[2]])
    ]), /invalid digest manifest/i, 'ordinary parts must preserve the exact snapshot partition');
    await assert.rejects(db.query(prepareSql, [
      digestId, 'bridge:pglite', originalLeaseToken, JSON.stringify(snapshot),
      JSON.stringify([parts[0], parts[1], { ...parts[2], itemIds: [concurrentRows[0].id] }])
    ]), /invalid digest manifest/i, 'reminder parts must equal the ordered reminder subset');
    await assert.rejects(db.query(prepareSql, [
      digestId, 'bridge:pglite', originalLeaseToken, JSON.stringify(snapshot),
      JSON.stringify([parts[2], parts[0], parts[1]])
    ]), /invalid digest manifest/i, 'part intent has one canonical ordinary-then-reminder order');

    const prepared = await db.query(prepareSql, [
      digestId, 'bridge:pglite', originalLeaseToken, JSON.stringify(snapshot), JSON.stringify(parts)
    ]);
    assert.equal(prepared.rows[0].result.applied, true);
    assert.equal(prepared.rows[0].result.created, true);
    assert.equal(prepared.rows[0].result.row.state, 'delivering');
    assert.equal(prepared.rows[0].result.parts.length, 3);
    const preparedPartIds = prepared.rows[0].result.parts.map((part) => part.id);
    const preparedClientIds = prepared.rows[0].result.parts.map((part) => part.client_message_id);
    const exactRetry = await db.query(prepareSql, [
      digestId, 'bridge:pglite', originalLeaseToken, JSON.stringify(snapshot), JSON.stringify(parts)
    ]);
    assert.equal(exactRetry.rows[0].result.created, false);
    assert.deepEqual(exactRetry.rows[0].result.parts.map((part) => part.id), preparedPartIds);
    assert.deepEqual(exactRetry.rows[0].result.parts.map((part) => part.client_message_id), preparedClientIds);
    const divergentRetry = await db.query(prepareSql, [
      digestId, 'bridge:pglite', originalLeaseToken, JSON.stringify(snapshot),
      JSON.stringify([{ ...parts[0], payloadHash: 'd'.repeat(64) }, parts[1], parts[2]])
    ]);
    assert.equal(divergentRetry.rows[0].result.applied, false,
      'a divergent retry cannot rewrite durable intent');
    assert.equal(divergentRetry.rows[0].result.reason, 'manifest_mismatch');
    assert.deepEqual(divergentRetry.rows[0].result.parts.map((part) => part.id), preparedPartIds);
    assert.deepEqual(
      divergentRetry.rows[0].result.parts.map((part) => part.client_message_id), preparedClientIds
    );

    const ordinaryOne = prepared.rows[0].result.parts.find((part) =>
      part.part_kind === 'ordinary' && part.part_number === 1);
    const ordinaryTwo = prepared.rows[0].result.parts.find((part) =>
      part.part_kind === 'ordinary' && part.part_number === 2);
    const reminderOne = prepared.rows[0].result.parts.find((part) => part.part_kind === 'daily_reminder');
    const firstPartClaim = await db.query(claimPartSql, [
      digestId, ordinaryOne.id, 'bridge:pglite', originalLeaseToken
    ]);
    assert.equal(firstPartClaim.rows[0].result.claimed, true);
    const firstPartDelivery = await db.query(deliverPartSql, [
      digestId, ordinaryOne.id, 'bridge:pglite', originalLeaseToken, 1,
      'CINBOX', '100.01', '2026-08-29T03:00:01.000Z'
    ]);
    assert.equal(firstPartDelivery.rows[0].result.applied, true);
    assert.equal(firstPartDelivery.rows[0].result.row.delivery_retry_at, null);
    const partialFinalize = await db.query(finalizeSql, [
      digestId, 'bridge:pglite', originalLeaseToken, '2026-08-29T03:00:02.000Z'
    ]);
    assert.equal(partialFinalize.rows[0].result.applied, false);

    const secondPartClaim = await db.query(claimPartSql, [
      digestId, ordinaryTwo.id, 'bridge:pglite', originalLeaseToken
    ]);
    assert.equal(secondPartClaim.rows[0].result.claimed, true);
    await db.query(`update public.digest_runs set lease_expires_at = '2000-01-01T00:00:00.000Z' where id = $1::uuid`, [digestId]);
    const reclaimed = await db.query(claimDigestSql, [
      ...digestArgs.slice(0, 4), 'bridge:recovery', 120
    ]);
    assert.equal(reclaimed.rows[0].result.claimed, true);
    assert.equal(reclaimed.rows[0].result.row.state, 'delivering');
    const recoveryToken = reclaimed.rows[0].result.row.lease_token;
    assert.notEqual(recoveryToken, originalLeaseToken);
    const staleDelivery = await db.query(deliverPartSql, [
      digestId, ordinaryTwo.id, 'bridge:pglite', originalLeaseToken, 1,
      'CINBOX', '100.02', '2026-08-29T03:00:03.000Z'
    ]);
    assert.equal(staleDelivery.rows[0].result.applied, false);
    const reconcileClaim = await db.query(claimPartSql, [
      digestId, ordinaryTwo.id, 'bridge:recovery', recoveryToken
    ]);
    assert.equal(reconcileClaim.rows[0].result.claimed, false, 'a prior delivering attempt must be reconciled, not reposted');
    assert.equal(reconcileClaim.rows[0].result.row.delivery_attempts, 1);
    const reconciled = await db.query(deliverPartSql, [
      digestId, ordinaryTwo.id, 'bridge:recovery', recoveryToken, 1,
      'CINBOX', '100.02', '2026-08-29T03:00:03.000Z'
    ]);
    assert.equal(reconciled.rows[0].result.applied, true);
    const deliveredReclaim = await db.query(claimPartSql, [
      digestId, ordinaryOne.id, 'bridge:recovery', recoveryToken
    ]);
    assert.equal(deliveredReclaim.rows[0].result.claimed, false);
    assert.equal(deliveredReclaim.rows[0].result.row.client_message_id, ordinaryOne.client_message_id);
    assert.equal(deliveredReclaim.rows[0].result.row.slack_message_ts, '100.01');

    const reminderClaim = await db.query(claimPartSql, [
      digestId, reminderOne.id, 'bridge:recovery', recoveryToken
    ]);
    assert.equal(reminderClaim.rows[0].result.claimed, true);
    await db.query(deliverPartSql, [
      digestId, reminderOne.id, 'bridge:recovery', recoveryToken, 1,
      'CINBOX', '100.03', '2026-08-29T03:00:04.000Z'
    ]);
    const wrongFinalizeOwner = await db.query(finalizeSql, [
      digestId, 'bridge:other', recoveryToken, '2026-08-29T03:00:05.000Z'
    ]);
    assert.equal(wrongFinalizeOwner.rows[0].result.applied, false);
    const finalized = await db.query(finalizeSql, [
      digestId, 'bridge:recovery', recoveryToken, '2026-08-29T03:00:05.000Z'
    ]);
    assert.equal(finalized.rows[0].result.applied, true);
    assert.equal(finalized.rows[0].result.updated_count, 1);
    assert.equal(finalized.rows[0].result.row.slack_message_ts, '100.01', 'root compatibility coordinate derives from ordinary part one');
    const duplicateFinalize = await db.query(finalizeSql, [
      digestId, 'bridge:recovery', recoveryToken, '2026-08-29T03:00:05.000Z'
    ]);
    assert.equal(duplicateFinalize.rows[0].result.applied, false);
    const { rows: digestCounters } = await db.query(`
      select id, version, digest_inclusion_count, consecutive_unhandled_digests, next_reminder_at
      from public.work_items_v2 where id in ($1::uuid, $2::uuid) order by id
    `, [actionId, concurrentRows[0].id]);
    const matching = digestCounters.find((row) => row.id === actionId);
    const stale = digestCounters.find((row) => row.id === concurrentRows[0].id);
    assert.equal(matching.digest_inclusion_count, 1);
    assert.equal(matching.consecutive_unhandled_digests, 1);
    assert.equal(matching.version, 2);
    assert.equal(new Date(matching.next_reminder_at).toISOString(), '2026-08-30T03:00:05.000Z');
    assert.equal(stale.digest_inclusion_count, 0, 'stale snapshot versions remain audit-only');

    const cappedDigest = await db.query(claimDigestSql, [
      'slack:CINBOX', '2026-08-29T05:00:00.000Z', '2026-08-29T03:00:00.000Z',
      '2026-08-29T05:00:00.000Z', 'bridge:cap', 120
    ]);
    const capId = cappedDigest.rows[0].result.row.id;
    const capToken = cappedDigest.rows[0].result.row.lease_token;
    const capSnapshot = [{ id: actionId, version: 999, inclusionReason: 'actionable', priority: 'normal' }];
    const capParts = [{
      kind: 'ordinary', partNumber: 1, partCount: 1, itemIds: [actionId], payloadHash: 'e'.repeat(64)
    }];
    const capPrepared = await db.query(prepareSql, [
      capId, 'bridge:cap', capToken, JSON.stringify(capSnapshot), JSON.stringify(capParts)
    ]);
    const capPartId = capPrepared.rows[0].result.parts[0].id;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const claim = await db.query(claimPartSql, [capId, capPartId, 'bridge:cap', capToken]);
      assert.equal(claim.rows[0].result.claimed, true);
      assert.equal(claim.rows[0].result.row.delivery_attempts, attempt);
      const failed = await db.query(failPartSql, [
        capId, capPartId, 'bridge:cap', capToken, attempt, 'slack_api_error',
        '2026-08-29T05:00:00.000Z', null
      ]);
      assert.equal(failed.rows[0].result.applied, true);
      assert.equal(failed.rows[0].result.row.delivery_retry_at, null);
    }
    const cappedClaim = await db.query(claimPartSql, [capId, capPartId, 'bridge:cap', capToken]);
    assert.equal(cappedClaim.rows[0].result.claimed, false);
    assert.equal(cappedClaim.rows[0].result.row.delivery_attempts, 3);

    const retryDigest = await db.query(claimDigestSql, [
      'slack:CRETRY', '2026-08-29T05:30:00.000Z', '2026-08-29T02:30:00.000Z',
      '2026-08-29T05:30:00.000Z', 'bridge:retry', 120
    ]);
    const retryId = retryDigest.rows[0].result.row.id;
    const retryToken = retryDigest.rows[0].result.row.lease_token;
    const retryPrepared = await db.query(prepareSql, [
      retryId, 'bridge:retry', retryToken,
      JSON.stringify([{ id: actionId, version: 999, inclusionReason: 'actionable', priority: 'normal' }]),
      JSON.stringify([{
        kind: 'ordinary', partNumber: 1, partCount: 1,
        itemIds: [actionId], payloadHash: '9'.repeat(64)
      }])
    ]);
    const retryPartId = retryPrepared.rows[0].result.parts[0].id;
    const retryClientMessageId = retryPrepared.rows[0].result.parts[0].client_message_id;
    const firstRetryClaim = await db.query(claimPartSql, [
      retryId, retryPartId, 'bridge:retry', retryToken
    ]);
    assert.equal(firstRetryClaim.rows[0].result.row.delivery_attempts, 1);
    const { rows: clockRows } = await db.query(`select now() as current_now`);
    const failedAt = new Date(clockRows[0].current_now).toISOString();
    const retryAt = new Date(Date.parse(failedAt) + 60 * 60 * 1000).toISOString();
    const tooLateRetryAt = new Date(Date.parse(failedAt) + (24 * 60 * 60 * 1000) + 1).toISOString();
    await assert.rejects(db.query(failPartSql, [
      retryId, retryPartId, 'bridge:retry', retryToken, 1, 'rate_limited', failedAt, null
    ]), /invalid digest part failure/i);
    await assert.rejects(db.query(failPartSql, [
      retryId, retryPartId, 'bridge:retry', retryToken, 1, 'slack_api_error', failedAt, retryAt
    ]), /invalid digest part failure/i);
    await assert.rejects(db.query(failPartSql, [
      retryId, retryPartId, 'bridge:retry', retryToken, 1, 'rate_limited', failedAt, tooLateRetryAt
    ]), /invalid digest part failure/i);
    await assert.rejects(db.query(failPartSql, [
      retryId, retryPartId, 'bridge:retry', retryToken, 1, 'rate_limited', failedAt, 'infinity'
    ]), /invalid digest part failure/i);
    const deferredFailure = await db.query(failPartSql, [
      retryId, retryPartId, 'bridge:retry', retryToken, 1, 'rate_limited', failedAt, retryAt
    ]);
    assert.equal(deferredFailure.rows[0].result.applied, true);
    assert.equal(new Date(deferredFailure.rows[0].result.row.delivery_retry_at).toISOString(), retryAt);
    const beforeRetryClaim = await db.query(claimPartSql, [
      retryId, retryPartId, 'bridge:retry', retryToken
    ]);
    assert.equal(beforeRetryClaim.rows[0].result.claimed, false);
    assert.equal(beforeRetryClaim.rows[0].result.row.delivery_attempts, 1);
    assert.equal(beforeRetryClaim.rows[0].result.row.client_message_id, retryClientMessageId);
    await db.query(`
      update public.digest_message_parts set delivery_retry_at = now()
      where id = $1::uuid
    `, [retryPartId]);
    const dueRetryClaim = await db.query(claimPartSql, [
      retryId, retryPartId, 'bridge:retry', retryToken
    ]);
    assert.equal(dueRetryClaim.rows[0].result.claimed, true);
    assert.equal(dueRetryClaim.rows[0].result.row.delivery_attempts, 2);
    assert.equal(dueRetryClaim.rows[0].result.row.delivery_retry_at, null);
    assert.equal(dueRetryClaim.rows[0].result.row.client_message_id, retryClientMessageId);
    const zeroRetryFailure = await db.query(failPartSql, [
      retryId, retryPartId, 'bridge:retry', retryToken, 2, 'rate_limited', failedAt, failedAt
    ]);
    assert.equal(zeroRetryFailure.rows[0].result.applied, true, 'Retry-After zero is an exact due boundary');
    const zeroRetryClaim = await db.query(claimPartSql, [
      retryId, retryPartId, 'bridge:retry', retryToken
    ]);
    assert.equal(zeroRetryClaim.rows[0].result.claimed, true);
    assert.equal(zeroRetryClaim.rows[0].result.row.delivery_attempts, 3);
    const maximumRetryAt = new Date(Date.parse(failedAt) + (24 * 60 * 60 * 1000)).toISOString();
    const maximumRetryFailure = await db.query(failPartSql, [
      retryId, retryPartId, 'bridge:retry', retryToken, 3, 'rate_limited', failedAt, maximumRetryAt
    ]);
    assert.equal(maximumRetryFailure.rows[0].result.applied, true, 'Retry-After 86400 is the inclusive bound');
    assert.equal(
      new Date(maximumRetryFailure.rows[0].result.row.delivery_retry_at).toISOString(),
      maximumRetryAt
    );

    const emptyDigest = await db.query(claimDigestSql, [
      'slack:CINBOX', '2026-08-29T06:00:00.000Z', '2026-08-29T05:00:00.000Z',
      '2026-08-29T06:00:00.000Z', 'bridge:empty', 120
    ]);
    assert.equal(emptyDigest.rows[0].result.previous_digest.id, digestId);
    assert.deepEqual(
      emptyDigest.rows[0].result.previous_digest.parts.map((part) => [part.part_kind, part.part_number, part.slack_message_ts]),
      [['ordinary', 1, '100.01'], ['ordinary', 2, '100.02'], ['daily_reminder', 1, '100.03']]
    );
    const earlyCleanup = await db.query(claimCleanupSql, [
      emptyDigest.rows[0].result.row.id, digestId, ordinaryOne.id, 'bridge:cleanup', 120
    ]);
    assert.equal(earlyCleanup.rows[0].result.claimed, false, 'cleanup cannot begin before current delivery');
    const emptyPrepared = await db.query(prepareSql, [
      emptyDigest.rows[0].result.row.id, 'bridge:empty', emptyDigest.rows[0].result.row.lease_token,
      '[]', '[]'
    ]);
    assert.equal(emptyPrepared.rows[0].result.parts.length, 0);
    const emptyRetry = await db.query(prepareSql, [
      emptyDigest.rows[0].result.row.id, 'bridge:empty', emptyDigest.rows[0].result.row.lease_token,
      '[]', '[]'
    ]);
    assert.equal(emptyRetry.rows[0].result.created, false);
    const emptyFinalized = await db.query(finalizeSql, [
      emptyDigest.rows[0].result.row.id, 'bridge:empty', emptyDigest.rows[0].result.row.lease_token,
      '2026-08-29T06:00:05.000Z'
    ]);
    assert.equal(emptyFinalized.rows[0].result.applied, true);
    assert.equal(emptyFinalized.rows[0].result.updated_count, 0);
    assert.equal(emptyFinalized.rows[0].result.row.slack_channel_id, null);
    const currentId = emptyDigest.rows[0].result.row.id;
    const secondSuccessor = await db.query(claimDigestSql, [
      'slack:CINBOX', '2026-08-29T07:00:00.000Z', '2026-08-29T06:00:00.000Z',
      '2026-08-29T07:00:00.000Z', 'bridge:second-successor', 120
    ]);
    assert.equal(secondSuccessor.rows[0].result.previous_digest.id, digestId);
    await db.query(prepareSql, [
      secondSuccessor.rows[0].result.row.id, 'bridge:second-successor',
      secondSuccessor.rows[0].result.row.lease_token, '[]', '[]'
    ]);
    const secondSuccessorFinalized = await db.query(finalizeSql, [
      secondSuccessor.rows[0].result.row.id, 'bridge:second-successor',
      secondSuccessor.rows[0].result.row.lease_token, '2026-08-29T07:00:05.000Z'
    ]);
    assert.equal(secondSuccessorFinalized.rows[0].result.applied, true);
    const secondSuccessorId = secondSuccessor.rows[0].result.row.id;

    const [cleanupWinner, cleanupLoser] = await Promise.all([
      db.query(claimCleanupSql, [currentId, digestId, ordinaryOne.id, 'bridge:cleanup-a', 120]),
      db.query(claimCleanupSql, [currentId, digestId, ordinaryOne.id, 'bridge:cleanup-b', 120])
    ]);
    const cleanupClaims = [cleanupWinner.rows[0].result, cleanupLoser.rows[0].result];
    assert.equal(cleanupClaims.filter((result) => result.claimed).length, 1, 'only one cleanup worker wins');
    const winningCleanup = cleanupClaims.find((result) => result.claimed);
    const expiringCleanup = await db.query(claimCleanupSql, [
      secondSuccessorId, digestId, ordinaryTwo.id, 'bridge:cleanup-old', 120
    ]);
    const firstCleanupFailure = await db.query(recordCleanupSql, [
      currentId, digestId, ordinaryOne.id, winningCleanup.part.cleanup_owner,
      winningCleanup.part.cleanup_token, 1, 'failed', 'rate_limited'
    ]);
    assert.equal(firstCleanupFailure.rows[0].result.applied, true);
    assert.equal(firstCleanupFailure.rows[0].result.row.state, 'delivered');
    assert.equal(
      firstCleanupFailure.rows[0].result.row.previous_cleanup_state,
      'deleting',
      'an in-flight sibling cleanup outranks the failed part in the aggregate'
    );
    const { rows: priorAfterFailure } = await db.query(`select state from public.digest_runs where id = $1::uuid`, [digestId]);
    assert.equal(priorAfterFailure[0].state, 'delivered');
    await db.query(`
      update public.digest_message_parts set cleanup_expires_at = '2000-01-01T00:00:00.000Z'
      where id = $1::uuid
    `, [ordinaryTwo.id]);
    const reclaimedCleanup = await db.query(claimCleanupSql, [
      secondSuccessorId, digestId, ordinaryTwo.id, 'bridge:cleanup-new', 120
    ]);
    assert.equal(reclaimedCleanup.rows[0].result.claimed, true);
    assert.equal(reclaimedCleanup.rows[0].result.part.cleanup_attempts, 2);
    assert.notEqual(reclaimedCleanup.rows[0].result.part.cleanup_token, expiringCleanup.rows[0].result.part.cleanup_token);
    const staleCleanupTerminal = await db.query(recordCleanupSql, [
      secondSuccessorId, digestId, ordinaryTwo.id, 'bridge:cleanup-old',
      expiringCleanup.rows[0].result.part.cleanup_token, 1, 'failed', 'cleanup_unconfirmed'
    ]);
    assert.equal(staleCleanupTerminal.rows[0].result.applied, false);
    const secondCleanupTerminal = await db.query(recordCleanupSql, [
      secondSuccessorId, digestId, ordinaryTwo.id, 'bridge:cleanup-new',
      reclaimedCleanup.rows[0].result.part.cleanup_token, 2, 'already_absent', null
    ]);
    assert.equal(
      secondCleanupTerminal.rows[0].result.row.previous_cleanup_state,
      'failed',
      'the aggregate converges to the remaining failed part once no cleanup is deleting'
    );
    const retriedCleanup = await db.query(claimCleanupSql, [
      currentId, digestId, ordinaryOne.id, 'bridge:cleanup-retry', 120
    ]);
    assert.equal(retriedCleanup.rows[0].result.claimed, true);
    assert.equal(retriedCleanup.rows[0].result.part.cleanup_attempts, 2);
    assert.notEqual(retriedCleanup.rows[0].result.part.cleanup_token, winningCleanup.part.cleanup_token);
    await db.query(recordCleanupSql, [
      currentId, digestId, ordinaryOne.id, 'bridge:cleanup-retry',
      retriedCleanup.rows[0].result.part.cleanup_token, 2, 'deleted', null
    ]);
    const reminderCleanup = await db.query(claimCleanupSql, [
      currentId, digestId, reminderOne.id, 'bridge:cleanup-final', 120
    ]);
    const completedCleanup = await db.query(recordCleanupSql, [
      currentId, digestId, reminderOne.id, 'bridge:cleanup-final',
      reminderCleanup.rows[0].result.part.cleanup_token, 1, 'already_absent', null
    ]);
    assert.equal(completedCleanup.rows[0].result.applied, true);
    assert.equal(completedCleanup.rows[0].result.row.previous_cleanup_state, 'deleted');
    const { rows: finalPrior } = await db.query(`select state from public.digest_runs where id = $1::uuid`, [digestId]);
    assert.equal(finalPrior[0].state, 'replaced');
    const terminalClaimRepair = await db.query(claimCleanupSql, [
      secondSuccessorId, digestId, reminderOne.id, 'bridge:terminal-repair', 120
    ]);
    assert.equal(terminalClaimRepair.rows[0].result.claimed, false);
    assert.equal(
      terminalClaimRepair.rows[0].result.row.previous_cleanup_state,
      'deleted',
      'a second delivered successor reconciles its aggregate when it encounters a terminal shared part'
    );

    await db.query(`update public.digest_runs set state = 'delivered' where id = $1::uuid`, [digestId]);
    await db.query(`
      update public.digest_runs
      set previous_cleanup_state = 'deleting', previous_cleanup_error = null, previous_deleted_at = null
      where id in ($1::uuid, $2::uuid)
    `, [currentId, secondSuccessorId]);
    const terminalRecordRepair = await db.query(recordCleanupSql, [
      currentId, digestId, reminderOne.id, 'bridge:cleanup-final',
      reminderCleanup.rows[0].result.part.cleanup_token, 1, 'already_absent', null
    ]);
    assert.equal(terminalRecordRepair.rows[0].result.applied, false, 'terminal retry remains idempotent');
    assert.equal(terminalRecordRepair.rows[0].result.part.cleanup_state, 'already_absent');
    assert.equal(terminalRecordRepair.rows[0].result.part.cleanup_attempts, 1);
    assert.equal(terminalRecordRepair.rows[0].result.part.cleanup_token, null);
    assert.equal(terminalRecordRepair.rows[0].result.row.previous_cleanup_state, 'deleted');
    const { rows: repairedPrior } = await db.query(`select state from public.digest_runs where id = $1::uuid`, [digestId]);
    assert.equal(repairedPrior[0].state, 'replaced', 'terminal re-entry repairs concurrent-equivalent missed replacement');

    const backlogPriorId = '81000000-0000-4000-8000-000000000001';
    const replacedSuccessorId = '81000000-0000-4000-8000-000000000002';
    const unconfirmedSuccessorId = '81000000-0000-4000-8000-000000000003';
    const backlogPartId = '81000000-0000-4000-8000-000000000004';
    await db.query(`
      insert into public.digest_runs (
        id, window_started_at, window_ended_at, scheduled_at, state, destination_key,
        item_snapshot, manifest_prepared_at, delivered_at, previous_digest_id,
        previous_cleanup_state, previous_cleanup_error, previous_deleted_at,
        lease_owner, lease_token, lease_expires_at
      ) values
        ($1::uuid, '2026-08-29T08:00:00Z', '2026-08-29T09:00:00Z', '2026-08-29T09:00:00Z',
          'delivered', 'slack:CBACKLOG', '[]'::jsonb, '2026-08-29T09:00:01Z', '2026-08-29T09:00:02Z',
          null, 'idle', null, null, null, null, null),
        ($2::uuid, '2026-08-29T09:00:00Z', '2026-08-29T10:00:00Z', '2026-08-29T10:00:00Z',
          'replaced', 'slack:CBACKLOG', '[]'::jsonb, '2026-08-29T10:00:01Z', '2026-08-29T10:00:02Z',
          $1::uuid, 'failed', 'rate_limited', null, null, null, null),
        ($3::uuid, '2026-08-29T10:00:00Z', '2026-08-29T11:00:00Z', '2026-08-29T11:00:00Z',
          'failed', 'slack:CBACKLOG', '[]'::jsonb, null, null,
          $1::uuid, 'idle', null, null, 'bridge:unconfirmed',
          '81000000-0000-4000-8000-000000000005'::uuid, now() + interval '2 minutes')
    `, [backlogPriorId, replacedSuccessorId, unconfirmedSuccessorId]);
    await db.query(`
      insert into public.digest_message_parts (
        id, digest_run_id, part_kind, part_number, part_count, item_ids, payload_hash,
        client_message_id, delivery_state, delivery_attempts, delivery_claimed_at,
        slack_channel_id, slack_message_ts, delivered_at, cleanup_state,
        cleanup_attempts, cleanup_attempted_at, cleanup_error
      ) values (
        $1::uuid, $2::uuid, 'ordinary', 1, 1,
        array['81000000-0000-4000-8000-000000000006'::uuid], repeat('f', 64),
        '81000000-0000-4000-8000-000000000007'::uuid, 'delivered', 1,
        '2026-08-29T09:00:01Z', 'CBACKLOG', '900.01', '2026-08-29T09:00:02Z',
        'failed', 1, '2026-08-29T10:00:03Z', 'rate_limited'
      )
    `, [backlogPartId, backlogPriorId]);
    await assert.rejects(db.query(listCleanupBacklogSql, ['slack:CBACKLOG', 11]), /invalid digest cleanup backlog/i);
    const backlog = await db.query(listCleanupBacklogSql, ['slack:CBACKLOG', 10]);
    assert.deepEqual(backlog.rows[0].result, [{
      successor_digest_id: replacedSuccessorId,
      previous_digest_id: backlogPriorId,
      previous_cleanup_state: 'failed',
      parts: [{
        previous_part_id: backlogPartId,
        part_kind: 'ordinary',
        part_number: 1,
        part_count: 1,
        slack_channel_id: 'CBACKLOG',
        slack_message_ts: '900.01',
        cleanup_state: 'failed'
      }]
    }]);
    const replacedClaim = await db.query(claimCleanupSql, [
      replacedSuccessorId, backlogPriorId, backlogPartId, 'bridge:backlog', 120
    ]);
    assert.equal(replacedClaim.rows[0].result.claimed, true, 'a confirmed replaced successor can resume its prior cleanup');
    const unconfirmedClaim = await db.query(claimCleanupSql, [
      unconfirmedSuccessorId, backlogPriorId, backlogPartId, 'bridge:unconfirmed', 120
    ]);
    assert.deepEqual(unconfirmedClaim.rows[0].result, { claimed: false, row: null, part: null });
    const replacedRecord = await db.query(recordCleanupSql, [
      replacedSuccessorId, backlogPriorId, backlogPartId, 'bridge:backlog',
      replacedClaim.rows[0].result.part.cleanup_token, 2, 'failed', 'rate_limited'
    ]);
    assert.equal(replacedRecord.rows[0].result.applied, true);
    assert.equal(replacedRecord.rows[0].result.row.state, 'replaced');

    const sharedPriorId = '82000000-0000-4000-8000-000000000001';
    const sharedSuccessorBId = '82000000-0000-4000-8000-000000000002';
    const sharedSuccessorCId = '82000000-0000-4000-8000-000000000003';
    const sharedPartId = '82000000-0000-4000-8000-000000000004';
    await db.query(`
      insert into public.digest_runs (
        id, window_started_at, window_ended_at, scheduled_at, state, destination_key,
        item_snapshot, manifest_prepared_at, delivered_at, previous_digest_id,
        previous_cleanup_state, previous_cleanup_error, previous_deleted_at,
        lease_owner, lease_token, lease_expires_at
      ) values
        ($1::uuid, '2026-08-29T11:00:00Z', '2026-08-29T12:00:00Z', '2026-08-29T12:00:00Z',
          'delivered', 'slack:CSHARED', '[]'::jsonb, '2026-08-29T12:00:01Z', '2026-08-29T12:00:02Z',
          null, 'idle', null, null, null, null, null),
        ($2::uuid, '2026-08-29T12:00:00Z', '2026-08-29T13:00:00Z', '2026-08-29T13:00:00Z',
          'delivered', 'slack:CSHARED', '[]'::jsonb, '2026-08-29T13:00:01Z', '2026-08-29T13:00:02Z',
          $1::uuid, 'idle', null, null, null, null, null),
        ($3::uuid, '2026-08-29T13:00:00Z', '2026-08-29T14:00:00Z', '2026-08-29T14:00:00Z',
          'replaced', 'slack:CSHARED', '[]'::jsonb, '2026-08-29T14:00:01Z', '2026-08-29T14:00:02Z',
          $1::uuid, 'idle', null, null, null, null, null)
    `, [sharedPriorId, sharedSuccessorBId, sharedSuccessorCId]);
    await db.query(`
      insert into public.digest_message_parts (
        id, digest_run_id, part_kind, part_number, part_count, item_ids, payload_hash,
        client_message_id, delivery_state, delivery_attempts, delivery_claimed_at,
        slack_channel_id, slack_message_ts, delivered_at, cleanup_state,
        cleanup_attempts, cleanup_attempted_at, cleanup_error
      ) values (
        $1::uuid, $2::uuid, 'ordinary', 1, 1,
        array['82000000-0000-4000-8000-000000000005'::uuid], repeat('8', 64),
        '82000000-0000-4000-8000-000000000006'::uuid, 'delivered', 1,
        '2026-08-29T12:00:01Z', 'CSHARED', '1200.01', '2026-08-29T12:00:02Z',
        'idle', 0, null, null
      )
    `, [sharedPartId, sharedPriorId]);
    const sharedInitialBacklog = await db.query(listCleanupBacklogSql, ['slack:CSHARED', 10]);
    assert.deepEqual(
      sharedInitialBacklog.rows[0].result.map((entry) => entry.successor_digest_id),
      [sharedSuccessorBId, sharedSuccessorCId],
      'shared-prior successors are ordered by their own oldest scheduled boundary'
    );
    const sharedBClaim = await db.query(claimCleanupSql, [
      sharedSuccessorBId, sharedPriorId, sharedPartId, 'bridge:shared-b', 120
    ]);
    assert.equal(sharedBClaim.rows[0].result.claimed, true);
    const sharedBRecord = await db.query(recordCleanupSql, [
      sharedSuccessorBId, sharedPriorId, sharedPartId, 'bridge:shared-b',
      sharedBClaim.rows[0].result.part.cleanup_token, 1, 'deleted', null
    ]);
    assert.equal(sharedBRecord.rows[0].result.row.previous_cleanup_state, 'deleted');
    const attemptsAfterDelete = sharedBRecord.rows[0].result.part.cleanup_attempts;
    assert.equal(sharedBRecord.rows[0].result.part.cleanup_token, null);
    const sharedRepairBacklog = await db.query(listCleanupBacklogSql, ['slack:CSHARED', 10]);
    assert.deepEqual(sharedRepairBacklog.rows[0].result, [{
      successor_digest_id: sharedSuccessorCId,
      previous_digest_id: sharedPriorId,
      previous_cleanup_state: 'idle',
      parts: [{
        previous_part_id: sharedPartId,
        part_kind: 'ordinary',
        part_number: 1,
        part_count: 1,
        slack_channel_id: 'CSHARED',
        slack_message_ts: '1200.01',
        cleanup_state: 'deleted'
      }]
    }]);
    const sharedCRepair = await db.query(claimCleanupSql, [
      sharedSuccessorCId, sharedPriorId, sharedPartId, 'bridge:shared-c', 120
    ]);
    assert.equal(sharedCRepair.rows[0].result.claimed, false);
    assert.equal(sharedCRepair.rows[0].result.row.previous_cleanup_state, 'deleted');
    assert.equal(sharedCRepair.rows[0].result.part.cleanup_attempts, attemptsAfterDelete);
    assert.equal(sharedCRepair.rows[0].result.part.cleanup_token, null);
    assert.deepEqual((await db.query(listCleanupBacklogSql, ['slack:CSHARED', 10])).rows[0].result, []);

    assert.deepEqual({
      listedIds: failClosedP0.map((row) => row.id),
      mergeStates: [futureAckMerge.rows[0].result.row.state, boundaryAckMerge.rows[0].result.row.state]
    }, {
      listedIds: p0ListRows.slice(2).map((row) => row.id),
      mergeStates: ['open', 'snoozed']
    }, 'SQL uses each operation cutoff for list and upsert wake eligibility');
  } finally {
    await db.close();
  }
});

test('notice cleanup migration is service-role only with invoker and empty-search-path functions', async () => {
  assert.ok(noticeCleanupMigrationName, 'the additive notice-cleanup migration must exist');
  const db = await createNoticeCleanupDatabase();
  try {
    const { rows } = await db.query(`
      select p.proname, p.prosecdef,
        coalesce(array_to_string(p.proconfig, ','), '') as config,
        has_function_privilege('anon', p.oid, 'execute') as anon_execute,
        has_function_privilege('authenticated', p.oid, 'execute') as authenticated_execute,
        has_function_privilege('service_role', p.oid, 'execute') as service_role_execute
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public'
        and p.proname in (
          'capture_notice_cleanup_work_sources_v2',
          'claim_notice_cleanup_batch_v2',
          'link_notice_cleanup_from_receipt_v2',
          'mark_notice_cleanup_deleted_v2',
          'mark_notice_cleanup_failed_v2'
        )
      order by p.proname
    `);
    assert.deepEqual(rows.map((row) => row.proname), [
      'capture_notice_cleanup_work_sources_v2',
      'claim_notice_cleanup_batch_v2',
      'link_notice_cleanup_from_receipt_v2',
      'mark_notice_cleanup_deleted_v2',
      'mark_notice_cleanup_failed_v2'
    ]);
    assert.ok(rows.every((row) => row.prosecdef === false));
    assert.ok(rows.every((row) => row.config === 'search_path=""'));
    assert.ok(rows.every((row) => row.anon_execute === false));
    assert.ok(rows.every((row) => row.authenticated_execute === false));
    assert.ok(rows.every((row) => row.service_role_execute === true));
    const tablePrivileges = (await db.query(`
      select has_table_privilege('anon', 'public.notice_cleanup_work_sources_v2', 'select') as anon_select,
        has_table_privilege('authenticated', 'public.notice_cleanup_work_sources_v2', 'select') as authenticated_select,
        has_table_privilege('service_role', 'public.notice_cleanup_work_sources_v2', 'select') as service_role_select,
        has_table_privilege('service_role', 'public.notice_cleanup_work_sources_v2', 'insert') as service_role_insert
    `)).rows[0];
    assert.deepEqual(tablePrivileges, {
      anon_select: false,
      authenticated_select: false,
      service_role_select: true,
      service_role_insert: true
    });
  } finally {
    await db.close();
  }
});

test('v2 P0 review round 1 lists eligibility before limiting and settles exact delivery CAS without clobbering payload', async () => {
  const db = await createP0DeliveryDatabase();
  const now = '2026-09-01T06:00:00.000Z';
  try {
    await db.query(`
      insert into public.work_items_v2 (
        work_key, room_key, title, summary, work_type, priority, state,
        actionable_at, first_opened_at, last_activity_at, payload
      )
      select
        'acked:' || n, 'room:' || n, 'acknowledged', '', 'human_review', 'p0', 'open',
        $1::timestamptz - interval '2 days', $1::timestamptz - interval '2 days',
        $1::timestamptz - interval '2 days',
        jsonb_build_object(
          'requires_human_action', true,
          'p0_acknowledged_at', to_char($1::timestamptz at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
        )
      from generate_series(1, 51) as n
    `, [now]);
    const { rows: inserted } = await db.query(`
      insert into public.work_items_v2 (
        work_key, room_key, title, summary, work_type, priority, state,
        actionable_at, first_opened_at, last_activity_at, payload
      ) values (
        'eligible', 'room:eligible', 'eligible', '', 'human_review', 'p0', 'open',
        $1::timestamptz, $1::timestamptz - interval '20 minutes',
        $1::timestamptz - interval '20 minutes', '{"requires_human_action":true}'::jsonb
      ) returning id, version
    `, [now]);
    const { rows: listedRows } = await db.query(`
      select public.list_due_p0_work_v2($1::timestamptz, 50) as result
    `, [now]);
    const listed = listedRows[0].result;
    assert.equal(listed.eligible_count, 1);
    assert.equal(listed.selected_count, 1);
    assert.equal(listed.omitted_count, 0);
    assert.deepEqual(listed.rows.map((row) => row.id), [inserted[0].id]);

    await db.query(`
      update public.work_items_v2
      set payload = jsonb_set(payload, '{concurrent_marker}', '"preserved"'::jsonb, true)
      where id = $1
    `, [inserted[0].id]);
    const clientId = '77777777-7777-5777-8777-777777777777';
    const { rows: claimedRows } = await db.query(`
      select public.claim_p0_delivery_v2(
        $1::uuid, $2::integer, 0, 1, 1, $3::uuid,
        $4::timestamptz, $4::timestamptz + interval '2 minutes'
      ) as result
    `, [inserted[0].id, inserted[0].version, clientId, now]);
    assert.equal(claimedRows[0].result.applied, true);
    assert.equal(claimedRows[0].result.row.payload.concurrent_marker, 'preserved');

    await db.query(`
      update public.work_items_v2
      set payload = jsonb_set(payload, '{other_writer}', 'true'::jsonb, true)
      where id = $1
    `, [inserted[0].id]);
    const { rows: settledRows } = await db.query(`
      select public.settle_p0_delivery_v2(
        $1::uuid, $2::integer, 'claimed', 1, $3::uuid, 'delivered',
        $4::timestamptz, 'CP0', '100.1'
      ) as result
    `, [inserted[0].id, inserted[0].version, clientId, now]);
    assert.equal(settledRows[0].result.applied, true);
    assert.equal(settledRows[0].result.row.payload.other_writer, true);

    const { rows: staleRows } = await db.query(`
      select public.settle_p0_delivery_v2(
        $1::uuid, $2::integer, 'claimed', 1, $3::uuid, 'retry_pending',
        $4::timestamptz, null, null
      ) as result
    `, [inserted[0].id, inserted[0].version, clientId, now]);
    assert.equal(staleRows[0].result.applied, false);
    const { rows: readback } = await db.query(
      `select payload from public.work_items_v2 where id = $1`, [inserted[0].id]
    );
    assert.equal(readback[0].payload.p0_delivery.status, 'delivered');
    assert.equal(readback[0].payload.p0_delivery.readback.message_ts, '100.1');
  } finally {
    await db.close();
  }
});

test('v2 P0 review round 1 reports authoritative selected and omitted counts after due filtering', async () => {
  const db = await createP0DeliveryDatabase();
  const now = '2026-09-01T06:00:00.000Z';
  try {
    await db.query(`
      insert into public.work_items_v2 (
        work_key, room_key, title, summary, work_type, priority, state,
        actionable_at, first_opened_at, last_activity_at, payload
      )
      select
        'due:' || n, 'room:' || n, 'due', '', 'human_review', 'p0', 'open',
        $1::timestamptz, $1::timestamptz - (n || ' minutes')::interval,
        $1::timestamptz - (n || ' minutes')::interval, '{"requires_human_action":true}'::jsonb
      from generate_series(20, 79) as n
    `, [now]);
    const { rows } = await db.query(
      `select public.list_due_p0_work_v2($1::timestamptz, 50) as result`, [now]
    );
    assert.equal(rows[0].result.eligible_count, 60);
    assert.equal(rows[0].result.selected_count, 50);
    assert.equal(rows[0].result.omitted_count, 10);
    assert.equal(rows[0].result.rows.length, 50);
    const { rows: privileges } = await db.query(`
      select p.proname,
        has_function_privilege('anon', p.oid, 'execute') as anon_execute,
        has_function_privilege('authenticated', p.oid, 'execute') as authenticated_execute,
        has_function_privilege('service_role', p.oid, 'execute') as service_role_execute
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname in (
        'list_due_p0_work_v2', 'claim_p0_delivery_v2',
        'settle_p0_delivery_v2', 'read_p0_delivery_v2'
      ) order by p.proname
    `);
    assert.equal(privileges.length, 4);
    assert.ok(privileges.every((row) => row.anon_execute === false
      && row.authenticated_execute === false && row.service_role_execute === true));
  } finally {
    await db.close();
  }
});

test('v2 P0 review round 2 reconciliation lease has one winner, rotates on expiry, and fences stale settlement', async () => {
  const db = await createP0ReconciliationDatabase();
  const id = '11111111-1111-4111-8111-111111111111';
  const clientId = '77777777-7777-5777-8777-777777777777';
  const ownerA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const ownerB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const now = '2026-09-02T06:10:00.000Z';
  try {
    await db.query(`
      insert into public.work_items_v2 (
        id, work_key, room_key, title, summary, work_type, priority, state,
        actionable_at, first_opened_at, last_activity_at, payload
      ) values (
        $1, 'reconcile', 'room:reconcile', 'reconcile', '', 'human_review', 'p0', 'open',
        $2::timestamptz, $2::timestamptz - interval '1 hour', $2::timestamptz,
        jsonb_build_object('requires_human_action', true, 'p0_delivery', jsonb_build_object(
          'status', 'reconcile_pending', 'generation', 1, 'attempt', 1,
          'client_message_id', $3::text,
          'claimed_at', '2026-09-02T05:59:00.000Z',
          'claim_expires_at', '2026-09-02T06:01:00.000Z',
          'last_attempt_at', '2026-09-02T06:00:00.000Z',
          'next_at', '2026-09-02T06:10:00.000Z'
        ))
      )
    `, [id, now, clientId]);
    const claimSql = `select public.claim_p0_reconciliation_v2(
      $1::uuid, 1, $2::text, 1, $3::uuid, $4::uuid, 120, $5::timestamptz
    ) as result`;
    const first = (await db.query(claimSql, [id, 'reconcile_pending', clientId, ownerA, now])).rows[0].result;
    const competing = (await db.query(claimSql, [id, 'reconcile_pending', clientId, ownerB, now])).rows[0].result;
    assert.equal(first.claimed, true);
    assert.equal(competing.claimed, false);
    assert.equal(first.row.payload.p0_delivery.status, 'reconciling');
    assert.equal(first.row.payload.p0_delivery.generation, 1);
    assert.equal(first.row.payload.p0_delivery.client_message_id, clientId);
    assert.equal(first.row.payload.p0_delivery.reconcile_owner, ownerA);
    assert.match(first.row.payload.p0_delivery.reconcile_token, /^[0-9a-f-]{36}$/);

    const expiredAt = '2026-09-02T06:12:00.001Z';
    const reclaimed = (await db.query(claimSql, [id, 'reconciling', clientId, ownerB, expiredAt])).rows[0].result;
    assert.equal(reclaimed.claimed, true);
    assert.equal(reclaimed.row.payload.p0_delivery.reconcile_owner, ownerB);
    assert.notEqual(reclaimed.row.payload.p0_delivery.reconcile_token, first.row.payload.p0_delivery.reconcile_token);

    const settleSql = `select public.settle_p0_delivery_v2(
      $1::uuid, 1, 'reconciling', 1, $2::uuid, $3::text,
      $4::timestamptz, $5::text, $6::text, $7::uuid, $8::uuid
    ) as result`;
    const stale = (await db.query(settleSql, [
      id, clientId, 'delivered', expiredAt, 'CP0', '100.1', ownerA,
      first.row.payload.p0_delivery.reconcile_token
    ])).rows[0].result;
    assert.equal(stale.applied, false);

    const retryAt = '2026-09-02T06:12:01.000Z';
    const rejected = (await db.query(settleSql, [
      id, clientId, 'retry_pending', retryAt, null, null, ownerB,
      reclaimed.row.payload.p0_delivery.reconcile_token
    ])).rows[0].result;
    assert.equal(rejected.applied, true);
    assert.equal(rejected.row.payload.p0_delivery.status, 'retry_pending');
    assert.equal(rejected.row.payload.p0_delivery.generation, 1);
    assert.equal(rejected.row.payload.p0_delivery.client_message_id, clientId);
    assert.equal(rejected.row.payload.p0_delivery.next_at, '2026-09-02T06:22:01.000Z');
    assert.equal(Object.hasOwn(rejected.row.payload.p0_delivery, 'reconcile_token'), false);

    const before = (await db.query(
      `select public.list_due_p0_work_v2('2026-09-02T06:22:00.999Z', 50) as result`
    )).rows[0].result;
    const due = (await db.query(
      `select public.list_due_p0_work_v2('2026-09-02T06:22:01.000Z', 50) as result`
    )).rows[0].result;
    assert.equal(before.eligible_count, 0);
    assert.equal(due.eligible_count, 1);
  } finally {
    await db.close();
  }
});

test('v2 P0 review round 2 reconciliation RPC remains service-role only', async () => {
  const db = await createP0ReconciliationDatabase();
  try {
    const privileges = (await db.query(`
      select
        has_function_privilege('anon', p.oid, 'execute') as anon_execute,
        has_function_privilege('authenticated', p.oid, 'execute') as authenticated_execute,
        has_function_privilege('service_role', p.oid, 'execute') as service_role_execute
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = 'claim_p0_reconciliation_v2'
    `)).rows;
    assert.deepEqual(privileges, [{
      anon_execute: false, authenticated_execute: false, service_role_execute: true
    }]);
  } finally {
    await db.close();
  }
});

test('v2 P0 review round 2 self-review rejects malformed claims and terminal settlements', async () => {
  const db = await createP0ReconciliationDatabase();
  const clientId = '77777777-7777-5777-8777-777777777777';
  const owner = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const malformedId = '11111111-1111-4111-8111-111111111112';
  const terminalId = '11111111-1111-4111-8111-111111111113';
  try {
    await db.query(`
      insert into public.work_items_v2 (
        id, work_key, room_key, title, summary, work_type, priority, state,
        actionable_at, first_opened_at, last_activity_at, payload
      ) values
      ($1, 'malformed-reconcile', 'room:malformed', 'malformed', '', 'human_review', 'p0', 'open',
       '2026-09-02T06:00:00.000Z', '2026-09-02T05:00:00.000Z', '2026-09-02T06:00:00.000Z',
       jsonb_build_object('requires_human_action', true, 'p0_delivery', jsonb_build_object(
         'status', 'reconcile_pending', 'generation', 1, 'attempt', 1, 'client_message_id', $3::text,
         'claimed_at', '2026-09-02T05:50:00.000Z', 'claim_expires_at', '2026-09-02T05:52:00.000Z',
         'last_attempt_at', '2026-09-02T05:51:00.000Z', 'next_at', '2026-09-02T06:00:00.000Z',
         'unexpected', 'field'))),
      ($2, 'terminal-settle', 'room:terminal', 'terminal', '', 'human_review', 'p0', 'resolved',
       '2026-09-02T06:00:00.000Z', '2026-09-02T05:00:00.000Z', '2026-09-02T06:00:00.000Z',
       jsonb_build_object('requires_human_action', true, 'p0_delivery', jsonb_build_object(
         'status', 'claimed', 'generation', 1, 'attempt', 1, 'client_message_id', $3::text,
         'claimed_at', '2026-09-02T05:58:00.000Z', 'claim_expires_at', '2026-09-02T06:02:00.000Z')))
    `, [malformedId, terminalId, clientId]);
    const malformed = (await db.query(`select public.claim_p0_reconciliation_v2(
      $1::uuid, 1, 'reconcile_pending', 1, $2::uuid, $3::uuid, 120,
      '2026-09-02T06:00:00.000Z'::timestamptz
    ) as result`, [malformedId, clientId, owner])).rows[0].result;
    const terminal = (await db.query(`select public.settle_p0_delivery_v2(
      $1::uuid, 1, 'claimed', 1, $2::uuid, 'delivered',
      '2026-09-02T06:00:01.000Z'::timestamptz, 'CP0', '100.1', null::uuid, null::uuid
    ) as result`, [terminalId, clientId])).rows[0].result;
    assert.equal(malformed.claimed, false);
    assert.equal(terminal.applied, false);
  } finally {
    await db.close();
  }
});

test('notice cleanup atomically gates digest, TTL, and P0 eligibility with reclaimable exact leases', async () => {
  assert.ok(noticeCleanupMigrationName, 'the additive notice-cleanup migration must exist');
  const db = await createNoticeCleanupDatabase();
  const ids = {
    ordinary: '10000000-0000-4000-8000-000000000001',
    missingDigest: '10000000-0000-4000-8000-000000000002',
    autoDue: '10000000-0000-4000-8000-000000000003',
    autoFuture: '10000000-0000-4000-8000-000000000004',
    p0: '10000000-0000-4000-8000-000000000005',
    missingCoordinate: '10000000-0000-4000-8000-000000000006',
    ordinaryWork: '20000000-0000-4000-8000-000000000001',
    missingWork: '20000000-0000-4000-8000-000000000002',
    p0Work: '20000000-0000-4000-8000-000000000005',
    missingCoordinateWork: '20000000-0000-4000-8000-000000000006'
  };
  try {
    await db.query(`
      insert into public.message_notification_receipts (
        id, source, source_event_key, room_key, received_at, urgency,
        notification_state, client_message_id, slack_channel_id, slack_message_ts,
        delivered_at, cleanup_after, payload, created_at
      ) values
        ($1, 'kakao', 'event-ordinary', 'room:1', '2026-08-31T05:00:00Z', 'normal',
          'delivered', gen_random_uuid(), 'CNOTICE', '101.1', '2026-08-31T05:00:01Z', null, '{}', '2026-08-31T05:00:00Z'),
        ($2, 'kakao', 'event-no-digest', 'room:2', '2026-08-31T05:00:00Z', 'normal',
          'delivered', gen_random_uuid(), 'CNOTICE', '102.1', '2026-08-31T05:00:01Z', null, '{}', '2026-08-31T05:00:00Z'),
        ($3, 'kakao', 'event-auto-due', 'room:3', '2026-08-31T05:00:00Z', 'normal',
          'cleanup_pending', gen_random_uuid(), 'CNOTICE', '103.1', '2026-08-31T05:00:01Z',
          '2026-08-31T05:59:59Z', '{"automation_notice_update":{"status":"updated"}}', '2026-08-31T05:00:00Z'),
        ($4, 'kakao', 'event-auto-future', 'room:4', '2026-08-31T05:00:00Z', 'normal',
          'cleanup_pending', gen_random_uuid(), 'CNOTICE', '104.1', '2026-08-31T05:00:01Z',
          '2026-08-31T07:00:00Z', '{"automation_notice_update":{"status":"updated"}}', '2026-08-31T05:00:00Z'),
        ($5, 'kakao', 'event-p0', 'room:5', '2026-08-31T05:00:00Z', 'p0',
          'delivered', gen_random_uuid(), 'CNOTICE', '105.1', '2026-08-31T05:00:01Z', null, '{}', '2026-08-31T05:00:00Z'),
        ($6, 'kakao', 'event-missing-coordinate', 'room:6', '2026-08-31T05:00:00Z', 'normal',
          'delivered', gen_random_uuid(), null, null, '2026-08-31T05:00:01Z', null, '{}', '2026-08-31T05:00:00Z')
    `, [ids.ordinary, ids.missingDigest, ids.autoDue, ids.autoFuture, ids.p0, ids.missingCoordinate]);

    await db.query(`
      insert into public.work_items_v2 (
        id, work_key, source_event_keys, room_key, title, work_type, priority, state,
        actionable_at, first_opened_at, last_activity_at, payload
      ) values
        ($1, 'work:ordinary', array['event-ordinary'], 'room:1', 'ordinary', 'human_review', 'normal', 'open', now(), now(), now(), '{}'),
        ($2, 'work:no-digest', array['event-no-digest'], 'room:2', 'missing', 'human_review', 'normal', 'open', now(), now(), now(), '{}'),
        ($3, 'work:p0', array['event-p0'], 'room:5', 'p0', 'human_review', 'p0', 'open', now(), now(), now(), '{}'),
        ($4, 'work:missing-coordinate', array['event-missing-coordinate'], 'room:6', 'coordinate', 'human_review', 'normal', 'open', now(), now(), now(), '{}')
    `, [ids.ordinaryWork, ids.missingWork, ids.p0Work, ids.missingCoordinateWork]);

    await db.query(`
      insert into public.digest_runs (
        window_started_at, window_ended_at, scheduled_at, state, destination_key,
        item_snapshot, manifest_prepared_at, slack_channel_id, slack_message_ts, delivered_at
      ) values (
        '2026-08-31T03:00:00Z', '2026-08-31T06:00:00Z', '2026-08-31T06:00:00Z',
        'delivered', 'slack:CNOTICE', $1::jsonb, '2026-08-31T06:00:00Z',
        'CNOTICE', '999.1', '2026-08-31T06:00:00Z'
      )
    `, [JSON.stringify([
      { id: ids.ordinaryWork, version: 1, inclusionReason: 'actionable', priority: 'normal' },
      { id: ids.p0Work, version: 1, inclusionReason: 'p0', priority: 'p0' },
      { id: ids.missingCoordinateWork, version: 1, inclusionReason: 'actionable', priority: 'normal' }
    ])]);

    const first = await db.query(`
      select public.claim_notice_cleanup_batch_v2(
        '2026-08-31T06:00:00.000Z'::timestamptz, 'bridge:first', 120, 25
      ) as result
    `);
    const firstRows = first.rows[0].result;
    assert.deepEqual(firstRows.map((row) => row.id).sort(), [
      ids.autoDue, ids.missingCoordinate, ids.ordinary, ids.p0
    ].sort());
    assert.equal(firstRows.find((row) => row.id === ids.p0).cleanup_state, 'blocked_p0');
    assert.ok(firstRows.filter((row) => row.cleanup_state === 'pending')
      .every((row) => row.cleanup_attempts === 1 && row.cleanup_owner === 'bridge:first' && row.cleanup_token));

    const second = await db.query(`
      select public.claim_notice_cleanup_batch_v2(
        '2026-08-31T06:00:01.000Z'::timestamptz, 'bridge:second', 120, 25
      ) as result
    `);
    assert.ok(second.rows[0].result.every((row) => row.cleanup_state === 'blocked_p0'));

    const ordinaryClaim = firstRows.find((row) => row.id === ids.ordinary);
    const reclaimed = await db.query(`
      select public.claim_notice_cleanup_batch_v2(
        '2026-08-31T06:02:01.000Z'::timestamptz, 'bridge:reclaim', 120, 25
      ) as result
    `);
    const ordinaryReclaim = reclaimed.rows[0].result.find((row) => row.id === ids.ordinary);
    assert.equal(ordinaryReclaim.cleanup_attempts, 2);
    assert.equal(ordinaryReclaim.cleanup_owner, 'bridge:reclaim');
    assert.notEqual(ordinaryReclaim.cleanup_token, ordinaryClaim.cleanup_token);

    const stale = await db.query(`
      select public.mark_notice_cleanup_deleted_v2(
        $1::uuid, 'bridge:first', $2::uuid, 1, false
      ) as result
    `, [ids.ordinary, ordinaryClaim.cleanup_token]);
    assert.deepEqual(stale.rows[0].result, { applied: false, row: null });

    await db.query(`update public.message_notification_receipts
      set cleanup_expires_at = clock_timestamp() + interval '5 minutes' where id = $1::uuid`, [ids.ordinary]);
    const settled = await db.query(`
      select public.mark_notice_cleanup_deleted_v2(
        $1::uuid, 'bridge:reclaim', $2::uuid, 2, true
      ) as result
    `, [ids.ordinary, ordinaryReclaim.cleanup_token]);
    assert.equal(settled.rows[0].result.applied, true);
    assert.equal(settled.rows[0].result.row.cleanup_state, 'deleted');
    assert.equal(settled.rows[0].result.row.cleanup_already_absent, true);

    const beforeFailure = await db.query(`
      select notification_state, delivered_at from public.message_notification_receipts where id = $1::uuid
    `, [ids.autoDue]);
    const workBefore = await db.query(`select state, version from public.work_items_v2 where id = $1::uuid`, [ids.ordinaryWork]);
    const autoClaim = reclaimed.rows[0].result.find((row) => row.id === ids.autoDue);
    await db.query(`update public.message_notification_receipts
      set cleanup_expires_at = clock_timestamp() + interval '5 minutes' where id = $1::uuid`, [ids.autoDue]);
    const failed = await db.query(`
      select public.mark_notice_cleanup_failed_v2(
        $1::uuid, 'bridge:reclaim', $2::uuid, 2, 'cant_delete_message'
      ) as result
    `, [ids.autoDue, autoClaim.cleanup_token]);
    assert.equal(failed.rows[0].result.applied, true);
    const afterFailure = await db.query(`
      select notification_state, delivered_at from public.message_notification_receipts where id = $1::uuid
    `, [ids.autoDue]);
    const workAfter = await db.query(`select state, version from public.work_items_v2 where id = $1::uuid`, [ids.ordinaryWork]);
    assert.deepEqual(afterFailure.rows[0], beforeFailure.rows[0]);
    assert.deepEqual(workAfter.rows[0], workBefore.rows[0]);

    await assert.rejects(
      db.query(`select public.claim_notice_cleanup_batch_v2(now(), 'bridge:test', 120, 26)`),
      /invalid/i
    );
    await assert.rejects(
      db.query(`select public.claim_notice_cleanup_batch_v2(now(), 'bridge:test', 120, null)`),
      /invalid/i
    );
    await assert.rejects(
      db.query(`select public.claim_notice_cleanup_batch_v2(now(), 'bridge:test', null, 25)`),
      /invalid/i
    );
    await assert.rejects(
      db.query(`select public.mark_notice_cleanup_failed_v2(
        $1::uuid, 'bridge:reclaim', $2::uuid, null, 'cant_delete_message'
      )`, [ids.missingCoordinate, reclaimed.rows[0].result.find((row) => row.id === ids.missingCoordinate).cleanup_token]),
      /invalid/i
    );
    await assert.rejects(
      db.query(`select public.mark_notice_cleanup_failed_v2(
        $1::uuid, 'bridge:reclaim', $2::uuid, 2, null
      )`, [ids.missingCoordinate, reclaimed.rows[0].result.find((row) => row.id === ids.missingCoordinate).cleanup_token]),
      /invalid/i
    );
  } finally {
    await db.close();
  }
});

test('notice cleanup uses a minimum work version plus the receipt creation temporal fence', async () => {
  const db = await createNoticeCleanupDatabase();
  const oldReceiptId = '31000000-0000-4000-8000-000000000001';
  const newReceiptId = '31000000-0000-4000-8000-000000000002';
  const candidate = (sourceEventKey, lastActivityAt) => ({
    work_key: 'review:stable-cleanup-link',
    source_event_keys: [sourceEventKey],
    room_key: 'room:stable-cleanup-link',
    title: 'Stable cleanup link',
    summary: '',
    work_type: 'human_review',
    priority: 'normal',
    state: 'open',
    owner_id: null,
    actionable_at: '2026-08-31T05:00:00.000Z',
    due_at: null,
    snoozed_until: null,
    first_opened_at: '2026-08-31T05:00:00.000Z',
    last_activity_at: lastActivityAt,
    automation_state: 'needs_human',
    payload: { requires_human_action: true }
  });
  try {
    await db.query(`
      insert into public.message_notification_receipts (
        id, source, source_event_key, room_key, received_at, notification_state,
        client_message_id, slack_channel_id, slack_message_ts, delivered_at,
        created_at
      ) values ($1, 'kakao', 'event-link-old', 'room:stable-cleanup-link',
        '2026-08-31T05:00:00Z', 'delivered', gen_random_uuid(), 'CNOTICE', '301.1',
        '2026-08-31T05:00:01Z', '2026-08-31T05:00:00Z')
    `, [oldReceiptId]);
    const firstWork = await db.query(
      `select public.upsert_work_item_v2($1::jsonb) as result`,
      [JSON.stringify(candidate('event-link-old', '2026-08-31T05:00:00.000Z'))]
    );
    assert.equal(firstWork.rows[0].result.row.version, 1);
    const workId = firstWork.rows[0].result.row.id;
    const mergedWork = await db.query(
      `select public.upsert_work_item_v2($1::jsonb) as result`,
      [JSON.stringify(candidate('event-link-new', '2026-08-31T05:30:00.000Z'))]
    );
    assert.equal(mergedWork.rows[0].result.row.id, workId);
    assert.equal(mergedWork.rows[0].result.row.version, 2);
    await db.query(`
      insert into public.digest_runs (
        window_started_at, window_ended_at, scheduled_at, state, destination_key,
        item_snapshot, manifest_prepared_at, slack_channel_id, slack_message_ts, delivered_at
      ) values (
        '2026-08-31T03:00:00Z', '2026-08-31T06:00:00Z', '2026-08-31T06:00:00Z',
        'delivered', 'slack:CNOTICE', $1::jsonb, '2026-08-31T06:00:00Z',
        'CNOTICE', '390.1', '2026-08-31T06:00:00Z'
      )
    `, [JSON.stringify([{ id: workId, version: 2, inclusionReason: 'actionable', priority: 'normal' }])]);

    const oldClaim = (await db.query(`
      select public.claim_notice_cleanup_batch_v2(
        '2026-08-31T06:00:01.000Z', 'bridge:old-link', 900, 25
      ) as result
    `)).rows[0].result;
    assert.deepEqual(oldClaim.map((row) => row.id), [oldReceiptId],
      'a v2 digest represents an older receipt linked to minimum work version v1');

    await db.query(`
      insert into public.message_notification_receipts (
        id, source, source_event_key, room_key, received_at, notification_state,
        client_message_id, slack_channel_id, slack_message_ts, delivered_at, created_at
      ) values ($1, 'kakao', 'event-link-new', 'room:stable-cleanup-link',
        '2026-08-31T06:01:00Z', 'delivered', gen_random_uuid(), 'CNOTICE', '302.1',
        '2026-08-31T06:01:01Z', '2026-08-31T06:01:00Z')
    `, [newReceiptId]);

    const afterPastSameVersionDigest = (await db.query(`
      select public.claim_notice_cleanup_batch_v2(
        '2026-08-31T06:01:02.000Z', 'bridge:new-link', 120, 25
      ) as result
    `)).rows[0].result;
    assert.equal(afterPastSameVersionDigest.some((row) => row.id === newReceiptId), false,
      'a digest delivered before a later receipt cannot authorize that receipt at the same version');

    await db.query(`
      insert into public.digest_runs (
        window_started_at, window_ended_at, scheduled_at, state, destination_key,
        item_snapshot, manifest_prepared_at, slack_channel_id, slack_message_ts, delivered_at
      ) values (
        '2026-08-31T06:00:00Z', '2026-08-31T09:00:00Z', '2026-08-31T09:00:00Z',
        'delivered', 'slack:CNOTICE', $1::jsonb, '2026-08-31T06:02:00Z',
        'CNOTICE', '391.1', '2026-08-31T06:02:00Z'
      )
    `, [JSON.stringify([{ id: workId, version: 1, inclusionReason: 'actionable', priority: 'normal' }])]);
    const afterLaterV1Digest = (await db.query(`
      select public.claim_notice_cleanup_batch_v2(
        '2026-08-31T06:02:01.000Z', 'bridge:new-link', 120, 25
      ) as result
    `)).rows[0].result;
    assert.equal(afterLaterV1Digest.some((row) => row.id === newReceiptId), false,
      'a new receipt linked at minimum v2 cannot be authorized by a later v1 digest');

    await db.query(`
      insert into public.digest_runs (
        window_started_at, window_ended_at, scheduled_at, state, destination_key,
        item_snapshot, manifest_prepared_at, slack_channel_id, slack_message_ts, delivered_at
      ) values (
        '2026-08-31T06:00:00Z', '2026-08-31T09:00:00Z', '2026-08-31T09:00:01Z',
        'delivered', 'slack:CNOTICE', $1::jsonb, '2026-08-31T06:03:00Z',
        'CNOTICE', '392.1', '2026-08-31T06:03:00Z'
      )
    `, [JSON.stringify([{ id: workId, version: 2, inclusionReason: 'actionable', priority: 'normal' }])]);
    const afterV2Digest = (await db.query(`
      select public.claim_notice_cleanup_batch_v2(
        '2026-08-31T06:03:01.000Z', 'bridge:new-link', 120, 25
      ) as result
    `)).rows[0].result;
    assert.equal(afterV2Digest.some((row) => row.id === newReceiptId), true);
    const links = await db.query(`
      select id, cleanup_work_id, cleanup_work_version
      from public.message_notification_receipts
      where id in ($1::uuid, $2::uuid)
      order by id
    `, [oldReceiptId, newReceiptId]);
    assert.deepEqual(links.rows, [
      { id: oldReceiptId, cleanup_work_id: workId, cleanup_work_version: 1 },
      { id: newReceiptId, cleanup_work_id: workId, cleanup_work_version: 2 }
    ]);
  } finally {
    await db.close();
  }
});

test('notice cleanup claim reconciles exact zero-one-many source ownership on every attempt', async () => {
  const db = await createNoticeCleanupDatabase();
  const receiptBeforeWork = '32000000-0000-4000-8000-000000000001';
  const workBeforeReceipt = '32000000-0000-4000-8000-000000000002';
  const ambiguousReceipt = '32000000-0000-4000-8000-000000000003';
  const zeroOwnerReceipt = '32000000-0000-4000-8000-000000000004';
  const firstWork = '32100000-0000-4000-8000-000000000001';
  const secondWork = '32100000-0000-4000-8000-000000000002';
  const ambiguousFirstWork = '32100000-0000-4000-8000-000000000003';
  const ambiguousSecondWork = '32100000-0000-4000-8000-000000000004';
  const insertWork = async (id, workKey, sourceEventKey) => db.query(`
    insert into public.work_items_v2 (
      id, work_key, source_event_keys, room_key, title, work_type, priority, state,
      actionable_at, first_opened_at, last_activity_at, version, payload
    ) values ($1, $2, array[$3], 'room:reconcile', 'Reconcile', 'human_review', 'normal',
      'open', '2026-08-31T05:00:00Z', '2026-08-31T05:00:00Z',
      '2026-08-31T05:00:00Z', 1, '{}')
  `, [id, workKey, sourceEventKey]);
  const insertReceipt = async (id, sourceEventKey, createdAt, messageTs) => db.query(`
    insert into public.message_notification_receipts (
      id, source, source_event_key, room_key, received_at, notification_state,
      client_message_id, slack_channel_id, slack_message_ts, delivered_at, created_at
    ) values ($1, 'kakao', $2, 'room:reconcile', $3::timestamptz, 'delivered',
      gen_random_uuid(), 'CNOTICE', $4, $3::timestamptz, $3::timestamptz)
  `, [id, sourceEventKey, createdAt, messageTs]);
  const insertDigest = async (workId, workVersion, deliveredAt, messageTs) => db.query(`
    insert into public.digest_runs (
      window_started_at, window_ended_at, scheduled_at, state, destination_key,
      item_snapshot, manifest_prepared_at, slack_channel_id, slack_message_ts, delivered_at
    ) values ('2026-08-31T03:00:00Z', '2026-08-31T06:00:00Z', $2::timestamptz,
      'delivered', 'slack:CNOTICE', $1::jsonb, $2::timestamptz, 'CNOTICE', $3, $2::timestamptz)
  `, [JSON.stringify([{
    id: workId, version: workVersion, inclusionReason: 'actionable', priority: 'normal'
  }]), deliveredAt, messageTs]);
  const claim = async (owner, now) => (await db.query(`
    select public.claim_notice_cleanup_batch_v2($1::timestamptz, $2, 900, 25) as result
  `, [now, owner])).rows[0].result;

  try {
    await insertReceipt(zeroOwnerReceipt, 'event-zero-owner', '2026-08-31T04:59:00Z', '320.0');
    await db.query(`update public.message_notification_receipts set urgency = 'p0' where id = $1::uuid`, [zeroOwnerReceipt]);
    await insertReceipt(receiptBeforeWork, 'event-receipt-before-work', '2026-08-31T05:00:00Z', '320.1');
    await insertWork(firstWork, 'work:receipt-before', 'event-receipt-before-work');
    let link = (await db.query(`
      select cleanup_work_id, cleanup_work_version
      from public.message_notification_receipts where id = $1::uuid
    `, [receiptBeforeWork])).rows[0];
    assert.deepEqual(link, { cleanup_work_id: null, cleanup_work_version: null },
      'receipt-before-work does not depend on a work-side trigger wakeup');
    await insertDigest(firstWork, 1, '2026-08-31T06:00:00Z', '420.1');
    const receiptFirstClaim = await claim('bridge:receipt-first', '2026-08-31T06:00:01Z');
    assert.equal(receiptFirstClaim.some((row) => row.id === receiptBeforeWork), true);
    assert.equal(receiptFirstClaim.some((row) => row.id === zeroOwnerReceipt), false,
      'a zero-owner P0 receipt is not claimed through the blocked-P0 path');
    link = (await db.query(`
      select cleanup_work_id, cleanup_work_version
      from public.message_notification_receipts where id = $1::uuid
    `, [receiptBeforeWork])).rows[0];
    assert.deepEqual(link, { cleanup_work_id: firstWork, cleanup_work_version: 1 });

    await insertWork(secondWork, 'work:work-before', 'event-work-before-receipt');
    await insertReceipt(workBeforeReceipt, 'event-work-before-receipt', '2026-08-31T05:01:00Z', '320.2');
    await db.query(`
      update public.message_notification_receipts
      set cleanup_work_id = null, cleanup_work_version = null
      where id = $1::uuid
    `, [workBeforeReceipt]);
    await db.query(`update public.work_items_v2 set version = 2 where id = $1::uuid`, [secondWork]);
    await db.query(`delete from public.notice_cleanup_work_sources_v2 where work_id = $1::uuid`, [secondWork]);
    await insertDigest(secondWork, 1, '2026-08-31T06:00:02Z', '420.2');
    const beforeCurrentDigest = await claim('bridge:missed-wake-old-digest', '2026-08-31T06:00:03Z');
    assert.equal(beforeCurrentDigest.some((row) => row.id === workBeforeReceipt), false,
      'missing membership conservatively waits for a digest at the current work version');
    await insertDigest(secondWork, 2, '2026-08-31T06:00:04Z', '420.21');
    const missedWakeClaim = await claim('bridge:missed-wake-current-digest', '2026-08-31T06:00:05Z');
    assert.equal(missedWakeClaim.some((row) => row.id === workBeforeReceipt), true,
      'claim-time reconciliation links a committed exact-one owner after its current-version digest');
    const missedMembership = (await db.query(`
      select count(*)::integer as count
      from public.notice_cleanup_work_sources_v2
      where work_id = $1::uuid and source_event_key = 'event-work-before-receipt'
    `, [secondWork])).rows[0].count;
    assert.equal(missedMembership, 0,
      'claim reconciliation does not repair membership while holding the source advisory lock');
    link = (await db.query(`
      select cleanup_work_id, cleanup_work_version
      from public.message_notification_receipts where id = $1::uuid
    `, [workBeforeReceipt])).rows[0];
    assert.deepEqual(link, { cleanup_work_id: secondWork, cleanup_work_version: 2 });

    await insertWork(ambiguousFirstWork, 'work:ambiguous-first', 'event-later-ambiguous');
    await insertReceipt(ambiguousReceipt, 'event-later-ambiguous', '2026-08-31T05:02:00Z', '320.3');
    await insertDigest(ambiguousFirstWork, 1, '2026-08-31T06:00:06Z', '420.3');
    await insertWork(ambiguousSecondWork, 'work:ambiguous-second', 'event-later-ambiguous');
    const ambiguousClaim = await claim('bridge:ambiguous', '2026-08-31T06:00:07Z');
    assert.equal(ambiguousClaim.some((row) => row.id === ambiguousReceipt), false,
      'a later second exact source owner invalidates even an already linked receipt');
    link = (await db.query(`
      select cleanup_work_id, cleanup_work_version
      from public.message_notification_receipts where id = $1::uuid
    `, [ambiguousReceipt])).rows[0];
    assert.deepEqual(link, { cleanup_work_id: ambiguousFirstWork, cleanup_work_version: 1 },
      'a bounded claim may leave a stale link stored but never trusts it without the exact recount');

    await db.query(`delete from public.work_items_v2 where id = $1::uuid`, [ambiguousSecondWork]);
    const restoredClaim = await claim('bridge:restored', '2026-08-31T06:00:08Z');
    assert.equal(restoredClaim.some((row) => row.id === ambiguousReceipt), true,
      'a later exact-one committed owner can safely restore the bounded link');
    link = (await db.query(`
      select cleanup_work_id, cleanup_work_version
      from public.message_notification_receipts where id = $1::uuid
    `, [ambiguousReceipt])).rows[0];
    assert.deepEqual(link, { cleanup_work_id: ambiguousFirstWork, cleanup_work_version: 1 });
  } finally {
    await db.close();
  }
});

test('notice cleanup bounds ownership mutations and skips unrelated active or ambiguous history', async () => {
  const db = await createNoticeCleanupDatabase();
  const ambiguousReceiptIds = Array.from({ length: 30 }, (_, index) =>
    `37000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`);
  const historyWorkIds = Array.from({ length: 30 }, (_, index) =>
    `37100000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`);
  const activeLeaseIds = Array.from({ length: 30 }, (_, index) =>
    `37400000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`);
  const validIds = [
    '37200000-0000-4000-8000-000000000001',
    '37200000-0000-4000-8000-000000000002'
  ];
  try {
    for (const [index, receiptId] of ambiguousReceiptIds.entries()) {
      const firstWorkId = `37300000-0000-4000-8000-${String(index * 2 + 1).padStart(12, '0')}`;
      const secondWorkId = `37300000-0000-4000-8000-${String(index * 2 + 2).padStart(12, '0')}`;
      const sourceKey = `event-bounded-ambiguous-${index}`;
      await db.query(`
        insert into public.work_items_v2 (
          id, work_key, source_event_keys, room_key, title, work_type, priority, state,
          actionable_at, first_opened_at, last_activity_at, version, payload
        ) values ($1, $2, array[$3], 'room:bounded', 'Bounded', 'human_review', 'p0',
          'open', now(), now(), now(), 1, '{}')
      `, [firstWorkId, `work:bounded:first:${index}`, sourceKey]);
      await db.query(`
        insert into public.message_notification_receipts (
          id, source, source_event_key, room_key, received_at, urgency, notification_state,
          client_message_id, slack_channel_id, slack_message_ts, delivered_at, created_at
        ) values ($1, 'kakao', $2, 'room:bounded', '2026-08-31T05:00:00Z', 'p0', 'delivered',
          gen_random_uuid(), 'CNOTICE', $3, '2026-08-31T05:00:01Z', '2026-08-31T05:00:00Z')
      `, [receiptId, sourceKey, `37${index}.1`]);
      await db.query(`
        insert into public.work_items_v2 (
          id, work_key, source_event_keys, room_key, title, work_type, priority, state,
          actionable_at, first_opened_at, last_activity_at, version, payload
        ) values ($1, $2, array[$3], 'room:bounded', 'Ambiguous', 'human_review', 'p0',
          'open', now(), now(), now(), 1, '{}')
      `, [secondWorkId, `work:bounded:second:${index}`, sourceKey]);
    }
    for (const [index, workId] of historyWorkIds.entries()) {
      await db.query(`
        insert into public.work_items_v2 (
          id, work_key, source_event_keys, room_key, title, work_type, priority, state,
          actionable_at, first_opened_at, last_activity_at, version, payload
        ) values ($1, $2, array[$3], 'room:history', 'History', 'human_review', 'normal',
          'resolved', now(), now(), now(), 1, '{}')
      `, [workId, `work:history:${index}`, `event-history-${index}`]);
    }
    await db.query(`delete from public.notice_cleanup_work_sources_v2 where work_id = any($1::uuid[])`, [historyWorkIds]);
    for (const [index, id] of activeLeaseIds.entries()) {
      await db.query(`
        insert into public.message_notification_receipts (
          id, source, source_event_key, room_key, received_at, notification_state,
          client_message_id, slack_channel_id, slack_message_ts, delivered_at, cleanup_after,
          cleanup_state, cleanup_attempts, cleanup_owner, cleanup_token, cleanup_expires_at,
          cleanup_attempted_at, payload
        ) values ($1, 'kakao', $2, 'room:active', '2026-08-31T05:00:00Z', 'cleanup_pending',
          gen_random_uuid(), 'CNOTICE', $3, '2026-08-31T05:00:01Z', '2026-08-31T05:59:59Z',
          'pending', 1, 'bridge:active', gen_random_uuid(), '2026-08-31T07:00:00Z',
          '2026-08-31T05:00:00Z', '{"automation_notice_update":{"status":"updated"}}')
      `, [id, `event-active-${index}`, `390.${index + 1}`]);
    }
    for (const [index, id] of validIds.entries()) {
      await db.query(`
        insert into public.message_notification_receipts (
          id, source, source_event_key, room_key, received_at, notification_state,
          client_message_id, slack_channel_id, slack_message_ts, delivered_at, cleanup_after, payload
        ) values ($1, 'kakao', $2, 'room:valid', '2026-08-31T05:00:00Z', 'cleanup_pending',
          gen_random_uuid(), 'CNOTICE', $3, '2026-08-31T05:00:01Z', '2026-08-31T05:59:59Z',
          '{"automation_notice_update":{"status":"updated"}}')
      `, [id, `event-valid-${index}`, `380.${index + 1}`]);
    }

    const claimed = (await db.query(`
      select public.claim_notice_cleanup_batch_v2('2026-08-31T06:00:00Z', 'bridge:bounded', 120, 25) as result
    `)).rows[0].result;
    assert.deepEqual(claimed.map((row) => row.id).sort(), validIds);
    const invalidated = (await db.query(`
      select count(*)::integer as count from public.message_notification_receipts
      where id = any($1::uuid[]) and cleanup_work_id is null
    `, [ambiguousReceiptIds])).rows[0].count;
    assert.ok(invalidated <= 25, 'one bounded sweep cannot mutate more than its receipt claim limit');
    const repairedHistory = (await db.query(`
      select count(*)::integer as count from public.notice_cleanup_work_sources_v2
      where work_id = any($1::uuid[])
    `, [historyWorkIds])).rows[0].count;
    assert.ok(repairedHistory <= 25, 'one bounded sweep cannot backfill unrelated history globally');
    const activeOwners = (await db.query(`
      select count(*)::integer as count from public.message_notification_receipts
      where id = any($1::uuid[]) and cleanup_owner = 'bridge:active'
        and cleanup_expires_at = '2026-08-31T07:00:00Z'
    `, [activeLeaseIds])).rows[0].count;
    assert.equal(activeOwners, activeLeaseIds.length,
      'unrelated active leases do not block or get mutated by the bounded scheduler');
  } finally {
    await db.close();
  }
});

test('notice cleanup completes a bounded b-then-a receipt batch under the shared multi-key lock contract', async () => {
  const db = await createNoticeCleanupDatabase();
  const receiptB = '37500000-0000-4000-8000-000000000001';
  const receiptA = '37500000-0000-4000-8000-000000000002';
  const workId = '37600000-0000-4000-8000-000000000001';
  try {
    await db.query(`
      insert into public.work_items_v2 (
        id, work_key, source_event_keys, room_key, title, work_type, priority, state,
        actionable_at, first_opened_at, last_activity_at, version, payload
      ) values ($1, 'work:lock-order', array['event-lock-a', 'event-lock-b'],
        'room:lock-order', 'Lock order', 'human_review', 'normal', 'open',
        '2026-08-31T05:00:00Z', '2026-08-31T05:00:00Z', '2026-08-31T05:00:00Z', 1, '{}')
    `, [workId]);
    await db.query(`
      insert into public.message_notification_receipts (
        id, source, source_event_key, room_key, received_at, notification_state,
        client_message_id, slack_channel_id, slack_message_ts, delivered_at,
        payload, created_at, updated_at
      ) values
        ($1, 'kakao', 'event-lock-b', 'room:lock-order', '2026-08-31T05:00:00Z', 'delivered',
          gen_random_uuid(), 'CNOTICE', '395.1', '2026-08-31T05:00:01Z', '{}',
          '2026-08-31T05:00:00Z', '2026-08-31T05:00:00Z'),
        ($2, 'kakao', 'event-lock-a', 'room:lock-order', '2026-08-31T05:00:00Z', 'delivered',
          gen_random_uuid(), 'CNOTICE', '395.2', '2026-08-31T05:00:01Z', '{}',
          '2026-08-31T05:00:00Z', '2026-08-31T05:01:00Z')
    `, [receiptB, receiptA]);
    await db.query(`
      insert into public.digest_runs (
        window_started_at, window_ended_at, scheduled_at, state, destination_key,
        item_snapshot, manifest_prepared_at, slack_channel_id, slack_message_ts, delivered_at
      ) values ('2026-08-31T03:00:00Z', '2026-08-31T06:00:00Z', '2026-08-31T06:00:00Z',
        'delivered', 'slack:CNOTICE', $1::jsonb, '2026-08-31T06:00:00Z',
        'CNOTICE', '495.1', '2026-08-31T06:00:00Z')
    `, [JSON.stringify([
      { id: workId, version: 1, inclusionReason: 'actionable', priority: 'normal' }
    ])]);
    const claimed = (await db.query(`
      select public.claim_notice_cleanup_batch_v2(
        '2026-08-31T06:00:01Z', 'bridge:lock-order', 120, 25
      ) as result
    `)).rows[0].result;
    assert.deepEqual(claimed.map((row) => row.id), [receiptB, receiptA],
      'opposite receipt order still completes after the implementation pre-acquires lexical source locks');
  } finally {
    await db.close();
  }
});

test('notice cleanup terminal CAS uses database execution time at and after lease expiry', async () => {
  const db = await createNoticeCleanupDatabase();
  const receiptId = '33000000-0000-4000-8000-000000000001';
  try {
    await db.query(`
      insert into public.message_notification_receipts (
        id, source, source_event_key, room_key, received_at, notification_state,
        client_message_id, slack_channel_id, slack_message_ts, delivered_at, cleanup_after, payload
      ) values ($1, 'kakao', 'event-db-clock', 'room:db-clock', clock_timestamp() - interval '1 hour',
        'cleanup_pending', gen_random_uuid(), 'CNOTICE', '330.1', clock_timestamp() - interval '59 minutes',
        clock_timestamp() - interval '1 minute', '{"automation_notice_update":{"status":"updated"}}')
    `, [receiptId]);
    const claim = (await db.query(`
      select public.claim_notice_cleanup_batch_v2(clock_timestamp(), 'bridge:db-clock', 120, 25) as result
    `)).rows[0].result[0];

    await db.query(`
      update public.message_notification_receipts
      set cleanup_expires_at = clock_timestamp() - interval '1 millisecond'
      where id = $1::uuid
    `, [receiptId]);
    const expired = await db.query(`
      select public.mark_notice_cleanup_deleted_v2(
        $1::uuid, 'bridge:db-clock', $2::uuid, 1, false
      ) as result
    `, [receiptId, claim.cleanup_token]);
    assert.deepEqual(expired.rows[0].result, { applied: false, row: null },
      'an expired worker cannot backdate completion without a reclaim');

    await db.query(`
      update public.message_notification_receipts
      set cleanup_expires_at = clock_timestamp()
      where id = $1::uuid
    `, [receiptId]);
    const boundary = await db.query(`
      select public.mark_notice_cleanup_failed_v2(
        $1::uuid, 'bridge:db-clock', $2::uuid, 1, 'cleanup_unconfirmed'
      ) as result
    `, [receiptId, claim.cleanup_token]);
    assert.deepEqual(boundary.rows[0].result, { applied: false, row: null },
      'the exact expiry boundary is not an unexpired lease');

    await db.query(`
      update public.message_notification_receipts
      set cleanup_expires_at = clock_timestamp() + interval '5 minutes'
      where id = $1::uuid
    `, [receiptId]);
    await db.exec(`create temporary table cleanup_terminal_clock_probe (before_at timestamptz not null)`);
    await db.exec(`insert into cleanup_terminal_clock_probe values (clock_timestamp())`);
    const settled = await db.query(`
      select public.mark_notice_cleanup_deleted_v2(
        $1::uuid, 'bridge:db-clock', $2::uuid, 1, true
      ) as result
    `, [receiptId, claim.cleanup_token]);
    assert.equal(settled.rows[0].result.applied, true);
    const persistedClock = await db.query(`
      select receipt.cleaned_at = $2::timestamptz as response_matches,
        receipt.cleaned_at >= probe.before_at and receipt.cleaned_at <= clock_timestamp() as in_db_window
      from public.message_notification_receipts as receipt
      cross join cleanup_terminal_clock_probe as probe
      where receipt.id = $1::uuid
    `, [receiptId, settled.rows[0].result.row.cleaned_at]);
    assert.deepEqual(persistedClock.rows[0], { response_matches: true, in_db_window: true },
      'cleaned_at is the database completion time, not a caller-provided sweep clock');
  } finally {
    await db.close();
  }
});

test('notice cleanup normalizes poison coordinates without blocking valid siblings', async () => {
  const db = await createNoticeCleanupDatabase();
  const poisonPartial = '34000000-0000-4000-8000-000000000001';
  const poisonMalformed = '34000000-0000-4000-8000-000000000002';
  const valid = '34000000-0000-4000-8000-000000000003';
  try {
    await db.query(`
      insert into public.message_notification_receipts (
        id, source, source_event_key, room_key, received_at, notification_state,
        client_message_id, slack_channel_id, slack_message_ts, delivered_at, cleanup_after, payload
      ) values
        ($1, 'kakao', 'event-poison-partial', 'room:poison', clock_timestamp() - interval '1 hour',
          'cleanup_pending', gen_random_uuid(), 'CNOTICE', null, clock_timestamp() - interval '59 minutes',
          clock_timestamp() - interval '1 minute', '{"automation_notice_update":{"status":"updated"}}'),
        ($2, 'kakao', 'event-poison-malformed', 'room:poison', clock_timestamp() - interval '1 hour',
          'cleanup_pending', gen_random_uuid(), 'not a channel', 'bad-ts', clock_timestamp() - interval '59 minutes',
          clock_timestamp() - interval '1 minute', '{"automation_notice_update":{"status":"updated"}}'),
        ($3, 'kakao', 'event-poison-valid', 'room:poison', clock_timestamp() - interval '1 hour',
          'cleanup_pending', gen_random_uuid(), 'CNOTICE', '340.3', clock_timestamp() - interval '59 minutes',
          clock_timestamp() - interval '1 minute', '{"automation_notice_update":{"status":"updated"}}')
    `, [poisonPartial, poisonMalformed, valid]);
    const rows = (await db.query(`
      select public.claim_notice_cleanup_batch_v2(clock_timestamp(), 'bridge:poison', 120, 25) as result
    `)).rows[0].result;
    assert.equal(rows.length, 3);
    for (const id of [poisonPartial, poisonMalformed]) {
      const poison = rows.find((row) => row.id === id);
      assert.equal(poison.coordinate_status, 'missing_coordinates');
      assert.equal(poison.slack_channel_id, null);
      assert.equal(poison.slack_message_ts, null);
      const failed = await db.query(`
        select public.mark_notice_cleanup_failed_v2(
          $1::uuid, 'bridge:poison', $2::uuid, 1, 'missing_coordinates'
        ) as result
      `, [id, poison.cleanup_token]);
      assert.equal(failed.rows[0].result.applied, true);
    }
    const validRow = rows.find((row) => row.id === valid);
    assert.equal(validRow.coordinate_status, 'valid');
    assert.deepEqual([validRow.slack_channel_id, validRow.slack_message_ts], ['CNOTICE', '340.3']);
    const deleted = await db.query(`
      select public.mark_notice_cleanup_deleted_v2(
        $1::uuid, 'bridge:poison', $2::uuid, 1, false
      ) as result
    `, [valid, validRow.cleanup_token]);
    assert.equal(deleted.rows[0].result.applied, true);
  } finally {
    await db.close();
  }
});

test('notice cleanup reclaims only complete legacy null-lease pending rows after migration', async () => {
  const db = await createFoundationDatabase();
  const legacyReceipt = '35000000-0000-4000-8000-000000000001';
  const partialReceipts = [
    '35000000-0000-4000-8000-000000000002',
    '35000000-0000-4000-8000-000000000003',
    '35000000-0000-4000-8000-000000000004',
    '35000000-0000-4000-8000-000000000005',
    '35000000-0000-4000-8000-000000000006',
    '35000000-0000-4000-8000-000000000007',
    '35000000-0000-4000-8000-000000000008',
    '35000000-0000-4000-8000-000000000009'
  ];
  const workId = '36000000-0000-4000-8000-000000000001';
  try {
    await db.query(`
      insert into public.message_notification_receipts (
        id, source, source_event_key, room_key, received_at, notification_state,
        client_message_id, slack_channel_id, slack_message_ts, delivered_at, cleanup_state,
        created_at
      ) values ($1, 'kakao', 'event-legacy-pending', 'room:legacy', '2026-08-31T05:00:00Z',
        'delivered', gen_random_uuid(), 'CNOTICE', '350.1', '2026-08-31T05:00:01Z', 'pending',
        '2026-08-31T05:00:00Z')
    `, [legacyReceipt]);
    await db.query(`
      insert into public.work_items_v2 (
        id, work_key, source_event_keys, room_key, title, work_type, priority, state,
        actionable_at, first_opened_at, last_activity_at, version, payload
      ) values ($1, 'work:legacy-pending', array['event-legacy-pending'], 'room:legacy',
        'Legacy pending', 'human_review', 'normal', 'open', now(), now(), now(), 1, '{}')
    `, [workId]);
    await db.query(`
      insert into public.digest_runs (
        window_started_at, window_ended_at, scheduled_at, state, destination_key,
        item_snapshot, manifest_prepared_at, slack_channel_id, slack_message_ts, delivered_at
      ) values ('2026-08-31T03:00:00Z', '2026-08-31T06:00:00Z', '2026-08-31T06:00:00Z',
        'delivered', 'slack:CNOTICE', $1::jsonb, '2026-08-31T06:00:00Z', 'CNOTICE', '399.1', '2026-08-31T06:00:00Z')
    `, [JSON.stringify([{ id: workId, version: 1, inclusionReason: 'actionable', priority: 'normal' }])]);

    await db.exec(readFileSync(join(migrationsDirectory, noticeCleanupMigrationName), 'utf8'));
    for (const [index, id] of partialReceipts.entries()) {
      await db.query(`
        insert into public.message_notification_receipts (
          id, source, source_event_key, room_key, received_at, notification_state,
          client_message_id, slack_channel_id, slack_message_ts, delivered_at, cleanup_after,
          cleanup_state, payload
        ) values ($1, 'kakao', $2, 'room:legacy', '2026-08-31T05:00:00Z',
          'cleanup_pending', gen_random_uuid(), 'CNOTICE', $3, '2026-08-31T05:00:01Z',
          '2026-08-31T05:59:59Z', 'pending',
          '{"automation_notice_update":{"status":"updated"}}')
      `, [id, `event-partial-pending-${index}`, `35${index + 1}.2`]);
    }
    await db.query(`update public.message_notification_receipts set cleanup_owner = 'partial-owner' where id = $1::uuid`, [partialReceipts[0]]);
    await db.query(`update public.message_notification_receipts set cleanup_token = gen_random_uuid() where id = $1::uuid`, [partialReceipts[1]]);
    await db.query(`update public.message_notification_receipts set cleanup_expires_at = '2026-08-31T05:00:00Z' where id = $1::uuid`, [partialReceipts[2]]);
    await db.query(`update public.message_notification_receipts set cleanup_attempts = 1 where id = $1::uuid`, [partialReceipts[3]]);
    await db.query(`update public.message_notification_receipts set cleanup_attempted_at = '2026-08-31T05:00:00Z' where id = $1::uuid`, [partialReceipts[4]]);
    await db.query(`update public.message_notification_receipts set cleaned_at = '2026-08-31T05:00:00Z' where id = $1::uuid`, [partialReceipts[5]]);
    await db.query(`update public.message_notification_receipts set cleanup_error = 'cleanup_unconfirmed' where id = $1::uuid`, [partialReceipts[6]]);
    await db.query(`update public.message_notification_receipts set cleanup_already_absent = true where id = $1::uuid`, [partialReceipts[7]]);
    const claimed = (await db.query(`
      select public.claim_notice_cleanup_batch_v2(
        '2026-08-31T06:00:01.000Z', 'bridge:legacy', 120, 25
      ) as result
    `)).rows[0].result;
    assert.deepEqual(claimed.map((row) => row.id), [legacyReceipt]);
    assert.equal(claimed[0].cleanup_owner, 'bridge:legacy');
    assert.ok(claimed[0].cleanup_token);
    assert.deepEqual(claimed.filter((row) => partialReceipts.includes(row.id)), [],
      'every partially populated pending generation or terminal shape fails closed');
  } finally {
    await db.close();
  }
});

test('digest-visible buttons are fenced until delivery and processable pending actions cannot starve', async () => {
  assert.ok(migrationName, 'the CLI-generated foundation migration must exist');
  const db = new PGlite({ extensions: { pgcrypto } });
  try {
    await db.exec(`
      create role anon nologin;
      create role authenticated nologin;
      create role service_role nologin;
      create extension if not exists pgcrypto;
    `);
    await db.exec(readFileSync(join(migrationsDirectory, migrationName), 'utf8'));

    const { rows: raceRows } = await db.query(`
      insert into public.work_items_v2 (
        work_key, room_key, title, summary, work_type, priority, state,
        actionable_at, first_opened_at, last_activity_at, automation_state, payload
      ) values (
        'review:race', 'room:review', 'Race review', '', 'review', 'normal', 'open',
        now() - interval '1 hour', now() - interval '1 day', now() - interval '1 hour',
        'needs_human', '{"requires_human_action":true}'::jsonb
      ) returning id, version, pending_action
    `);
    const race = raceRows[0];
    const { rows: claimedRows } = await db.query(`
      select public.claim_digest_run_v2(
        'slack:review-race', now(), now() - interval '3 hours', now(), 'bridge:review-race', 120
      ) as result
    `);
    const claimed = claimedRows[0].result;
    const digestId = claimed.row.id;
    const originalToken = claimed.row.lease_token;
    const snapshot = [{ id: race.id, version: race.version, inclusionReason: 'actionable', priority: 'normal' }];
    const intent = [{
      kind: 'ordinary', partNumber: 1, partCount: 1,
      itemIds: [race.id], payloadHash: 'f'.repeat(64)
    }];
    const prepare = async (owner, token) => (await db.query(`
      select public.prepare_digest_parts_v2($1::uuid, $2::text, $3::uuid, $4::jsonb, $5::jsonb) as result
    `, [digestId, owner, token, JSON.stringify(snapshot), JSON.stringify(intent)])).rows[0].result;
    const prepared = await prepare('bridge:review-race', originalToken);
    assert.equal(prepared.created, true);
    const originalPart = prepared.parts[0];
    const { rows: partClaimRows } = await db.query(`
      select public.claim_digest_part_delivery_v2($1::uuid, $2::uuid, $3::text, $4::uuid) as result
    `, [digestId, originalPart.id, 'bridge:review-race', originalToken]);
    assert.equal(partClaimRows[0].result.claimed, true);
    const { rows: deliveredRows } = await db.query(`
      select public.mark_digest_part_delivered_v2(
        $1::uuid, $2::uuid, $3::text, $4::uuid, 1, 'CREVIEW', '200.01', now()
      ) as result
    `, [digestId, originalPart.id, 'bridge:review-race', originalToken]);
    assert.equal(deliveredRows[0].result.applied, true, 'part one is visible while the run remains unfinished');

    const actionSql = `
      select public.request_work_item_action_v2($1::uuid, $2::integer, $3::jsonb, $4::text) as result
    `;
    const blocked = await db.query(actionSql, [race.id, 1, JSON.stringify({ type: 'progress' }), 'UOWNER1']);
    assert.deepEqual(blocked.rows[0].result, { applied: false, row: null });
    const { rows: unchangedRows } = await db.query(`
      select version, pending_action from public.work_items_v2 where id = $1::uuid
    `, [race.id]);
    assert.deepEqual(unchangedRows[0], { version: 1, pending_action: {} });

    await db.query(`
      update public.digest_runs set lease_expires_at = '2000-01-01T00:00:00.000Z' where id = $1::uuid
    `, [digestId]);
    const { rows: reclaimedRows } = await db.query(`
      select public.claim_digest_run_v2(
        $1::text, $2::timestamptz, $3::timestamptz, $4::timestamptz, 'bridge:review-recovery', 120
      ) as result
    `, [claimed.row.destination_key, claimed.row.scheduled_at, claimed.row.window_started_at, claimed.row.window_ended_at]);
    const reclaimed = reclaimedRows[0].result;
    assert.equal(reclaimed.claimed, true);
    assert.equal(reclaimed.created, false);
    const recovered = await prepare('bridge:review-recovery', reclaimed.row.lease_token);
    assert.equal(recovered.created, false);
    assert.deepEqual(
      recovered.parts.map((part) => [part.id, part.client_message_id, part.payload_hash]),
      [[originalPart.id, originalPart.client_message_id, originalPart.payload_hash]],
      'crash/reclaim preserves the exact durable render manifest'
    );
    const { rows: finalizedRows } = await db.query(`
      select public.finalize_digest_run_v2($1::uuid, $2::text, $3::uuid, now()) as result
    `, [digestId, 'bridge:review-recovery', reclaimed.row.lease_token]);
    assert.equal(finalizedRows[0].result.applied, true);
    const applied = await db.query(actionSql, [race.id, 1, JSON.stringify({ type: 'progress' }), 'UOWNER1']);
    assert.equal(applied.rows[0].result.applied, true, 'the unchanged button applies after the run is delivered');
    assert.equal(applied.rows[0].result.row.version, 2);
    await db.query(`
      update public.work_items_v2 set state = 'dismissed', pending_action = '{}'::jsonb
      where id = $1::uuid
    `, [race.id]);

    await db.exec(`
      insert into public.work_items_v2 (
        work_key, room_key, title, work_type, state, actionable_at, first_opened_at,
        last_activity_at, pending_action, version, updated_at
      )
      select
        'review:resolve:' || n, 'room:review', 'Resolve ' || n, 'review', 'open',
        now() - interval '2 hours', now() - interval '1 day', now() - interval '2 hours',
        jsonb_build_object(
          'type', 'request_resolve', 'action', jsonb_build_object('type', 'request_resolve'),
          'status', 'pending', 'requested_at', now() - interval '2 hours',
          'requested_by', 'UOWNER1', 'expected_version', 1
        ),
        2, now() - interval '2 hours'
      from generate_series(1, 12) as n;

      insert into public.work_items_v2 (
        work_key, room_key, title, work_type, state, actionable_at, first_opened_at,
        last_activity_at, pending_action, version, updated_at
      ) values (
        'review:invalid', 'room:review', 'Invalid', 'review', 'open', now() - interval '2 hours',
        now() - interval '1 day', now() - interval '2 hours', '{"status":"pending"}'::jsonb,
        2, now() - interval '2 hours'
      );
    `);
    const { rows: progressRows } = await db.query(`
      insert into public.work_items_v2 (
        work_key, room_key, title, work_type, state, actionable_at, first_opened_at,
        last_activity_at, pending_action, version, updated_at
      ) values (
        'review:progress', 'room:review', 'Progress', 'review', 'open', now() - interval '1 hour',
        now() - interval '1 day', now() - interval '1 hour',
        jsonb_build_object(
          'type', 'progress', 'action', jsonb_build_object('type', 'progress'),
          'status', 'pending', 'requested_at', now() - interval '1 minute',
          'requested_by', 'UOWNER1', 'expected_version', 1
        ),
        2, now()
      ) returning id
    `);
    const { rows: pendingRows } = await db.query(`
      select * from public.list_pending_work_actions_v2(1)
    `);
    assert.equal(pendingRows.length, 1);
    assert.equal(pendingRows[0].id, progressRows[0].id);
    assert.equal(pendingRows[0].pending_action.type, 'progress');
    await assert.rejects(db.query(`select * from public.list_pending_work_actions_v2(0)`), /invalid pending work action query/i);
    await assert.rejects(db.query(`select * from public.list_pending_work_actions_v2(51)`), /invalid pending work action query/i);
  } finally {
    await db.close();
  }
});

test('SQL hands a divergent partial to one same-slot successor without touching its exact coordinate', async () => {
  const db = await createFoundationDatabase();
  try {
    await db.exec(`
      insert into public.work_items_v2 (
        id, work_key, room_key, title, summary, work_type, priority, state,
        actionable_at, first_opened_at, last_activity_at, automation_state, payload
      ) values (
        '92000000-0000-4000-8000-000000000001', 'successor:1', 'room:successor',
        'Successor handoff', 'Immutable partial evidence', 'human_review', 'normal', 'open',
        '2026-08-29T00:00:00Z', '2026-08-29T00:00:00Z', '2026-08-29T00:00:00Z',
        'needs_human', '{"requires_human_action":true}'::jsonb
      )
    `);
    const claimSql = `select public.claim_digest_run_v2(
      'slack:CSUCCESSOR', '2026-08-29T03:00:00Z', '2026-08-29T00:00:00Z',
      '2026-08-29T03:00:00Z', $1::text, 120
    ) as result`;
    const first = (await db.query(claimSql, ['bridge:first'])).rows[0].result.row;
    const snapshot = [{
      id: '92000000-0000-4000-8000-000000000001', version: 1,
      inclusionReason: 'actionable', priority: 'normal'
    }];
    const intent = [{
      kind: 'ordinary', partNumber: 1, partCount: 1,
      itemIds: ['92000000-0000-4000-8000-000000000001'], payloadHash: 'a'.repeat(64)
    }];
    const prepared = (await db.query(`select public.prepare_digest_parts_v2(
      $1::uuid, 'bridge:first', $2::uuid, $3::jsonb, $4::jsonb
    ) as result`, [first.id, first.lease_token, JSON.stringify(snapshot), JSON.stringify(intent)]))
      .rows[0].result;
    const part = prepared.parts[0];
    await db.query(`select public.claim_digest_part_delivery_v2(
      $1::uuid, $2::uuid, 'bridge:first', $3::uuid
    )`, [first.id, part.id, first.lease_token]);
    await db.query(`select public.mark_digest_part_delivered_v2(
      $1::uuid, $2::uuid, 'bridge:first', $3::uuid, 1, 'CSUCCESSOR', '920.1', now()
    )`, [first.id, part.id, first.lease_token]);

    const handedOff = (await db.query(`select public.mark_digest_generation_diverged_v2(
      $1::uuid, 'bridge:first', $2::uuid, 'digest_generation_diverged'
    ) as result`, [first.id, first.lease_token])).rows[0].result;
    assert.equal(handedOff.applied, true);
    assert.equal(handedOff.row.state, 'diverged');
    const beforeSuccessor = await db.query(`select delivery_state, slack_channel_id, slack_message_ts,
      cleanup_state from public.digest_message_parts where id = $1::uuid`, [part.id]);
    assert.deepEqual(beforeSuccessor.rows[0], {
      delivery_state: 'delivered', slack_channel_id: 'CSUCCESSOR', slack_message_ts: '920.1',
      cleanup_state: 'idle'
    });

    const recoverySql = `select public.claim_divergent_digest_run_v2(
      'slack:CSUCCESSOR', '2026-08-29T06:00:00Z', $1::text, 120
    ) as result`;
    const winner = (await db.query(recoverySql, ['bridge:successor-a'])).rows[0].result;
    const loser = (await db.query(recoverySql, ['bridge:successor-b'])).rows[0].result;
    assert.equal(winner.claimed, true);
    assert.equal(winner.created, true);
    assert.equal(winner.row.generation, 2);
    assert.equal(winner.row.previous_digest_id, first.id);
    assert.equal(new Date(winner.row.scheduled_at).toISOString(), '2026-08-29T03:00:00.000Z');
    assert.equal(new Date(winner.row.window_started_at).toISOString(), '2026-08-29T00:00:00.000Z');
    assert.equal(new Date(winner.row.window_ended_at).toISOString(), '2026-08-29T03:00:00.000Z');
    assert.equal(loser.claimed, false);
    assert.equal(loser.created, false);
    assert.equal(loser.row.id, winner.row.id);

    const current = (await db.query(`select public.claim_digest_run_v2(
      'slack:CSUCCESSOR', '2026-08-29T06:00:00Z', '2026-08-29T03:00:00Z',
      '2026-08-29T06:00:00Z', 'bridge:current', 120
    ) as result`)).rows[0].result;
    assert.equal(current.claimed, true, 'the recovery claim does not starve the current boundary');
    assert.equal(new Date(current.row.scheduled_at).toISOString(), '2026-08-29T06:00:00.000Z');
  } finally {
    await db.close();
  }
});

test('SQL cleanup keeps an inherited full digest reachable beyond fifty divergent generations', async () => {
  const db = await createFoundationDatabase();
  try {
    await db.exec(`
      insert into public.digest_runs (
        id, window_started_at, window_ended_at, scheduled_at, generation, state,
        destination_key, item_snapshot, manifest_prepared_at, delivered_at
      ) values (
        '95000000-0000-4000-8000-000000000001',
        '2026-08-28T21:00:00Z', '2026-08-29T00:00:00Z', '2026-08-29T00:00:00Z',
        1, 'delivered', 'slack:CDEEP', '[]'::jsonb,
        '2026-08-29T00:00:01Z', '2026-08-29T00:00:02Z'
      );
      insert into public.digest_message_parts (
        id, digest_run_id, part_kind, part_number, part_count, item_ids, payload_hash,
        client_message_id, delivery_state, delivery_attempts, delivery_claimed_at,
        slack_channel_id, slack_message_ts, delivered_at
      ) values (
        '95000000-0000-4000-8000-000000000002',
        '95000000-0000-4000-8000-000000000001',
        'ordinary', 1, 1, array['96000000-0000-4000-8000-000000000001'::uuid],
        repeat('a', 64), '95000000-0000-4000-8000-000000000003',
        'delivered', 1, '2026-08-29T00:00:01Z', 'CDEEP', '950.1',
        '2026-08-29T00:00:02Z'
      );

      do $$
      declare
        v_generation integer;
        v_id uuid;
        v_previous_id uuid := '95000000-0000-4000-8000-000000000001';
      begin
        for v_generation in 1..51 loop
          v_id := ('95000000-0000-4000-8000-'
            || lpad((100 + v_generation)::text, 12, '0'))::uuid;
          insert into public.digest_runs (
            id, window_started_at, window_ended_at, scheduled_at, generation, state,
            destination_key, item_snapshot, manifest_prepared_at, previous_digest_id, error
          ) values (
            v_id, '2026-08-29T00:00:00Z', '2026-08-29T03:00:00Z',
            '2026-08-29T03:00:00Z', v_generation, 'diverged', 'slack:CDEEP',
            '[]'::jsonb, '2026-08-29T03:00:01Z', v_previous_id,
            'digest_generation_diverged'
          );
          v_previous_id := v_id;
        end loop;
        insert into public.digest_runs (
          id, window_started_at, window_ended_at, scheduled_at, generation, state,
          destination_key, item_snapshot, manifest_prepared_at, delivered_at,
          previous_digest_id
        ) values (
          '95000000-0000-4000-8000-000000000999',
          '2026-08-29T00:00:00Z', '2026-08-29T03:00:00Z', '2026-08-29T03:00:00Z',
          52, 'delivered', 'slack:CDEEP', '[]'::jsonb,
          '2026-08-29T03:00:02Z', '2026-08-29T03:00:03Z', v_previous_id
        );
      end
      $$;
    `);

    const backlog = await db.query(`
      select public.list_digest_cleanup_backlog_v2('slack:CDEEP', 1) as result
    `);
    assert.deepEqual(backlog.rows[0].result.map((entry) => [
      entry.successor_digest_id, entry.previous_digest_id,
      entry.parts.map((part) => part.previous_part_id)
    ]), [[
      '95000000-0000-4000-8000-000000000999',
      '95000000-0000-4000-8000-000000000001',
      ['95000000-0000-4000-8000-000000000002']
    ]]);

    const claimed = await db.query(`
      select public.claim_digest_part_cleanup_v2(
        '95000000-0000-4000-8000-000000000999',
        '95000000-0000-4000-8000-000000000001',
        '95000000-0000-4000-8000-000000000002',
        'bridge:deep-cleanup', 120
      ) as result
    `);
    assert.equal(claimed.rows[0].result.claimed, true);
    const part = claimed.rows[0].result.part;
    const recorded = await db.query(`
      select public.record_digest_part_cleanup_v2(
        '95000000-0000-4000-8000-000000000999',
        '95000000-0000-4000-8000-000000000001',
        '95000000-0000-4000-8000-000000000002',
        'bridge:deep-cleanup', $1::uuid, $2::integer, 'already_absent', null
      ) as result
    `, [part.cleanup_token, part.cleanup_attempts]);
    assert.equal(recorded.rows[0].result.applied, true);
    const tail = await db.query(`
      select state from public.digest_runs
      where id = '95000000-0000-4000-8000-000000000001'
    `);
    assert.equal(tail.rows[0].state, 'replaced');
  } finally {
    await db.close();
  }
});

test('SQL proves 500/501 completeness and divergent partial generations converge without losing immutable audit', async () => {
  const db = await createFoundationDatabase();
  try {
    await db.exec(`
      insert into public.work_items_v2 (
        work_key, room_key, title, summary, work_type, priority, state,
        actionable_at, first_opened_at, last_activity_at, automation_state, payload
      )
      select
        'overflow:' || value::text,
        'room:overflow',
        'Overflow ' || value::text,
        'Bounded render input',
        'human_review',
        'normal',
        'open',
        '2026-08-29T00:00:00.000Z'::timestamptz,
        '2026-08-29T00:00:00.000Z'::timestamptz,
        '2026-08-29T00:00:00.000Z'::timestamptz,
        'needs_human',
        '{"requires_human_action":true}'::jsonb
      from generate_series(1, 501) as value;
    `);
    let listed = await db.query(`
      select public.list_actionable_work_v2(
        '2026-08-29T03:00:00.000Z'::timestamptz, 500
      ) as result
    `);
    assert.equal(listed.rows.length, 1);
    assert.equal(listed.rows[0].result.rows.length, 500);
    assert.equal(listed.rows[0].result.eligible_count, 501);

    await db.exec(`delete from public.work_items_v2 where work_key = 'overflow:501'`);
    listed = await db.query(`
      select public.list_actionable_work_v2(
        '2026-08-29T03:00:00.000Z'::timestamptz, 500
      ) as result
    `);
    assert.equal(listed.rows[0].result.rows.length, 500);
    assert.equal(listed.rows[0].result.eligible_count, 500);

    await db.exec(`delete from public.work_items_v2`);
    const inserted = await db.query(`
      insert into public.work_items_v2 (
        id, work_key, room_key, title, summary, work_type, priority, state,
        actionable_at, first_opened_at, last_activity_at, automation_state, payload
      )
      select
        ('91000000-0000-4000-8000-' || lpad(value::text, 12, '0'))::uuid,
        'generation:' || value::text,
        'room:generation',
        'Generation ' || value::text,
        'Versioned bounded render input ' || value::text,
        'human_review',
        'normal',
        'open',
        '2026-08-29T00:00:00.000Z'::timestamptz,
        '2026-08-29T00:00:00.000Z'::timestamptz,
        '2026-08-29T00:00:00.000Z'::timestamptz,
        'needs_human',
        '{"requires_human_action":true}'::jsonb
      from generate_series(1, 25) as value
      returning id, version
    `);
    const ordered = inserted.rows.sort((left, right) => left.id.localeCompare(right.id));
    const snapshotOne = ordered.map(({ id, version }) => ({
      id, version, inclusionReason: 'actionable', priority: 'normal'
    }));
    const partsOne = [
      {
        kind: 'ordinary', partNumber: 1, partCount: 2,
        itemIds: snapshotOne.slice(0, 24).map(({ id }) => id), payloadHash: 'a'.repeat(64)
      },
      {
        kind: 'ordinary', partNumber: 2, partCount: 2,
        itemIds: snapshotOne.slice(24).map(({ id }) => id), payloadHash: 'b'.repeat(64)
      }
    ];
    const inheritedPriorId = '93000000-0000-4000-8000-000000000001';
    const inheritedPriorPartId = '93000000-0000-4000-8000-000000000002';
    await db.query(`
      insert into public.digest_runs (
        id, window_started_at, window_ended_at, scheduled_at, generation, state,
        destination_key, item_snapshot, manifest_prepared_at, slack_channel_id,
        slack_message_ts, delivered_at
      ) values (
        $1::uuid, '2026-08-28T21:00:00Z', '2026-08-29T00:00:00Z',
        '2026-08-29T00:00:00Z', 1, 'delivered', 'slack:CGEN', $2::jsonb,
        '2026-08-29T00:00:01Z', 'CGEN', '600.1', '2026-08-29T00:00:02Z'
      )
    `, [inheritedPriorId, JSON.stringify([snapshotOne[0]])]);
    await db.query(`
      insert into public.digest_message_parts (
        id, digest_run_id, part_kind, part_number, part_count, item_ids, payload_hash,
        client_message_id, delivery_state, delivery_attempts, delivery_claimed_at,
        slack_channel_id, slack_message_ts, delivered_at
      ) values (
        $2::uuid, $1::uuid, 'ordinary', 1, 1, array[$3::uuid], $4::text,
        '93000000-0000-4000-8000-000000000003', 'delivered', 1,
        '2026-08-29T00:00:01Z', 'CGEN', '600.1', '2026-08-29T00:00:02Z'
      )
    `, [inheritedPriorId, inheritedPriorPartId, snapshotOne[0].id, 'f'.repeat(64)]);
    const claimSql = `
      select public.claim_digest_run_v2(
        $1::text, $2::timestamptz, $3::timestamptz, $4::timestamptz, $5::text, $6::integer
      ) as result
    `;
    const digestArgs = [
      'slack:CGEN', '2026-08-29T03:00:00.000Z', '2026-08-29T00:00:00.000Z',
      '2026-08-29T03:00:00.000Z', 'bridge:generation-one', 120
    ];
    const firstClaim = await db.query(claimSql, digestArgs);
    const firstRun = firstClaim.rows[0].result.row;
    assert.equal(firstRun.generation, 1);
    assert.equal(firstRun.previous_digest_id, inheritedPriorId);
    const preparedOne = await db.query(`
      select public.prepare_digest_parts_v2(
        $1::uuid, $2::text, $3::uuid, $4::jsonb, $5::jsonb
      ) as result
    `, [firstRun.id, 'bridge:generation-one', firstRun.lease_token,
      JSON.stringify(snapshotOne), JSON.stringify(partsOne)]);
    const oldParts = preparedOne.rows[0].result.parts;
    const oldClientIds = oldParts.map((part) => part.client_message_id);
    const oldPartIds = oldParts.map((part) => part.id);
    const deliveredPart = oldParts.find((part) => part.part_number === 1);
    const deliveryClaim = await db.query(`
      select public.claim_digest_part_delivery_v2($1::uuid, $2::uuid, $3::text, $4::uuid) as result
    `, [firstRun.id, deliveredPart.id, 'bridge:generation-one', firstRun.lease_token]);
    assert.equal(deliveryClaim.rows[0].result.claimed, true);
    const delivery = await db.query(`
      select public.mark_digest_part_delivered_v2(
        $1::uuid, $2::uuid, $3::text, $4::uuid, 1, 'CGEN', '700.1',
        '2026-08-29T03:00:01.000Z'::timestamptz
      ) as result
    `, [firstRun.id, deliveredPart.id, 'bridge:generation-one', firstRun.lease_token]);
    assert.equal(delivery.rows[0].result.applied, true);

    await db.query(`
      update public.work_items_v2
      set title = 'Mutated after partial delivery', version = version + 1
      where id = $1::uuid
    `, [snapshotOne[0].id]);
    await db.query(`
      update public.digest_runs set lease_expires_at = '2000-01-01T00:00:00.000Z'
      where id = $1::uuid
    `, [firstRun.id]);
    const reclaimed = await db.query(claimSql, [
      ...digestArgs.slice(0, 4), 'bridge:generation-recovery', 120
    ]);
    const reclaimedRun = reclaimed.rows[0].result.row;
    assert.equal(reclaimedRun.id, firstRun.id);
    assert.equal(reclaimedRun.generation, 1);
    assert.notEqual(reclaimedRun.lease_token, firstRun.lease_token);
    const currentRows = await db.query(`
      select id, version from public.work_items_v2 order by id
    `);
    const snapshotTwo = currentRows.rows.map(({ id, version }) => ({
      id, version, inclusionReason: 'actionable', priority: 'normal'
    }));
    const partsTwo = [
      {
        kind: 'ordinary', partNumber: 1, partCount: 2,
        itemIds: snapshotTwo.slice(0, 24).map(({ id }) => id), payloadHash: 'd'.repeat(64)
      },
      {
        kind: 'ordinary', partNumber: 2, partCount: 2,
        itemIds: snapshotTwo.slice(24).map(({ id }) => id), payloadHash: 'e'.repeat(64)
      }
    ];
    const mismatch = await db.query(`
      select public.prepare_digest_parts_v2(
        $1::uuid, $2::text, $3::uuid, $4::jsonb, $5::jsonb
      ) as result
    `, [firstRun.id, 'bridge:generation-recovery', reclaimedRun.lease_token,
      JSON.stringify(snapshotTwo), JSON.stringify(partsTwo)]);
    assert.equal(mismatch.rows[0].result.applied, false);
    assert.equal(mismatch.rows[0].result.reason, 'manifest_mismatch');
    assert.deepEqual(mismatch.rows[0].result.parts.map((part) => part.client_message_id), oldClientIds);

    const handedOff = await db.query(`
      select public.mark_digest_generation_diverged_v2(
        $1::uuid, $2::text, $3::uuid, 'digest_generation_diverged'
      ) as result
    `, [firstRun.id, 'bridge:generation-recovery', reclaimedRun.lease_token]);
    assert.equal(handedOff.rows[0].result.applied, true);
    assert.equal(handedOff.rows[0].result.row.state, 'diverged');
    const oldBeforeSuccessor = await db.query(`
      select state, error from public.digest_runs where id = $1::uuid
    `, [firstRun.id]);
    assert.equal(oldBeforeSuccessor.rows[0].state, 'diverged');
    const exactBeforeSuccessor = await db.query(`
      select slack_channel_id, slack_message_ts, cleanup_state
      from public.digest_message_parts where id = $1::uuid
    `, [deliveredPart.id]);
    assert.deepEqual(exactBeforeSuccessor.rows[0], {
      slack_channel_id: 'CGEN', slack_message_ts: '700.1', cleanup_state: 'idle'
    });

    const nextClaim = await db.query(claimSql, [
      ...digestArgs.slice(0, 4), 'bridge:generation-two', 120
    ]);
    const secondRun = nextClaim.rows[0].result.row;
    assert.notEqual(secondRun.id, firstRun.id);
    assert.equal(secondRun.generation, 2);
    const preparedTwo = await db.query(`
      select public.prepare_digest_parts_v2(
        $1::uuid, $2::text, $3::uuid, $4::jsonb, $5::jsonb
      ) as result
    `, [secondRun.id, 'bridge:generation-two', secondRun.lease_token,
      JSON.stringify(snapshotTwo), JSON.stringify(partsTwo)]);
    assert.equal(preparedTwo.rows[0].result.applied, true);
    assert.deepEqual(preparedTwo.rows[0].result.parts.map((part) => part.payload_hash), ['d'.repeat(64), 'e'.repeat(64)]);
    assert.ok(preparedTwo.rows[0].result.parts.every((part) => !oldClientIds.includes(part.client_message_id)));

    for (const [index, part] of preparedTwo.rows[0].result.parts.entries()) {
      const claim = await db.query(`
        select public.claim_digest_part_delivery_v2($1::uuid, $2::uuid, $3::text, $4::uuid) as result
      `, [secondRun.id, part.id, 'bridge:generation-two', secondRun.lease_token]);
      assert.equal(claim.rows[0].result.claimed, true);
      const settled = await db.query(`
        select public.mark_digest_part_delivered_v2(
          $1::uuid, $2::uuid, $3::text, $4::uuid, 1, 'CGEN', $5::text,
          '2026-08-29T03:00:02.000Z'::timestamptz
        ) as result
      `, [secondRun.id, part.id, 'bridge:generation-two', secondRun.lease_token, `800.${index + 1}`]);
      assert.equal(settled.rows[0].result.applied, true);
    }
    const finalized = await db.query(`
      select public.finalize_digest_run_v2(
        $1::uuid, $2::text, $3::uuid, '2026-08-29T03:00:03.000Z'::timestamptz
      ) as result
    `, [secondRun.id, 'bridge:generation-two', secondRun.lease_token]);
    assert.equal(finalized.rows[0].result.applied, true);
    assert.equal(finalized.rows[0].result.row.state, 'delivered');

    const backlog = await db.query(`
      select public.list_digest_cleanup_backlog_v2('slack:CGEN', 10) as result
    `);
    assert.deepEqual(backlog.rows[0].result.map((entry) => [
      entry.successor_digest_id, entry.previous_digest_id
    ]), [
      [secondRun.id, firstRun.id],
      [secondRun.id, inheritedPriorId]
    ]);
    const cleanupClaim = await db.query(`
      select public.claim_digest_part_cleanup_v2(
        $1::uuid, $2::uuid, $3::uuid, 'bridge:generation-cleanup', 120
      ) as result
    `, [secondRun.id, firstRun.id, deliveredPart.id]);
    assert.equal(cleanupClaim.rows[0].result.claimed, true);
    const cleanupPart = cleanupClaim.rows[0].result.part;
    const cleanupRecorded = await db.query(`
      select public.record_digest_part_cleanup_v2(
        $1::uuid, $2::uuid, $3::uuid, 'bridge:generation-cleanup', $4::uuid,
        $5::integer, 'deleted', null
      ) as result
    `, [secondRun.id, firstRun.id, deliveredPart.id,
      cleanupPart.cleanup_token, cleanupPart.cleanup_attempts]);
    assert.equal(cleanupRecorded.rows[0].result.applied, true);
    const stillAuthorized = await db.query(`
      select state, previous_cleanup_state from public.digest_runs where id = $1::uuid
    `, [firstRun.id]);
    assert.deepEqual(stillAuthorized.rows[0], {
      state: 'diverged', previous_cleanup_state: 'idle'
    }, 'N cannot retire after its own partial is cleaned while inherited A remains outstanding');

    const inheritedClaim = await db.query(`
      select public.claim_digest_part_cleanup_v2(
        $1::uuid, $2::uuid, $3::uuid, 'bridge:inherited-cleanup', 120
      ) as result
    `, [secondRun.id, inheritedPriorId, inheritedPriorPartId]);
    assert.equal(inheritedClaim.rows[0].result.claimed, true);
    const inheritedPart = inheritedClaim.rows[0].result.part;
    const inheritedRecorded = await db.query(`
      select public.record_digest_part_cleanup_v2(
        $1::uuid, $2::uuid, $3::uuid, 'bridge:inherited-cleanup', $4::uuid,
        $5::integer, 'already_absent', null
      ) as result
    `, [secondRun.id, inheritedPriorId, inheritedPriorPartId,
      inheritedPart.cleanup_token, inheritedPart.cleanup_attempts]);
    assert.equal(inheritedRecorded.rows[0].result.applied, true);

    const audit = await db.query(`
      select state, generation, item_snapshot, error
      from public.digest_runs where id = $1::uuid
    `, [firstRun.id]);
    assert.equal(audit.rows[0].state, 'retired');
    assert.equal(audit.rows[0].generation, 1);
    assert.deepEqual(audit.rows[0].item_snapshot, snapshotOne);
    assert.equal(audit.rows[0].error, 'digest_generation_diverged');
    const oldAuditParts = await db.query(`
      select id, payload_hash, client_message_id, cleanup_state
      from public.digest_message_parts where digest_run_id = $1::uuid
      order by part_number
    `, [firstRun.id]);
    assert.deepEqual(oldAuditParts.rows.map((part) => part.id), oldPartIds);
    assert.deepEqual(oldAuditParts.rows.map((part) => part.payload_hash), ['a'.repeat(64), 'b'.repeat(64)]);
    assert.equal(oldAuditParts.rows[0].cleanup_state, 'deleted');
    const unfinished = await db.query(`
      select count(*)::integer as count from public.digest_runs
      where state in ('building','delivering','failed')
    `);
    assert.equal(unfinished.rows[0].count, 0);
  } finally {
    await db.close();
  }
});
