import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';

import { recordShadowNotificationObligation } from './shadow-receipts.mjs';
import { buildDigestSlackMessage, selectDigestItems } from './digests.mjs';
import { buildHumanWorkCandidates, v2P0ReminderDecision } from './work-items.mjs';

process.env.KAKAO_DOM_BRIDGE_NO_LISTEN = '1';
Object.assign(process.env, {
  AI_WORKER_FOLLOW_UP_ITEMS_ENABLED: '1',
  KAKAO_FOLLOW_UP_ITEMS_ENABLED: '1',
  SLACK_AGENT_CARD_DELIVERY_ENABLED: '1',
  P0_SLACK_ESCALATION_ENABLED: '1',
  WORK_ORCHESTRATOR_V2_IMMEDIATE_ENABLED: '0',
  WORK_ORCHESTRATOR_V2_WORK_ITEMS_ENABLED: '0',
  WORK_ORCHESTRATOR_V2_DIGEST_ENABLED: '0',
  WORK_ORCHESTRATOR_V2_CLEANUP_ENABLED: '0',
  WORK_ORCHESTRATOR_V2_P0_READBACK_ENABLED: '0',
  WORK_ORCHESTRATOR_V2_P0_CUTOVER_ENABLED: '0'
});
const {
  createWorkOrchestratorShadowRuntime,
  handleEvent,
  runP0EscalationPair
} = await import('../kakao-dom-bridge/server.mjs');

const migrationsDirectory = join(import.meta.dirname, '..', '..', 'supabase', 'migrations');
const [migrationName] = readdirSync(migrationsDirectory)
  .filter((name) => /^\d+_work_orchestrator_v2_foundation\.sql$/.test(name));

function eventRequest(event) {
  const request = Readable.from([JSON.stringify(event)]);
  request.method = 'POST';
  request.url = '/events';
  request.headers = { host: '127.0.0.1' };
  return request;
}

function eventResponse() {
  return {
    status: null,
    body: null,
    writeHead(status) {
      this.status = status;
    },
    end(body) {
      this.body = JSON.parse(body);
    }
  };
}

test('accepted Kakao duplicate reaches the migrated receipt RPC exactly once without blocking legacy scheduling', async () => {
  assert.ok(migrationName, 'the reviewed foundation migration must exist');
  const db = new PGlite({ extensions: { pgcrypto } });
  const order = [];
  let shadowInvocations = 0;
  let rpcClaims = 0;
  let legacyWrites = 0;
  let legacySchedules = 0;

  try {
    await db.exec(`
      create role anon nologin;
      create role authenticated nologin;
      create role service_role nologin;
      create extension if not exists pgcrypto;
    `);
    await db.exec(readFileSync(join(migrationsDirectory, migrationName), 'utf8'));

    const store = {
      async claimNotificationReceipt(input) {
        rpcClaims += 1;
        order.push('rpc-claim');
        const { rows } = await db.query(`
          select public.claim_message_notification_receipt(
            $1, $2, $3, $4, $5::timestamptz, $6::uuid, $7::jsonb
          ) as result
        `, [
          input.source,
          input.sourceEventKey,
          input.sourceMessageId,
          input.roomKey,
          input.receivedAt,
          input.clientMessageId,
          JSON.stringify(input.payload)
        ]);
        return rows[0].result;
      }
    };
    const shadowRuntime = createWorkOrchestratorShadowRuntime({
      config: { shadowWrites: true },
      store,
      record(args) {
        shadowInvocations += 1;
        order.push('shadow-invocation');
        return recordShadowNotificationObligation(args);
      },
      now: () => '2026-08-30T00:00:01.000Z'
    });
    const dependencies = {
      appendNdjson: () => {},
      shadowRuntime,
      async writeSupabaseEvent() {
        legacyWrites += 1;
        order.push('legacy-write');
      },
      scheduleDebouncedJob() {
        legacySchedules += 1;
        order.push('legacy-schedule');
      }
    };
    const event = {
      source: 'kakao_channel_manager_dom',
      reason: 'dom_event',
      roomKey: 'chat:pglite-shadow-integration',
      previewText: 'availability question',
      messagePreview: 'availability question',
      displayTime: '오전 9:00',
      eventHash: 'pglite-shadow-event-1',
      detectedAt: '2026-08-30T00:00:00.000Z'
    };

    const firstResponse = eventResponse();
    await handleEvent(eventRequest(event), firstResponse, dependencies);

    assert.equal(firstResponse.status, 202);
    assert.equal(shadowInvocations, 1);
    assert.equal(rpcClaims, 1);
    assert.equal(legacyWrites, 1);
    assert.equal(legacySchedules, 1);
    assert.deepEqual(order.slice(0, 4), [
      'shadow-invocation',
      'rpc-claim',
      'legacy-write',
      'legacy-schedule'
    ]);

    const repeatedResponse = eventResponse();
    await handleEvent(eventRequest(event), repeatedResponse, dependencies);
    await shadowRuntime.settled();

    assert.equal(repeatedResponse.status, 202);
    assert.equal(shadowInvocations, 1, 'the rejected repeated revision never invokes shadow again');
    assert.equal(rpcClaims, 1, 'the rejected repeated revision never reaches the RPC again');
    assert.equal(legacyWrites, 2, 'legacy durable writes remain uninterrupted');
    assert.equal(legacySchedules, 2, 'legacy scheduling remains uninterrupted');

    const { rows } = await db.query(`
      select count(*)::integer as count
      from public.message_notification_receipts
      where source_event_key = 'pglite-shadow-event-1'
    `);
    assert.equal(rows[0].count, 1);
  } finally {
    await db.close();
  }
});

