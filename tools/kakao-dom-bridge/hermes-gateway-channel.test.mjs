import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rename as realRename, rm, writeFile as realWriteFile } from 'node:fs/promises';
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
    const claim = await channel.claim({ consumerId: 'gateway-1', waitMs: 0 });
    const receipt = {
      schema: 'village-confirmation-receipt/v1',
      receipt_id: 'receipt-1',
      job_id: 'job-a1',
      room_key: 'room-a',
      room_revision: 4,
      lease_id: claim.lease_id,
      status: 'ok',
      availability_report: [],
      authoritative_sheet_result: null,
      created_at: '2026-08-21T00:00:00.000Z',
      error: null
    };
    await channel.recordToolReceipt(receipt);
    const completed = await channel.complete({
      job_id: 'job-a1', room_key: 'room-a', room_revision: 4, lease_id: claim.lease_id, final: { reply_mode: 'draft_only' }
    });
    const repeated = await channel.complete({
      job_id: 'job-a1', room_key: 'room-a', room_revision: 4, lease_id: claim.lease_id, final: { reply_mode: 'draft_only' }
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
    const noFinalClaim = await channel.claim({ consumerId: 'gateway-1', waitMs: 0 });
    await channel.recordOutcome({ job_id: 'job-no-final', room_key: 'room-a', room_revision: 1, lease_id: noFinalClaim.lease_id, outcome: 'no_final' });
    const noFinal = await channel.get('job-no-final');
    assert.equal(noFinal.state, 'failed');
    assert.equal(noFinal.error.type, 'no_final');
    assert.equal(noFinal.human_review_required, true);

    await channel.enqueue(event('job-old', 'room-b', 1));
    const oldClaim = await channel.claim({ consumerId: 'gateway-1', waitMs: 0 });
    await channel.enqueue(event('job-new', 'room-b', 2));
    await channel.recordOutcome({ job_id: 'job-old', room_key: 'room-b', room_revision: 1, lease_id: oldClaim.lease_id, outcome: 'cancelled' });
    const cancelled = await channel.get('job-old');
    assert.equal(cancelled.state, 'superseded');
    assert.equal(cancelled.outcome.outcome, 'cancelled');
  });
});

test('does not publish a new or claimed state until its write and rename are durable', async () => {
  let failWrite = true;
  let failRename = false;
  const storage = {
    async writeFile(...args) {
      if (failWrite) {
        failWrite = false;
        throw new Error('injected write failure');
      }
      return realWriteFile(...args);
    },
    async rename(...args) {
      if (failRename) {
        failRename = false;
        throw new Error('injected rename failure');
      }
      return realRename(...args);
    }
  };
  await withChannel(async ({ channel }) => {
    await assert.rejects(channel.enqueue(event('job-a1', 'room-a', 1)), /injected write failure/);
    assert.equal(await channel.get('job-a1'), null);

    await channel.enqueue(event('job-a1', 'room-a', 1));
    failRename = true;
    await assert.rejects(channel.claim({ consumerId: 'gateway-1', waitMs: 0 }), /injected rename failure/);
    assert.equal((await channel.get('job-a1')).state, 'ready');
    assert.equal((await channel.claim({ consumerId: 'gateway-1', waitMs: 0 })).state, 'claimed');
  }, { storage });
});

test('recovers a multi-document same-room supersession with the durable newer revision authoritative', async () => {
  let renameCalls = 0;
  let failAtRename = Number.POSITIVE_INFINITY;
  const storage = {
    async rename(...args) {
      renameCalls += 1;
      if (renameCalls === failAtRename) throw new Error('injected supersession rename failure');
      return realRename(...args);
    }
  };
  await withChannel(async ({ directory, channel, clock }) => {
    await channel.enqueue(event('job-old', 'room-a', 1));
    failAtRename = 3;
    await assert.rejects(channel.enqueue(event('job-new', 'room-a', 2)), /injected supersession rename failure/);

    assert.equal((await channel.claim({ consumerId: 'gateway-1', waitMs: 0 })).job_id, 'job-new');
    const restarted = createHermesGatewayChannel({ directory, leaseMs: 1_000, maxAttempts: 2, now: () => clock.now });
    assert.equal((await restarted.get('job-old')).state, 'superseded');
    assert.equal((await restarted.get('job-new')).room_revision, 2);
  }, { storage });
});

