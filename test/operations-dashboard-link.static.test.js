const fs = require('fs');
const path = require('path');
const assert = require('assert');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

const operations = read('apps/follow-up-dashboard/operations.html');

[
  "const DASHBOARD_URL",
  'function todayDashboardUrl(date)',
  'function updateTodayDashboardLink(date)',
  'id="today-dashboard-link"',
  'const EQUIPMENT_VISIBLE_LIMIT = 4',
  "params.set('date', date)",
  'class="equip-list"',
  'class="equip-chip"',
  'normalized.slice(0, EQUIPMENT_VISIBLE_LIMIT)',
  'class="equip-chip more"',
  "'외 ' + hiddenCount + '개'"
].forEach((contract) => {
  assert(
    operations.includes(contract),
    `operations.html must expose one today-schedule entry point and keep the equip-chip helper available: ${contract}`
  );
});

// 사장님 정책 (2026-05-26): 운영판 카드에서 장비 chip 표시 안 함.
// 헬퍼 함수(renderEquipmentList)는 보존하되, 카드 row에서 호출하지 않아야 함.
assert(
  !/\$\{\s*renderEquipmentList\(\s*it\.items\s*\)\s*\}/.test(operations),
  'operations.html cards must not render equipment chips per current operator policy'
);

[
  'function dashboardUrl(item, phase, fallbackDate)',
  'function scheduleLink(item, phase, fallbackDate)',
  'class="schedule-link"',
  'row-actions'
].forEach((removedContract) => {
  assert(
    !operations.includes(removedContract),
    `operations.html must not attach today-schedule links to every operation row: ${removedContract}`
  );
});

assert(
  !/itemsToText\(it\.items\)/.test(operations),
  'operations checkout/checkin rows must not render equipment as one comma-separated text string'
);

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

['dashboard.html', 'docs/dashboard.html'].forEach((file) => {
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
