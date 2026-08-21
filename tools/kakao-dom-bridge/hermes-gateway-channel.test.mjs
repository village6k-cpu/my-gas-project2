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

function confirmationOperation(claim, requestDigest = 'request-digest-1') {
  return {
    tool: 'confirmation_request',
    job_id: claim.job_id,
    room_key: claim.room_key,
    room_revision: claim.room_revision,
    lease_id: claim.lease_id,
    request_digest: requestDigest
  };
}

function confirmationReceipt(claim, operationId, requestDigest = 'request-digest-1') {
  return {
    schema: 'village-confirmation-receipt/v1', receipt_id: 'receipt-1',
    job_id: claim.job_id, room_key: claim.room_key, room_revision: claim.room_revision,
    lease_id: claim.lease_id, request_digest: requestDigest, operation_id: operationId,
    status: 'ok', availability_report: [], authoritative_sheet_result: null,
    created_at: '2026-08-21T00:00:00.000Z', error: null
  };
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
    const reserved = await channel.reserveToolOperation(confirmationOperation(claim));
    const receipt = confirmationReceipt(claim, reserved.reservation.operation_id);
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

test('requires a durable fence for receipts and the current unexpired lease for completion and outcome mutations', async () => {
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
        }), { code: 'operation_fence_required' });
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
    const reserved = await channel.reserveToolOperation(confirmationOperation(claim));
    const base = {
      schema: 'village-confirmation-receipt/v1', receipt_id: 'receipt-1', job_id: 'job-a1', room_key: 'room-a',
      room_revision: 4, lease_id: claim.lease_id, status: 'ok', availability_report: [],
      authoritative_sheet_result: null, created_at: '2026-08-21T00:00:00.000Z', error: null,
      request_digest: 'request-digest-1', operation_id: reserved.reservation.operation_id
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
      room_key: 'room-a', job_id: 'job-a1', receipt_id: 'receipt-1', schema: 'village-confirmation-receipt/v1',
      request_digest: 'request-digest-1', operation_id: reserved.reservation.operation_id
    };
    assert.equal((await channel.recordToolReceipt(reorderedReceipt)).tool_receipts.length, 1);

    const result = { job_id: 'job-a1', room_key: 'room-a', room_revision: 4, lease_id: claim.lease_id, final: { reply_mode: 'draft_only', confidence: 0.9 } };
    await channel.complete(result);
    const reorderedResult = { final: { confidence: 0.9, reply_mode: 'draft_only' }, lease_id: claim.lease_id, room_revision: 4, room_key: 'room-a', job_id: 'job-a1' };
    assert.equal((await channel.complete(reorderedResult)).state, 'completed');
  });
});

test('persists a channel-owned confirmation reservation and accepts only its exact receipt after lease expiry', async () => {
  await withChannel(async ({ channel, clock }) => {
    await channel.enqueue(event('job-reserved', 'room-reserved', 1));
    const claim = await channel.claim({ consumerId: 'gateway-1', waitMs: 0 });
    const reserved = await channel.reserveToolOperation(confirmationOperation(claim));

    assert.equal(reserved.created, true);
    assert.equal(reserved.reservation.schema, 'village-tool-operation-reservation/v1');
    assert.match(reserved.reservation.operation_id, /^[0-9a-f-]{36}$/);
    assert.equal(reserved.reservation.state, 'reserved');

    await assert.rejects(
      channel.recordToolReceipt(confirmationReceipt(claim, 'wrong-operation-id')),
      { code: 'operation_fence_mismatch' }
    );

    clock.now += 1_000;
    await channel.reapExpiredLeases();
    const fenced = await channel.get(claim.job_id);
    assert.equal(fenced.state, 'failed');
    assert.equal(fenced.human_review_required, true);
    assert.equal(fenced.error.type, 'confirmation_operation_unresolved');

    const recorded = await channel.recordToolReceipt(
      confirmationReceipt(claim, reserved.reservation.operation_id)
    );
    assert.equal(recorded.tool_receipts.length, 1);
    assert.equal(recorded.tool_operation.state, 'completed');
    assert.equal(recorded.tool_operation.receipt_id, 'receipt-1');
  });
});

test('rejects a late confirmation receipt that has no durable operation fence', async () => {
  await withChannel(async ({ channel, clock }) => {
    await channel.enqueue(event('job-unfenced', 'room-unfenced', 1));
    const claim = await channel.claim({ consumerId: 'gateway-1', waitMs: 0 });
    clock.now += 1_000;
    await channel.reapExpiredLeases();

    const unfenced = confirmationReceipt(claim, 'invented-operation-id');
    await assert.rejects(channel.recordToolReceipt(unfenced), { code: 'operation_fence_required' });
  });
});

