import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';

const migrationsDirectory = join(import.meta.dirname, '..', '..', 'supabase', 'migrations');
const migrationNames = readdirSync(migrationsDirectory)
  .filter((name) => /^\d+_kakao_automation_audit_events\.sql$/.test(name));

async function createAuditDatabase() {
  assert.equal(migrationNames.length, 1, 'exactly one Kakao automation audit migration must exist');
  const db = new PGlite();
  await db.exec(`
    create role anon nologin;
    create role authenticated nologin;
    create role service_role nologin;
  `);
  await db.exec(readFileSync(join(migrationsDirectory, migrationNames[0]), 'utf8'));
  return db;
}

const baseEvent = Object.freeze({
  event_key: `kakao:confirmation_request:${'a'.repeat(64)}`,
  job_id: 'job-audit-1',
  room_revision: 4,
  operation_id: '11111111-2222-4333-8444-555555555555',
  receipt_id: 'receipt-audit-1',
  occurred_at: '2026-09-07T01:02:03.000Z',
  effect_type: 'confirmation_request',
  action_type: 'create',
  outcome: 'success',
  customer_label: '테스트 고객',
  target_type: 'request',
  target_id: 'RQ-260907-001',
  summary: '확인요청 RQ-260907-001을 생성했습니다.',
  change_items: [{ field: 'equipment', before: null, after: '소니 FX3 바디세트 1개' }],
  outbound_text: null,
  evidence: { schema: 'village-confirmation-receipt/v1', status: 'ok', readback: true },
  source_message_at: '2026-09-07T01:01:00.000Z',
  historical_import: false
});

async function insertEvent(db, event = baseEvent) {
  const keys = Object.keys(event);
  const values = Object.values(event);
  const placeholders = keys.map((_, index) => `$${index + 1}`).join(',');
  await db.query(
    `insert into public.kakao_automation_audit_events (${keys.join(',')}) values (${placeholders})`,
    values
  );
}

test('Kakao automation audit migration creates an isolated immutable service-only read model', async () => {
  const db = await createAuditDatabase();
  try {
    await insertEvent(db);
    const row = (await db.query(`
      select event_key, effect_type, action_type, outcome, target_id, change_items, evidence
      from public.kakao_automation_audit_events
    `)).rows[0];
    assert.deepEqual(row, {
      event_key: baseEvent.event_key,
      effect_type: 'confirmation_request',
      action_type: 'create',
      outcome: 'success',
      target_id: 'RQ-260907-001',
      change_items: baseEvent.change_items,
      evidence: baseEvent.evidence
    });
    assert.equal((await db.query(`select to_regclass('public.work_items_v2') as relation`)).rows[0].relation, null);

    await assert.rejects(
      db.query(`update public.kakao_automation_audit_events set summary = 'tampered' where event_key = $1`, [baseEvent.event_key]),
      /kakao_automation_audit_event_immutable/
    );
    await assert.rejects(
      db.query(`delete from public.kakao_automation_audit_events where event_key = $1`, [baseEvent.event_key]),
      /kakao_automation_audit_event_immutable/
    );
  } finally {
    await db.close();
  }
});

test('Kakao automation audit rejects invalid enums, unbounded JSON, and duplicate identities', async () => {
  const db = await createAuditDatabase();
  try {
    await insertEvent(db);
    await assert.rejects(insertEvent(db), /duplicate key|unique constraint/i);
    const invalidOutcome = { ...baseEvent, event_key: `kakao:confirmation_request:${'b'.repeat(64)}`, outcome: 'maybe' };
    await assert.rejects(insertEvent(db, invalidOutcome), /check constraint/i);
    const oversizedChanges = {
      ...baseEvent,
      event_key: `kakao:confirmation_request:${'c'.repeat(64)}`,
      change_items: Array.from({ length: 21 }, (_, index) => ({ field: 'equipment', before: null, after: String(index) }))
    };
    await assert.rejects(insertEvent(db, oversizedChanges), /check constraint/i);
    const unsafeKey = { ...baseEvent, event_key: 'not-derived-from-authority' };
    await assert.rejects(insertEvent(db, unsafeKey), /check constraint/i);
    const unsafeTarget = {
      ...baseEvent,
      event_key: `kakao:confirmation_request:${'d'.repeat(64)}`,
      target_id: '010-1234-5678'
    };
    await assert.rejects(insertEvent(db, unsafeTarget), /check constraint/i);
    const unsafeSecret = {
      ...baseEvent,
      event_key: `kakao:confirmation_request:${'e'.repeat(64)}`,
      summary: 'token=private-value'
    };
    await assert.rejects(insertEvent(db, unsafeSecret), /check constraint/i);
    const unsafeAccount = {
      ...baseEvent,
      event_key: `kakao:confirmation_request:${'f'.repeat(64)}`,
      outbound_text: '우리은행 1005-404-109661로 보내주세요'
    };
    await assert.rejects(insertEvent(db, unsafeAccount), /check constraint/i);
  } finally {
    await db.close();
  }
});

