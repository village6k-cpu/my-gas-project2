const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

const backend = read('checkAvailability.js');

const photoMapBody = backend.match(/function getDashboardPhotoMap_\(tradeIds\)[\s\S]*?\n}\n\nfunction addDashboardPhotoCell_/);
assert.ok(photoMapBody, 'getDashboardPhotoMap_ must exist before addDashboardPhotoCell_');

assert.match(
  photoMapBody[0],
  /getRange\(2,\s*schema\.tradeIdCol,\s*rowCount,\s*1\)\.getDisplayValues\(\)/,
  'dashboard photo lookup must scan only the tradeId column first'
);

assert.match(
  photoMapBody[0],
  /readDashboardScheduleRowsDisplay_\(sheet,\s*rowsToRead,\s*lastCol\)/,
  'dashboard photo lookup must read only matching photo rows'
);

assert.doesNotMatch(
  photoMapBody[0],
  /getRange\(2,\s*1,\s*rowCount,\s*lastCol\)\.getDisplayValues\(\)/,
  'dashboard photo lookup must not read the whole photo sheet for each active tab'
);

assert.match(
  photoMapBody[0],
  /row:\s*rowsToRead\[i\]/,
  'dashboard photo lookup must preserve actual sheet row numbers after sparse reads'
);

const fileIndexBody = backend.match(/function getDashboardPhotoFileIndex_\(\)[\s\S]*?\n}\n\nfunction normalizeDashboardPhotoPhase_/);
assert.ok(fileIndexBody, 'dashboard photo file index helpers must exist before phase normalization');

assert.match(
  fileIndexBody[0],
  /readDashboardPhotoFileIndexCache_\(cache\)/,
  'photo lookup must reuse the chunked script cache before scanning Drive'
);

assert.match(
  fileIndexBody[0],
  /readDashboardPhotoFileIndexProperties_\(\)/,
  'photo lookup must keep a durable compressed index after the six-hour cache expires'
);

assert.match(
  fileIndexBody[0],
  /DASHBOARD_PHOTO_FILE_INDEX_CACHE_CHUNK_PREFIX_[\s\S]*cache\.putAll\(/,
  'the Drive filename index must be split across cache entries below the 100KB per-key limit'
);

assert.match(
  fileIndexBody[0],
  /Utilities\.gzip\([\s\S]*DASHBOARD_PHOTO_FILE_INDEX_PROPERTY_CHUNK_PREFIX_/,
  'the durable filename index must be compressed and split below the 9KB property limit'
);

assert.doesNotMatch(
  fileIndexBody[0],
  /cache\.put\(DASHBOARD_PHOTO_FILE_INDEX_CACHE_KEY_,\s*JSON\.stringify\(index\)/,
  'the 1,900-file index must never be written as one oversized cache value'
);

assert.match(
  backend,
  /if \(fileId\) \{[\s\S]{0,320}rememberDashboardPhotoFileIndexEntry_\(fileName, fileId\)/,
  'photos added outside this web app must join the durable index after their first fallback lookup'
);

console.log('dashboard photo performance static checks passed');
