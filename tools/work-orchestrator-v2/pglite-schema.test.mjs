import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';

const migrationsDirectory = join(import.meta.dirname, '..', '..', 'supabase', 'migrations');
const [migrationName] = readdirSync(migrationsDirectory)
  .filter((name) => /^\d+_work_orchestrator_v2_foundation\.sql$/.test(name));

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
        )
      order by p.proname
    `);
    assert.deepEqual(functions.map((row) => row.proname), [
      'claim_digest_part_cleanup_v2',
      'claim_digest_part_delivery_v2',
      'claim_digest_run_v2',
      'claim_message_notification_receipt',
      'fail_digest_run_v2',
      'finalize_digest_run_v2',
      'is_effective_p0_ack_v2',
      'list_actionable_work_v2',
      'list_digest_cleanup_backlog_v2',
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
    const { rows: failClosedP0 } = await db.query(`
      select id from public.list_actionable_work_v2($1::timestamptz, $2::integer)
    `, ['2000-01-01T00:00:00.000Z', 3]);

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
        $1::uuid, $2::uuid, $3::text, $4::uuid, $5::integer, $6::text
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
    await assert.rejects(db.query(prepareSql, [
      digestId, 'bridge:pglite', originalLeaseToken, JSON.stringify(snapshot),
      JSON.stringify([{ ...parts[0], payloadHash: 'd'.repeat(64) }, parts[1], parts[2]])
    ]), /digest manifest mismatch/i, 'a divergent retry cannot rewrite durable intent');

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
        capId, capPartId, 'bridge:cap', capToken, attempt, 'rate_limited'
      ]);
      assert.equal(failed.rows[0].result.applied, true);
    }
    const cappedClaim = await db.query(claimPartSql, [capId, capPartId, 'bridge:cap', capToken]);
    assert.equal(cappedClaim.rows[0].result.claimed, false);
    assert.equal(cappedClaim.rows[0].result.row.delivery_attempts, 3);

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
