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
  '고객카톡문구',
  '민감발송',
  '재추천차단일',
  'customerPhone: item.customerPhone || item.tel || item.customerTel ||',
  'riskItems: (item.riskWarnings || []).map(equipmentRiskBackendItem_)',
  'var evaluatedWarnings = evaluated.riskItems || evaluated.warnings || evaluated.riskWarnings || [];',
  'evaluateEquipmentRiskGuidanceStates_(result);',
  "if (payload.riskAction === 'approval' || payload.sendMode === 'approval_request') payload.action = 'approval';",
  "postEquipmentRiskBackend_('/admin/equipment-risk/customer-guidance'",
  "postEquipmentRiskBackend_('/admin/equipment-risk/events'"
].forEach((contract) => {
  assert.ok(
    backend.indexOf(contract) !== -1,
    `checkAvailability.js must include backend contract: ${contract}`
  );
});

assert.doesNotMatch(
  backend,
  /postEquipmentRiskBackend_\('\/admin\/equipment-risk\/send'/,
  'send proxy must not use the old /send path'
);

assert.doesNotMatch(
  backend,
  /postEquipmentRiskBackend_\('\/admin\/equipment-risk\/event'/,
  'event proxy must not use the old singular /event path'
);

assert.ok(
  (backend.match(/evaluateEquipmentRiskGuidanceStates_\(result\);/g) || []).length >= 2,
  'dashboard and dashboardSearch results must both evaluate equipment risk guidance states'
);

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

  [
    'customerPhone: item.customerPhone || item.tel || item.customerTel ||',
    'pickup_ack',
    'return_ok',
    'return_issue',
    'return_not_checked',
    "if (payload.sendMode === 'approval_request') {",
    "payload.action = 'approval';",
    "payload.riskAction = 'approval';",
    'payload.notes = note;',
    "if (state === 'recommend') return '발송 권장';",
    "if (state === 'recent_sent') return '최근 발송';",
    "if (state === 'recipient_missing') return '대상 없음';",
    "confirm(confirmText)",
    "dashboardApiPayload('equipmentRiskSend'",
    'dashboardApiPayload('
  ].forEach((contract) => {
    assert.ok(
      html.indexOf(contract) !== -1,
      `${file} must include dashboard contract: ${contract}`
    );
  });

  const confirmIndex = html.indexOf('confirm(confirmText)');
  const sendIndex = html.indexOf("dashboardApiPayload('equipmentRiskSend'");
  assert.ok(
    confirmIndex !== -1 && sendIndex !== -1 && confirmIndex < sendIndex,
    `${file} must confirm before posting equipmentRiskSend`
  );

  [
    'pickup_acknowledged',
    'return_unknown',
    'payload.note = note'
  ].forEach((unsupported) => {
    assert.ok(
      html.indexOf(unsupported) === -1,
      `${file} must not use unsupported event name: ${unsupported}`
    );
  });
});

console.log('equipment risk dashboard static checks passed');
