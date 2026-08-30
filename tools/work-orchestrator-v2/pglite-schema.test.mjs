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
        and c.relname in ('message_notification_receipts', 'work_items_v2', 'digest_runs')
      order by c.relname
    `);
    assert.deepEqual(tables.map((row) => row.relname), [
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
        and c.relname in ('message_notification_receipts', 'work_items_v2', 'digest_runs')
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
        and c.relname in ('message_notification_receipts', 'work_items_v2', 'digest_runs')
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
          'finalize_digest_run_v2',
          'fail_digest_run_v2',
          'record_digest_cleanup_v2'
        )
      order by p.proname
    `);
    assert.deepEqual(functions.map((row) => row.proname), [
      'claim_digest_run_v2',
      'claim_message_notification_receipt',
      'fail_digest_run_v2',
      'finalize_digest_run_v2',
      'is_effective_p0_ack_v2',
      'list_actionable_work_v2',
      'record_digest_cleanup_v2',
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
          'finalize_digest_run_v2',
          'fail_digest_run_v2',
          'record_digest_cleanup_v2'
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
          'touch_digest_runs_updated_at'
        )
        and not t.tgisinternal
      order by t.tgname
    `);
    assert.deepEqual(triggers.map((row) => row.tgname), [
      'touch_digest_runs_updated_at',
      'touch_message_notification_receipts_updated_at',
      'touch_work_items_v2_updated_at',
    ]);

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
    const digestArgs = [
      'slack:CINBOX', '2026-08-29T03:00:00.000Z', '2026-08-29T00:00:00.000Z',
      '2026-08-29T03:00:00.000Z', 'bridge:pglite', 120
    ];
    await assert.rejects(
      db.query(claimDigestSql, [
        'slack:CINBOX', 'infinity', '2026-08-29T00:00:00.000Z',
        '2026-08-29T03:00:00.000Z', 'bridge:pglite', 120
      ]),
      /invalid digest claim/i
    );
    const firstDigest = await db.query(claimDigestSql, digestArgs);
    const secondDigest = await db.query(claimDigestSql, digestArgs);
    assert.equal(firstDigest.rows[0].result.claimed, true);
    assert.equal(firstDigest.rows[0].result.created, true);
    assert.equal(secondDigest.rows[0].result.claimed, false);
    assert.match(firstDigest.rows[0].result.row.lease_token, /^[0-9a-f-]{36}$/);
    assert.equal(firstDigest.rows[0].result.previous_digest, null);
    const digestId = firstDigest.rows[0].result.row.id;
    const digestLeaseToken = firstDigest.rows[0].result.row.lease_token;

    const snapshot = [
      { id: actionId, version: 2, inclusionReason: 'overdue', priority: 'normal' },
      { id: concurrentRows[0].id, version: 999, inclusionReason: 'actionable', priority: 'normal' }
    ];
    const finalizeSql = `
      select public.finalize_digest_run_v2(
        $1::uuid, $2::text, $3::uuid, $4::jsonb, $5::text, $6::text, $7::timestamptz
      ) as result
    `;
    const wrongFinalizeOwner = await db.query(finalizeSql, [
      digestId, 'bridge:other', digestLeaseToken, JSON.stringify(snapshot), 'CINBOX', '123.45', '2026-08-29T03:00:05.000Z'
    ]);
    assert.equal(wrongFinalizeOwner.rows[0].result.applied, false);
    assert.equal(wrongFinalizeOwner.rows[0].result.updated_count, 0);
    const finalized = await db.query(finalizeSql, [
      digestId, 'bridge:pglite', digestLeaseToken, JSON.stringify(snapshot), 'CINBOX', '123.45', '2026-08-29T03:00:05.000Z'
    ]);
    assert.equal(finalized.rows[0].result.applied, true);
    assert.equal(finalized.rows[0].result.updated_count, 1);
    assert.deepEqual(finalized.rows[0].result.row.item_snapshot, snapshot);
    const { rows: digestCounters } = await db.query(`
      select id, version, digest_inclusion_count, consecutive_unhandled_digests, last_digest_at, next_reminder_at
      from public.work_items_v2 where id in ($1::uuid, $2::uuid) order by id
    `, [actionId, concurrentRows[0].id]);
    const matching = digestCounters.find((row) => row.id === actionId);
    const stale = digestCounters.find((row) => row.id === concurrentRows[0].id);
    assert.equal(matching.digest_inclusion_count, 1);
    assert.equal(matching.consecutive_unhandled_digests, 1);
    assert.equal(matching.version, 2, 'digest metadata never invalidates the rendered work version');
    assert.ok(matching.last_digest_at);
    assert.equal(new Date(matching.next_reminder_at).toISOString(), '2026-08-23T00:00:00.000Z');
    assert.equal(stale.digest_inclusion_count, 0, 'stale snapshot versions do not advance counters');

    const emptyDigest = await db.query(claimDigestSql, [
      'slack:CINBOX', '2026-08-29T06:00:00.000Z', '2026-08-29T03:00:00.000Z',
      '2026-08-29T06:00:00.000Z', 'bridge:pglite', 120
    ]);
    const emptyFinalized = await db.query(finalizeSql, [
      emptyDigest.rows[0].result.row.id, 'bridge:pglite', emptyDigest.rows[0].result.row.lease_token,
      '[]', null, null, '2026-08-29T06:00:05.000Z'
    ]);
    assert.equal(emptyFinalized.rows[0].result.applied, true);
    assert.equal(emptyFinalized.rows[0].result.updated_count, 0);
    assert.equal(emptyFinalized.rows[0].result.row.slack_channel_id, null);
    assert.equal(emptyFinalized.rows[0].result.row.slack_message_ts, null);
    assert.equal(emptyDigest.rows[0].result.previous_digest.id, digestId);

    const cleanupSql = `
      select public.record_digest_cleanup_v2(
        $1::uuid, $2::uuid, $3::text, $4::text
      ) as result
    `;
    const cleanup = await db.query(cleanupSql, [
      emptyDigest.rows[0].result.row.id, digestId, 'deleted', null
    ]);
    assert.equal(cleanup.rows[0].result.applied, true);
    assert.equal(cleanup.rows[0].result.row.previous_cleanup_state, 'deleted');
    const { rows: replacedDigest } = await db.query(`
      select state from public.digest_runs where id = $1::uuid
    `, [digestId]);
    assert.equal(replacedDigest[0].state, 'replaced');

    const dailyDigest = await db.query(claimDigestSql, [
      'slack:CINBOX', '2026-08-29T07:00:00.000Z', '2026-08-29T06:00:00.000Z',
      '2026-08-29T07:00:00.000Z', 'bridge:pglite', 120
    ]);
    const dailyFinalized = await db.query(finalizeSql, [
      dailyDigest.rows[0].result.row.id, 'bridge:pglite', dailyDigest.rows[0].result.row.lease_token,
      JSON.stringify([{
        id: actionId, version: 2, inclusionReason: 'daily_reminder', priority: 'normal'
      }]), 'CINBOX', '789.01', '2026-08-29T07:00:05.000Z'
    ]);
    assert.equal(dailyFinalized.rows[0].result.updated_count, 1);
    const { rows: dailyReminderWork } = await db.query(`
      select version, digest_inclusion_count, next_reminder_at
      from public.work_items_v2 where id = $1::uuid
    `, [actionId]);
    assert.equal(dailyReminderWork[0].version, 2);
    assert.equal(dailyReminderWork[0].digest_inclusion_count, 2);
    assert.equal(new Date(dailyReminderWork[0].next_reminder_at).toISOString(), '2026-08-30T07:00:05.000Z');

    const cleanupFailureDigest = await db.query(claimDigestSql, [
      'slack:CINBOX', '2026-08-29T08:00:00.000Z', '2026-08-29T07:00:00.000Z',
      '2026-08-29T08:00:00.000Z', 'bridge:pglite', 120
    ]);
    assert.equal(cleanupFailureDigest.rows[0].result.previous_digest.id, dailyDigest.rows[0].result.row.id);
    const cleanupFailureFinalized = await db.query(finalizeSql, [
      cleanupFailureDigest.rows[0].result.row.id, 'bridge:pglite',
      cleanupFailureDigest.rows[0].result.row.lease_token, '[]', null, null,
      '2026-08-29T08:00:05.000Z'
    ]);
    assert.equal(cleanupFailureFinalized.rows[0].result.applied, true);
    const cleanupFailed = await db.query(cleanupSql, [
      cleanupFailureDigest.rows[0].result.row.id, dailyDigest.rows[0].result.row.id,
      'failed', 'rate_limited'
    ]);
    assert.equal(cleanupFailed.rows[0].result.applied, true);
    assert.equal(cleanupFailed.rows[0].result.row.state, 'delivered');
    assert.equal(cleanupFailed.rows[0].result.row.previous_cleanup_state, 'failed');
    const { rows: priorAfterCleanupFailure } = await db.query(`
      select state from public.digest_runs where id = $1::uuid
    `, [dailyDigest.rows[0].result.row.id]);
    assert.equal(priorAfterCleanupFailure[0].state, 'delivered');
    const cleanupRecovered = await db.query(cleanupSql, [
      cleanupFailureDigest.rows[0].result.row.id, dailyDigest.rows[0].result.row.id,
      'already_absent', null
    ]);
    assert.equal(cleanupRecovered.rows[0].result.row.previous_cleanup_state, 'already_absent');
    const { rows: priorAfterCleanupRecovery } = await db.query(`
      select state from public.digest_runs where id = $1::uuid
    `, [dailyDigest.rows[0].result.row.id]);
    assert.equal(priorAfterCleanupRecovery[0].state, 'replaced');

    const carryWork = await db.query(upsertSql, [JSON.stringify({
      ...candidate,
      work_key: 'room:pglite:carry-threshold',
      source_event_keys: ['event-carry-threshold']
    })]);
    await db.query(`
      update public.work_items_v2
      set digest_inclusion_count = 99, consecutive_unhandled_digests = 1
      where id = $1::uuid
    `, [carryWork.rows[0].result.row.id]);
    const hiddenWork = await db.query(upsertSql, [JSON.stringify({
      ...candidate,
      work_key: 'room:pglite:hidden-acknowledged-p0',
      source_event_keys: ['event-hidden-acknowledged-p0']
    })]);
    await db.query(`
      update public.work_items_v2
      set priority = 'p0', state = 'snoozed',
          actionable_at = '2099-01-01T00:00:00.000Z',
          snoozed_until = '2099-01-01T00:00:00.000Z',
          payload = payload || '{"p0_acknowledged_at":"2026-08-29T11:00:05.000Z"}'::jsonb
      where id = $1::uuid
    `, [hiddenWork.rows[0].result.row.id]);
    const futureHiddenWork = await db.query(upsertSql, [JSON.stringify({
      ...candidate,
      work_key: 'room:pglite:hidden-future-ack-p0',
      source_event_keys: ['event-hidden-future-ack-p0']
    })]);
    await db.query(`
      update public.work_items_v2
      set priority = 'p0', state = 'snoozed',
          actionable_at = '2099-01-01T00:00:00.000Z',
          snoozed_until = '2099-01-01T00:00:00.000Z',
          payload = payload || '{"p0_acknowledged_at":"2026-08-29T11:30:05.001Z"}'::jsonb
      where id = $1::uuid
    `, [futureHiddenWork.rows[0].result.row.id]);
    const carryDigest = await db.query(claimDigestSql, [
      'slack:CINBOX', '2026-08-29T10:00:00.000Z', '2026-08-29T09:00:00.000Z',
      '2026-08-29T10:00:00.000Z', 'bridge:pglite', 120
    ]);
    const hiddenDigest = await db.query(claimDigestSql, [
      'slack:CINBOX', '2026-08-29T11:00:00.000Z', '2026-08-29T10:00:00.000Z',
      '2026-08-29T11:00:00.000Z', 'bridge:pglite', 120
    ]);
    const futureHiddenDigest = await db.query(claimDigestSql, [
      'slack:CINBOX', '2026-08-29T11:30:00.000Z', '2026-08-29T11:00:00.000Z',
      '2026-08-29T11:30:00.000Z', 'bridge:pglite', 120
    ]);
    const semanticGuards = await Promise.allSettled([
      db.query(finalizeSql, [
        carryDigest.rows[0].result.row.id, 'bridge:pglite', carryDigest.rows[0].result.row.lease_token,
        JSON.stringify([{
          id: carryWork.rows[0].result.row.id, version: 1,
          inclusionReason: 'carry_over', priority: 'normal'
        }]), 'CINBOX', '810.01', '2026-08-29T10:00:05.000Z'
      ]),
      db.query(finalizeSql, [
        hiddenDigest.rows[0].result.row.id, 'bridge:pglite', hiddenDigest.rows[0].result.row.lease_token,
        JSON.stringify([{
          id: hiddenWork.rows[0].result.row.id, version: 1,
          inclusionReason: 'p0', priority: 'p0'
        }]), 'CINBOX', '811.01', '2026-08-29T11:00:05.000Z'
      ]),
      db.query(finalizeSql, [
        futureHiddenDigest.rows[0].result.row.id, 'bridge:pglite',
        futureHiddenDigest.rows[0].result.row.lease_token,
        JSON.stringify([{
          id: futureHiddenWork.rows[0].result.row.id, version: 1,
          inclusionReason: 'p0', priority: 'p0'
        }]), 'CINBOX', '812.01', '2026-08-29T11:30:05.000Z'
      ])
    ]);
    assert.deepEqual({
      listedIds: failClosedP0.map((row) => row.id),
      mergeStates: [futureAckMerge.rows[0].result.row.state, boundaryAckMerge.rows[0].result.row.state],
      finalizeStates: semanticGuards.map((result) => result.status)
    }, {
      listedIds: p0ListRows.slice(2).map((row) => row.id),
      mergeStates: ['open', 'snoozed'],
      finalizeStates: ['rejected', 'rejected', 'fulfilled']
    }, 'SQL uses each operation cutoff for list, upsert wake, and finalization eligibility');
    assert.ok(semanticGuards.slice(0, 2).every((result) => /snapshot semantics/i.test(result.reason?.message)));
    assert.equal(semanticGuards[2].value.rows[0].result.updated_count, 1);
    const { rows: guardedCounters } = await db.query(`
      select id, digest_inclusion_count, consecutive_unhandled_digests, last_digest_at
      from public.work_items_v2 where id in ($1::uuid, $2::uuid, $3::uuid) order by id
    `, [
      carryWork.rows[0].result.row.id,
      hiddenWork.rows[0].result.row.id,
      futureHiddenWork.rows[0].result.row.id
    ]);
    assert.equal(guardedCounters.find((row) => row.id === carryWork.rows[0].result.row.id).digest_inclusion_count, 99);
    assert.equal(guardedCounters.find((row) => row.id === hiddenWork.rows[0].result.row.id).digest_inclusion_count, 0);
    const futureGuarded = guardedCounters.find((row) => row.id === futureHiddenWork.rows[0].result.row.id);
    assert.equal(futureGuarded.digest_inclusion_count, 1);
    assert.ok(futureGuarded.last_digest_at);

    const failedDigest = await db.query(claimDigestSql, [
      'slack:CINBOX', '2026-08-29T09:00:00.000Z', '2026-08-29T06:00:00.000Z',
      '2026-08-29T09:00:00.000Z', 'bridge:pglite', 120
    ]);
    const failSql = `
      select public.fail_digest_run_v2(
        $1::uuid, $2::text, $3::uuid, $4::text
      ) as result
    `;
    const wrongOwner = await db.query(failSql, [
      failedDigest.rows[0].result.row.id, 'bridge:other', failedDigest.rows[0].result.row.lease_token,
      'digest_delivery_failed'
    ]);
    const rightOwner = await db.query(failSql, [
      failedDigest.rows[0].result.row.id, 'bridge:pglite', failedDigest.rows[0].result.row.lease_token,
      'digest_delivery_failed'
    ]);
    const staleFailure = await db.query(failSql, [
      failedDigest.rows[0].result.row.id, 'bridge:pglite', failedDigest.rows[0].result.row.lease_token,
      'digest_delivery_failed'
    ]);
    assert.equal(wrongOwner.rows[0].result.applied, false);
    assert.equal(rightOwner.rows[0].result.applied, true);
    assert.equal(staleFailure.rows[0].result.applied, false, 'failed lease cannot be failed twice');
    await db.query(`
      update public.digest_runs set lease_expires_at = '2000-01-01T00:00:00.000Z'
      where id = $1::uuid
    `, [failedDigest.rows[0].result.row.id]);
    const recoveredFailure = await db.query(claimDigestSql, [
      'slack:CINBOX', '2026-08-29T09:00:00.000Z', '2026-08-29T06:00:00.000Z',
      '2026-08-29T09:00:00.000Z', 'bridge:pglite', 120
    ]);
    assert.equal(recoveredFailure.rows[0].result.claimed, true);
    assert.equal(recoveredFailure.rows[0].result.created, false);
    assert.equal(recoveredFailure.rows[0].result.row.lease_owner, 'bridge:pglite');
    assert.notEqual(
      recoveredFailure.rows[0].result.row.lease_token,
      failedDigest.rows[0].result.row.lease_token,
      'every reclaim rotates the lease generation even for the same owner'
    );
    const oldGenerationFailure = await db.query(failSql, [
      failedDigest.rows[0].result.row.id, 'bridge:pglite', failedDigest.rows[0].result.row.lease_token,
      'digest_delivery_failed'
    ]);
    assert.equal(oldGenerationFailure.rows[0].result.applied, false);
    const oldGenerationFinalize = await db.query(finalizeSql, [
      failedDigest.rows[0].result.row.id, 'bridge:pglite', failedDigest.rows[0].result.row.lease_token,
      '[]', null, null, '2026-08-29T09:00:05.000Z'
    ]);
    assert.equal(oldGenerationFinalize.rows[0].result.applied, false);

    const buildingDigest = await db.query(claimDigestSql, [
      'slack:CINBOX', '2026-08-29T12:00:00.000Z', '2026-08-29T09:00:00.000Z',
      '2026-08-29T12:00:00.000Z', 'bridge:original', 120
    ]);
    await db.query(`
      update public.digest_runs set lease_expires_at = '2000-01-01T00:00:00.000Z'
      where id = $1::uuid
    `, [buildingDigest.rows[0].result.row.id]);
    const recoveredBuilding = await db.query(claimDigestSql, [
      'slack:CINBOX', '2026-08-29T12:00:00.000Z', '2026-08-29T09:00:00.000Z',
      '2026-08-29T12:00:00.000Z', 'bridge:recovery', 120
    ]);
    assert.equal(recoveredBuilding.rows[0].result.claimed, true);
    assert.equal(recoveredBuilding.rows[0].result.created, false);

    await assert.rejects(db.query(finalizeSql, [
      recoveredBuilding.rows[0].result.row.id, 'bridge:recovery',
      recoveredBuilding.rows[0].result.row.lease_token,
      JSON.stringify([
        { id: actionId, version: 2, inclusionReason: 'actionable', priority: 'urgent' }
      ]), 'CINBOX', '900.01', '2026-08-29T12:00:05.000Z'
    ]), /snapshot semantics/i);
    await assert.rejects(db.query(finalizeSql, [
      recoveredBuilding.rows[0].result.row.id, 'bridge:recovery',
      recoveredBuilding.rows[0].result.row.lease_token,
      JSON.stringify([
        { id: actionId, version: 2, inclusionReason: 'daily_reminder', priority: 'normal' }
      ]), 'CINBOX', '900.01', '2026-08-29T12:00:05.000Z'
    ]), /snapshot semantics/i);
    await assert.rejects(db.query(finalizeSql, [
      recoveredBuilding.rows[0].result.row.id, 'bridge:recovery',
      recoveredBuilding.rows[0].result.row.lease_token,
      JSON.stringify([
        { id: actionId.toUpperCase(), version: 2, inclusionReason: 'actionable', priority: 'normal' },
        { id: actionId, version: 2, inclusionReason: 'actionable', priority: 'normal' }
      ]), 'CINBOX', '900.01', '2026-08-29T12:00:05.000Z'
    ]), /invalid digest finalization/i);
    await assert.rejects(db.query(finalizeSql, [
      recoveredBuilding.rows[0].result.row.id, 'bridge:recovery',
      recoveredBuilding.rows[0].result.row.lease_token, '[]', null, null, 'infinity'
    ]), /invalid digest finalization/i);

    const { rows: failureCounterAudit } = await db.query(`
      select id, version, digest_inclusion_count
      from public.work_items_v2 where id in ($1::uuid, $2::uuid) order by id
    `, [actionId, concurrentRows[0].id]);
    assert.equal(failureCounterAudit.find((row) => row.id === actionId).digest_inclusion_count, 2);
    assert.equal(failureCounterAudit.find((row) => row.id === actionId).version, 2);
    assert.equal(failureCounterAudit.find((row) => row.id === concurrentRows[0].id).digest_inclusion_count, 0);
  } finally {
    await db.close();
  }
});
