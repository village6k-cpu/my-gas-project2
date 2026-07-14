"use client";

import type { ObservationInput } from "./staff";

export const INVENTORY_AUDIT_DB_NAME = "village-inventory-audit";
export const INVENTORY_AUDIT_DB_VERSION = 1;
export const OBSERVATION_WRITE_STORE = "observationWrites";
export const EVIDENCE_JOB_STORE = "evidenceJobs";

const OBSERVATION_RETRY_DELAYS_MS = [3_000, 8_000, 20_000, 60_000] as const;

export type QueueJobState =
  | "pending"
  | "sending"
  | "retry_wait"
  | "auth_paused"
  | "waiting_observation"
  | "conflict"
  | "failed"
  | "discarding";

export interface InventoryAuditQueueError {
  status: number;
  code: string;
  retryable: boolean;
  message: string;
}

export interface ObservationWriteRecord {
  key: string;
  sessionId: string;
  observationId: string;
  createdAt: number;
  revision: number;
  attempts: number;
  nextAttemptAt: number | null;
  state: QueueJobState;
  error: InventoryAuditQueueError | null;
  body: ObservationInput;
}

export interface EvidenceJobRecord {
  key: string;
  sessionId: string;
  observationId: string;
  evidenceId: string;
  createdAt: number;
  revision: number;
  attempts: number;
  nextAttemptAt: number | null;
  state: QueueJobState;
  error: InventoryAuditQueueError | null;
  blob: Blob;
  sizeBytes: number;
  contentType: "image/jpeg";
}

export interface InventoryAuditQueueStorage {
  getObservation(key: string): Promise<ObservationWriteRecord | null>;
  mutateObservation(
    key: string,
    mutate: (
      current: ObservationWriteRecord | null,
    ) => ObservationWriteRecord | null,
  ): Promise<ObservationWriteRecord | null>;
  listObservations(sessionId?: string): Promise<ObservationWriteRecord[]>;
  getEvidence(key: string): Promise<EvidenceJobRecord | null>;
  mutateEvidence(
    key: string,
    mutate: (current: EvidenceJobRecord | null) => EvidenceJobRecord | null,
  ): Promise<EvidenceJobRecord | null>;
  listEvidence(sessionId?: string): Promise<EvidenceJobRecord[]>;
}

export class InventoryAuditOfflineError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "InventoryAuditOfflineError";
    this.code = code;
  }
}

export class InventoryAuditQueueRequestError extends Error {
  readonly status: number;
  readonly code: string;
  readonly retryable: boolean;

  constructor(input: InventoryAuditQueueError) {
    super(input.message);
    this.name = "InventoryAuditQueueRequestError";
    this.status = input.status;
    this.code = input.code;
    this.retryable = input.retryable;
  }
}

export function observationWriteKey(
  sessionId: string,
  observationId: string,
): string {
  return `obs:${sessionId}:${observationId}`;
}

export function evidenceJobKey(
  sessionId: string,
  observationId: string,
  evidenceId: string,
): string {
  return `evidence:${sessionId}:${observationId}:${evidenceId}`;
}

export function nextMonotonicClientTimestamp(
  previousTimestamp: string | null | undefined,
  nowMs = Date.now(),
): string {
  const previousMs = previousTimestamp ? Date.parse(previousTimestamp) : NaN;
  const nextMs = Number.isFinite(previousMs)
    ? Math.max(Math.trunc(nowMs), previousMs + 1)
    : Math.trunc(nowMs);
  return new Date(nextMs).toISOString();
}

export function shouldPreemptInventoryAuditWake(
  currentWakeAt: number | null,
  nextWakeAt: number,
): boolean {
  return currentWakeAt === null || nextWakeAt < currentWakeAt;
}

function offlineError(
  code: string,
  message: string,
  cause?: unknown,
): InventoryAuditOfflineError {
  return new InventoryAuditOfflineError(code, message, {
    cause: cause instanceof Error ? cause : undefined,
  });
}

function transactionError(
  operation: "read" | "write",
  cause?: unknown,
): InventoryAuditOfflineError {
  return offlineError(
    operation === "read" ? "indexeddb_read_failed" : "indexeddb_write_failed",
    operation === "read"
      ? "오프라인 재고 실사 기록을 읽지 못했습니다."
      : "오프라인 재고 실사 기록을 저장하지 못했습니다.",
    cause,
  );
}

