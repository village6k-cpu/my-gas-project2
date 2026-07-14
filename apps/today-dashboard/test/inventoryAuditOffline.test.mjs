import assert from "node:assert/strict";
import test from "node:test";

import {
  INVENTORY_AUDIT_DB_NAME,
  INVENTORY_AUDIT_DB_VERSION,
  OBSERVATION_WRITE_STORE,
  EVIDENCE_JOB_STORE,
  InventoryAuditOfflineError,
  IndexedDbAuditQueueStorage,
  ObservationWriteQueue,
  observationWriteKey,
  evidenceJobKey,
  getInventoryAuditQueueSnapshot,
  isRetryableInventoryAuditResponse,
  nextMonotonicClientTimestamp,
  readInventoryAuditPendingCounts,
  refreshInventoryAuditQueueSnapshot,
  shouldPreemptInventoryAuditWake,
} from "../lib/inventory-audit/offline.ts";
import {
  EVIDENCE_RETRY_DELAYS_MS,
  MAX_EVIDENCE_ATTEMPTS,
  EvidenceUploadQueue,
  isRetryableInventoryAuditEvidenceResponse,
  shouldAutoScheduleEvidenceJob,
} from "../lib/inventory-audit/evidenceQueue.ts";

const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const OBSERVATION_A = "22222222-2222-4222-8222-222222222222";
const OBSERVATION_B = "33333333-3333-4333-8333-333333333333";
const EVIDENCE_ID = "44444444-4444-4444-8444-444444444444";

function copy(value) {
  return value == null ? value : structuredClone(value);
}

class MemoryAuditQueueStorage {
  observations = new Map();
  evidence = new Map();

  async getObservation(key) {
    return copy(this.observations.get(key) ?? null);
  }

  async mutateObservation(key, mutate) {
    const next = mutate(copy(this.observations.get(key) ?? null));
    if (next == null) this.observations.delete(key);
    else this.observations.set(key, copy(next));
    return copy(next);
  }

  async listObservations(sessionId) {
    return [...this.observations.values()]
      .filter((row) => !sessionId || row.sessionId === sessionId)
      .map(copy);
  }

  async getEvidence(key) {
    return copy(this.evidence.get(key) ?? null);
  }

  async mutateEvidence(key, mutate) {
    const next = mutate(copy(this.evidence.get(key) ?? null));
    if (next == null) this.evidence.delete(key);
    else this.evidence.set(key, copy(next));
    return copy(next);
  }

  async listEvidence(sessionId) {
    return [...this.evidence.values()]
      .filter((row) => !sessionId || row.sessionId === sessionId)
      .map(copy);
  }
}

function observationBody(id, countNormal = 1, overrides = {}) {
  return {
    id,
    equipmentId: `CAM-${id === OBSERVATION_A ? "001" : "002"}`,
    temporaryCode: null,
    temporaryLabel: null,
    location: "A 선반",
    countNormal,
    countMaintenance: 0,
    countDamaged: 0,
    countConditionUnknown: 0,
    missingComponents: [],
    note: "",
    identificationStatus: "confirmed",
    clientUpdatedAt: "2026-07-14T10:00:00.000Z",
    expectedClientUpdatedAt: null,
    ...overrides,
  };
}

function requestError(status, code, retryable = false) {
  const error = new Error(code);
  error.status = status;
  error.code = code;
  error.retryable = retryable;
  return error;
}

test("uses an audit-only versioned IndexedDB and stable queue keys", () => {
  assert.equal(INVENTORY_AUDIT_DB_NAME, "village-inventory-audit");
  assert.equal(INVENTORY_AUDIT_DB_VERSION, 1);
  assert.equal(OBSERVATION_WRITE_STORE, "observationWrites");
  assert.equal(EVIDENCE_JOB_STORE, "evidenceJobs");
  assert.equal(
    observationWriteKey(SESSION_ID, OBSERVATION_A),
    `obs:${SESSION_ID}:${OBSERVATION_A}`,
  );
  assert.equal(
    evidenceJobKey(SESSION_ID, OBSERVATION_A, EVIDENCE_ID),
    `evidence:${SESSION_ID}:${OBSERVATION_A}:${EVIDENCE_ID}`,
  );
});