test('conflicts a confirmation reservation with a different digest, lease, or correlation', async () => {
  await withChannel(async ({ channel }) => {
    await channel.enqueue(event('job-conflict', 'room-conflict', 2));
    const claim = await channel.claim({ consumerId: 'gateway-1', waitMs: 0 });
    await channel.reserveToolOperation(confirmationOperation(claim));

    await assert.rejects(
      channel.reserveToolOperation(confirmationOperation(claim, 'different-request-digest')),
      { code: 'confirmation_operation_conflict' }
    );
    await assert.rejects(
      channel.reserveToolOperation({ ...confirmationOperation(claim), lease_id: 'different-lease' }),
      { code: 'confirmation_operation_conflict' }
    );
    await assert.rejects(
      channel.reserveToolOperation({ ...confirmationOperation(claim), room_revision: 1 }),
      { code: 'stale_room_revision' }
    );
  });
});

test('an unresolved durable confirmation reservation survives restart and never requeues', async () => {
  await withChannel(async ({ channel, directory, clock }) => {
    await channel.enqueue(event('job-restart', 'room-restart', 1));
    const claim = await channel.claim({ consumerId: 'gateway-1', waitMs: 0 });
    const reserved = await channel.reserveToolOperation(confirmationOperation(claim));

    const restarted = createHermesGatewayChannel({
      directory, leaseMs: 1_000, maxAttempts: 2, now: () => clock.now
    });
    const recovered = await restarted.get(claim.job_id);
    assert.equal(recovered.tool_operation.operation_id, reserved.reservation.operation_id);

    const duplicate = await restarted.reserveToolOperation(confirmationOperation(claim));
    assert.equal(duplicate.created, false);
    assert.equal(duplicate.reservation.operation_id, reserved.reservation.operation_id);

    clock.now += 1_000;
    await restarted.reapExpiredLeases();
    const review = await restarted.get(claim.job_id);
    assert.equal(review.state, 'failed');
    assert.equal(review.human_review_required, true);
    assert.equal(review.error.type, 'confirmation_operation_unresolved');
    assert.equal(await restarted.claim({ consumerId: 'gateway-2', waitMs: 0 }), null);
  });
});

test('accepts an exact reserved receipt after a newer same-room revision supersedes the operation', async () => {
  await withChannel(async ({ channel }) => {
    await channel.enqueue(event('job-old-operation', 'room-shared', 1));
    const claim = await channel.claim({ consumerId: 'gateway-1', waitMs: 0 });
    const reserved = await channel.reserveToolOperation(confirmationOperation(claim));

    await channel.enqueue(event('job-new-turn', 'room-shared', 2));
    const superseded = await channel.get(claim.job_id);
    assert.equal(superseded.state, 'superseded');
    assert.equal(superseded.human_review_required, true);
    assert.equal(superseded.error.type, 'confirmation_operation_unresolved');

    const recorded = await channel.recordToolReceipt(
      confirmationReceipt(claim, reserved.reservation.operation_id)
    );
    assert.equal(recorded.tool_receipts.length, 1);
    assert.equal(recorded.tool_operation.state, 'completed');
  });
});

test('a result submitted before its reserved confirmation receipt fails terminally and survives restart', async () => {
  await withChannel(async ({ channel, directory, clock }) => {
    await channel.enqueue(event('job-result-before-receipt', 'room-result-before-receipt', 1));
    const claim = await channel.claim({ consumerId: 'gateway-1', waitMs: 0 });
    const reserved = await channel.reserveToolOperation(confirmationOperation(claim));
    const result = {
      job_id: claim.job_id, room_key: claim.room_key, room_revision: claim.room_revision,
      lease_id: claim.lease_id, final: { reply_mode: 'draft_only' }
    };

    await assert.rejects(channel.complete(result), { code: 'confirmation_operation_unresolved' });
    const failed = await channel.get(claim.job_id);
    assert.equal(failed.state, 'failed');
    assert.equal(failed.human_review_required, true);
    assert.equal(failed.error.type, 'confirmation_operation_unresolved');
    assert.equal(failed.error.operation_id, reserved.reservation.operation_id);
    assert.equal(failed.error.operation_state, 'reserved');

    const restarted = createHermesGatewayChannel({
      directory, leaseMs: 1_000, maxAttempts: 2, now: () => clock.now
    });
    const recovered = await restarted.get(claim.job_id);
    assert.equal(recovered.state, 'failed');
    assert.equal(recovered.human_review_required, true);
    assert.equal((await restarted.status()).counts.completed, 0);
    assert.equal((await restarted.status()).counts.failed, 1);
    assert.equal(await restarted.claim({ consumerId: 'gateway-2', waitMs: 0 }), null);
  });
});