type IndexedDbOptions = { indexedDB?: IDBFactory };

export class IndexedDbAuditQueueStorage implements InventoryAuditQueueStorage {
  private readonly factory: IDBFactory | undefined;

  constructor(options?: IndexedDbOptions) {
    this.factory =
      options && Object.prototype.hasOwnProperty.call(options, "indexedDB")
        ? options.indexedDB
        : typeof indexedDB === "undefined"
          ? undefined
          : indexedDB;
  }

  private open(): Promise<IDBDatabase> {
    const factory = this.factory;
    if (!factory) {
      return Promise.reject(
        offlineError(
          "indexeddb_unavailable",
          "이 브라우저에서는 오프라인 재고 실사 저장소를 사용할 수 없습니다.",
        ),
      );
    }
    return new Promise((resolve, reject) => {
      let settled = false;
      let request: IDBOpenDBRequest;
      try {
        request = factory.open(
          INVENTORY_AUDIT_DB_NAME,
          INVENTORY_AUDIT_DB_VERSION,
        );
      } catch (error) {
        reject(
          offlineError(
            "indexeddb_unavailable",
            "오프라인 재고 실사 저장소를 열지 못했습니다.",
            error,
          ),
        );
        return;
      }
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(OBSERVATION_WRITE_STORE)) {
          const store = db.createObjectStore(OBSERVATION_WRITE_STORE, {
            keyPath: "key",
          });
          store.createIndex("sessionId", "sessionId", { unique: false });
          store.createIndex("createdAt", "createdAt", { unique: false });
        }
        if (!db.objectStoreNames.contains(EVIDENCE_JOB_STORE)) {
          const store = db.createObjectStore(EVIDENCE_JOB_STORE, {
            keyPath: "key",
          });
          store.createIndex("sessionId", "sessionId", { unique: false });
          store.createIndex("createdAt", "createdAt", { unique: false });
        }
      };
      request.onsuccess = () => {
        if (settled) {
          request.result.close();
          return;
        }
        settled = true;
        resolve(request.result);
      };
      request.onerror = () => {
        if (settled) return;
        settled = true;
        reject(
          offlineError(
            "indexeddb_unavailable",
            "오프라인 재고 실사 저장소를 열지 못했습니다.",
            request.error,
          ),
        );
      };
      request.onblocked = () => {
        if (settled) return;
        settled = true;
        reject(
          offlineError(
            "indexeddb_blocked",
            "다른 창에서 재고 실사 저장소를 사용 중입니다. 다른 창을 닫고 다시 시도해 주세요.",
          ),
        );
      };
    });
  }

  private async get<T>(storeName: string, key: string): Promise<T | null> {
    const db = await this.open();
    try {
      return await new Promise<T | null>((resolve, reject) => {
        let request: IDBRequest;
        try {
          request = db.transaction(storeName, "readonly").objectStore(storeName).get(key);
        } catch (error) {
          reject(transactionError("read", error));
          return;
        }
        request.onsuccess = () => resolve((request.result as T | undefined) ?? null);
        request.onerror = () => reject(transactionError("read", request.error));
      });
    } finally {
      db.close();
    }
  }

  private async list<T extends { sessionId: string }>(
    storeName: string,
    sessionId?: string,
  ): Promise<T[]> {
    const db = await this.open();
    try {
      const rows = await new Promise<T[]>((resolve, reject) => {
        let request: IDBRequest;
        try {
          const store = db.transaction(storeName, "readonly").objectStore(storeName);
          request = sessionId
            ? store.index("sessionId").getAll(IDBKeyRange.only(sessionId))
            : store.getAll();
        } catch (error) {
          reject(transactionError("read", error));
          return;
        }
        request.onsuccess = () =>
          resolve(Array.isArray(request.result) ? (request.result as T[]) : []);
        request.onerror = () => reject(transactionError("read", request.error));
      });
      return rows;
    } finally {
      db.close();
    }
  }

  private async mutate<T>(
    storeName: string,
    key: string,
    mutate: (current: T | null) => T | null,
  ): Promise<T | null> {
    const db = await this.open();
    try {
      return await new Promise<T | null>((resolve, reject) => {
        let result: T | null = null;
        let settled = false;
        let transaction: IDBTransaction;
        try {
          transaction = db.transaction(storeName, "readwrite", {
            durability: "strict",
          });
          const store = transaction.objectStore(storeName);
          const read = store.get(key);
          read.onsuccess = () => {
            try {
              result = mutate((read.result as T | undefined) ?? null);
              if (result === null) store.delete(key);
              else store.put(result);
            } catch (error) {
              transaction.abort();
              if (!settled) {
                settled = true;
                reject(error);
              }
            }
          };
          read.onerror = () => transaction.abort();
        } catch (error) {
          reject(transactionError("write", error));
          return;
        }
        transaction.oncomplete = () => {
          if (settled) return;
          settled = true;
          resolve(result);
        };
        transaction.onerror = () => {
          if (settled) return;
          settled = true;
          reject(transactionError("write", transaction.error));
        };
        transaction.onabort = () => {
          if (settled) return;
          settled = true;
          reject(transactionError("write", transaction.error));
        };
      });
    } finally {
      db.close();
    }
  }

  getObservation(key: string) {
    return this.get<ObservationWriteRecord>(OBSERVATION_WRITE_STORE, key);
  }

  mutateObservation(
    key: string,
    mutate: (
      current: ObservationWriteRecord | null,
    ) => ObservationWriteRecord | null,
  ) {
    return this.mutate<ObservationWriteRecord>(
      OBSERVATION_WRITE_STORE,
      key,
      mutate,
    );
  }

  listObservations(sessionId?: string) {
    return this.list<ObservationWriteRecord>(OBSERVATION_WRITE_STORE, sessionId);
  }

  getEvidence(key: string) {
    return this.get<EvidenceJobRecord>(EVIDENCE_JOB_STORE, key);
  }

  mutateEvidence(
    key: string,
    mutate: (current: EvidenceJobRecord | null) => EvidenceJobRecord | null,
  ) {
    return this.mutate<EvidenceJobRecord>(EVIDENCE_JOB_STORE, key, mutate);
  }

  listEvidence(sessionId?: string) {
    return this.list<EvidenceJobRecord>(EVIDENCE_JOB_STORE, sessionId);
  }
}

