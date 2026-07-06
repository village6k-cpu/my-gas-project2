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
}

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
let processing = false;
let wakeTimer: ReturnType<typeof setTimeout> | null = null;

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
  if (wakeTimer) return;
  const pending = Array.from(jobs.values()).filter((job) => job.attempts < MAX_ATTEMPTS);
  if (!pending.length) return;
  const soonest = Math.min(...pending.map((job) => nextAttemptAt.get(job.queueId) ?? 0));
  const delay = Math.max(250, soonest - Date.now());
  wakeTimer = setTimeout(() => {
    wakeTimer = null;
    void processQueue();
  }, delay);
}

async function processQueue(): Promise<void> {
  if (processing || !handlers) return;
  processing = true;
  try {
    for (;;) {
      const ready = readyJobs(Date.now());
      if (!ready.length) break;
      const job = ready[0];
      try {
        const response = await handlers.send(job);
        jobs.delete(job.queueId);
        nextAttemptAt.delete(job.queueId);
        await idbDelete(job.queueId);
        handlers.onSuccess(job, response);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const permanent = Boolean((error as { permanent?: boolean } | null)?.permanent);
        job.attempts = permanent ? MAX_ATTEMPTS : job.attempts + 1;
        job.lastError = message;
        const willRetry = job.attempts < MAX_ATTEMPTS;
        if (willRetry) {
          const delay = RETRY_DELAYS_MS[Math.min(job.attempts - 1, RETRY_DELAYS_MS.length - 1)];
          nextAttemptAt.set(job.queueId, Date.now() + delay);
        }
        await idbWrite(job);
        handlers.onFailure(job, message, willRetry);
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
  void processQueue();
}

/** 앱 재시작 시 IndexedDB에 남은 작업을 복원해 마저 올린다. */
export async function resumePhotoUploads(): Promise<PhotoUploadJob[]> {
  const stored = await idbReadAll();
  for (const job of stored) {
    if (jobs.has(job.queueId)) continue;
    job.attempts = 0;
    job.lastError = undefined;
    jobs.set(job.queueId, job);
  }
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
  void processQueue();
}

export async function discardPhotoUpload(queueId: string): Promise<void> {
  jobs.delete(queueId);
  nextAttemptAt.delete(queueId);
  await idbDelete(queueId);
}

export function pendingPhotoUploadCount(): number {
  return jobs.size;
}

if (typeof window !== "undefined") {
  window.addEventListener("online", () => void processQueue());
}
