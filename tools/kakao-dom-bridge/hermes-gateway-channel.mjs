import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

const TERMINAL_STATES = new Set(['completed', 'superseded', 'failed']);
const JOB_STATES = new Set(['ready', 'claimed', 'completed', 'superseded', 'retry_wait', 'failed']);

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function iso(now) {
  return new Date(now).toISOString();
}

function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}

function channelError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function requiredString(value, name) {
  const normalized = String(value ?? '').trim();
  if (!normalized) throw channelError('invalid_event', `${name} is required`);
  return normalized;
}

function positiveRevision(value) {
  const revision = Number(value);
  if (!Number.isInteger(revision) || revision <= 0) {
    throw channelError('invalid_event', 'room_revision must be a positive integer');
  }
  return revision;
}

function normalizeEvent(event) {
  const jobId = requiredString(event?.job_id ?? event?.jobId, 'job_id');
  const roomKey = requiredString(event?.room_key ?? event?.roomKey, 'room_key');
  const roomRevision = positiveRevision(event?.room_revision ?? event?.roomRevision);
  return {
    job_id: jobId,
    room_key: roomKey,
    room_revision: roomRevision,
    event: clone(event)
  };
}

function sameResult(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function createHermesGatewayChannel({ directory, leaseMs = 300_000, maxAttempts = 2, now = Date.now } = {}) {
  const queueDirectory = path.join(requiredString(directory, 'directory'), 'hermes-gateway');
  const leaseDuration = Number(leaseMs);
  const maximumAttempts = Number(maxAttempts);
  if (!Number.isFinite(leaseDuration) || leaseDuration <= 0) throw channelError('invalid_config', 'leaseMs must be positive');
  if (!Number.isInteger(maximumAttempts) || maximumAttempts < 1) throw channelError('invalid_config', 'maxAttempts must be a positive integer');

  const jobs = new Map();
  let initialized = false;
  let queueOrder = 0;
  let mutationTail = Promise.resolve();

  const currentTime = () => {
    const value = now();
    const milliseconds = value instanceof Date ? value.getTime() : Number(value);
    if (!Number.isFinite(milliseconds)) throw channelError('invalid_clock', 'now() must return a timestamp');
    return milliseconds;
  };

  const fileFor = (jobId) => path.join(queueDirectory, `${digest(jobId)}.json`);

  async function initialize() {
    if (initialized) return;
    await mkdir(queueDirectory, { recursive: true });
    const names = await readdir(queueDirectory);
    for (const name of names) {
      if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
      const job = JSON.parse(await readFile(path.join(queueDirectory, name), 'utf8'));
      if (!JOB_STATES.has(job.state) || !job.job_id || path.basename(fileFor(job.job_id)) !== name) {
        throw channelError('invalid_persisted_job', `invalid persisted Hermes Gateway job: ${name}`);
      }
      jobs.set(job.job_id, job);
      queueOrder = Math.max(queueOrder, Number(job.queue_order) || 0);
    }
    initialized = true;
  }

  async function persist(job) {
    const target = fileFor(job.job_id);
    const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(job)}\n`, 'utf8');
    await rename(temporary, target);
  }

  async function mutate(operation) {
    const previous = mutationTail;
    let release;
    mutationTail = new Promise((resolve) => { release = resolve; });
    await previous;
    try {
      await initialize();
      return await operation();
    } finally {
      release();
    }
  }

  async function update(job, changes) {
    Object.assign(job, changes, { updated_at: iso(currentTime()) });
    await persist(job);
    return clone(job);
  }

  function roomJobs(roomKey) {
    return [...jobs.values()]
      .filter((job) => job.room_key === roomKey)
      .sort((left, right) => right.room_revision - left.room_revision || right.queue_order - left.queue_order);
  }

  async function reapExpiredLeasesInternal() {
    const nowMs = currentTime();
    const reaped = [];
    for (const job of jobs.values()) {
      if (job.state !== 'claimed' || Number(job.lease_expires_at_ms) > nowMs) continue;
      if (job.attempts >= maximumAttempts) {
        await update(job, {
          state: 'failed',
          claimed_by: null,
          lease_id: null,
          lease_expires_at: null,
          lease_expires_at_ms: null,
          human_review_required: true,
          error: { type: 'lease_retry_exhausted', attempts: job.attempts }
        });
      } else {
        await update(job, {
          state: 'retry_wait',
          claimed_by: null,
          lease_id: null,
          lease_expires_at: null,
          lease_expires_at_ms: null,
          error: { type: 'lease_expired', attempts: job.attempts }
        });
        await update(job, { state: 'ready' });
      }
      reaped.push(clone(job));
    }
    return reaped;
  }

  function assertEnvelope(job, envelope) {
    const roomKey = requiredString(envelope?.room_key ?? envelope?.roomKey, 'room_key');
    const roomRevision = positiveRevision(envelope?.room_revision ?? envelope?.roomRevision);
    if (job.room_key !== roomKey || job.room_revision !== roomRevision) {
      throw channelError('stale_room_revision', 'result does not match the current room revision');
    }
  }

  async function claimOnce(consumerId) {
    await reapExpiredLeasesInternal();
    const activeRooms = new Set([...jobs.values()]
      .filter((job) => job.state === 'claimed')
      .map((job) => job.room_key));
    const candidate = [...jobs.values()]
      .filter((job) => job.state === 'ready' && !activeRooms.has(job.room_key))
      .sort((left, right) => left.queue_order - right.queue_order)[0];
    if (!candidate) return null;
    const nowMs = currentTime();
    return update(candidate, {
      state: 'claimed',
      attempts: candidate.attempts + 1,
      claimed_by: consumerId,
      lease_id: randomUUID(),
      lease_expires_at: iso(nowMs + leaseDuration),
      lease_expires_at_ms: nowMs + leaseDuration,
      error: null
    });
  }

  return {
    async enqueue(event) {
      return mutate(async () => {
        const normalized = normalizeEvent(event);
        const existingById = jobs.get(normalized.job_id);
        if (existingById) {
          if (existingById.room_key !== normalized.room_key || existingById.room_revision !== normalized.room_revision) {
            throw channelError('job_id_conflict', 'job_id is already bound to another room revision');
          }
          return clone(existingById);
        }

        const existingRoomJobs = roomJobs(normalized.room_key);
        const latest = existingRoomJobs[0];
        if (latest && normalized.room_revision < latest.room_revision) {
          throw channelError('stale_room_revision', 'cannot enqueue an older room revision');
        }
        if (latest && normalized.room_revision === latest.room_revision) return clone(latest);

        for (const older of existingRoomJobs.filter((job) => !TERMINAL_STATES.has(job.state))) {
          await update(older, {
            state: 'superseded',
            superseded_by: normalized.job_id,
            claimed_by: null,
            lease_id: null,
            lease_expires_at: null,
            lease_expires_at_ms: null
          });
        }

        const nowMs = currentTime();
        const job = {
          schema: 'village-hermes-gateway-job/v1',
          ...normalized,
          state: 'ready',
          attempts: 0,
          queue_order: ++queueOrder,
          created_at: iso(nowMs),
          updated_at: iso(nowMs),
          claimed_by: null,
          lease_id: null,
          lease_expires_at: null,
          lease_expires_at_ms: null,
          superseded_by: null,
          tool_receipts: [],
          result: null,
          outcome: null,
          error: null,
          human_review_required: false
        };
        jobs.set(job.job_id, job);
        await persist(job);
        return clone(job);
      });
    },

    async claim({ consumerId, waitMs = 0 } = {}) {
      const consumer = requiredString(consumerId, 'consumerId');
      const timeout = Math.max(0, Number(waitMs) || 0);
      const deadline = currentTime() + timeout;
      do {
        const claimed = await mutate(() => claimOnce(consumer));
        if (claimed || currentTime() >= deadline) return claimed;
        await new Promise((resolve) => setTimeout(resolve, Math.min(25, deadline - currentTime())));
      } while (true);
    },

    async recordToolReceipt(receipt) {
      return mutate(async () => {
        const jobId = requiredString(receipt?.job_id ?? receipt?.jobId, 'job_id');
        const job = jobs.get(jobId);
        if (!job) throw channelError('unknown_job', 'job does not exist');
        assertEnvelope(job, receipt);
        const receiptId = requiredString(receipt?.receipt_id ?? receipt?.receiptId, 'receipt_id');
        const existing = job.tool_receipts.find((item) => item.receipt_id === receiptId);
        if (existing) {
          if (!sameResult(existing, receipt)) throw channelError('receipt_conflict', 'receipt_id already has another value');
          return clone(job);
        }
        if (job.state !== 'claimed') throw channelError('job_not_claimed', 'tool receipts require an active claim');
        job.tool_receipts.push(clone(receipt));
        return update(job, {});
      });
    },

    async complete(result) {
      return mutate(async () => {
        const jobId = requiredString(result?.job_id ?? result?.jobId, 'job_id');
        const job = jobs.get(jobId);
        if (!job) throw channelError('unknown_job', 'job does not exist');
        assertEnvelope(job, result);
        if (job.state === 'completed') {
          if (sameResult(job.result, result)) return clone(job);
          throw channelError('completion_conflict', 'job already has another completion result');
        }
        if (job.state === 'superseded') throw channelError('stale_room_revision', 'superseded jobs cannot complete');
        if (job.state !== 'claimed') throw channelError('job_not_claimed', 'only a claimed job can complete');
        return update(job, {
          state: 'completed',
          result: clone(result),
          claimed_by: null,
          lease_id: null,
          lease_expires_at: null,
          lease_expires_at_ms: null
        });
      });
    },

    async recordOutcome(outcome) {
      return mutate(async () => {
        const jobId = requiredString(outcome?.job_id ?? outcome?.jobId, 'job_id');
        const job = jobs.get(jobId);
        if (!job) throw channelError('unknown_job', 'job does not exist');
        assertEnvelope(job, outcome);
        const kind = requiredString(outcome?.outcome, 'outcome');
        if (job.outcome && sameResult(job.outcome, outcome)) return clone(job);
        if (kind === 'no_final') {
          if (job.state !== 'claimed') throw channelError('job_not_claimed', 'no_final requires an active claim');
          return update(job, {
            state: 'failed',
            outcome: clone(outcome),
            claimed_by: null,
            lease_id: null,
            lease_expires_at: null,
            lease_expires_at_ms: null,
            human_review_required: true,
            error: { type: 'no_final' }
          });
        }
        if (kind === 'cancelled' && job.state === 'superseded') {
          return update(job, { outcome: clone(outcome) });
        }
        throw channelError('invalid_outcome', 'only no_final and superseded cancelled outcomes are accepted');
      });
    },

    async reapExpiredLeases() {
      return mutate(reapExpiredLeasesInternal);
    },

    async get(jobId) {
      return mutate(async () => {
        const job = jobs.get(requiredString(jobId, 'job_id'));
        return job ? clone(job) : null;
      });
    },

    async status() {
      return mutate(async () => {
        const counts = Object.fromEntries([...JOB_STATES].map((state) => [state, 0]));
        let lastCompleted = null;
        for (const job of jobs.values()) {
          counts[job.state] += 1;
          if (job.state === 'completed' && (!lastCompleted || job.updated_at > lastCompleted.updated_at)) lastCompleted = job;
        }
        return { counts, last_completed_job_id: lastCompleted?.job_id ?? null };
      });
    }
  };
}
