import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createHermesGatewayChannel } from './hermes-gateway-channel.mjs';

function event(jobId, roomKey, roomRevision, detectedAt = '2026-08-21T00:00:00.000Z') {
  return { job_id: jobId, room_key: roomKey, room_revision: roomRevision, detected_at: detectedAt };
}

async function withChannel(run, options = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'hermes-gateway-channel-'));
  const clock = { now: Date.parse('2026-08-21T00:00:00.000Z') };
  try {
    await run({
      directory,
      clock,
      channel: createHermesGatewayChannel({
        directory,
        leaseMs: 1_000,
        maxAttempts: 2,
        now: () => clock.now,
        ...options
      })
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('persists every job atomically under a SHA-256 name and recovers it after restart', async () => {
  await withChannel(async ({ directory, channel, clock }) => {
    await channel.enqueue(event('job-private-1', 'private-room', 1));

    const queueDirectory = path.join(directory, 'hermes-gateway');
    const expectedName = `${createHash('sha256').update('job-private-1').digest('hex')}.json`;
    assert.deepEqual(await readdir(queueDirectory), [expectedName]);
    const persisted = JSON.parse(await readFile(path.join(queueDirectory, expectedName), 'utf8'));
    assert.equal(persisted.job_id, 'job-private-1');
    assert.equal(persisted.state, 'ready');
    assert.equal(JSON.stringify(persisted).includes('private-room'), true);

    const restarted = createHermesGatewayChannel({
      directory,
      leaseMs: 1_000,
      maxAttempts: 2,
      now: () => clock.now
    });
    assert.equal((await restarted.get('job-private-1')).state, 'ready');
  });
});

test('claims ready jobs FIFO across rooms while allowing only one active lease per room', async () => {
  await withChannel(async ({ channel, clock }) => {
    await channel.enqueue(event('job-a1', 'room-a', 1, '2026-08-21T00:00:00.000Z'));
    clock.now += 1;
    await channel.enqueue(event('job-b1', 'room-b', 1, '2026-08-21T00:00:00.001Z'));

    const first = await channel.claim({ consumerId: 'gateway-1', waitMs: 0 });
    const second = await channel.claim({ consumerId: 'gateway-2', waitMs: 0 });
    const third = await channel.claim({ consumerId: 'gateway-3', waitMs: 0 });
    assert.equal(first.job_id, 'job-a1');
    assert.equal(second.job_id, 'job-b1');
    assert.equal(third, null);
  });
});

test('coalesces duplicate jobs and supersedes an older same-room revision', async () => {
  await withChannel(async ({ channel }) => {
    await channel.enqueue(event('job-a1', 'room-a', 1));
    const duplicate = await channel.enqueue(event('job-a1', 'room-a', 1));
    const coalesced = await channel.enqueue(event('job-a1-replay', 'room-a', 1));
    await channel.enqueue(event('job-a2', 'room-a', 2));

    assert.equal(duplicate.job_id, 'job-a1');
    assert.equal(coalesced.job_id, 'job-a1');
    assert.equal((await channel.get('job-a1')).state, 'superseded');
    assert.equal((await channel.get('job-a1')).superseded_by, 'job-a2');
    assert.equal((await channel.claim({ consumerId: 'gateway-1', waitMs: 0 })).job_id, 'job-a2');
  });
});

test('requeues only an expired lease and fails terminally after the second claim expires', async () => {
  await withChannel(async ({ channel, clock }) => {
    await channel.enqueue(event('job-a1', 'room-a', 1));
    const first = await channel.claim({ consumerId: 'gateway-1', waitMs: 0 });
    assert.equal(first.attempts, 1);
    clock.now += 1_000;
    await channel.reapExpiredLeases();
    assert.equal((await channel.get('job-a1')).state, 'ready');

    const second = await channel.claim({ consumerId: 'gateway-1', waitMs: 0 });
    assert.equal(second.job_id, 'job-a1');
    assert.equal(second.attempts, 2);
    clock.now += 1_000;
    await channel.reapExpiredLeases();
    const exhausted = await channel.get('job-a1');
    assert.equal(exhausted.state, 'failed');
    assert.equal(exhausted.error.type, 'lease_retry_exhausted');
  });
});

test('records an exact tool receipt and completes a claimed job idempotently', async () => {
  await withChannel(async ({ channel }) => {
    await channel.enqueue(event('job-a1', 'room-a', 4));
    await channel.claim({ consumerId: 'gateway-1', waitMs: 0 });
    const receipt = {
      schema: 'village-confirmation-receipt/v1',
      receipt_id: 'receipt-1',
      job_id: 'job-a1',
      room_key: 'room-a',
      room_revision: 4
    };
    await channel.recordToolReceipt(receipt);
    const completed = await channel.complete({
      job_id: 'job-a1', room_key: 'room-a', room_revision: 4, final: { reply_mode: 'draft_only' }
    });
    const repeated = await channel.complete({
      job_id: 'job-a1', room_key: 'room-a', room_revision: 4, final: { reply_mode: 'draft_only' }
    });
    assert.equal(completed.state, 'completed');
    assert.deepEqual(repeated, completed);
    assert.equal((await channel.get('job-a1')).tool_receipts[0].receipt_id, 'receipt-1');
  });
});

test('rejects a stale result revision without completing the claimed job', async () => {
  await withChannel(async ({ channel }) => {
    await channel.enqueue(event('job-a1', 'room-a', 3));
    await channel.claim({ consumerId: 'gateway-1', waitMs: 0 });
    await assert.rejects(
      channel.complete({ job_id: 'job-a1', room_key: 'room-a', room_revision: 2, final: {} }),
      { code: 'stale_room_revision' }
    );
    assert.equal((await channel.get('job-a1')).state, 'claimed');
  });
});

test('treats no_final and superseded cancellation as terminal outcomes without retries', async () => {
  await withChannel(async ({ channel }) => {
    await channel.enqueue(event('job-no-final', 'room-a', 1));
    await channel.claim({ consumerId: 'gateway-1', waitMs: 0 });
    await channel.recordOutcome({ job_id: 'job-no-final', room_key: 'room-a', room_revision: 1, outcome: 'no_final' });
    const noFinal = await channel.get('job-no-final');
    assert.equal(noFinal.state, 'failed');
    assert.equal(noFinal.error.type, 'no_final');
    assert.equal(noFinal.human_review_required, true);

    await channel.enqueue(event('job-old', 'room-b', 1));
    await channel.claim({ consumerId: 'gateway-1', waitMs: 0 });
    await channel.enqueue(event('job-new', 'room-b', 2));
    await channel.recordOutcome({ job_id: 'job-old', room_key: 'room-b', room_revision: 1, outcome: 'cancelled' });
    const cancelled = await channel.get('job-old');
    assert.equal(cancelled.state, 'superseded');
    assert.equal(cancelled.outcome.outcome, 'cancelled');
  });
});
