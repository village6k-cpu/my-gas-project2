const fs = require('fs');
const path = require('path');
const assert = require('assert');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

const operations = read('apps/follow-up-dashboard/operations.html');

[
  "const DASHBOARD_URL",
  'function dashboardUrl(item, phase, fallbackDate)',
  'const EQUIPMENT_VISIBLE_LIMIT = 4',
  "params.set('date', date)",
  "params.set('search', item.tid)",
  "params.set('tab', phase)",
  'class="schedule-link"',
  'renderEquipmentList(it.items)',
  'class="equip-list"',
  'class="equip-chip"',
  'normalized.slice(0, EQUIPMENT_VISIBLE_LIMIT)',
  'class="equip-chip more"',
  "'외 ' + hiddenCount + '개'"
].forEach((contract) => {
  assert(
    operations.includes(contract),
    `operations.html must link operation rows to today schedule and render readable equipment chips: ${contract}`
  );
});

assert(
  !/itemsToText\(it\.items\)/.test(operations),
  'operations checkout/checkin rows must not render equipment as one comma-separated text string'
);

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
});

console.log('operations dashboard link static checks passed');
