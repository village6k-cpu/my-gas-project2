const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

const backend = read('checkAvailability.js');

const tradeExtrasBody = backend.match(/function getTradeExtrasForIds_\([\s\S]*?\n}\n\nvar DASHBOARD_PHOTO_SHEET_NAME_/);
assert.ok(tradeExtrasBody, 'getTradeExtrasForIds_ must exist before dashboard photo helpers');

assert.match(
  backend,
  /DASHBOARD_TRADE_EXTRA_CACHE_PREFIX_/,
  'dashboard trade extras must use per-trade script cache keys'
);

assert.match(
  tradeExtrasBody[0],
  /cache\.getAll\(keys\)/,
  'dashboard trade extras must fetch cached per-trade extras in one cache call'
);

assert.match(
  tradeExtrasBody[0],
  /cache\.putAll\(cachePayload,\s*DASHBOARD_TRADE_EXTRA_CACHE_SECONDS_\)/,
  'dashboard trade extras must store refreshed per-trade extras with a short TTL'
);

assert.match(
  tradeExtrasBody[0],
  /getRange\(2,\s*idCol,\s*거래시트\.getLastRow\(\) - 1,\s*1\)\.getDisplayValues\(\)/,
  'dashboard trade extras must scan only the 거래ID column before reading matched rows'
);

assert.match(
  tradeExtrasBody[0],
  /readDashboardScheduleRowsDisplay_\(거래시트,\s*rowsToRead,\s*readCols\)/,
  'dashboard trade extras must read only matched 거래내역 rows'
);

assert.doesNotMatch(
  tradeExtrasBody[0],
  /var readCols\s*=\s*Math\.max\(lastCol,/,
  'dashboard trade extras must not read every 거래내역 data column on every dashboard load'
);

assert.match(
  backend,
  /function invalidateDashboardTradeExtraCache_\(tradeIds\)[\s\S]*cache\.removeAll\(keys\)/,
  'dashboard trade extras must support targeted cache invalidation'
);

[
  /function updateTradePaymentMethod\(tid,\s*method\)[\s\S]*invalidateDashboardTradeExtraCache_\(\[tid\]\)[\s\S]*invalidateDashboardCache\(\)/,
  /function updateTradeBillingCompany\(tid,\s*billingCompany\)[\s\S]*invalidateDashboardTradeExtraCache_\(\[tid\]\)[\s\S]*invalidateDashboardCache\(\)/,
  /function updateTradeProofField\(tid,\s*field,\s*value\)[\s\S]*invalidateDashboardTradeExtraCache_\(\[tid\]\)[\s\S]*invalidateDashboardCache\(\)/,
  /function callVillageOpsApi_\(action,\s*tid\)[\s\S]*invalidateDashboardTradeExtraCache_\(\[tid\]\)[\s\S]*invalidateDashboardCache\(\)/
].forEach((pattern) => {
  assert.match(
    backend,
    pattern,
    'trade extra writes must invalidate only the touched trade extra cache before dashboard cache'
  );
});

assert.match(
  backend,
  /function fetchCardCautionsBatch_\(requests\)[\s\S]*UrlFetchApp\.fetchAll\(fetchRequests\)/,
  'dashboard card cautions must use one batched external API call group instead of local rule-sheet matching'
);

console.log('dashboard trade extras cache static checks passed');
