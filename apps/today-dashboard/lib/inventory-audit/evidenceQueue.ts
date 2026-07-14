"use client";

import {
  InventoryAuditOfflineError,
  InventoryAuditQueueRequestError,
  type EvidenceJobRecord,
  type InventoryAuditQueueError,
  type InventoryAuditQueueStorage,
  evidenceJobKey,
  getInventoryAuditQueueStorage,
  observationWriteKey,
  refreshInventoryAuditQueueSnapshot,
  shouldPreemptInventoryAuditWake,
  subscribeInventoryAuditObservationChanges,
} from "#inventory-audit-offline";

export const EVIDENCE_RETRY_DELAYS_MS = [3_000, 8_000, 20_000, 60_000] as const;
export const MAX_EVIDENCE_ATTEMPTS = 5;
export const MAX_EVIDENCE_SIZE_BYTES = 3_500_000;

export interface EvidenceEnqueueInput {
  sessionId: string;
  observationId: string;
  evidenceId: string;
  blob: Blob;
}

export interface EvidenceUploadQueueOptions {
  storage: InventoryAuditQueueStorage;
  upload: (job: EvidenceJobRecord) => Promise<unknown>;
  discardRemote: (job: EvidenceJobRecord) => Promise<unknown>;
  now?: () => number;
  isOnline?: () => boolean;
  autoSchedule?: boolean;
  onChange?: () => unknown;
}

export function shouldAutoScheduleEvidenceJob(
  job: Pick<EvidenceJobRecord, "state" | "attempts" | "nextAttemptAt">,
): boolean {
  if (job.state === "discarding") return false;
  if (job.state === "pending") return job.attempts < MAX_EVIDENCE_ATTEMPTS;
  return (
    job.state === "retry_wait" && job.attempts < MAX_EVIDENCE_ATTEMPTS
  );
}

function queueError(error: unknown): InventoryAuditQueueError {
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
        : "재고 실사 사진 전송 중 오류가 발생했습니다.",
  };
}

function evidenceDelay(attempts: number): number {
  return EVIDENCE_RETRY_DELAYS_MS[
    Math.min(Math.max(attempts - 1, 0), EVIDENCE_RETRY_DELAYS_MS.length - 1)
  ];
}

function validateBlob(blob: Blob): void {
  if (!(blob instanceof Blob)) {
    throw new InventoryAuditOfflineError(
      "invalid_evidence_file",
      "재고 실사 사진 파일이 필요합니다.",
    );
  }
  if (blob.type !== "image/jpeg") {
    throw new InventoryAuditOfflineError(
      "invalid_evidence_type",
      "재고 실사 사진은 JPEG 형식이어야 합니다.",
    );
  }
  if (blob.size <= 0 || blob.size > MAX_EVIDENCE_SIZE_BYTES) {
    throw new InventoryAuditOfflineError(
      "invalid_evidence_size",
      "재고 실사 사진 크기가 올바르지 않습니다.",
    );
  }
}

export class EvidenceUploadQueue {
  private readonly storage: InventoryAuditQueueStorage;
  private readonly upload: EvidenceUploadQueueOptions["upload"];
  private readonly discardRemote: EvidenceUploadQueueOptions["discardRemote"];
  private readonly now: () => number;
  private readonly isOnline: () => boolean;
  private readonly autoSchedule: boolean;
  private readonly onChange: () => unknown;
  private processing: Promise<void> | null = null;
  private rerunRequested = false;
  private wakeTimer: ReturnType<typeof setTimeout> | null = null;
  private wakeAt: number | null = null;
  private scheduleRevision = 0;

