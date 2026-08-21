import { createHash, randomUUID } from 'node:crypto';
import {
  mkdir as defaultMkdir,
  readFile as defaultReadFile,
  readdir as defaultReaddir,
  rename as defaultRename,
  unlink as defaultUnlink,
  writeFile as defaultWriteFile
} from 'node:fs/promises';
import path from 'node:path';

const TERMINAL_STATES = new Set(['completed', 'superseded', 'failed']);
const JOB_STATES = new Set(['ready', 'claimed', 'completed', 'superseded', 'retry_wait', 'failed']);
const TOOL_OPERATION_STATES = new Set(['reserved', 'completed']);

const clone = (value) => JSON.parse(JSON.stringify(value));
const iso = (value) => new Date(value).toISOString();
const digest = (value) => createHash('sha256').update(value).digest('hex');

function channelError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function requiredString(value, name, code = 'invalid_event') {
  const normalized = String(value ?? '').trim();
  if (!normalized) throw channelError(code, name + ' is required');
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
  return {
    job_id: requiredString(event?.job_id ?? event?.jobId, 'job_id'),
    room_key: requiredString(event?.room_key ?? event?.roomKey, 'room_key'),
    room_revision: positiveRevision(event?.room_revision ?? event?.roomRevision),
    event: clone(event)
  };
}

function canonicalJson(value) {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalJson(value[key])]));
  }
  return value;
}

const sameResult = (left, right) => JSON.stringify(canonicalJson(left)) === JSON.stringify(canonicalJson(right));
const isObjectOrNull = (value) => value === null || (value && typeof value === 'object' && !Array.isArray(value));
const isValidIso = (value) => typeof value === 'string'
  && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)
  && Number.isFinite(Date.parse(value));

function validateReceipt(receipt) {
  if (receipt?.schema !== 'village-confirmation-receipt/v1') throw channelError('invalid_receipt', 'receipt schema is invalid');
  requiredString(receipt?.receipt_id ?? receipt?.receiptId, 'receipt_id', 'invalid_receipt');
  if (!String(receipt?.status ?? '').trim()) throw channelError('invalid_receipt', 'receipt status is required');
  if (!Array.isArray(receipt?.availability_report)) throw channelError('invalid_receipt', 'availability_report must be a list');
  if (!isObjectOrNull(receipt?.authoritative_sheet_result)) throw channelError('invalid_receipt', 'authoritative_sheet_result must be an object or null');
  if (!isValidIso(receipt?.created_at)) throw channelError('invalid_receipt', 'created_at must be ISO-8601');
  if (!(receipt?.error === null || typeof receipt?.error === 'string' || isObjectOrNull(receipt?.error))) {
    throw channelError('invalid_receipt', 'error must be null, a string, or an object');
  }
}

function normalizeToolOperation(operation) {
  const tool = requiredString(operation?.tool, 'tool', 'invalid_tool_operation');
  if (tool !== 'confirmation_request') {
    throw channelError('invalid_tool_operation', 'unsupported tool operation');
  }
  return {
    tool,
    job_id: requiredString(operation?.job_id ?? operation?.jobId, 'job_id', 'invalid_tool_operation'),
    room_key: requiredString(operation?.room_key ?? operation?.roomKey, 'room_key', 'invalid_tool_operation'),
    room_revision: positiveRevision(operation?.room_revision ?? operation?.roomRevision),
    lease_id: requiredString(operation?.lease_id ?? operation?.leaseId, 'lease_id', 'stale_lease'),
    request_digest: requiredString(operation?.request_digest ?? operation?.requestDigest, 'request_digest', 'invalid_tool_operation')
  };
}

function sameToolOperationEnvelope(reservation, operation) {
  return reservation?.tool === operation.tool
    && reservation?.job_id === operation.job_id
    && reservation?.room_key === operation.room_key
    && reservation?.room_revision === operation.room_revision
    && reservation?.lease_id === operation.lease_id
    && reservation?.request_digest === operation.request_digest;
}

