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
        and p.proname in ('touch_work_orchestrator_v2_updated_at', 'claim_message_notification_receipt')
      order by p.proname
    `);
    assert.deepEqual(functions.map((row) => row.proname), [
      'claim_message_notification_receipt',
      'touch_work_orchestrator_v2_updated_at',
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
        and p.proname in ('touch_work_orchestrator_v2_updated_at', 'claim_message_notification_receipt')
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
  } finally {
    await db.close();
  }
});
