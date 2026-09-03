import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';

import { recordShadowNotificationObligation } from './shadow-receipts.mjs';

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
  handleEvent
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