function normalizeQueueError(error: unknown): InventoryAuditQueueError {
  const candidate =
    error && typeof error === "object"
      ? (error as Partial<InventoryAuditQueueError>)
      : {};
  return {
    status:
      typeof candidate.status === "number" && Number.isInteger(candidate.status)
        ? candidate.status
        : 0,
    code:
      typeof candidate.code === "string" && candidate.code
        ? candidate.code
        : "network_error",
    retryable: candidate.retryable === true || !("retryable" in candidate),
    message:
      error instanceof Error && error.message
        ? error.message
        : "재고 실사 전송 중 오류가 발생했습니다.",
  };
}

function retryDelay(attempts: number): number {
  return OBSERVATION_RETRY_DELAYS_MS[
    Math.min(Math.max(attempts - 1, 0), OBSERVATION_RETRY_DELAYS_MS.length - 1)
  ];
}

export interface ObservationSendResult {
  clientUpdatedAt: string;
}

export interface ObservationWriteQueueOptions {
  storage: InventoryAuditQueueStorage;
  send: (job: ObservationWriteRecord) => Promise<ObservationSendResult>;
  now?: () => number;
  isOnline?: () => boolean;
  autoSchedule?: boolean;
  onChange?: () => unknown;
}

export class ObservationWriteQueue {
  private readonly storage: InventoryAuditQueueStorage;
  private readonly send: ObservationWriteQueueOptions["send"];
  private readonly now: () => number;
  private readonly isOnline: () => boolean;
  private readonly autoSchedule: boolean;
  private readonly onChange: () => unknown;
  private processing: Promise<void> | null = null;
  private wakeTimer: ReturnType<typeof setTimeout> | null = null;
  private wakeAt: number | null = null;
  private scheduleRevision = 0;

  constructor(options: ObservationWriteQueueOptions) {
    this.storage = options.storage;
    this.send = options.send;
    this.now = options.now ?? Date.now;
    this.isOnline =
      options.isOnline ??
      (() => typeof navigator === "undefined" || navigator.onLine !== false);
    this.autoSchedule = options.autoSchedule !== false;
    this.onChange = options.onChange ?? (() => {});
  }

  private changed(): void {
    void this.onChange();
  }

