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
  /WRITE_ACTIONS[\s\S]{0,360}"uploadDashboardPhoto"/,
  'Next GAS proxy must allow dashboard photo uploads'
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
  /export async function uploadTradePhoto\(tradeId: string, phase: Phase, file: File\)/,
  'store must expose a real photo upload action'
);

assert.match(
  store,
  /gasMutation\("uploadDashboardPhoto"[\s\S]{0,260}data/,
  'photo upload must call the GAS uploadDashboardPhoto action with image data'
);

assert.match(
  photoStrip,
  /export function PhotoStrip\(\{ tradeId, photos \}: \{ tradeId: string; photos: PhotoMeta\[\] \}\)/,
  'PhotoStrip must know which trade it uploads photos for'
);

assert.match(
  photoStrip,
  /type="file"[\s\S]{0,120}accept="image\/\*"[\s\S]{0,120}capture="environment"/,
  'PhotoStrip must open mobile camera/file input'
);

assert.match(
  photoStrip,
  /uploadTradePhoto\(tradeId, nextPhase, file\)/,
  'PhotoStrip must upload selected photos'
);

assert.match(
  photoStrip,
  /refreshTradePhotos\(tradeId\)/,
  'PhotoStrip must load already saved photos when opened'
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
  /<PhotoStrip tradeId=\{trade\.tradeId\} photos=\{trade\.photos\} \/>/,
  'ScheduleCard must pass tradeId into PhotoStrip'
);

assert.match(
  types,
  /thumbnailUrl\?: string/,
  'PhotoMeta must support real thumbnail URLs returned by GAS'
);

console.log('today dashboard timeline/photo static checks passed');
