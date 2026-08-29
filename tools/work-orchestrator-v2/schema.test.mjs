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
