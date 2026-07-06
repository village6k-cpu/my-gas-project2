const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

const store = read('apps/today-dashboard/lib/data/store.ts');
const route = read('apps/today-dashboard/app/api/gas/route.ts');

assert.match(
  store,
  /const DASHBOARD_PHOTO_MAX_SIDE\s*=\s*1600/,
  'photo uploads must resize camera originals before sending them to GAS'
);

assert.match(
  store,
  /const DASHBOARD_PHOTO_MAX_DATA_URL_CHARS\s*=\s*4_000_000/,
  'photo uploads must keep the JSON payload below the live Next/Vercel 413 boundary'
);

assert.match(
  store,
  /function loadDashboardPhotoImage_\(dataUrl: string\): Promise<HTMLImageElement>/,
  'photo uploads must decode images before canvas compression'
);

assert.match(
  store,
  /async function prepareDashboardPhotoUpload_\(file: File\)[\s\S]*canvas\.toDataURL\("image\/jpeg",\s*quality\)/,
  'photo uploads must canvas-compress to JPEG before calling GAS'
);

assert.match(
  store,
  /prepareDashboardPhotoUpload_\(file\)[\s\S]*enqueuePhotoUpload\(\{[\s\S]*fileName: upload\.fileName[\s\S]*mimeType: upload\.mimeType[\s\S]*data: upload\.data/,
  'uploadTradePhoto must enqueue the compressed payload, not the original camera file'
);

assert.match(
  store,
  /gasMutation\("uploadDashboardPhoto",\s*\{[\s\S]*?data: job\.data/,
  'the upload queue sender must forward the compressed job payload to GAS'
);

const uploadTradePhotoBody = store.match(/export async function uploadTradePhoto\(tradeId: string, phase: Phase, file: File\): Promise<void> \{[\s\S]*?\n\}/);
assert.ok(uploadTradePhotoBody, 'uploadTradePhoto must exist');
assert.doesNotMatch(
  uploadTradePhotoBody[0],
  /const data = await readFileAsDataUrl\(file\)/,
  'uploadTradePhoto must not read and upload the original camera data URL directly'
);

assert.match(
  route,
  /export const maxDuration\s*=\s*60/,
  'GAS proxy route must declare enough runtime for photo forwarding'
);

console.log('today-dashboard-photo-compression.static.test.js OK');
