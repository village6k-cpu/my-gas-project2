"use client";

// 반출/반납 사진 백그라운드 업로드 큐.
// 촬영 즉시 화면에 타일을 띄우고 실제 GAS 업로드는 뒤에서 처리한다(앱시트 체감 속도).
// IndexedDB에 작업을 보존해 새로고침·앱 종료 후에도 이어서 올리고, 실패는 백오프로 재시도한다.
// 서버(GAS)는 clientKey로 중복 업로드를 걸러내므로 재시도가 사진을 두 번 만들지 않는다.

export interface PhotoUploadJob {
  queueId: string;
  tradeId: string;
  phase: "checkout" | "checkin";
  fileName: string;
  mimeType: string;
  /** 압축된 JPEG data URL */
  data: string;
  createdAt: number;
  attempts: number;
  lastError?: string;
  /** 서버가 영구 거절한 잡 — 온라인 복귀/재시작 자동 부활 대상에서 제외 */
  permanent?: boolean;
}

/** 오프라인/네트워크 원인 실패 판별 — 이런 잡은 온라인 복귀 시 자동 부활한다 */
const NETWORK_ERROR_RE = /network|fetch|timeout|timed out|호출 실패|응답 확인 실패|유효한 JSON/i;

export interface PhotoUploadHandlers {
  send: (job: PhotoUploadJob) => Promise<unknown>;
  onSuccess: (job: PhotoUploadJob, response: unknown) => void;
  onFailure: (job: PhotoUploadJob, message: string, willRetry: boolean) => void;
}

const DB_NAME = "village-photo-uploads";
const DB_STORE = "jobs";
const MAX_ATTEMPTS = 5;
const RETRY_DELAYS_MS = [3_000, 8_000, 20_000, 60_000];
const TRANSIENT_RETRY_MS = 60_000;

let handlers: PhotoUploadHandlers | null = null;
const jobs = new Map<string, PhotoUploadJob>();
const nextAttemptAt = new Map<string, number>();
const directSendJobs = new Set<string>();
const durableJobs = new Set<string>();

// 큐 변화(추가/성공/실패/재시도/폐기/부활)를 UI 배지에 알린다 — 거래가 화면 윈도우
// 밖으로 나가도 실패 잡이 보이도록 전역 요약을 구독할 수 있게 한다.
const queueChangeListeners = new Set<() => void>();
function notifyQueueChange(): void {
  queueChangeListeners.forEach((listener) => {
    try { listener(); } catch { /* listener 오류가 큐를 멈추면 안 된다 */ }
  });
}
export function onPhotoQueueChange(listener: () => void): () => void {
  queueChangeListeners.add(listener);
  return () => queueChangeListeners.delete(listener);
}
export function listPhotoUploadJobs(): PhotoUploadJob[] {
  return Array.from(jobs.values()).sort((a, b) => a.createdAt - b.createdAt);
}
export function isPhotoUploadJobFailed(job: PhotoUploadJob): boolean {
  return job.permanent === true || job.attempts >= MAX_ATTEMPTS;
}
export function snapshotPhotoQueueSummary(): { uploading: number; failed: number } {
  let uploading = 0;
  let failed = 0;
  for (const job of jobs.values()) {
    if (isPhotoUploadJobFailed(job)) failed += 1;
    else uploading += 1;
  }
  return { uploading, failed };
}
let processing = false;
let wakeTimer: ReturnType<typeof setTimeout> | null = null;
/** 현재 예약된 wake 타이머의 발화 시각 — 더 이른 재시도가 들어오면 선점(clearTimeout) 판단용 */
let wakeAt: number | null = null;