test('silent Kakao intake hands off only one Hermes-classified owner action', async () => {
  assert.ok(migrationName, 'the reviewed foundation migration must exist');
  const db = new PGlite({ extensions: { pgcrypto } });
  let persistedEvents = 0;
  let scheduledRooms = 0;
  let rawSlackPosts = 0;
  let p0Calls = 0;

  try {
    await db.exec(`
      create role anon nologin;
      create role authenticated nologin;
      create role service_role nologin;
      create extension if not exists pgcrypto;
    `);
    await db.exec(readFileSync(join(migrationsDirectory, migrationName), 'utf8'));

    const event = {
      source: 'kakao_channel_manager_dom',
      reason: 'dom_event',
      roomKey: 'chat:employee-handoff',
      previewText: 'customer messages stay internal before classification',
      messagePreview: 'customer messages stay internal before classification',
      displayTime: '오전 9:00',
      eventHash: 'employee-handoff-event-1',
      detectedAt: '2026-09-03T00:00:00.000Z'
    };
    const response = eventResponse();
    await handleEvent(eventRequest(event), response, {
      appendNdjson: () => {},
      shadowRuntime: { enabled: false, recordAccepted: () => { rawSlackPosts += 1; } },
      immediateRuntime: { enabled: false, deliverAccepted: () => { rawSlackPosts += 1; } },
      writeSupabaseEvent: async () => { persistedEvents += 1; },
      scheduleDebouncedJob: () => { scheduledRooms += 1; }
    });

    const semantic = buildHumanWorkCandidates({
      now: '2026-09-03T00:00:01.000Z',
      job: event,
      followUpRows: [{
        work_key: 'conversation:room-1:customer-1',
        room_key: 'chat:employee-handoff',
        type: 'reply_needed',
        title: '고객 답변 필요',
        summary: '직원이 대화를 검토했고 고객에게 최종 일정 답변이 필요합니다.',
        recommended_action: '확정 일정을 확인한 뒤 고객에게 답변하세요.',
        requires_human_action: true
      }]
    });
    assert.equal(semantic.length, 1);
    const candidateKeys = [
      'work_key', 'source_event_keys', 'room_key', 'title', 'summary', 'work_type', 'priority', 'state',
      'owner_id', 'actionable_at', 'due_at', 'snoozed_until', 'first_opened_at', 'last_activity_at',
      'automation_state', 'payload'
    ];
    const dbCandidate = Object.fromEntries(candidateKeys.map((key) => [key, semantic[0][key]]));
    const upserted = await db.query(
      'select public.upsert_work_item_v2($1::jsonb) as result',
      [JSON.stringify(dbCandidate)]
    );
    const semanticWorkId = upserted.rows[0].result.row.id;
    const listed = await db.query(
      `select public.list_actionable_work_v2($1::timestamptz, 500) as result`,
      ['2026-09-03T00:00:02.000Z']
    );
    const timestampKeys = [
      'actionable_at', 'due_at', 'snoozed_until', 'first_opened_at',
      'last_activity_at', 'last_digest_at', 'next_reminder_at'
    ];
    const actionableRows = listed.rows[0].result.rows.map((row) => ({
      ...row,
      ...Object.fromEntries(timestampKeys.map((key) => [
        key,
        row[key] === null ? null : new Date(row[key]).toISOString()
      ]))
    }));
    const selected = selectDigestItems(actionableRows, '2026-09-03T00:00:02.000Z');
    const digest = buildDigestSlackMessage(selected, {
      now: '2026-09-03T00:00:02.000Z', ownerSlackIds: {}
    });

    const automatic = buildHumanWorkCandidates({
      now: '2026-09-03T00:00:01.000Z',
      followUpRows: [{
        work_key: 'conversation:room-2:auto',
        room_key: 'chat:auto',
        type: 'reply_needed',
        requires_human_action: false
      }]
    });
    const [p0] = buildHumanWorkCandidates({
      now: '2026-09-03T00:00:01.000Z',
      followUpRows: [{
        work_key: 'conversation:room-3:p0',
        room_key: 'chat:p0',
        type: 'damage_repair',
        priority: 'p0',
        title: '장비 사고 즉시 확인',
        summary: '직원이 실제 장비 사고 가능성을 확인했습니다.',
        recommended_action: '즉시 대화를 확인하고 대응을 결정하세요.',
        requires_human_action: true
      }]
    });
    const p0Decision = v2P0ReminderDecision(p0, { now: '2026-09-03T00:10:01.000Z' });
    if (p0Decision.due) {
      await runP0EscalationPair({
        cutoverEnabled: true,
        v2: async () => { p0Calls += 1; return { status: 'ok' }; }
      });
    }

    assert.equal(response.status, 202);
    assert.equal(persistedEvents, 1);
    assert.equal(scheduledRooms, 1);
    assert.equal(rawSlackPosts, 0);
    assert.equal(automatic.length, 0);
    assert.deepEqual(selected.map(({ id }) => id), [semanticWorkId]);
    assert.equal(selected.length, 1);
    assert.equal(digest.renderedCount, 1);
    assert.match(digest.ordinaryParts[0].blocks[1].text.text, /대표님이 할 일/);
    assert.equal(p0Calls, 1);
  } finally {
    await db.close();
  }
});