function exactReceiptForToolOperation(job) {
  const reservation = job?.tool_operation;
  if (!reservation || reservation.state !== 'completed') return null;
  return (Array.isArray(job.tool_receipts) ? job.tool_receipts : []).find((receipt) => (
    receipt?.schema === 'village-confirmation-receipt/v1'
    && receipt.receipt_id === reservation.receipt_id
    && receipt.operation_id === reservation.operation_id
    && receipt.job_id === reservation.job_id
    && receipt.room_key === reservation.room_key
    && receipt.room_revision === reservation.room_revision
    && receipt.lease_id === reservation.lease_id
    && receipt.request_digest === reservation.request_digest
  )) || null;
}

function validatePersistedToolOperation(job) {
  const reservation = job?.tool_operation;
  if (reservation == null) return;
  if (reservation.schema !== 'village-tool-operation-reservation/v1'
    || !TOOL_OPERATION_STATES.has(reservation.state)
    || !isValidIso(reservation.created_at)
    || !String(reservation.operation_id || '').trim()) {
    throw channelError('invalid_persisted_job', 'persisted tool operation is invalid');
  }
  const normalized = normalizeToolOperation(reservation);
  if (normalized.job_id !== job.job_id
    || normalized.room_key !== job.room_key
    || normalized.room_revision !== job.room_revision
    || (reservation.state === 'completed' && !String(reservation.receipt_id || '').trim())) {
    throw channelError('invalid_persisted_job', 'persisted tool operation does not match its job');
  }
}