test("client timestamps advance by at least one millisecond", () => {
  assert.equal(
    nextMonotonicClientTimestamp("2026-07-14T10:00:00.000Z", Date.parse("2026-07-14T10:00:00.000Z")),
    "2026-07-14T10:00:00.001Z",
  );
  assert.equal(
    nextMonotonicClientTimestamp("2026-07-14T10:00:00.010Z", Date.parse("2026-07-14T10:00:00.005Z")),
    "2026-07-14T10:00:00.011Z",
  );
});

test("a newly due edit preempts an existing later retry wake", () => {
  assert.equal(shouldPreemptInventoryAuditWake(null, 10_000), true);
  assert.equal(shouldPreemptInventoryAuditWake(60_000, 0), true);
  assert.equal(shouldPreemptInventoryAuditWake(60_000, 60_000), false);
  assert.equal(shouldPreemptInventoryAuditWake(3_000, 8_000), false);
});

test("repeated edits replace the exact body, retain creation order, and increment revision", async () => {
  const storage = new MemoryAuditQueueStorage();
  let now = Date.parse("2026-07-14T10:00:00.000Z");
  const queue = new ObservationWriteQueue({
    storage,
    send: async () => ({ clientUpdatedAt: "unused" }),
    now: () => now,
    isOnline: () => false,
    autoSchedule: false,
  });

  const first = await queue.enqueue(SESSION_ID, observationBody(OBSERVATION_A, 1));
  now = Date.parse("2026-07-14T10:00:00.000Z");
  const second = await queue.enqueue(
    SESSION_ID,
    observationBody(OBSERVATION_A, 7, {
      note: "새 메모",
      expectedClientUpdatedAt: "2026-07-14T09:00:00.000Z",
    }),
  );

  assert.equal(second.createdAt, first.createdAt);
  assert.equal(second.revision, 2);
  assert.equal(second.body.countNormal, 7);
  assert.equal(second.body.note, "새 메모");
  assert.equal(second.body.expectedClientUpdatedAt, first.body.expectedClientUpdatedAt);
  assert.equal(second.body.clientUpdatedAt, "2026-07-14T10:00:00.002Z");
  assert.equal(second.state, "pending");
});

test("an older in-flight success never deletes a newer edit and rebases its CAS timestamp", async () => {
  const storage = new MemoryAuditQueueStorage();
  let resolveSend;
  let sendStarted;
  const started = new Promise((resolve) => (sendStarted = resolve));
  const queue = new ObservationWriteQueue({
    storage,
    send: async () => {
      sendStarted();
      return new Promise((resolve) => (resolveSend = resolve));
    },
    now: () => Date.parse("2026-07-14T10:00:00.000Z"),
    isOnline: () => true,
    autoSchedule: false,
  });

  const first = await queue.enqueue(SESSION_ID, observationBody(OBSERVATION_A, 1));
  const processing = queue.process();
  await started;
  const newer = await queue.enqueue(SESSION_ID, observationBody(OBSERVATION_A, 9));
  resolveSend({ clientUpdatedAt: first.body.clientUpdatedAt });
  await processing;

  const stored = await storage.getObservation(first.key);
  assert.equal(stored.revision, newer.revision);
  assert.equal(stored.body.countNormal, 9);
  assert.equal(stored.body.expectedClientUpdatedAt, first.body.clientUpdatedAt);
  assert.equal(stored.state, "pending");
});

test("observation writes send in original creation order", async () => {
  const storage = new MemoryAuditQueueStorage();
  let now = 20;
  const sent = [];
  const queue = new ObservationWriteQueue({
    storage,
    send: async (job) => {
      sent.push(job.observationId);
      return { clientUpdatedAt: job.body.clientUpdatedAt };
    },
    now: () => now,
    isOnline: () => true,
    autoSchedule: false,
  });

  await queue.enqueue(SESSION_ID, observationBody(OBSERVATION_B));
  now = 10;
  await queue.enqueue(SESSION_ID, observationBody(OBSERVATION_A));
  await queue.process();

  assert.deepEqual(sent, [OBSERVATION_A, OBSERVATION_B]);
});