test('a late exact receipt enriches an unresolved result job without auto-completing or retrying it', async () => {
  await withChannel(async ({ channel }) => {
    await channel.enqueue(event('job-late-result-receipt', 'room-late-result-receipt', 1));
    const claim = await channel.claim({ consumerId: 'gateway-1', waitMs: 0 });
    const reserved = await channel.reserveToolOperation(confirmationOperation(claim));
    const result = {
      job_id: claim.job_id, room_key: claim.room_key, room_revision: claim.room_revision,
      lease_id: claim.lease_id, final: { reply_mode: 'draft_only' }
    };
    await assert.rejects(channel.complete(result), { code: 'confirmation_operation_unresolved' });

    const withReceipt = await channel.recordToolReceipt(
      confirmationReceipt(claim, reserved.reservation.operation_id)
    );
    assert.equal(withReceipt.tool_receipts.length, 1);
    assert.equal(withReceipt.tool_operation.state, 'completed');
    assert.equal(withReceipt.state, 'failed');
    assert.equal(withReceipt.human_review_required, true);
    assert.equal(withReceipt.error.type, 'confirmation_operation_unresolved');
    await assert.rejects(channel.complete(result), { code: 'confirmation_operation_unresolved' });
    assert.equal(await channel.claim({ consumerId: 'gateway-2', waitMs: 0 }), null);
  });
});

test('a completed operation missing its exact persisted receipt fails closed instead of completing the job', async () => {
  await withChannel(async ({ channel, directory, clock }) => {
    await channel.enqueue(event('job-corrupt-operation', 'room-corrupt-operation', 1));
    const claim = await channel.claim({ consumerId: 'gateway-1', waitMs: 0 });
    const reserved = await channel.reserveToolOperation(confirmationOperation(claim));
    const jobPath = path.join(
      directory,
      'hermes-gateway',
      `${createHash('sha256').update(claim.job_id).digest('hex')}.json`
    );
    const persisted = JSON.parse(await readFile(jobPath, 'utf8'));
    persisted.tool_operation = {
      ...persisted.tool_operation,
      state: 'completed',
      receipt_id: 'receipt-never-persisted',
      completed_at: '2026-08-21T00:00:00.000Z'
    };
    await realWriteFile(jobPath, JSON.stringify(persisted) + '\n', 'utf8');

    const restarted = createHermesGatewayChannel({
      directory, leaseMs: 1_000, maxAttempts: 2, now: () => clock.now
    });
    await assert.rejects(restarted.complete({
      job_id: claim.job_id, room_key: claim.room_key, room_revision: claim.room_revision,
      lease_id: claim.lease_id, final: { reply_mode: 'draft_only' }
    }), { code: 'confirmation_operation_unresolved' });
    const failed = await restarted.get(claim.job_id);
    assert.equal(failed.state, 'failed');
    assert.equal(failed.human_review_required, true);
    assert.equal(failed.error.reason, 'exact_receipt_missing');
    assert.equal(failed.error.operation_id, reserved.reservation.operation_id);
  });
});

test('no_final and superseded cancellation preserve unresolved confirmation operation evidence', async () => {
  await withChannel(async ({ channel }) => {
    await channel.enqueue(event('job-no-final-operation', 'room-no-final-operation', 1));
    const noFinalClaim = await channel.claim({ consumerId: 'gateway-1', waitMs: 0 });
    const noFinalReservation = await channel.reserveToolOperation(confirmationOperation(noFinalClaim));
    await assert.rejects(channel.recordOutcome({
      job_id: noFinalClaim.job_id, room_key: noFinalClaim.room_key, room_revision: noFinalClaim.room_revision,
      lease_id: noFinalClaim.lease_id, outcome: 'no_final'
    }), { code: 'confirmation_operation_unresolved' });
    const noFinal = await channel.get(noFinalClaim.job_id);
    assert.equal(noFinal.state, 'failed');
    assert.equal(noFinal.human_review_required, true);
    assert.equal(noFinal.error.type, 'confirmation_operation_unresolved');
    assert.equal(noFinal.error.operation_id, noFinalReservation.reservation.operation_id);

    await channel.enqueue(event('job-cancelled-operation', 'room-cancelled-operation', 1));
    const cancelledClaim = await channel.claim({ consumerId: 'gateway-1', waitMs: 0 });
    const cancelledReservation = await channel.reserveToolOperation(confirmationOperation(cancelledClaim));
    await channel.enqueue(event('job-cancelled-new-turn', 'room-cancelled-operation', 2));
    await channel.recordOutcome({
      job_id: cancelledClaim.job_id, room_key: cancelledClaim.room_key, room_revision: cancelledClaim.room_revision,
      lease_id: cancelledClaim.lease_id, outcome: 'cancelled'
    });
    const cancelled = await channel.get(cancelledClaim.job_id);
    assert.equal(cancelled.state, 'superseded');
    assert.equal(cancelled.human_review_required, true);
    assert.equal(cancelled.error.type, 'confirmation_operation_unresolved');
    assert.equal(cancelled.error.operation_id, cancelledReservation.reservation.operation_id);
  });
});