export function createHermesGatewayChannel({ directory, leaseMs = 300000, maxAttempts = 2, now = Date.now, storage = {} } = {}) {
  const queueDirectory = path.join(requiredString(directory, 'directory'), 'hermes-gateway');
  const leaseDuration = Number(leaseMs);
  const maximumAttempts = Number(maxAttempts);
  if (!Number.isFinite(leaseDuration) || leaseDuration <= 0) throw channelError('invalid_config', 'leaseMs must be positive');
  if (!Number.isInteger(maximumAttempts) || maximumAttempts < 1) throw channelError('invalid_config', 'maxAttempts must be a positive integer');

  const fs = {
    mkdir: defaultMkdir, readFile: defaultReadFile, readdir: defaultReaddir, rename: defaultRename,
    unlink: defaultUnlink, writeFile: defaultWriteFile, ...storage
  };
  const jobs = new Map();
  let initialized = false;
  let needsReconciliation = false;
  let queueOrder = 0;
  let mutationTail = Promise.resolve();
  const currentTime = () => {
    const value = now();
    const milliseconds = value instanceof Date ? value.getTime() : Number(value);
    if (!Number.isFinite(milliseconds)) throw channelError('invalid_clock', 'now() must return a timestamp');
    return milliseconds;
  };
  const fileFor = (jobId) => path.join(queueDirectory, digest(jobId) + '.json');

  async function persist(nextJob) {
    const target = fileFor(nextJob.job_id);
    const temporary = target + '.' + process.pid + '.' + randomUUID() + '.tmp';
    try {
      await fs.writeFile(temporary, JSON.stringify(nextJob) + '\n', 'utf8');
      await fs.rename(temporary, target);
    } catch (error) {
      await fs.unlink(temporary).catch(() => {});
      throw error;
    }
  }

  async function initialize() {
    if (initialized) return;
    await fs.mkdir(queueDirectory, { recursive: true });
    for (const name of await fs.readdir(queueDirectory)) {
      if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
      const job = JSON.parse(await fs.readFile(path.join(queueDirectory, name), 'utf8'));
      if (!JOB_STATES.has(job.state) || !job.job_id || path.basename(fileFor(job.job_id)) !== name) {
        throw channelError('invalid_persisted_job', 'invalid persisted Hermes Gateway job: ' + name);
      }
      validatePersistedToolOperation(job);
      jobs.set(job.job_id, job);
      queueOrder = Math.max(queueOrder, Number(job.queue_order) || 0);
    }
    initialized = true;
    needsReconciliation = true;
  }

  async function update(job, changes) {
    const next = { ...job, ...clone(changes), updated_at: iso(currentTime()) };
    await persist(next);
    jobs.set(next.job_id, next);
    return next;
  }

  function roomJobs(roomKey) {
    return [...jobs.values()].filter((job) => job.room_key === roomKey)
      .sort((left, right) => right.room_revision - left.room_revision || right.queue_order - left.queue_order);
  }

  const authoritativeJob = (roomKey) => roomJobs(roomKey)[0] ?? null;
  const isAuthoritative = (job) => authoritativeJob(job.room_key)?.job_id === job.job_id;

  async function reconcileRoom(roomKey) {
    const authoritative = authoritativeJob(roomKey);
    if (!authoritative) return;
    for (const older of roomJobs(roomKey)) {
      if (older.job_id === authoritative.job_id || TERMINAL_STATES.has(older.state)) continue;
      await update(older, {
        state: 'superseded', superseded_by: authoritative.job_id, superseded_lease_id: older.lease_id,
        claimed_by: null, lease_id: null, lease_expires_at: null, lease_expires_at_ms: null,
        ...(older.tool_operation ? {
          human_review_required: true,
          error: {
            type: 'confirmation_operation_unresolved',
            operation_id: older.tool_operation.operation_id,
            operation_state: older.tool_operation.state
          }
        } : {})
      });
    }
  }

  async function reconcilePending() {
    if (!needsReconciliation) return;
    for (const job of [...jobs.values()]) {
      if (job.state === 'retry_wait') await update(job, { state: 'ready' });
    }
    for (const roomKey of new Set([...jobs.values()].map((job) => job.room_key))) await reconcileRoom(roomKey);
    needsReconciliation = false;
  }

  async function mutate(operation) {
    const previous = mutationTail;
    let release;
    mutationTail = new Promise((resolve) => { release = resolve; });
    await previous;
    try {
      await initialize();
      await reconcilePending();
      return await operation();
    } finally {
      release();
    }
  }

  async function reapExpiredLeasesInternal() {
    const nowMs = currentTime();
    const reaped = [];
    for (const job of [...jobs.values()]) {
      if (job.state !== 'claimed' || Number(job.lease_expires_at_ms) > nowMs) continue;
      const next = job.tool_operation
        ? await update(job, {
          state: 'failed', claimed_by: null, lease_id: null, lease_expires_at: null, lease_expires_at_ms: null,
          human_review_required: true,
          error: {
            type: 'confirmation_operation_unresolved',
            operation_id: job.tool_operation.operation_id,
            operation_state: job.tool_operation.state
          }
        })
        : job.attempts >= maximumAttempts
        ? await update(job, {
          state: 'failed', claimed_by: null, lease_id: null, lease_expires_at: null, lease_expires_at_ms: null,
          human_review_required: true, error: { type: 'lease_retry_exhausted', attempts: job.attempts }
        })
        : await update(job, {
          state: 'ready', claimed_by: null, lease_id: null, lease_expires_at: null, lease_expires_at_ms: null,
          error: { type: 'lease_expired', attempts: job.attempts }
        });
      reaped.push(clone(next));
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

  function assertCurrentLease(job, envelope) {
    const leaseId = requiredString(envelope?.lease_id ?? envelope?.leaseId, 'lease_id', 'stale_lease');
    if (job.state !== 'claimed' || job.lease_id !== leaseId || Number(job.lease_expires_at_ms) <= currentTime()) {
      throw channelError('stale_lease', 'mutation lease is no longer current');
    }
  }

  async function rejectUnresolvedToolOperation(job, { outcome = null } = {}) {
    if (job.state === 'failed' && job.error?.type === 'confirmation_operation_unresolved') {
      throw channelError('confirmation_operation_unresolved', 'confirmation operation requires human review');
    }
    if (job.state === 'superseded' && job.error?.type === 'confirmation_operation_unresolved') {
      throw channelError('confirmation_operation_unresolved', 'superseded confirmation operation requires human review');
    }
    const operation = job.tool_operation;
    const error = {
      type: 'confirmation_operation_unresolved',
      operation_id: operation.operation_id,
      operation_state: operation.state,
      reason: operation.state === 'completed' ? 'exact_receipt_missing' : 'receipt_not_persisted'
    };
    await update(job, {
      state: 'failed',
      claimed_by: null,
      lease_id: null,
      lease_expires_at: null,
      lease_expires_at_ms: null,
      human_review_required: true,
      error,
      ...(outcome ? { outcome: clone(outcome) } : {})
    });
    throw channelError('confirmation_operation_unresolved', 'confirmation operation requires human review');
  }

  async function claimOnce(consumerId) {
    await reapExpiredLeasesInternal();
    const activeRooms = new Set([...jobs.values()].filter((job) => job.state === 'claimed' && isAuthoritative(job)).map((job) => job.room_key));
    const candidate = [...jobs.values()]
      .filter((job) => job.state === 'ready' && isAuthoritative(job) && !activeRooms.has(job.room_key))
      .sort((left, right) => left.queue_order - right.queue_order)[0];
    if (!candidate) return null;
    const nowMs = currentTime();
    return clone(await update(candidate, {
      state: 'claimed', attempts: candidate.attempts + 1, claimed_by: consumerId, lease_id: randomUUID(),
      lease_expires_at: iso(nowMs + leaseDuration), lease_expires_at_ms: nowMs + leaseDuration, error: null
    }));
  }

  return {
    async enqueue(event) {
      return mutate(async () => {
        const normalized = normalizeEvent(event);
        const existing = jobs.get(normalized.job_id);
        if (existing) {
          if (existing.room_key !== normalized.room_key || existing.room_revision !== normalized.room_revision) {
            throw channelError('job_id_conflict', 'job_id is already bound to another room revision');
          }
          return clone(existing);
        }
        const latest = authoritativeJob(normalized.room_key);
        if (latest && normalized.room_revision < latest.room_revision) throw channelError('stale_room_revision', 'cannot enqueue an older room revision');
        if (latest && normalized.room_revision === latest.room_revision) return clone(latest);
        const nowMs = currentTime();
        const job = {
          schema: 'village-hermes-gateway-job/v1', ...normalized, state: 'ready', attempts: 0, queue_order: ++queueOrder,
          created_at: iso(nowMs), updated_at: iso(nowMs), claimed_by: null, lease_id: null, lease_expires_at: null,
          lease_expires_at_ms: null, superseded_by: null, superseded_lease_id: null, tool_receipts: [], result: null,
          tool_operation: null, outcome: null, error: null, human_review_required: false
        };
        await persist(job);
        jobs.set(job.job_id, job);
        needsReconciliation = true;
        await reconcilePending();
        return clone(jobs.get(job.job_id));
      });
    },

    async claim({ consumerId, waitMs = 0 } = {}) {
      const consumer = requiredString(consumerId, 'consumerId');
      const deadline = currentTime() + Math.max(0, Number(waitMs) || 0);
      do {
        const claimed = await mutate(() => claimOnce(consumer));
        if (claimed || currentTime() >= deadline) return claimed;
        await new Promise((resolve) => setTimeout(resolve, Math.min(25, deadline - currentTime())));
      } while (true);
    },

    async reserveToolOperation(operation) {
      return mutate(async () => {
        const normalized = normalizeToolOperation(operation);
        const job = jobs.get(normalized.job_id);
        if (!job) throw channelError('unknown_job', 'job does not exist');
        assertEnvelope(job, normalized);
        if (job.tool_operation) {
          if (!sameToolOperationEnvelope(job.tool_operation, normalized)) {
            throw channelError('confirmation_operation_conflict', 'job already has another confirmation operation');
          }
          return { created: false, reservation: clone(job.tool_operation) };
        }
        assertCurrentLease(job, normalized);
        const reservation = {
          schema: 'village-tool-operation-reservation/v1',
          operation_id: randomUUID(),
          ...normalized,
          state: 'reserved',
          created_at: iso(currentTime()),
          receipt_id: null,
          completed_at: null
        };
        const next = await update(job, { tool_operation: reservation });
        return { created: true, reservation: clone(next.tool_operation) };
      });
    },

    async recordToolReceipt(receipt) {
      return mutate(async () => {
        validateReceipt(receipt);
        const job = jobs.get(requiredString(receipt?.job_id ?? receipt?.jobId, 'job_id'));
        if (!job) throw channelError('unknown_job', 'job does not exist');
        assertEnvelope(job, receipt);
        const receiptId = requiredString(receipt?.receipt_id ?? receipt?.receiptId, 'receipt_id', 'invalid_receipt');
        const existing = job.tool_receipts.find((item) => item.receipt_id === receiptId);
        if (existing) {
          if (!sameResult(existing, receipt)) throw channelError('receipt_conflict', 'receipt_id already has another value');
          return clone(job);
        }
        const reservation = job.tool_operation;
        if (!reservation) throw channelError('operation_fence_required', 'receipt has no durable tool operation reservation');
        const operationId = requiredString(receipt?.operation_id ?? receipt?.operationId, 'operation_id', 'operation_fence_mismatch');
        const receiptOperation = normalizeToolOperation({ ...receipt, tool: 'confirmation_request' });
        if (reservation.operation_id !== operationId || !sameToolOperationEnvelope(reservation, receiptOperation)) {
          throw channelError('operation_fence_mismatch', 'receipt does not match its durable tool operation reservation');
        }
        if (reservation.state === 'completed') {
          throw channelError('receipt_conflict', 'tool operation already has another receipt');
        }
        const completedAt = iso(currentTime());
        return clone(await update(job, {
          tool_receipts: [...job.tool_receipts, clone(receipt)],
          tool_operation: {
            ...reservation,
            state: 'completed',
            receipt_id: receiptId,
            completed_at: completedAt
          }
        }));
      });
    },

    async complete(result) {
      return mutate(async () => {
        const job = jobs.get(requiredString(result?.job_id ?? result?.jobId, 'job_id'));
        if (!job) throw channelError('unknown_job', 'job does not exist');
        assertEnvelope(job, result);
        if (job.tool_operation && !exactReceiptForToolOperation(job)) {
          return rejectUnresolvedToolOperation(job);
        }
        if (job.state === 'failed' && job.error?.type === 'confirmation_operation_unresolved') {
          throw channelError('confirmation_operation_unresolved', 'confirmation operation requires human review');
        }
        if (job.state === 'completed') {
          if (sameResult(job.result, result)) return clone(job);
          throw channelError('completion_conflict', 'job already has another completion result');
        }
        if (job.state === 'superseded') throw channelError('stale_room_revision', 'superseded jobs cannot complete');
        assertCurrentLease(job, result);
        return clone(await update(job, {
          state: 'completed', result: clone(result), claimed_by: null, lease_id: null, lease_expires_at: null, lease_expires_at_ms: null
        }));
      });
    },

    async recordOutcome(outcome) {
      return mutate(async () => {
        const job = jobs.get(requiredString(outcome?.job_id ?? outcome?.jobId, 'job_id'));
        if (!job) throw channelError('unknown_job', 'job does not exist');
        assertEnvelope(job, outcome);
        const kind = requiredString(outcome?.outcome, 'outcome');
        if (job.outcome && sameResult(job.outcome, outcome)) return clone(job);
        if (kind === 'no_final') {
          if (job.tool_operation && !exactReceiptForToolOperation(job)) {
            return rejectUnresolvedToolOperation(job, { outcome });
          }
          assertCurrentLease(job, outcome);
          return clone(await update(job, {
            state: 'failed', outcome: clone(outcome), claimed_by: null, lease_id: null, lease_expires_at: null,
            lease_expires_at_ms: null, human_review_required: true, error: { type: 'no_final' }
          }));
        }
        const leaseId = requiredString(outcome?.lease_id ?? outcome?.leaseId, 'lease_id', 'stale_lease');
        if (kind === 'cancelled' && job.state === 'superseded' && job.superseded_lease_id === leaseId) {
          return clone(await update(job, { outcome: clone(outcome) }));
        }
        throw channelError('invalid_outcome', 'only no_final and superseded cancelled outcomes are accepted');
      });
    },

    async reapExpiredLeases() { return mutate(reapExpiredLeasesInternal); },
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