test("conflicts and validation failures stay persisted and visible", async () => {
  for (const [error, expectedState] of [
    [requestError(409, "stale_write"), "conflict"],
    [requestError(422, "invalid_request"), "failed"],
  ]) {
    const storage = new MemoryAuditQueueStorage();
    const queue = new ObservationWriteQueue({
      storage,
      send: async () => {
        throw error;
      },
      now: () => 1_000,
      isOnline: () => true,
      autoSchedule: false,
    });
    const job = await queue.enqueue(SESSION_ID, observationBody(OBSERVATION_A));
    await queue.process();
    const stored = await storage.getObservation(job.key);
    assert.equal(stored.state, expectedState);
    assert.equal(stored.error.code, error.code);
  }
});

test("offline and authentication pauses do not consume observation attempts", async () => {
  const storage = new MemoryAuditQueueStorage();
  let online = false;
  const queue = new ObservationWriteQueue({
    storage,
    send: async () => {
      throw requestError(401, "unauthorized");
    },
    now: () => 1_000,
    isOnline: () => online,
    autoSchedule: false,
  });
  const job = await queue.enqueue(SESSION_ID, observationBody(OBSERVATION_A));
  await queue.process();
  assert.equal((await storage.getObservation(job.key)).attempts, 0);

  online = true;
  await queue.process();
  const paused = await storage.getObservation(job.key);
  assert.equal(paused.attempts, 0);
  assert.equal(paused.state, "auth_paused");
});

test("a connection that drops during send does not consume queue attempts", async () => {
  const observationStorage = new MemoryAuditQueueStorage();
  let observationOnline = true;
  const observationQueue = new ObservationWriteQueue({
    storage: observationStorage,
    send: async () => {
      observationOnline = false;
      throw requestError(0, "network_error", true);
    },
    now: () => 1_000,
    isOnline: () => observationOnline,
    autoSchedule: false,
  });
  const observation = await observationQueue.enqueue(
    SESSION_ID,
    observationBody(OBSERVATION_A),
  );
  await observationQueue.process();
  const savedObservation = await observationStorage.getObservation(observation.key);
  assert.equal(savedObservation.attempts, 0);
  assert.equal(savedObservation.state, "pending");

  const evidenceStorage = new MemoryAuditQueueStorage();
  let evidenceOnline = true;
  const evidenceQueue = new EvidenceUploadQueue({
    storage: evidenceStorage,
    upload: async () => {
      evidenceOnline = false;
      throw requestError(0, "network_error", true);
    },
    discardRemote: async () => {},
    now: () => 1_000,
    isOnline: () => evidenceOnline,
    autoSchedule: false,
  });
  const evidence = await evidenceQueue.enqueue({
    sessionId: SESSION_ID,
    observationId: OBSERVATION_A,
    evidenceId: EVIDENCE_ID,
    blob: new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xd9])], {
      type: "image/jpeg",
    }),
  });
  await evidenceQueue.process();
  const savedEvidence = await evidenceStorage.getEvidence(evidence.key);
  assert.equal(savedEvidence.attempts, 0);
  assert.equal(savedEvidence.state, "pending");
});

test("legacy staff API 5xx responses retry without localized message parsing", () => {
  assert.equal(isRetryableInventoryAuditResponse(500, undefined), true);
  assert.equal(isRetryableInventoryAuditResponse(503, undefined), true);
  assert.equal(isRetryableInventoryAuditResponse(409, undefined), false);
  assert.equal(isRetryableInventoryAuditResponse(502, false), false);
  assert.equal(isRetryableInventoryAuditResponse(422, true), true);
  assert.equal(isRetryableInventoryAuditEvidenceResponse(502, undefined), true);
  assert.equal(isRetryableInventoryAuditEvidenceResponse(503, undefined), true);
  assert.equal(isRetryableInventoryAuditEvidenceResponse(409, undefined), false);
  assert.equal(isRetryableInventoryAuditEvidenceResponse(502, false), false);
  assert.equal(isRetryableInventoryAuditEvidenceResponse(422, true), true);
});