test('wrong or missing result leases cannot preempt a reserved confirmation operation', async () => {
  await withChannel(async ({ channel }) => {
    await channel.enqueue(event('job-wrong-result-lease', 'room-wrong-result-lease', 1));
    const claim = await channel.claim({ consumerId: 'gateway-1', waitMs: 0 });
    const reserved = await channel.reserveToolOperation(confirmationOperation(claim));
    const original = await channel.get(claim.job_id);

    for (const suppliedLease of [undefined, '', 'different-lease']) {
      const result = {
        job_id: claim.job_id, room_key: claim.room_key, room_revision: claim.room_revision,
        final: { reply_mode: 'draft_only' },
        ...(suppliedLease === undefined ? {} : { lease_id: suppliedLease })
      };
      await assert.rejects(channel.complete(result), { code: 'stale_lease' });
      assert.deepEqual(await channel.get(claim.job_id), original);
    }

    await channel.recordToolReceipt(confirmationReceipt(claim, reserved.reservation.operation_id));
    const completed = await channel.complete({
      job_id: claim.job_id, room_key: claim.room_key, room_revision: claim.room_revision,
      lease_id: claim.lease_id, final: { reply_mode: 'draft_only' }
    });
    assert.equal(completed.state, 'completed');
  });
});

test('wrong or missing no_final leases cannot hide or terminally preempt a reserved operation', async () => {
  await withChannel(async ({ channel }) => {
    await channel.enqueue(event('job-wrong-outcome-lease', 'room-wrong-outcome-lease', 1));
    const claim = await channel.claim({ consumerId: 'gateway-1', waitMs: 0 });
    const reserved = await channel.reserveToolOperation(confirmationOperation(claim));
    const original = await channel.get(claim.job_id);

    for (const suppliedLease of [undefined, '', 'different-lease']) {
      const outcome = {
        job_id: claim.job_id, room_key: claim.room_key, room_revision: claim.room_revision,
        outcome: 'no_final',
        ...(suppliedLease === undefined ? {} : { lease_id: suppliedLease })
      };
      await assert.rejects(channel.recordOutcome(outcome), { code: 'stale_lease' });
      assert.deepEqual(await channel.get(claim.job_id), original);
    }

    await channel.recordToolReceipt(confirmationReceipt(claim, reserved.reservation.operation_id));
    const completed = await channel.complete({
      job_id: claim.job_id, room_key: claim.room_key, room_revision: claim.room_revision,
      lease_id: claim.lease_id, final: { reply_mode: 'draft_only' }
    });
    assert.equal(completed.state, 'completed');
  });
});

test('an already failed unresolved operation still rejects a wrong lease without rewriting evidence', async () => {
  await withChannel(async ({ channel }) => {
    await channel.enqueue(event('job-failed-wrong-lease', 'room-failed-wrong-lease', 1));
    const claim = await channel.claim({ consumerId: 'gateway-1', waitMs: 0 });
    await channel.reserveToolOperation(confirmationOperation(claim));
    const exactResult = {
      job_id: claim.job_id, room_key: claim.room_key, room_revision: claim.room_revision,
      lease_id: claim.lease_id, final: { reply_mode: 'draft_only' }
    };
    await assert.rejects(channel.complete(exactResult), { code: 'confirmation_operation_unresolved' });
    const failed = await channel.get(claim.job_id);

    await assert.rejects(
      channel.complete({ ...exactResult, lease_id: 'different-lease' }),
      { code: 'stale_lease' }
    );
    assert.deepEqual(await channel.get(claim.job_id), failed);
    await assert.rejects(channel.complete(exactResult), { code: 'confirmation_operation_unresolved' });
    assert.deepEqual(await channel.get(claim.job_id), failed);
  });
});