  async enqueue(
    sessionId: string,
    body: ObservationInput,
  ): Promise<ObservationWriteRecord> {
    const key = observationWriteKey(sessionId, body.id);
    const now = this.now();
    const stored = await this.storage.mutateObservation(key, (current) => {
      const previousTimestamp = current?.body.clientUpdatedAt ?? body.clientUpdatedAt;
      return {
        key,
        sessionId,
        observationId: body.id,
        createdAt: current?.createdAt ?? now,
        revision: (current?.revision ?? 0) + 1,
        attempts: 0,
        nextAttemptAt: null,
        state: "pending",
        error: null,
        body: {
          ...body,
          id: body.id,
          clientUpdatedAt: nextMonotonicClientTimestamp(previousTimestamp, now),
          expectedClientUpdatedAt:
            current
              ? current.body.expectedClientUpdatedAt
              : body.expectedClientUpdatedAt,
        },
      };
    });
    if (!stored) throw offlineError("indexeddb_write_failed", "관측 저장에 실패했습니다.");
    this.changed();
    this.schedule();
    return stored;
  }

  async resume(): Promise<ObservationWriteRecord[]> {
    const rows = await this.storage.listObservations();
    for (const row of rows) {
      if (row.state !== "sending") continue;
      await this.storage.mutateObservation(row.key, (current) =>
        current && current.revision === row.revision
          ? { ...current, state: "pending", nextAttemptAt: null }
          : current,
      );
    }
    this.changed();
    this.schedule();
    return this.storage.listObservations();
  }

  async retry(key: string): Promise<ObservationWriteRecord | null> {
    const stored = await this.storage.mutateObservation(key, (current) =>
      current
        ? {
            ...current,
            attempts: 0,
            nextAttemptAt: null,
            state: "pending",
            error: null,
          }
        : null,
    );
    this.changed();
    this.schedule();
    return stored;
  }

  async resumeAuth(): Promise<void> {
    const rows = await this.storage.listObservations();
    for (const row of rows) {
      if (row.state !== "auth_paused") continue;
      await this.storage.mutateObservation(row.key, (current) =>
        current?.state === "auth_paused"
          ? { ...current, state: "pending", error: null }
          : current,
      );
    }
    this.changed();
    this.schedule();
  }

  process(): Promise<void> {
    if (this.processing) return this.processing;
    this.processing = this.processPass().finally(() => {
      this.processing = null;
      this.schedule();
    });
    return this.processing;
  }

  private async processPass(): Promise<void> {
    if (!this.isOnline()) return;
    const now = this.now();
    const rows = (await this.storage.listObservations())
      .filter(
        (row) =>
          (row.state === "pending" || row.state === "retry_wait") &&
          (row.nextAttemptAt === null || row.nextAttemptAt <= now),
      )
      .sort((left, right) => left.createdAt - right.createdAt || left.key.localeCompare(right.key));

    for (const queued of rows) {
      if (!this.isOnline()) break;
      const sent = await this.storage.mutateObservation(queued.key, (current) => {
        if (!current || current.revision !== queued.revision) return current;
        if (current.state !== "pending" && current.state !== "retry_wait") return current;
        return { ...current, state: "sending", nextAttemptAt: null };
      });
      if (!sent || sent.revision !== queued.revision || sent.state !== "sending") continue;
      this.changed();
      try {
        const result = await this.send(sent);
        await this.storage.mutateObservation(sent.key, (current) => {
          if (!current) return null;
          if (current.revision === sent.revision) return null;
          return {
            ...current,
            state: "pending",
            attempts: 0,
            nextAttemptAt: null,
            error: null,
            body: {
              ...current.body,
              expectedClientUpdatedAt: result.clientUpdatedAt,
            },
          };
        });
      } catch (error) {
        const normalized = normalizeQueueError(error);
        await this.storage.mutateObservation(sent.key, (current) => {
          if (!current || current.revision !== sent.revision) return current;
          if (!this.isOnline()) {
            return {
              ...current,
              state: "pending",
              nextAttemptAt: null,
              error: normalized,
            };
          }
          if (normalized.status === 401 || normalized.code === "unauthorized") {
            return { ...current, state: "auth_paused", error: normalized };
          }
          const attempts = current.attempts + 1;
          if (normalized.status === 409) {
            return {
              ...current,
              attempts,
              nextAttemptAt: null,
              state: "conflict",
              error: normalized,
            };
          }
          if (!normalized.retryable) {
            return {
              ...current,
              attempts,
              nextAttemptAt: null,
              state: "failed",
              error: normalized,
            };
          }
          return {
            ...current,
            attempts,
            nextAttemptAt: this.now() + retryDelay(attempts),
            state: "retry_wait",
            error: normalized,
          };
        });
      }
      this.changed();
    }
  }

