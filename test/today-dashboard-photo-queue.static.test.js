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
  /await enqueuePhotoUpload\([\s\S]*if \(enqueueResult === "completed"\) return;[\s\S]*mergePhotos\(t\.photos,\s*\[optimistic\]\)/,
  'uploadTradePhoto must show the optimistic tile only after durable local enqueue succeeds'
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

// ── GAS: 짧은 durable claim + 잠금 밖 Drive I/O + 멱등성 ───────────

const gasUpload = backend.match(/function uploadDashboardPhoto\(tid, phase, fileName, mimeType, data, memo, clientKey\) \{[\s\S]*?\n\}\n\n\/\*\* 반출\/반납 사진 1장 삭제/);
assert.ok(gasUpload, 'uploadDashboardPhoto must accept clientKey');
assert.match(
  gasUpload[0],
  /dashboardPhotoUploadClaimKey_\(clientKey\)[\s\S]*claimLock\.tryLock\(1500\)[\s\S]*claimLock\.releaseLock\(\)/,
  'uploadDashboardPhoto must serialize only the short durable-claim decision'
);
assert.ok(
  gasUpload[0].indexOf('claimLock.releaseLock()') < gasUpload[0].indexOf('folder.createFile(blob)'),
  'Drive upload must start only after the durable-claim lock is released',
);
assert.ok(
  gasUpload[0].indexOf('folder.createFile(blob)') < gasUpload[0].indexOf('appendLock.tryLock(2000)'),
  'Drive upload must not run while the short sheet-append lock is held',
);
assert.doesNotMatch(gasUpload[0], /waitLock\(/, 'photo upload must never wait on the global lock for a long critical section');
assert.doesNotMatch(
  gasUpload[0],
  /file\.getUrl\(\)/,
  'uploadDashboardPhoto must construct the Drive URL from fileId instead of an extra Drive round trip'
);
assert.match(
  gasUpload[0],
  /claimState && claimState\.state === 'done' && claimState\.result[\s\S]*return claimState\.result/,
  'a repeated clientKey must return the durable completed result even after cache expiry'
);
assert.match(
  gasUpload[0],
  /var fileId = String\(claimState && claimState\.fileId \|\| ''\)[\s\S]*if \(!fileId\)[\s\S]*folder\.createFile\(blob\)[\s\S]*claimState\.state = 'file'/,
  'a retry after Drive creation must reuse the claimed file instead of uploading a duplicate'
);
assert.match(
  gasUpload[0],
  /claimState\.state = claimState\.fileId \? 'file' : 'pending'[\s\S]*claimState\.retryReady = true/,
  'failed uploads must leave a durable retry-ready pending/file claim'
);
assert.match(
  gasUpload[0],
  /claimState\.state = 'done'[\s\S]*claimState\.result = result[\s\S]*props\.setProperty\(claimKey, JSON\.stringify\(claimState\)\)/,
  'successful uploads must persist the final result in the durable claim'
);
assert.match(
  gasUpload[0],
  /CacheService\.getScriptCache\(\)\.put\(dedupKey,\s*JSON\.stringify\(result\),\s*21600\)/,
  'CacheService remains a secondary fast-path hint for successful retries'
);
assert.match(
  api,
  /uploadDashboardPhoto\([\s\S]*?params\.clientKey \|\| postBody\.clientKey/,
  'sheetAPI must forward clientKey to uploadDashboardPhoto'
);

console.log('today-dashboard-photo-queue.static.test.js OK');