function openDb(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    if (typeof indexedDB === "undefined") return resolve(null);
    try {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(DB_STORE)) {
          req.result.createObjectStore(DB_STORE, { keyPath: "queueId" });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

async function idbWrite(job: PhotoUploadJob): Promise<boolean> {
  const db = await openDb();
  if (!db) return false;
  const written = await new Promise<boolean>((resolve) => {
    try {
      const tx = db.transaction(DB_STORE, "readwrite");
      tx.objectStore(DB_STORE).put(job);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => resolve(false);
      tx.onabort = () => resolve(false);
    } catch {
      resolve(false);
    }
  });
  db.close();
  return written;
}

async function idbDelete(queueId: string): Promise<boolean> {
  const db = await openDb();
  if (!db) return false;
  const deleted = await new Promise<boolean>((resolve) => {
    try {
      const tx = db.transaction(DB_STORE, "readwrite");
      tx.objectStore(DB_STORE).delete(queueId);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => resolve(false);
      tx.onabort = () => resolve(false);
    } catch {
      resolve(false);
    }
  });
  db.close();
  return deleted;
}

async function idbReadAll(): Promise<PhotoUploadJob[]> {
  const db = await openDb();
  if (!db) return [];
  const rows = await new Promise<PhotoUploadJob[]>((resolve) => {
    try {
      const tx = db.transaction(DB_STORE, "readonly");
      const req = tx.objectStore(DB_STORE).getAll();
      req.onsuccess = () => resolve(Array.isArray(req.result) ? (req.result as PhotoUploadJob[]) : []);
      req.onerror = () => resolve([]);
    } catch {
      resolve([]);
    }
  });
  db.close();
  return rows;
}

function readyJobs(now: number): PhotoUploadJob[] {
  return Array.from(jobs.values())
    .filter((job) => !directSendJobs.has(job.queueId) && job.attempts < MAX_ATTEMPTS && (nextAttemptAt.get(job.queueId) ?? 0) <= now)
    .sort((a, b) => a.createdAt - b.createdAt);
}

function scheduleWake(): void {
  const pending = Array.from(jobs.values()).filter((job) => !directSendJobs.has(job.queueId) && job.attempts < MAX_ATTEMPTS);
  if (!pending.length) return;
  const soonest = Math.min(...pending.map((job) => nextAttemptAt.get(job.queueId) ?? 0));
  // 오프라인이면 processQueue가 즉시 break하므로 250ms 타이머는 4Hz 공회전이 된다.
  // online 이벤트가 복귀 즉시 재개하므로 폴백 wake는 60초면 충분하다.
  const offline = typeof navigator !== "undefined" && navigator.onLine === false;
  const delay = Math.max(offline ? 60_000 : 250, soonest - Date.now());
  const at = Date.now() + delay;
  // 더 이른 재시도가 필요한 잡이 생기면 기존 타이머를 선점하고 짧은 지연으로 재예약한다.
  // (예전엔 기존 타이머가 있으면 무조건 반환 → 새 실패 잡의 재시도가 최대 60초까지 밀렸다)
  if (wakeTimer) {
    if (wakeAt !== null && wakeAt <= at) return;
    clearTimeout(wakeTimer);
  }
  wakeAt = at;
  wakeTimer = setTimeout(() => {
    wakeTimer = null;
    wakeAt = null;
    void processQueue();
  }, delay);
}

async function processQueue(): Promise<void> {
  if (processing || !handlers) return;
  processing = true;
  try {
    for (;;) {
      // 오프라인이면 시도 자체를 하지 않는다. 즉시 실패로 attempts를 태우면 약 91초 만에
      // 잡이 소진되어(3+8+20+60초) 온라인 복귀 후에도 자동 재개되지 않았다.
      if (typeof navigator !== "undefined" && navigator.onLine === false) break;
      const ready = readyJobs(Date.now());
      if (!ready.length) break;
      const job = ready[0];
      try {
        const response = await handlers.send(job);
        // 성공 UI 반영까지 끝나기 전에 원본을 지우면 handler 예외 한 번으로 사진이 유실된다.
        handlers.onSuccess(job, response);
        const deleted = await idbDelete(job.queueId);
        jobs.delete(job.queueId);
        nextAttemptAt.delete(job.queueId);
        if (deleted) durableJobs.delete(job.queueId);
        if (deleted === false) {
          // 서버 clientKey 멱등성으로 다음 앱 시작의 잔존 잡 재생은 안전하다.
          console.error("[photo-queue] 서버 저장 후 IndexedDB 작업 삭제 실패:", job.queueId);
        }
        notifyQueueChange();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const detail = error as { permanent?: boolean; retryable?: boolean; outcomeUnknown?: boolean } | null;
        const permanent = Boolean(detail?.permanent);
        const transient = !permanent && (
          detail?.retryable === true ||
          detail?.outcomeUnknown === true ||
          NETWORK_ERROR_RE.test(message)
        );
        const offlineNow = typeof navigator !== "undefined" && navigator.onLine === false;
        if ((offlineNow && !permanent) || transient) {
          // BUSY·응답유실·네트워크 순단은 서버의 7분 durable claim보다 먼저
          // 시도 횟수를 소모하지 않는다. 같은 clientKey와 원본을 보존한 채 다시 확인한다.
          job.lastError = message;
          nextAttemptAt.set(job.queueId, Date.now() + TRANSIENT_RETRY_MS);
          await idbWrite(job);
          handlers.onFailure(job, message, true);
          notifyQueueChange();
          continue;
        }
        if (permanent) job.permanent = true;
        job.attempts = permanent ? MAX_ATTEMPTS : job.attempts + 1;
        job.lastError = message;
        const willRetry = job.attempts < MAX_ATTEMPTS;
        if (willRetry) {
          const delay = RETRY_DELAYS_MS[Math.min(job.attempts - 1, RETRY_DELAYS_MS.length - 1)];
          nextAttemptAt.set(job.queueId, Date.now() + delay);
          await idbWrite(job);
        } else {
          // 자동 재시도만 멈춘다. 촬영 증빙 원본은 작업자가 성공/폐기를 선택할 때까지
          // IndexedDB에 보존해 앱 종료·새로고침 뒤에도 실패 타일과 수동 재시도를 복원한다.
          await idbWrite(job);
        }
        handlers.onFailure(job, message, willRetry);
        notifyQueueChange();
      }
    }
  } finally {
    processing = false;
    scheduleWake();
  }
}

/** 스토어가 전송/성공/실패 핸들러를 연결한다. 연결 즉시 대기 작업 처리 시작. */
export function configurePhotoUploadQueue(next: PhotoUploadHandlers): void {
  handlers = next;
  void processQueue();
}

async function sendPhotoWithoutDurableStorage_(job: PhotoUploadJob): Promise<void> {
  const activeHandlers = handlers;
  if (!activeHandlers) {
    jobs.delete(job.queueId);
    directSendJobs.delete(job.queueId);
    throw new Error("사진 임시 저장소를 열 수 없어 업로드를 시작하지 못했습니다");
  }
  try {
    const response = await activeHandlers.send(job);
    activeHandlers.onSuccess(job, response);
    jobs.delete(job.queueId);
    nextAttemptAt.delete(job.queueId);
    directSendJobs.delete(job.queueId);
    notifyQueueChange();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    job.attempts = MAX_ATTEMPTS;
    job.lastError = `기기 임시 보관 실패 · 서버 저장 미확인: ${detail}`;
    activeHandlers.onFailure(job, job.lastError, false);
    notifyQueueChange();
    throw new Error("기기에 사진을 임시 보관할 수 없고 서버 저장도 확인하지 못했습니다. 실패 타일에서 다시 시도해 주세요.");
  }
}

export async function enqueuePhotoUpload(job: PhotoUploadJob): Promise<"queued" | "completed"> {
  const persisted = await idbWrite(job);
  jobs.set(job.queueId, job);
  notifyQueueChange();
  if (!persisted) {
    // Safari private mode·저장공간 부족처럼 IndexedDB가 막힌 경우에는 앱 종료 후
    // 사라지는 백그라운드 잡으로 속이지 않고, 이 호출에서 서버 확정까지 직접 기다린다.
    directSendJobs.add(job.queueId);
    await sendPhotoWithoutDurableStorage_(job);
    return "completed";
  }
  durableJobs.add(job.queueId);
  // 호출자가 내구 보존 확인 후 로컬 타일을 먼저 그릴 수 있게
  // 네트워크 전송은 다음 타이머 턴에서 시작한다.
  setTimeout(() => { void processQueue(); }, 0);
  return "queued";
}

/** 앱 재시작 시 IndexedDB에 남은 작업을 복원해 마저 올린다. */
export async function resumePhotoUploads(): Promise<PhotoUploadJob[]> {
  const stored = await idbReadAll();
  for (const job of stored) {
    if (jobs.has(job.queueId)) continue;
    // 네트워크 원인으로 소진된 잡은 재시작 시 1회 자동 부활한다 (서버 clientKey 멱등이라
    // 재전송이 사진을 두 번 만들지 않는다). 서버가 영구 거절한 잡(permanent)과
    // 원인 불명 잡은 수동 재시도용으로 그대로 복원한다.
    if (!job.permanent && job.attempts >= MAX_ATTEMPTS && NETWORK_ERROR_RE.test(String(job.lastError || ""))) {
      job.attempts = 0;
      job.lastError = undefined;
      void idbWrite(job);
    }
    jobs.set(job.queueId, job);
    durableJobs.add(job.queueId);
  }
  notifyQueueChange();
  void processQueue();
  return Array.from(jobs.values());
}

export async function retryPhotoUpload(queueId: string): Promise<void> {
  const job = jobs.get(queueId);
  if (!job) return;
  job.attempts = 0;
  job.permanent = false;
  job.lastError = undefined;
  nextAttemptAt.delete(queueId);
  notifyQueueChange();
  const persisted = await idbWrite(job);
  if (!persisted) {
    directSendJobs.add(job.queueId);
    await sendPhotoWithoutDurableStorage_(job);
    return;
  }
  durableJobs.add(job.queueId);
  directSendJobs.delete(job.queueId);
  void processQueue();
}

export async function discardPhotoUpload(queueId: string): Promise<void> {
  if (durableJobs.has(queueId)) {
    const deleted = await idbDelete(queueId);
    if (!deleted) {
      throw new Error("사진 임시 보관본을 삭제하지 못했습니다. 잠시 후 다시 시도해 주세요.");
    }
    durableJobs.delete(queueId);
  }
  jobs.delete(queueId);
  nextAttemptAt.delete(queueId);
  directSendJobs.delete(queueId);
  notifyQueueChange();
}

export function pendingPhotoUploadCount(): number {
  return jobs.size;
}

if (typeof window !== "undefined") {
  window.addEventListener("online", () => {
    // 온라인 복귀: 대기 잡은 즉시 재개하고, 네트워크 원인으로 소진된 잡만 부활한다
    // (재시작 부활과 같은 게이트 — 서버가 5회 실거절한 잡을 매 복귀마다 재전송하면 안 된다).
    // 서버가 영구 거절한 잡(permanent)은 항상 제외. 재전송은 clientKey 멱등이라 안전.
    const now = Date.now();
    for (const job of jobs.values()) {
      if (job.permanent) continue;
      if (job.attempts >= MAX_ATTEMPTS) {
        if (!NETWORK_ERROR_RE.test(String(job.lastError || ""))) continue;
        job.attempts = 0;
        job.lastError = undefined;
        void idbWrite(job);
      }
      nextAttemptAt.set(job.queueId, now);
    }
    notifyQueueChange();
    void processQueue();
  });
}