  private schedule(): void {
    const revision = ++this.scheduleRevision;
    if (!this.autoSchedule || this.processing) return;
    if (!this.isOnline()) {
      this.clearWake();
      return;
    }
    void this.storage
      .listObservations()
      .then((rows) => {
        if (revision !== this.scheduleRevision || this.processing) return;
        const eligible = rows.filter(
          (row) => row.state === "pending" || row.state === "retry_wait",
        );
        if (!eligible.length) {
          this.clearWake();
          return;
        }
        const dueAt = Math.min(
          ...eligible.map((row) => row.nextAttemptAt ?? this.now()),
        );
        if (!shouldPreemptInventoryAuditWake(this.wakeAt, dueAt)) return;
        this.clearWake();
        const delay = Math.max(0, dueAt - this.now());
        this.wakeAt = dueAt;
        this.wakeTimer = setTimeout(() => {
          this.wakeTimer = null;
          this.wakeAt = null;
          void this.process();
        }, delay);
      })
      .catch(() => this.changed());
  }

  private clearWake(): void {
    if (this.wakeTimer !== null) clearTimeout(this.wakeTimer);
    this.wakeTimer = null;
    this.wakeAt = null;
  }
}

export async function readInventoryAuditPendingCounts(
  storage: InventoryAuditQueueStorage,
  sessionId: string,
): Promise<{
  pendingObservationWrites: number;
  pendingEvidenceUploads: number;
}> {
  const [observations, evidence] = await Promise.all([
    storage.listObservations(sessionId),
    storage.listEvidence(sessionId),
  ]);
  return {
    pendingObservationWrites: observations.length,
    pendingEvidenceUploads: evidence.length,
  };
}

export interface InventoryAuditQueueSessionSnapshot {
  pendingObservationWrites: number;
  pendingEvidenceUploads: number;
  observationStates: Record<string, number>;
  evidenceStates: Record<string, number>;
}

export interface InventoryAuditQueueSnapshot {
  ready: boolean;
  revision: number;
  error: { code: string; message: string } | null;
  sessions: Record<string, InventoryAuditQueueSessionSnapshot>;
}

let queueSnapshot: InventoryAuditQueueSnapshot = {
  ready: false,
  revision: 0,
  error: null,
  sessions: {},
};
const queueListeners = new Set<() => void>();
const observationChangeListeners = new Set<() => void>();
let snapshotRefreshSequence = 0;

export function subscribeInventoryAuditQueue(listener: () => void): () => void {
  queueListeners.add(listener);
  return () => queueListeners.delete(listener);
}

export function subscribeInventoryAuditObservationChanges(
  listener: () => void,
): () => void {
  observationChangeListeners.add(listener);
  return () => observationChangeListeners.delete(listener);
}

export function getInventoryAuditQueueSnapshot(): InventoryAuditQueueSnapshot {
  return queueSnapshot;
}

function countStates(rows: Array<{ state: QueueJobState }>): Record<string, number> {
  const states: Record<string, number> = {};
  for (const row of rows) states[row.state] = (states[row.state] ?? 0) + 1;
  return states;
}

