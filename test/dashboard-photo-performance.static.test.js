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

console.log('dashboard photo performance static checks passed');
