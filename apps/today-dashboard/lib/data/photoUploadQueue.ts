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

let handlers: PhotoUploadHandlers | null = null;
const jobs = new Map<string, PhotoUploadJob>();
const nextAttemptAt = new Map<string, number>();

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

async function idbWrite(job: PhotoUploadJob): Promise<void> {
  const db = await openDb();
  if (!db) return;
  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction(DB_STORE, "readwrite");
      tx.objectStore(DB_STORE).put(job);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    } catch {
      resolve();
    }
  });
  db.close();
}

async function idbDelete(queueId: string): Promise<void> {
  const db = await openDb();
  if (!db) return;
  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction(DB_STORE, "readwrite");
      tx.objectStore(DB_STORE).delete(queueId);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    } catch {
      resolve();
    }
  });
  db.close();
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
    .filter((job) => job.attempts < MAX_ATTEMPTS && (nextAttemptAt.get(job.queueId) ?? 0) <= now)
    .sort((a, b) => a.createdAt - b.createdAt);
}

function scheduleWake(): void {
  const pending = Array.from(jobs.values()).filter((job) => job.attempts < MAX_ATTEMPTS);
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
        jobs.delete(job.queueId);
        nextAttemptAt.delete(job.queueId);
        await idbDelete(job.queueId);
        handlers.onSuccess(job, response);
        notifyQueueChange();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const permanent = Boolean((error as { permanent?: boolean } | null)?.permanent);
        const offlineNow = typeof navigator !== "undefined" && navigator.onLine === false;
        if (offlineNow && !permanent) {
          // 전송 도중 연결이 끊긴 경우 — 시도 횟수를 태우지 않고 온라인 복귀를 기다린다
          job.lastError = message;
          nextAttemptAt.set(job.queueId, Date.now() + 60_000);
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

export async function enqueuePhotoUpload(job: PhotoUploadJob): Promise<void> {
  jobs.set(job.queueId, job);
  await idbWrite(job);
  notifyQueueChange();
  void processQueue();
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
  }
  notifyQueueChange();
  void processQueue();
  return Array.from(jobs.values());
}

export function retryPhotoUpload(queueId: string): void {
  const job = jobs.get(queueId);
  if (!job) return;
  job.attempts = 0;
  job.lastError = undefined;
  nextAttemptAt.delete(queueId);
  void idbWrite(job);
  notifyQueueChange();
  void processQueue();
}

export async function discardPhotoUpload(queueId: string): Promise<void> {
  jobs.delete(queueId);
  nextAttemptAt.delete(queueId);
  await idbDelete(queueId);
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