export async function refreshInventoryAuditQueueSnapshot(
  storage: InventoryAuditQueueStorage = getInventoryAuditQueueStorage(),
): Promise<InventoryAuditQueueSnapshot> {
  const refreshSequence = ++snapshotRefreshSequence;
  let nextSnapshot: InventoryAuditQueueSnapshot;
  try {
    const [observations, evidence] = await Promise.all([
      storage.listObservations(),
      storage.listEvidence(),
    ]);
    const sessionIds = new Set([
      ...observations.map((row) => row.sessionId),
      ...evidence.map((row) => row.sessionId),
    ]);
    const sessions: Record<string, InventoryAuditQueueSessionSnapshot> = {};
    for (const sessionId of sessionIds) {
      const observationRows = observations.filter((row) => row.sessionId === sessionId);
      const evidenceRows = evidence.filter((row) => row.sessionId === sessionId);
      sessions[sessionId] = {
        pendingObservationWrites: observationRows.length,
        pendingEvidenceUploads: evidenceRows.length,
        observationStates: countStates(observationRows),
        evidenceStates: countStates(evidenceRows),
      };
    }
    nextSnapshot = {
      ready: true,
      revision: queueSnapshot.revision + 1,
      error: null,
      sessions,
    };
  } catch (error) {
    const normalized = normalizeQueueError(error);
    nextSnapshot = {
      ...queueSnapshot,
      ready: true,
      revision: queueSnapshot.revision + 1,
      error: { code: normalized.code, message: normalized.message },
    };
  }
  if (refreshSequence !== snapshotRefreshSequence) return queueSnapshot;
  queueSnapshot = nextSnapshot;
  queueListeners.forEach((listener) => listener());
  return queueSnapshot;
}

let singletonStorage: IndexedDbAuditQueueStorage | null = null;
let singletonObservationQueue: ObservationWriteQueue | null = null;

export function isRetryableInventoryAuditResponse(
  status: number,
  explicit: unknown,
): boolean {
  return typeof explicit === "boolean" ? explicit : status >= 500;
}

export function getInventoryAuditQueueStorage(): IndexedDbAuditQueueStorage {
  singletonStorage ??= new IndexedDbAuditQueueStorage();
  return singletonStorage;
}

async function readResponseError(response: Response): Promise<InventoryAuditQueueRequestError> {
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    // Stable fallbacks below intentionally do not depend on response text.
  }
  const record = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  return new InventoryAuditQueueRequestError({
    status: response.status,
    code: typeof record.code === "string" ? record.code : "request_failed",
    retryable: isRetryableInventoryAuditResponse(
      response.status,
      record.retryable,
    ),
    message:
      typeof record.error === "string"
        ? record.error
        : "재고 실사 내용을 전송하지 못했습니다.",
  });
}

async function sendObservationRequest(
  job: ObservationWriteRecord,
): Promise<ObservationSendResult> {
  let response: Response;
  try {
    const { authFetch } = await import("@/lib/data/authFetch");
    response = await authFetch(
      `/api/inventory-audits/${encodeURIComponent(job.sessionId)}/observations`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify(job.body),
      },
    );
  } catch (error) {
    throw new InventoryAuditQueueRequestError({
      status: 0,
      code: "network_error",
      retryable: true,
      message: error instanceof Error ? error.message : "네트워크 연결을 확인해 주세요.",
    });
  }
  if (!response.ok) throw await readResponseError(response);
  const data = (await response.json()) as {
    observation?: { clientUpdatedAt?: unknown };
  };
  const clientUpdatedAt = data.observation?.clientUpdatedAt;
  if (typeof clientUpdatedAt !== "string") {
    throw new InventoryAuditQueueRequestError({
      status: 502,
      code: "invalid_upstream_response",
      retryable: true,
      message: "관측 저장 응답이 올바르지 않습니다.",
    });
  }
  return { clientUpdatedAt };
}

function getObservationQueue(): ObservationWriteQueue {
  singletonObservationQueue ??= new ObservationWriteQueue({
    storage: getInventoryAuditQueueStorage(),
    send: sendObservationRequest,
    onChange: () => {
      void refreshInventoryAuditQueueSnapshot();
      observationChangeListeners.forEach((listener) => listener());
    },
  });
  return singletonObservationQueue;
}

export function enqueueInventoryAuditObservation(
  sessionId: string,
  body: ObservationInput,
) {
  return getObservationQueue().enqueue(sessionId, body);
}

export function retryInventoryAuditObservation(key: string) {
  return getObservationQueue().retry(key);
}

export function resumeInventoryAuditObservationWrites() {
  return getObservationQueue().resume();
}

export function resumeInventoryAuditAuth() {
  return getObservationQueue().resumeAuth();
}

export function processInventoryAuditObservationWrites() {
  return getObservationQueue().process();
}

export function rereadInventoryAuditPendingCounts(sessionId: string) {
  return readInventoryAuditPendingCounts(getInventoryAuditQueueStorage(), sessionId);
}

if (typeof window !== "undefined") {
  window.addEventListener("online", () => {
    void processInventoryAuditObservationWrites();
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      void resumeInventoryAuditAuth();
    }
  });
}
