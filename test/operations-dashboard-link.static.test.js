const fs = require('fs');
const path = require('path');
const assert = require('assert');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

const sheetApi = read('sheetAPI.js');
[
  'function operationsScheduleItem_(row)',
  'var setName = String(row[2] || "").trim();',
  'var itemName = String(row[3] || row[2] || "").trim();',
  'if (setName && setName !== itemName) return null;',
  'var opItem = operationsScheduleItem_(row);',
  'if (opItem) todayCheckoutMap[tid].items.push(opItem);',
  'if (opItem) todayCheckinMap[tid].items.push(opItem);',
  'if (opItem) imminentMap[tid].items.push(opItem);',
  'var cacheKey = "operations_v2_" + todayStr;'
].forEach((contract) => {
  assert(
    sheetApi.includes(contract),
    `sheetAPI.js operations data must hide set component rows: ${contract}`
  );
});

['dashboard.html'].forEach((file) => {
  const html = read(file);
  [
    'var dashboardInitialSearchQuery =',
    "urlParams.get('search')",
    "urlParams.get('tid')",
    "urlParams.get('tab')",
    'function applyDashboardInitialSearchQuery()',
    'onDashboardSearchInput(dashboardInitialSearchQuery)'
  ].forEach((contract) => {
    assert(
      html.includes(contract),
      `${file} must accept operations-board deep links into today schedule: ${contract}`
    );
  });
  [
    'function dashboardMyReservationUrl(item)',
    'https://village6k-cpu.github.io/village-agreement/?id=',
    '&admin=1',
    '내예약 열기'
  ].forEach((contract) => {
    assert(
      html.includes(contract),
      `${file} must expose an owner-visible my-reservation link on reservation cards: ${contract}`
    );
  });
});

console.log('operations dashboard link static checks passed');
