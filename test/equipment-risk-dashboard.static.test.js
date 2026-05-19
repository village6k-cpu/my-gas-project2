const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

const backend = read('checkAvailability.js');
const api = read('sheetAPI.js');

[
  "var EQUIPMENT_RISK_RULE_SHEET_NAME = '장비주의사항';",
  'function getEquipmentRiskRules_()',
  'function matchEquipmentRiskRulesForEquipments_(equipments, rules)',
  'riskWarnings: attachEquipmentRiskWarnings_(displayEquip, riskRules)',
  'evaluateEquipmentRiskGuidanceStates_(result);'
].forEach((contract) => {
  assert.ok(
    backend.indexOf(contract) !== -1,
    `checkAvailability.js must include contract: ${contract}`
  );
});

[
  "case \"equipmentRiskSend\":",
  'jsonResponse(sendEquipmentRiskGuidance_(postBody.payload || postBody))',
  "case \"equipmentRiskEvent\":",
  'jsonResponse(recordEquipmentRiskEvent_(postBody.payload || postBody))'
].forEach((contract) => {
  assert.ok(
    api.indexOf(contract) !== -1,
    `sheetAPI.js must include contract: ${contract}`
  );
});

['dashboard.html', 'docs/dashboard.html'].forEach((file) => {
  const html = read(file);

  [
    'function riskWarningSummaryHtml(item, cardType)',
    'function equipmentRiskPanelHtml(item, cardType)',
    'function sendEquipmentRiskGuidance(btn)',
    'function recordEquipmentRiskEvent(btn, eventType)'
  ].forEach((contract) => {
    assert.ok(
      html.indexOf(contract) !== -1,
      `${file} must include contract: ${contract}`
    );
  });
});

console.log('equipment risk dashboard static checks passed');
