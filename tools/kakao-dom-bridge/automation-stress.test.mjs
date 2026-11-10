import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createHermesGatewayChannel } from './hermes-gateway-channel.mjs';

// Real durable queue, isolated filesystem, no network or customer transport.
async function fixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'village-automation-stress-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const clock = { now: Date.parse('2026-11-10T00:00:00Z') };
  const restart = () => createHermesGatewayChannel({ directory, leaseMs: 1000, now: () => clock.now });
  return { clock, restart, channel: restart() };
}
const event = i => ({ job_id: `stress-${i}`, room_key: `room-${i}`, room_revision: 1,
  detected_at: '2026-11-10T00:00:00Z' });
const operation = claim => ({ ...claim, tool: 'confirmed_reservation_commit', request_digest: `digest-${claim.job_id}` });
const receipt = (claim, id, status) => ({
  schema: 'village-confirmed-reservation-commit-receipt/v1', receipt_id: `receipt-${claim.job_id}`,
  job_id: claim.job_id, room_key: claim.room_key, room_revision: claim.room_revision,
  lease_id: claim.lease_id, request_digest: `digest-${claim.job_id}`, operation_id: id,
  status, target_scope: 'pending_request', authorized_registration: {},
  request_id: 'RQ-261110-001', effective_request_id: 'RQ-261110-001', trade_id: null,
  authoritative_result: null, applied_stages: [], attempted_stage: 'confirmed_registration',
  customer_reply: 'no_reply', created_at: '2026-11-10T00:00:00Z',
  error: status === 'ok' ? null : { type: 'outcome_unknown', message: 'injected response loss' }
});

test('120 jobs and 480 duplicate events survive 16 consumers, mixed receipts and restart without duplicate operations', async t => {
  const f = await fixture(t);
  let channel = f.channel;
  const claimed = new Set(), operations = new Set();
  for (let wave = 0; wave < 4; wave++) {
    const ids = Array.from({ length: 30 }, (_, i) => wave * 30 + i);
    await Promise.all(ids.flatMap(i => Array.from({ length: 4 }, () => channel.enqueue(event(i)))));
    await Promise.all(Array.from({ length: 16 }, async (_, consumer) => {
      for (;;) {
        const claim = await channel.claim({ consumerId: `consumer-${consumer}`, waitMs: 0 });
        if (!claim) break;
        assert.equal(claimed.has(claim.job_id), false);
        claimed.add(claim.job_id);
        const attempts = await Promise.all(Array.from({ length: 5 }, () => channel.reserveToolOperation(operation(claim))));
        assert.equal(attempts.filter(a => a.created).length, 1);
        const id = attempts[0].reservation.operation_id;
        assert.ok(attempts.every(a => a.reservation.operation_id === id));
        assert.equal(operations.has(id), false);
        operations.add(id);
        const status = Number(claim.job_id.split('-')[1]) % 3 === 0 ? 'partial_success' : 'ok';
        await channel.recordToolReceipt(receipt(claim, id, status));
        await channel.complete({ ...claim, content: '{}' });
      }
    }));
    channel = f.restart();
    for (const i of ids) {
      const record = await channel.get(`stress-${i}`);
      assert.equal(record.state, 'completed');
      assert.equal(record.tool_receipts.length, 1);
      assert.equal(record.human_review_required, i % 3 === 0);
      assert.equal(record.application.state, 'pending', 'model completion must still await host application');
    }
  }
  assert.equal(claimed.size, 120);
  assert.equal(operations.size, 120);
  assert.equal(await channel.claim({ consumerId: 'after-restart', waitMs: 0 }), null);
});

test('32 response losses across a restart remain fenced and produce durable review, never another write', async t => {
  const f = await fixture(t);
  await Promise.all(Array.from({ length: 32 }, (_, i) => f.channel.enqueue(event(i))));
  const claims = [];
  for (let i = 0; i < 32; i++) {
    const claim = await f.channel.claim({ consumerId: 'fault-injector', waitMs: 0 });
    claims.push(claim);
    await f.channel.reserveToolOperation(operation(claim));
  }
  f.clock.now += 1001;
  const restarted = f.restart();
  await restarted.reapExpiredLeases();
  for (const claim of claims) {
    const record = await restarted.get(claim.job_id);
    assert.equal(record.state, 'failed');
    assert.equal(record.error.type, 'confirmation_operation_unresolved');
    assert.equal(record.failure_notification.state, 'pending');
    assert.equal((await restarted.reserveToolOperation(operation(claim))).created, false);
    await assert.rejects(restarted.reserveToolOperation({ ...operation(claim), request_digest: 'new-payload' }));
  }
  assert.equal(await restarted.claim({ consumerId: 'no-replay', waitMs: 0 }), null);
  assert.equal((await restarted.listPendingFailureNotifications()).length, 32);
});