test("session pending counts include sending, retry, conflict, and terminal failed rows", async () => {
  const storage = new MemoryAuditQueueStorage();
  for (const [index, state] of ["sending", "retry_wait", "conflict", "failed"].entries()) {
    const id = `00000000-0000-4000-8000-00000000000${index}`;
    storage.observations.set(observationWriteKey(SESSION_ID, id), {
      key: observationWriteKey(SESSION_ID, id),
      sessionId: SESSION_ID,
      observationId: id,
      createdAt: index,
      revision: 1,
      attempts: 1,
      nextAttemptAt: null,
      state,
      error: { code: "x", status: 409, retryable: false, message: "x" },
      body: observationBody(id),
    });
  }
  storage.evidence.set(evidenceJobKey(SESSION_ID, OBSERVATION_A, EVIDENCE_ID), {
    key: evidenceJobKey(SESSION_ID, OBSERVATION_A, EVIDENCE_ID),
    sessionId: SESSION_ID,
    observationId: OBSERVATION_A,
    evidenceId: EVIDENCE_ID,
    createdAt: 5,
    attempts: 5,
    nextAttemptAt: null,
    state: "failed",
    error: { code: "x", status: 413, retryable: false, message: "x" },
    blob: new Blob(["jpeg"], { type: "image/jpeg" }),
    sizeBytes: 4,
    contentType: "image/jpeg",
  });

  assert.deepEqual(await readInventoryAuditPendingCounts(storage, SESSION_ID), {
    pendingObservationWrites: 4,
    pendingEvidenceUploads: 1,
  });
});

test("an older snapshot read cannot overwrite a newer IndexedDB view", async () => {
  let resolveObservations;
  let resolveEvidence;
  const oldStorage = {
    listObservations: () => new Promise((resolve) => (resolveObservations = resolve)),
    listEvidence: () => new Promise((resolve) => (resolveEvidence = resolve)),
  };
  const latestStorage = {
    listObservations: async () => [],
    listEvidence: async () => [],
  };
  const staleRefresh = refreshInventoryAuditQueueSnapshot(oldStorage);
  await refreshInventoryAuditQueueSnapshot(latestStorage);
  resolveObservations([
    {
      key: observationWriteKey(SESSION_ID, OBSERVATION_A),
      sessionId: SESSION_ID,
      observationId: OBSERVATION_A,
      state: "pending",
    },
  ]);
  resolveEvidence([]);
  await staleRefresh;

  assert.equal(getInventoryAuditQueueSnapshot().sessions[SESSION_ID], undefined);
});

test("IndexedDB unavailable rejects visibly instead of pretending persistence", async () => {
  const storage = new IndexedDbAuditQueueStorage({ indexedDB: undefined });
  await assert.rejects(storage.listObservations(), (error) => {
    assert.ok(error instanceof InventoryAuditOfflineError);
    assert.equal(error.code, "indexeddb_unavailable");
    return true;
  });
});

test("evidence retry delays are fixed and the fifth failure remains terminal", async () => {
  assert.deepEqual(EVIDENCE_RETRY_DELAYS_MS, [3_000, 8_000, 20_000, 60_000]);
  assert.equal(MAX_EVIDENCE_ATTEMPTS, 5);

  const storage = new MemoryAuditQueueStorage();
  let now = 0;
  const queue = new EvidenceUploadQueue({
    storage,
    upload: async () => {
      throw requestError(502, "storage_upstream_error", true);
    },
    discardRemote: async () => {},
    now: () => now,
    isOnline: () => true,
    autoSchedule: false,
  });
  const blob = new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xd9])], {
    type: "image/jpeg",
  });
  const job = await queue.enqueue({
    sessionId: SESSION_ID,
    observationId: OBSERVATION_A,
    evidenceId: EVIDENCE_ID,
    blob,
  });

  const expectedNext = [3_000, 8_000, 20_000, 60_000, null];
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    await queue.process();
    const stored = await storage.getEvidence(job.key);
    assert.equal(stored.attempts, attempt);
    assert.equal(stored.nextAttemptAt, expectedNext[attempt - 1] == null ? null : now + expectedNext[attempt - 1]);
    assert.equal(stored.state, attempt === 5 ? "failed" : "retry_wait");
    if (stored.nextAttemptAt != null) now = stored.nextAttemptAt;
  }
});

test("an observation-dependent evidence job waits for an observation change instead of busy-looping", () => {
  assert.equal(
    shouldAutoScheduleEvidenceJob({
      state: "waiting_observation",
      attempts: 0,
      nextAttemptAt: null,
    }),
    false,
  );
  assert.equal(
    shouldAutoScheduleEvidenceJob({
      state: "retry_wait",
      attempts: 1,
      nextAttemptAt: 3_000,
    }),
    true,
  );
  assert.equal(
    shouldAutoScheduleEvidenceJob({
      state: "discarding",
      attempts: 0,
      nextAttemptAt: null,
    }),
    false,
  );
});

