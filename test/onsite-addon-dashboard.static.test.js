const fs = require('fs');
const path = require('path');
const assert = require('assert');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

const api = read('sheetAPI.js');
const logic = read('checkAvailability.js');

[
  'case "onsiteAddon":',
  'dashboardRecordOnsiteAddon('
].forEach((contract) => {
  assert(
    api.includes(contract),
    `sheetAPI.js must expose today-checkout onsite addon contract: ${contract}`
  );
});

[
  'function dashboardRecordOnsiteAddon(tid, entries, options)',
  'recordOnsiteAddonBackend_(payload)',
  "postEquipmentRiskBackend_('/admin/onsite-addons'",
  "source: 'schedule_button'"
].forEach((contract) => {
  assert(
    logic.includes(contract),
    `checkAvailability.js must record onsite addon contract: ${contract}`
  );
});

['dashboard.html', 'docs/dashboard.html'].forEach((file) => {
  const html = read(file);
  [
    '+ 현장추가',
    'function addOnsiteAddon(tid)',
    "action: 'onsiteAddon'",
    'addEquipSettlement',
    "mode === 'onsite' ? postOnsiteAddonBatch"
  ].forEach((contract) => {
    assert(
      html.includes(contract),
      `${file} must expose today-checkout onsite addon UI contract: ${contract}`
    );
  });
});

console.log('onsite addon dashboard static checks passed');