test('Kakao automation audit supports stable newest-first composite pagination and filters', async () => {
  const db = await createAuditDatabase();
  try {
    const events = [
      baseEvent,
      { ...baseEvent, event_key: `kakao:auto_reply:${'f'.repeat(64)}`, receipt_id: 'reply-readback-f', operation_id: null, occurred_at: '2026-09-07T02:00:00.000Z', effect_type: 'auto_reply', action_type: 'send', customer_label: '가 고객', target_type: 'room', target_id: null, summary: '카카오 답변을 전송했습니다.', change_items: [], outbound_text: '네, 가능합니다.', evidence: { schema: 'kakao-dom-readback/v1', status: 'sent', readback: true } },
      { ...baseEvent, event_key: `kakao:document_send:${'e'.repeat(64)}`, receipt_id: 'document-e', occurred_at: '2026-09-07T02:00:00.000Z', effect_type: 'document_send', action_type: 'send', outcome: 'failed', customer_label: '나 고객', target_type: 'document', target_id: '260907-001', summary: '견적서 전송이 실패했습니다.', change_items: [], evidence: { schema: 'village-document-receipt/v1', status: 'failed', readback: true } }
    ];
    for (const event of events) await insertEvent(db, event);

    const firstPage = (await db.query(`
      select event_key from public.kakao_automation_audit_events
      order by occurred_at desc, event_key desc limit 2
    `)).rows.map((row) => row.event_key);
    assert.deepEqual(firstPage, [events[1].event_key, events[2].event_key].sort().reverse());

    const cursor = (await db.query(`
      select occurred_at, event_key from public.kakao_automation_audit_events
      order by occurred_at desc, event_key desc limit 1 offset 1
    `)).rows[0];
    const after = (await db.query(`
      select event_key from public.kakao_automation_audit_events
      where (occurred_at, event_key) < ($1::timestamptz, $2::text)
      order by occurred_at desc, event_key desc
    `, [cursor.occurred_at, cursor.event_key])).rows.map((row) => row.event_key);
    assert.deepEqual(after, [baseEvent.event_key]);

    const failedDocument = (await db.query(`
      select target_id from public.kakao_automation_audit_events
      where outcome = 'failed' and effect_type = 'document_send'
        and lower(customer_label) like lower('%나%') and target_id = '260907-001'
    `)).rows;
    assert.deepEqual(failedDocument, [{ target_id: '260907-001' }]);
  } finally {
    await db.close();
  }
});

test('Kakao automation audit projection status is content-free and independently mutable', async () => {
  const db = await createAuditDatabase();
  try {
    await db.query(`
      update public.kakao_automation_audit_projection_status
      set pending_count = 2, conflict_count = 1,
          oldest_pending_at = '2026-09-07T00:00:00.000Z',
          last_success_at = '2026-09-07T01:00:00.000Z',
          updated_at = '2026-09-07T02:00:00.000Z'
      where singleton
    `);
    const row = (await db.query(`select * from public.kakao_automation_audit_projection_status`)).rows[0];
    assert.deepEqual(Object.keys(row).sort(), [
      'conflict_count', 'last_success_at', 'oldest_pending_at', 'pending_count', 'singleton', 'updated_at'
    ]);
    assert.equal(row.pending_count, 2);
    assert.equal(row.conflict_count, 1);
    await assert.rejects(
      db.query(`update public.kakao_automation_audit_projection_status set pending_count = -1 where singleton`),
      /check constraint/i
    );
  } finally {
    await db.close();
  }
});