test("evidence resume preserves attempts, UUID, exact Blob, and metadata", async () => {
  const storage = new MemoryAuditQueueStorage();
  const originalBytes = new Uint8Array([0xff, 0xd8, 0xff, 1, 2, 3, 0xd9]);
  const originalBlob = new Blob([originalBytes], { type: "image/jpeg" });
  const key = evidenceJobKey(SESSION_ID, OBSERVATION_A, EVIDENCE_ID);
  storage.evidence.set(key, {
    key,
    sessionId: SESSION_ID,
    observationId: OBSERVATION_A,
    evidenceId: EVIDENCE_ID,
    createdAt: 123,
    attempts: 3,
    nextAttemptAt: 999,
    state: "retry_wait",
    error: { code: "storage_upstream_error", status: 502, retryable: true, message: "retry" },
    blob: originalBlob,
    sizeBytes: originalBlob.size,
    contentType: "image/jpeg",
  });
  const queue = new EvidenceUploadQueue({
    storage,
    upload: async () => {},
    discardRemote: async () => {},
    now: () => 100,
    isOnline: () => false,
    autoSchedule: false,
  });

  await queue.resume();
  const resumed = await storage.getEvidence(key);
  assert.equal(resumed.attempts, 3);
  assert.equal(resumed.evidenceId, EVIDENCE_ID);
  assert.equal(resumed.sizeBytes, originalBlob.size);
  assert.equal(resumed.contentType, "image/jpeg");
  assert.deepEqual(
    new Uint8Array(await resumed.blob.arrayBuffer()),
    originalBytes,
  );
});

test("evidence waits for its observation and a dependency 404 consumes no attempt", async () => {
  const storage = new MemoryAuditQueueStorage();
  let sends = 0;
  const observationKey = observationWriteKey(SESSION_ID, OBSERVATION_A);
  storage.observations.set(observationKey, {
    key: observationKey,
    sessionId: SESSION_ID,
    observationId: OBSERVATION_A,
    createdAt: 1,
    revision: 1,
    attempts: 0,
    nextAttemptAt: null,
    state: "pending",
    error: null,
    body: observationBody(OBSERVATION_A),
  });
  const queue = new EvidenceUploadQueue({
    storage,
    upload: async () => {
      sends += 1;
      storage.observations.set(observationKey, {
        key: observationKey,
        sessionId: SESSION_ID,
        observationId: OBSERVATION_A,
        createdAt: 2,
        revision: 1,
        attempts: 0,
        nextAttemptAt: null,
        state: "pending",
        error: null,
        body: observationBody(OBSERVATION_A),
      });
      throw requestError(404, "not_found");
    },
    discardRemote: async () => {},
    now: () => 100,
    isOnline: () => true,
    autoSchedule: false,
  });
  const job = await queue.enqueue({
    sessionId: SESSION_ID,
    observationId: OBSERVATION_A,
    evidenceId: EVIDENCE_ID,
    blob: new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xd9])], { type: "image/jpeg" }),
  });

  await queue.process();
  assert.equal(sends, 0);
  assert.equal((await storage.getEvidence(job.key)).attempts, 0);

  storage.observations.delete(observationKey);
  await queue.process();
  const waiting = await storage.getEvidence(job.key);
  assert.equal(sends, 1);
  assert.equal(waiting.attempts, 0);
  assert.equal(waiting.state, "waiting_observation");
});

test("an observation wake received mid-pass reruns evidence after a stale dependency read", async () => {
  const storage = new MemoryAuditQueueStorage();
  const observationKey = observationWriteKey(SESSION_ID, OBSERVATION_A);
  const dependency = {
    key: observationKey,
    sessionId: SESSION_ID,
    observationId: OBSERVATION_A,
    createdAt: 1,
    revision: 1,
    attempts: 0,
    nextAttemptAt: null,
    state: "sending",
    error: null,
    body: observationBody(OBSERVATION_A),
  };
  storage.observations.set(observationKey, dependency);
  let resolveFirstDependencyRead;
  let dependencyReadStarted;
  let firstRead = true;
  const readStarted = new Promise((resolve) => (dependencyReadStarted = resolve));
  storage.getObservation = async (key) => {
    if (key === observationKey && firstRead) {
      firstRead = false;
      dependencyReadStarted();
      return new Promise((resolve) => (resolveFirstDependencyRead = resolve));
    }
    return copy(storage.observations.get(key) ?? null);
  };
  let uploads = 0;
  const queue = new EvidenceUploadQueue({
    storage,
    upload: async () => {
      uploads += 1;
    },
    discardRemote: async () => {},
    now: () => 100,
    isOnline: () => true,
    autoSchedule: false,
  });
  const job = await queue.enqueue({
    sessionId: SESSION_ID,
    observationId: OBSERVATION_A,
    evidenceId: EVIDENCE_ID,
    blob: new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xd9])], {
      type: "image/jpeg",
    }),
  });

  const processing = queue.process();
  await readStarted;
  storage.observations.delete(observationKey);
  const wakeDuringPass = queue.process();
  resolveFirstDependencyRead(copy(dependency));
  await Promise.all([processing, wakeDuringPass]);

  assert.equal(uploads, 1);
  assert.equal(await storage.getEvidence(job.key), null);
});

