const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

const timeline = read('apps/today-dashboard/components/VillageTimeline.tsx');
const route = read('apps/today-dashboard/app/api/gas/route.ts');
const apiClient = read('apps/today-dashboard/lib/data/apiClient.ts');
const writeback = read('apps/today-dashboard/lib/data/writeback.ts');
const store = read('apps/today-dashboard/lib/data/store.ts');
const photoStrip = read('apps/today-dashboard/components/PhotoStrip.tsx');
const scheduleCard = read('apps/today-dashboard/components/ScheduleCard.tsx');
const types = read('apps/today-dashboard/lib/domain/types.ts');

assert.match(
  timeline,
  /const \{ rangeStartMs, rangeEndMs, days \} = useMemo/,
  'timeline must keep an explicit visible range end'
);

assert.doesNotMatch(
  timeline,
  /for \(const it of items\)[\s\S]{0,180}it\.startMs < min[\s\S]{0,180}it\.endMs > max/,
  'timeline must not expand the default viewport to every reservation in the database'
);

assert.match(
  timeline,
  /const visibleItems = useMemo\(\(\) =>\s*items\.filter\(\(it\) => it\.endMs >= rangeStartMs && it\.startMs <= rangeEndMs\)/,
  'timeline must filter rows to items overlapping the visible range'
);

assert.match(
  timeline,
  /groupItems\(visibleItems, mode, search\)/,
  'timeline grouping must use visible range items'
);

assert.match(
  timeline,
  /computeConflicts\(visibleItems\)/,
  'timeline conflict checks must use visible range items'
);

assert.match(
  route,
  /READ_ACTIONS[\s\S]{0,260}"dashboardPhotos"[\s\S]{0,120}"dashboardPhotosBatch"/,
  'Next GAS proxy must allow dashboard photo reads'
);

assert.match(
  route,
  /import \{ revalidateTag, unstable_cache \} from "next\/cache"[\s\S]*import \{ createHash \} from "node:crypto"[\s\S]*const PERSISTENT_PHOTO_CACHE_TAG = "dashboard-photos-v1"/,
  'authenticated photo reads must use the shared Next data cache rather than only an instance-local Map'
);

assert.match(
  route,
  /unstable_cache\([\s\S]*revalidate:\s*30[\s\S]*tags:\s*\[PERSISTENT_PHOTO_CACHE_TAG\]/,
  'shared photo metadata must revalidate in the background every 30 seconds'
);

assert.match(
  route,
  /function isCacheablePhotoBody[\s\S]*result\.photosByTrade[\s\S]*request\.tradeIds\.every[\s\S]*validPhotoBucket_/,
  'persistent photo reads must reject nested warnings, errors, and missing requested trades'
);

assert.match(
  route,
  /createHash\("sha256"\)\.update\(queryString\)\.digest\("hex"\)[\s\S]*\["gas-photo-read-v2", queryFingerprint\]/,
  'the persistent cache key must contain only a fingerprint, never the GAS key or trade IDs'
);

assert.doesNotMatch(
  route,
  /unstable_cache\([\s\S]{0,900}async \(url: string\)|readPersistentlyCachedPhotoResponse\(url\)/,
  'sensitive upstream URLs must never be passed as unstable_cache invocation arguments'
);

assert.match(
  route,
  /photoWrite[\s\S]*revalidateTag\(PERSISTENT_PHOTO_CACHE_TAG\)/,
  'successful photo changes must invalidate every serverless instance photo cache'
);

assert.match(
  route,
  /\.finally\(\(\) => \{[\s\S]*if \(photoWrite\) invalidateCacheForWrite\(action\)[\s\S]*finally \{[\s\S]*if \(photoWrite\) invalidateCacheForWrite\(action\)/,
  'GET and POST photo writes must invalidate shared cache even when only the response is lost'
);

assert.match(
  route,
  /const photoRead = isPhotoReadAction\(action\)[\s\S]*if \(!isWrite && !noCache && !photoRead\)[\s\S]*if \(!isWrite && !noCache && photoRead\)/,
  'photo reads must bypass the instance-local Map so cross-instance invalidation cannot be skipped'
);

const persistentPhotoBranch = route.slice(
  route.indexOf('if (!isWrite && !noCache && photoRead)'),
  route.indexOf('\n  return fetch(url', route.indexOf('if (!isWrite && !noCache && photoRead)')),
);
assert.doesNotMatch(
  persistentPhotoBranch,
  /cache\.get\(|cache\.set\(/,
  'the persistent photo branch must not read or repopulate an instance-local stale cache'
);

assert.doesNotMatch(
  route,
  /s-maxage|stale-while-revalidate/i,
  'authenticated photo metadata must not be exposed through a public CDN cache header'
);

// 문자 수 창으로 재면 목록에 줄이 하나 늘 때마다 깨진다. 멤버십만 본다.
assert.ok(
  route.slice(route.indexOf('const WRITE_ACTIONS = new Set(['), route.indexOf(']);', route.indexOf('const WRITE_ACTIONS = new Set([')))
    .includes('"uploadDashboardPhoto"'),
  'Next GAS proxy must allow dashboard photo uploads'
);

assert.match(
  route,
  /WRITE_ACTIONS[\s\S]{0,420}"deleteDashboardPhoto"/,
  'Next GAS proxy must allow dashboard photo deletion'
);

assert.match(
  route,
  /export async function POST\(req: NextRequest\)/,
  'Next GAS proxy must expose POST for large base64 photo uploads'
);

assert.match(
  apiClient,
  /export async function gasPost/,
  'API client must expose POST calls to the GAS proxy'
);

assert.match(
  writeback,
  /mustPost[\s\S]{0,220}gasPost\(\{ action, \.\.\.params \}\)/,
  'writeback must send large photo payloads through POST, not query strings'
);

assert.match(
  store,
  /export async function refreshTradePhotos\(tradeId: string\)/,
  'store must refresh saved dashboard photos for a trade'
);

assert.match(
  store,
  /export function ensureTradePhotos\(tradeIds: string\[\]\)/,
  'store must batch-load saved dashboard photos for visible cards'
);

assert.match(
  store,
  /dashboardPhotosBatch[\s\S]{0,220}JSON\.stringify\(batch\)/,
  'visible card photo loading must use the GAS batch endpoint'
);

assert.match(
  store,
  /const PHOTO_LOAD_FRESH_MS\s*=\s*30_000[\s\S]*const photoLoadStates = new Map[\s\S]*const photoLoadPromises = new Map/,
  'photo loading must track freshness and share the same in-flight request per trade'
);

assert.match(
  store,
  /async function loadTradePhotosBatch_[\s\S]*successfulPhotoMap[\s\S]*failedTradeIds/,
  'one bad trade must not discard successful photos for the rest of its batch'
);

assert.match(
  store,
  /for \(let i = 0; i < ids\.length; i \+= DASHBOARD_PHOTO_BATCH_SIZE\)[\s\S]*mergeTradePhotosFromGas\(successfulPhotoMap\)[\s\S]*emit\(\)/,
  'each completed photo chunk must render immediately instead of waiting for every later GAS roundtrip'
);

assert.match(
  store,
  /const pending = photoLoadPromises\.get\(id\)[\s\S]*joined\.add\(pending\)/,
  'card preload and modal open must join an existing request instead of racing a duplicate'
);

assert.match(
  store,
  /photoLoadPromiseGenerations[\s\S]*pendingIsFreshEnough[\s\S]*>= requiredGeneration[\s\S]*force && !pendingIsFreshEnough[\s\S]*loadTradePhotosBatch_\(forceAfterIds, true, forceAfterGenerations\)/,
  'a forced refresh must follow any in-flight read that predates its causal generation'
);

assert.match(
  store,
  /requestGenerations[\s\S]*photoLoadGeneration_\(tradeId\) !== requestGenerations\.get\(tradeId\)[\s\S]*continue/,
  'a photo list read started before an upload or delete must not overwrite the newer local truth'
);

assert.match(
  store,
  /event: "photo-change"[\s\S]*state\.trades\.some\(\(t\) => t\.tradeId === tradeId\)[\s\S]*loadTradePhotosBatch_\(\[tradeId\], true\)/,
  'every visible trade must causally refresh on a remote photo change, including initial loading and error states'
);

assert.match(
  store,
  /force \? \{ nocache: "1" \} : \{\}/,
  'explicit photo retry and broadcast refresh must bypass stale proxy cache'
);

assert.match(
  store,
  /export async function uploadTradePhoto\(tradeId: string, phase: Phase, file: File\)/,
  'store must expose a real photo upload action'
);

assert.match(
  store,
  /gasMutation\("uploadDashboardPhoto"[\s\S]{0,260}data/,
  'photo upload must call the GAS uploadDashboardPhoto action with image data'
);

assert.match(
  store,
  /export async function deleteTradePhoto\(tradeId: string, photo: PhotoMeta\)[\s\S]{0,900}gasMutation\("deleteDashboardPhoto"/,
  'photo deletion must be confirmed by GAS before removing the local tile'
);

assert.match(
  photoStrip,
  /export function PhotoStrip\(\{[\s\S]{0,120}tradeId,[\s\S]{0,120}photos,/,
  'PhotoStrip must know which trade it uploads photos for'
);

assert.match(
  photoStrip,
  /const photoLoad = useTradePhotoLoadState\(tradeId\)[\s\S]{0,100}const photosLoaded = photoLoad\.loaded/,
  'PhotoStrip must subscribe to the full per-trade photo loading state'
);

assert.match(
  photoStrip,
  /photosLoaded[\s\S]{0,180}`반출 \$\{checkout\.length\} · 반납 \$\{checkin\.length\}`[\s\S]{0,180}photoLoad\.error[\s\S]{0,100}"불러오기 실패"/,
  'PhotoStrip must distinguish ready, loading, and failed photo reads'
);

// 2026-07-12: 사장 요청으로 카메라 강제(capture="environment")를 제거 —
// 기존에 찍어둔 사진도 올릴 수 있도록 OS 선택창(카메라/보관함/파일)이 뜨게 한다.
assert.match(
  photoStrip,
  /type="file"[\s\S]{0,120}accept="image\/\*"[\s\S]{0,120}multiple/,
  'PhotoStrip must accept image files (camera or gallery, not camera-forced)'
);
assert.doesNotMatch(
  photoStrip,
  /capture="environment"/,
  'PhotoStrip must NOT force the camera — gallery upload must be possible'
);

assert.match(
  photoStrip,
  /uploadTradePhoto\(tradeId, nextPhase, file\)/,
  'PhotoStrip must upload selected photos'
);

assert.match(
  photoStrip,
  /window\.confirm[\s\S]{0,600}deleteTradePhoto\(tradeId, photo\)/,
  'saved photo tiles must confirm and delete the exact server photo'
);

const gasBackend = read('checkAvailability.js');
const gasDeletePhoto = gasBackend.slice(
  gasBackend.indexOf('function deleteDashboardPhoto'),
  gasBackend.indexOf('\nfunction invalidateDashboardPhotoCache_', gasBackend.indexOf('function deleteDashboardPhoto')),
);
assert.ok(
  gasDeletePhoto.includes("sheet.getRange(matched.row, targetPhotoCol).setValue(remaining.join('\\n'))"),
  'GAS must remove the selected photo value from the sheet row',
);
assert.match(
  gasDeletePhoto,
  /DriveApp\.getFileById\(fileId\)\.setTrashed\(true\)/,
  'GAS must remove the sheet record and move the exact Drive photo to trash'
);
assert.ok(
  gasDeletePhoto.indexOf('lock.releaseLock()') < gasDeletePhoto.indexOf('DriveApp.getFileById(fileId).setTrashed(true)'),
  'slow Drive trashing must happen after the short sheet-delete lock is released',
);

assert.match(
  photoStrip,
  /ensureTradePhotos\(\[tradeId\]\)[\s\S]*retryPhotoLoad[\s\S]*refreshTradePhotos\(tradeId\)/,
  'PhotoStrip must reuse fresh preloaded photos and reserve forced reads for explicit retry'
);

const photoOpenEffect = photoStrip.slice(
  photoStrip.indexOf('useEffect(() => {\n    if (!open) return;'),
  photoStrip.indexOf('\n  }, [open, tradeId]);', photoStrip.indexOf('useEffect(() => {\n    if (!open) return;')),
);
assert.match(
  photoOpenEffect,
  /ensureTradePhotos\(\[tradeId\]\)/,
  'opening the modal must only freshness-check the already batched photo state'
);
assert.doesNotMatch(
  photoOpenEffect,
  /setLoading\(true\)|refreshTradePhotos\(tradeId\)/,
  'opening a preloaded modal must not block on another 3-5 second GAS read'
);

assert.match(
  photoStrip,
  /z-\[120\][\s\S]{0,180}pb-\[env\(safe-area-inset-bottom\)\]/,
  'PhotoStrip modal must sit above fixed app chrome and respect iPhone safe area'
);

assert.match(
  photoStrip,
  /max-h-\[calc\(100dvh-1rem\)\]/,
  'PhotoStrip modal must use dynamic viewport height on mobile camera return'
);

assert.match(
  scheduleCard,
  /ensureTradePhotos\(\[trade\.tradeId\]\)/,
  'ScheduleCard must preload saved photos from the legacy sheet DB'
);

assert.match(
  scheduleCard,
  /<PhotoStrip\s+tradeId=\{trade\.tradeId\}\s+photos=\{trade\.photos\}[\s\S]{0,120}\/>/,
  'ScheduleCard must pass tradeId into PhotoStrip'
);

assert.match(
  types,
  /thumbnailUrl\?: string/,
  'PhotoMeta must support real thumbnail URLs returned by GAS'
);

console.log('today dashboard timeline/photo static checks passed');