test('requires the current unexpired lease for receipt, completion, and outcome mutations', async () => {
  await withChannel(async ({ channel, clock }) => {
    for (const jobId of ['job-receipt', 'job-completion', 'job-outcome']) {
      await channel.enqueue(event(jobId, `room-${jobId}`, 1));
      const first = await channel.claim({ consumerId: 'gateway-1', waitMs: 0 });
      clock.now += 1_000;
      await channel.reapExpiredLeases();
      const second = await channel.claim({ consumerId: 'gateway-2', waitMs: 0 });
      assert.notEqual(first.lease_id, second.lease_id);
      const base = { job_id: jobId, room_key: `room-${jobId}`, room_revision: 1, lease_id: first.lease_id };
      if (jobId === 'job-receipt') {
        await assert.rejects(channel.recordToolReceipt({
          ...base, schema: 'village-confirmation-receipt/v1', receipt_id: 'late-receipt', status: 'ok',
          availability_report: [], authoritative_sheet_result: null, created_at: '2026-08-21T00:00:00.000Z', error: null
        }), { code: 'stale_lease' });
      } else if (jobId === 'job-completion') {
        await assert.rejects(channel.complete({ ...base, final: {} }), { code: 'stale_lease' });
      } else {
        await assert.rejects(channel.recordOutcome({ ...base, outcome: 'no_final' }), { code: 'stale_lease' });
      }
    }
  });
});

test('persists only complete bridge-authored confirmation receipts and treats reordered duplicates as idempotent', async () => {
  await withChannel(async ({ channel }) => {
    await channel.enqueue(event('job-a1', 'room-a', 4));
    const claim = await channel.claim({ consumerId: 'gateway-1', waitMs: 0 });
    const base = {
      schema: 'village-confirmation-receipt/v1', receipt_id: 'receipt-1', job_id: 'job-a1', room_key: 'room-a',
      room_revision: 4, lease_id: claim.lease_id, status: 'ok', availability_report: [],
      authoritative_sheet_result: null, created_at: '2026-08-21T00:00:00.000Z', error: null
    };
    for (const invalid of [
      { ...base, schema: 'wrong-schema' },
      { ...base, status: '' },
      { ...base, availability_report: {} },
      { ...base, authoritative_sheet_result: 'not-an-object' },
      { ...base, created_at: 'not-an-iso-date' },
      { ...base, error: 42 }
    ]) {
      await assert.rejects(channel.recordToolReceipt(invalid), { code: 'invalid_receipt' });
    }
    await channel.recordToolReceipt(base);
    const reorderedReceipt = {
      error: null, created_at: '2026-08-21T00:00:00.000Z', authoritative_sheet_result: null,
      availability_report: [], status: 'ok', lease_id: claim.lease_id, room_revision: 4,
      room_key: 'room-a', job_id: 'job-a1', receipt_id: 'receipt-1', schema: 'village-confirmation-receipt/v1'
    };
    assert.equal((await channel.recordToolReceipt(reorderedReceipt)).tool_receipts.length, 1);

    const result = { job_id: 'job-a1', room_key: 'room-a', room_revision: 4, lease_id: claim.lease_id, final: { reply_mode: 'draft_only', confidence: 0.9 } };
    await channel.complete(result);
    const reorderedResult = { final: { confidence: 0.9, reply_mode: 'draft_only' }, lease_id: claim.lease_id, room_revision: 4, room_key: 'room-a', job_id: 'job-a1' };
    assert.equal((await channel.complete(reorderedResult)).state, 'completed');
  });
});