  constructor(options: EvidenceUploadQueueOptions) {
    this.storage = options.storage;
    this.upload = options.upload;
    this.discardRemote = options.discardRemote;
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

  async enqueue(input: EvidenceEnqueueInput): Promise<EvidenceJobRecord> {
    validateBlob(input.blob);
    const key = evidenceJobKey(
      input.sessionId,
      input.observationId,
      input.evidenceId,
    );
    const createdAt = this.now();
    const stored = await this.storage.mutateEvidence(key, (current) => {
      if (current) {
        if (
          current.sessionId !== input.sessionId ||
          current.observationId !== input.observationId ||
          current.evidenceId !== input.evidenceId ||
          current.sizeBytes !== input.blob.size ||
          current.contentType !== "image/jpeg"
        ) {
          throw new InventoryAuditOfflineError(
            "evidence_id_conflict",
            "같은 사진 ID에 다른 파일을 저장할 수 없습니다.",
          );
        }
        return current;
      }
      return {
        key,
        sessionId: input.sessionId,
        observationId: input.observationId,
        evidenceId: input.evidenceId,
        createdAt,
        revision: 1,
        attempts: 0,
        nextAttemptAt: null,
        state: "pending",
        error: null,
        blob: input.blob,
        sizeBytes: input.blob.size,
        contentType: "image/jpeg",
      };
    });
    if (!stored) {
      throw new InventoryAuditOfflineError(
        "indexeddb_write_failed",
        "재고 실사 사진을 저장하지 못했습니다.",
      );
    }
    this.changed();
    this.schedule();
    return stored;
  }

  async resume(): Promise<EvidenceJobRecord[]> {
    const rows = await this.storage.listEvidence();
    for (const row of rows) {
      if (row.state === "sending") {
        await this.storage.mutateEvidence(row.key, (current) =>
          current && current.revision === row.revision
            ? { ...current, state: "pending", nextAttemptAt: null }
            : current,
        );
      } else if (row.state === "waiting_observation") {
        const dependency = await this.storage.getObservation(
          observationWriteKey(row.sessionId, row.observationId),
        );
        if (!dependency) {
          await this.storage.mutateEvidence(row.key, (current) =>
            current && current.revision === row.revision
              ? { ...current, state: "pending", nextAttemptAt: null }
              : current,
          );
        }
      }
    }
    this.changed();
    if (rows.some((row) => row.state === "discarding")) {
      await this.process();
    } else {
      this.schedule();
    }
    return this.storage.listEvidence();
  }

  async retry(key: string): Promise<EvidenceJobRecord | null> {
    const stored = await this.storage.mutateEvidence(key, (current) =>
      current
        ? {
            ...current,
            revision: current.revision + 1,
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
    const rows = await this.storage.listEvidence();
    for (const row of rows) {
      if (row.state !== "auth_paused") continue;
      await this.storage.mutateEvidence(row.key, (current) =>
        current?.state === "auth_paused"
          ? {
              ...current,
              revision: current.revision + 1,
              state: "pending",
              error: null,
              nextAttemptAt: null,
            }
          : current,
      );
    }
    this.changed();
    this.schedule();
  }

  async discard(key: string): Promise<void> {
    if (!this.isOnline()) {
      throw new InventoryAuditQueueRequestError({
        status: 0,
        code: "offline",
        retryable: true,
        message: "온라인 상태에서 사진 삭제를 다시 시도해 주세요.",
      });
    }
    const job = await this.storage.mutateEvidence(key, (current) => {
      if (current?.state === "sending") {
        throw new InventoryAuditQueueRequestError({
          status: 409,
          code: "evidence_upload_in_progress",
          retryable: true,
          message: "사진 전송이 끝난 뒤 삭제를 다시 시도해 주세요.",
        });
      }
      return current
        ? {
            ...current,
            revision: current.revision + 1,
            state: "discarding",
            nextAttemptAt: null,
            error: null,
          }
        : null;
    });
    if (!job) return;
    this.changed();
    try {
      await this.discardRemote(job);
      await this.storage.mutateEvidence(key, (current) =>
        current?.revision === job.revision ? null : current,
      );
      this.changed();
    } catch (error) {
      const normalized = queueError(error);
      await this.storage.mutateEvidence(key, (current) =>
        current?.revision === job.revision
          ? { ...current, state: "discarding", error: normalized }
          : current,
      );
      this.changed();
      throw error;
    }
  }

  process(): Promise<void> {
    if (this.processing) {
      this.rerunRequested = true;
      return this.processing;
    }
    this.processing = this.processUntilSettled().finally(() => {
      this.processing = null;
      this.schedule();
    });
    return this.processing;
  }

  private async processUntilSettled(): Promise<void> {
    do {
      this.rerunRequested = false;
      await this.processPass();
    } while (this.rerunRequested);
  }

  private async processPass(): Promise<void> {
    if (!this.isOnline()) return;
    const now = this.now();
    const rows = (await this.storage.listEvidence())
      .filter(
        (row) =>
          row.state === "discarding" ||
          ((row.state === "pending" ||
            row.state === "retry_wait" ||
            row.state === "waiting_observation") &&
            row.attempts < MAX_EVIDENCE_ATTEMPTS &&
            (row.nextAttemptAt === null || row.nextAttemptAt <= now)),
      )
      .sort((left, right) => left.createdAt - right.createdAt || left.key.localeCompare(right.key));

    for (const queued of rows) {
      if (!this.isOnline()) break;
      if (queued.state === "discarding") {
        await this.processDiscard(queued);
        continue;
      }
      const dependency = await this.storage.getObservation(
        observationWriteKey(queued.sessionId, queued.observationId),
      );
      if (dependency) {
        await this.storage.mutateEvidence(queued.key, (current) =>
          current?.revision === queued.revision
            ? {
                ...current,
                state: "waiting_observation",
                nextAttemptAt: null,
              }
            : current,
        );
        this.changed();
        continue;
      }
      const sent = await this.storage.mutateEvidence(queued.key, (current) => {
        if (!current || current.revision !== queued.revision) return current;
        if (
          current.state !== "pending" &&
          current.state !== "retry_wait" &&
          current.state !== "waiting_observation"
        ) {
          return current;
        }
        return { ...current, state: "sending", nextAttemptAt: null };
      });
      if (!sent || sent.revision !== queued.revision || sent.state !== "sending") continue;
      this.changed();
      try {
        await this.upload(sent);
        await this.storage.mutateEvidence(sent.key, (current) =>
          current?.revision === sent.revision ? null : current,
        );
      } catch (error) {
        const normalized = queueError(error);
        const dependencyAfterFailure =
          normalized.status === 404
            ? await this.storage.getObservation(
                observationWriteKey(sent.sessionId, sent.observationId),
              )
            : null;
        await this.storage.mutateEvidence(sent.key, (current) => {
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
          if (dependencyAfterFailure) {
            return {
              ...current,
              state: "waiting_observation",
              nextAttemptAt: null,
              error: normalized,
            };
          }
          const attempts = current.attempts + 1;
          if (!normalized.retryable || attempts >= MAX_EVIDENCE_ATTEMPTS) {
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
            nextAttemptAt: this.now() + evidenceDelay(attempts),
            state: "retry_wait",
            error: normalized,
          };
        });
      }
      this.changed();
    }
  }

  private async processDiscard(job: EvidenceJobRecord): Promise<void> {
    try {
      await this.discardRemote(job);
      await this.storage.mutateEvidence(job.key, (current) =>
        current?.revision === job.revision ? null : current,
      );
    } catch (error) {
      const normalized = queueError(error);
      await this.storage.mutateEvidence(job.key, (current) =>
        current?.revision === job.revision
          ? { ...current, state: "discarding", error: normalized }
          : current,
      );
    }
    this.changed();
  }

  private schedule(): void {
    const revision = ++this.scheduleRevision;
    if (!this.autoSchedule || this.processing) return;
    if (!this.isOnline()) {
      this.clearWake();
      return;
    }
    void this.storage
      .listEvidence()
      .then((rows) => {
        if (revision !== this.scheduleRevision || this.processing) return;
        const eligible = rows.filter(shouldAutoScheduleEvidenceJob);
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

export function isRetryableInventoryAuditEvidenceResponse(
  status: number,
  explicit: unknown,
): boolean {
  return typeof explicit === "boolean" ? explicit : status >= 500;
}

async function responseError(response: Response): Promise<InventoryAuditQueueRequestError> {
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    // Do not infer behavior from localized response text.
  }
  const record = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  return new InventoryAuditQueueRequestError({
    status: response.status,
    code: typeof record.code === "string" ? record.code : "request_failed",
    retryable: isRetryableInventoryAuditEvidenceResponse(
      response.status,
      record.retryable,
    ),
    message:
      typeof record.error === "string"
        ? record.error
        : "재고 실사 사진 요청에 실패했습니다.",
  });
}

async function uploadEvidenceRequest(job: EvidenceJobRecord): Promise<void> {
  const form = new FormData();
  form.set("observationId", job.observationId);
  form.set("evidenceId", job.evidenceId);
  form.set("file", job.blob, `${job.evidenceId}.jpg`);
  let response: Response;
  try {
    const { authFetch } = await import("@/lib/data/authFetch");
    response = await authFetch(
      `/api/inventory-audits/${encodeURIComponent(job.sessionId)}/evidence`,
      { method: "POST", credentials: "same-origin", body: form },
    );
  } catch (error) {
    throw new InventoryAuditQueueRequestError({
      status: 0,
      code: "network_error",
      retryable: true,
      message: error instanceof Error ? error.message : "네트워크 연결을 확인해 주세요.",
    });
  }
  if (!response.ok) throw await responseError(response);
}

async function discardEvidenceRequest(job: EvidenceJobRecord): Promise<void> {
  let response: Response;
  try {
    const { authFetch } = await import("@/lib/data/authFetch");
    response = await authFetch(
      `/api/inventory-audits/${encodeURIComponent(job.sessionId)}/evidence`,
      {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({
          observationId: job.observationId,
          evidenceId: job.evidenceId,
        }),
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
  if (!response.ok) throw await responseError(response);
}

let singletonEvidenceQueue: EvidenceUploadQueue | null = null;
let dependencySubscription: (() => void) | null = null;

function getEvidenceQueue(): EvidenceUploadQueue {
  if (!singletonEvidenceQueue) {
    singletonEvidenceQueue = new EvidenceUploadQueue({
      storage: getInventoryAuditQueueStorage(),
      upload: uploadEvidenceRequest,
      discardRemote: discardEvidenceRequest,
      onChange: () => refreshInventoryAuditQueueSnapshot(),
    });
    dependencySubscription = subscribeInventoryAuditObservationChanges(() => {
      void singletonEvidenceQueue?.process();
    });
    void dependencySubscription;
  }
  return singletonEvidenceQueue;
}

export function enqueueInventoryAuditEvidence(input: EvidenceEnqueueInput) {
  return getEvidenceQueue().enqueue(input);
}

export function retryInventoryAuditEvidence(key: string) {
  return getEvidenceQueue().retry(key);
}

export function discardInventoryAuditEvidence(key: string) {
  return getEvidenceQueue().discard(key);
}

export function resumeInventoryAuditEvidenceJobs() {
  return getEvidenceQueue().resume();
}

export function resumeInventoryAuditEvidenceAuth() {
  return getEvidenceQueue().resumeAuth();
}

export function processInventoryAuditEvidenceJobs() {
  return getEvidenceQueue().process();
}

if (typeof window !== "undefined") {
  window.addEventListener("online", () => {
    void processInventoryAuditEvidenceJobs();
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      void resumeInventoryAuditEvidenceAuth();
    }
  });
}
