// 반출/반납 사진 업로드가 다시 "기다리는 업로드"로 퇴행하지 않도록 잠그는 테스트.
// 근본 원인(2026-07): 사진 1장당 GAS 동기 왕복 8~11초 + 업로드 동안 버튼 전체 잠금 →
// 직원들이 예전 앱시트 앱으로 돌아감. 수정: 낙관적 타일 + IndexedDB 백그라운드 큐 + GAS 경로 단축.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

const store = read('apps/today-dashboard/lib/data/store.ts');
const queue = read('apps/today-dashboard/lib/data/photoUploadQueue.ts');
const strip = read('apps/today-dashboard/components/PhotoStrip.tsx');
const mappers = read('apps/today-dashboard/lib/data/mappers.ts');
const backend = read('checkAvailability.js');
const api = read('sheetAPI.js');

// ── 클라이언트: 업로드는 화면을 막지 않는다 ──────────────────────────

const uploadBody = store.match(/export async function uploadTradePhoto\(tradeId: string, phase: Phase, file: File\): Promise<void> \{[\s\S]*?\n\}/);
assert.ok(uploadBody, 'uploadTradePhoto must exist with the same signature');
assert.doesNotMatch(
  uploadBody[0],
  /await gasMutation\(/,
  'uploadTradePhoto must not block on the GAS round trip — enqueue and return'
);
assert.match(
  uploadBody[0],
  /mergePhotos\(t\.photos,\s*\[optimistic\]\)[\s\S]*enqueuePhotoUpload\(/,
  'uploadTradePhoto must show the optimistic tile before enqueueing the background upload'
);
assert.match(
  uploadBody[0],
  /status: "uploading"/,
  'the optimistic tile must be marked uploading so the UI can badge it'
);

// 미리보기 data URL은 PhotoMeta에 넣지 않는다 — 넣으면 Supabase trades 행에 MB 단위 JSON이 저장됨
assert.doesNotMatch(
  uploadBody[0],
  /thumbnailUrl:\s*upload\.data/,
  'the optimistic PhotoMeta must not carry the data URL (it would be persisted to Supabase)'
);
assert.match(
  store,
  /localPhotoPreviews\.set\(queueId,\s*upload\.data\)/,
  'the local preview must live in the in-memory map, not in PhotoMeta'
);
assert.match(
  mappers,
  /photos:\s*t\.photos\.filter\(\(p\) => !p\.status\)/,
  'tradeToRow must not persist pending/failed local photo tiles to Supabase'
);

// ── 큐: 보존 + 재시도 + 복원 ────────────────────────────────────────

assert.match(queue, /indexedDB\.open\(/, 'upload queue must persist jobs in IndexedDB so photos survive reload/app close');
assert.match(queue, /const MAX_ATTEMPTS = 5/, 'upload queue must cap retries');
assert.match(queue, /RETRY_DELAYS_MS = \[3_000, 8_000, 20_000, 60_000\]/, 'upload queue must back off between retries');
assert.match(queue, /export async function resumePhotoUploads\(/, 'upload queue must resume pending jobs on app start');
assert.match(store, /void resumePhotoUploads\(\)/, 'store must resume pending photo uploads on load');
assert.match(queue, /addEventListener\("online"/, 'upload queue must retry when the device comes back online');
assert.match(store, /clientKey: job\.queueId/, 'queue sender must pass clientKey so GAS can dedupe retries');

// ── UI: 버튼 잠금 제거 + 다중 선택 + 실패 복구 ──────────────────────

assert.doesNotMatch(
  strip,
  /uploading === phase \? "업로드 중…"/,
  'PhotoStrip must not hold the add button hostage for the network round trip'
);
assert.match(strip, /<input[^>]*multiple/, 'PhotoStrip file input must allow selecting multiple photos');
assert.match(strip, /재시도/, 'failed tiles must offer a retry action');
assert.match(strip, /retryTradePhotoUpload\(/, 'retry must go through the queue');
assert.match(strip, /discardTradePhotoUpload\(/, 'failed tiles must be discardable');

// ── GAS: 업로드 경로에서 전역 락/불필요 왕복 제거 + 멱등성 ───────────

const gasUpload = backend.match(/function uploadDashboardPhoto\(tid, phase, fileName, mimeType, data, memo, clientKey\) \{[\s\S]*?\n\}\n\nfunction invalidateDashboardPhotoCache_/);
assert.ok(gasUpload, 'uploadDashboardPhoto must accept clientKey');
assert.doesNotMatch(
  gasUpload[0],
  /LockService/,
  'uploadDashboardPhoto must not take the global script lock (added up to +10s and its failure was ignored anyway)'
);
assert.doesNotMatch(
  gasUpload[0],
  /file\.getUrl\(\)/,
  'uploadDashboardPhoto must construct the Drive URL from fileId instead of an extra Drive round trip'
);
assert.match(
  gasUpload[0],
  /dashboard_photo_upload_[\s\S]*CacheService\.getScriptCache\(\)\.get\(dedupKey\)/,
  'uploadDashboardPhoto must return the cached result for a repeated clientKey (idempotent retries)'
);
assert.match(
  gasUpload[0],
  /CacheService\.getScriptCache\(\)\.put\(dedupKey,\s*JSON\.stringify\(result\),\s*21600\)/,
  'uploadDashboardPhoto must cache the success result for retry dedup'
);
assert.match(
  api,
  /uploadDashboardPhoto\([\s\S]*?params\.clientKey \|\| postBody\.clientKey/,
  'sheetAPI must forward clientKey to uploadDashboardPhoto'
);

console.log('today-dashboard-photo-queue.static.test.js OK');