test("manual evidence retry resets attempts but keeps the original evidence identity and blob", async () => {
  const storage = new MemoryAuditQueueStorage();
  const queue = new EvidenceUploadQueue({
    storage,
    upload: async () => {},
    discardRemote: async () => {},
    now: () => 100,
    isOnline: () => false,
    autoSchedule: false,
  });
  const blob = new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xd9])], { type: "image/jpeg" });
  const job = await queue.enqueue({
    sessionId: SESSION_ID,
    observationId: OBSERVATION_A,
    evidenceId: EVIDENCE_ID,
    blob,
  });
  await storage.mutateEvidence(job.key, (stored) => ({
    ...stored,
    attempts: 5,
    state: "failed",
    error: { code: "x", status: 413, retryable: false, message: "x" },
  }));

  await queue.retry(job.key);
  const retried = await storage.getEvidence(job.key);
  assert.equal(retried.attempts, 0);
  assert.equal(retried.state, "pending");
  assert.equal(retried.evidenceId, EVIDENCE_ID);
  assert.deepEqual(new Uint8Array(await retried.blob.arrayBuffer()), new Uint8Array(await blob.arrayBuffer()));
});

test("discard removes a local evidence job only after the remote two-phase delete succeeds", async () => {
  const storage = new MemoryAuditQueueStorage();
  let shouldFail = true;
  const queue = new EvidenceUploadQueue({
    storage,
    upload: async () => {},
    discardRemote: async () => {
      if (shouldFail) throw requestError(502, "storage_upstream_error", true);
    },
    now: () => 100,
    isOnline: () => true,
    autoSchedule: false,
  });
  const job = await queue.enqueue({
    sessionId: SESSION_ID,
    observationId: OBSERVATION_A,
    evidenceId: EVIDENCE_ID,
    blob: new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xd9])], { type: "image/jpeg" }),
  });

  await assert.rejects(queue.discard(job.key), { code: "storage_upstream_error" });
  assert.ok(await storage.getEvidence(job.key));

  shouldFail = false;
  await queue.discard(job.key);
  assert.equal(await storage.getEvidence(job.key), null);
});

test("discard refuses an in-flight upload instead of racing POST with DELETE", async () => {
  const storage = new MemoryAuditQueueStorage();
  let resolveUpload;
  let uploadStarted;
  let discardCalls = 0;
  const started = new Promise((resolve) => (uploadStarted = resolve));
  const queue = new EvidenceUploadQueue({
    storage,
    upload: async () => {
      uploadStarted();
      await new Promise((resolve) => (resolveUpload = resolve));
    },
    discardRemote: async () => {
      discardCalls += 1;
    },
    now: () => 100,
    isOnline: () => true,
    autoSchedule: false,
  });
  const job = await queue.enqueue({
    sessionId: SESSION_ID,
    observationId: OBSERVATION_A,
    evidenceId: EVIDENCE_ID,
    blob: new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xd9])], {
      type: "image/jpeg",
    }),
  });

  const processing = queue.process();
  await started;
  await assert.rejects(queue.discard(job.key), (error) => {
    assert.equal(error.status, 409);
    assert.equal(error.code, "evidence_upload_in_progress");
    assert.equal(error.retryable, true);
    return true;
  });
  assert.equal(discardCalls, 0);
  assert.equal((await storage.getEvidence(job.key)).state, "sending");

  resolveUpload();
  await processing;
  assert.equal(await storage.getEvidence(job.key), null);
});
