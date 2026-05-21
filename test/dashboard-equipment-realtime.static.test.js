const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

const backend = read('checkAvailability.js');

assert.match(
  backend,
  /addedItems:\s*newRows\.map/,
  'dashboardAddEquipment(s) must return addedItems so the UI can update without a full dashboard reload'
);

assert.match(
  backend,
  /removedScheduleIds:\s*removedScheduleIds/,
  'dashboardRemoveEquipment must return removedScheduleIds so the UI can remove rows immediately'
);

assert.match(
  backend,
  /scheduleId:\s*update\.scheduleId/,
  'dashboardUpdateEquipmentQty must include scheduleId in updatedItems'
);

['dashboard.html', 'docs/dashboard.html'].forEach((file) => {
  const html = read(file);

  [
    'function applyDashboardEquipmentMutation(',
    'function syncDashboardEquipmentAdditions(',
    'function syncDashboardEquipmentRemoval(',
    'function syncDashboardEquipmentQtyUpdate(',
    'function renderDashboardEquipmentMutation(',
    'function queueDashboardSilentRefresh('
  ].forEach((contract) => {
    assert.ok(html.includes(contract), `${file} must include realtime equipment helper: ${contract}`);
  });

  const removeBody = html.match(/function removeEquip\([\s\S]*?\n}\n\nfunction editEquipQty/);
  assert.ok(removeBody, `${file} must expose removeEquip before editEquipQty`);
  assert.doesNotMatch(
    removeBody[0],
    /loadData\(true\)/,
    `${file} removeEquip success must not trigger the full loading dashboard reload`
  );
  assert.match(
    removeBody[0],
    /applyDashboardEquipmentMutation\(tid,\s*res,\s*\{[\s\S]*operation:\s*'remove'/,
    `${file} removeEquip must apply a realtime remove mutation`
  );

  const qtyBody = html.match(/function editEquipQty\([\s\S]*?\n}\n\nfunction tradeReturnFieldsHtml/);
  assert.ok(qtyBody, `${file} must expose editEquipQty before tradeReturnFieldsHtml`);
  assert.doesNotMatch(
    qtyBody[0],
    /loadData\(true\)/,
    `${file} editEquipQty success must not trigger the full loading dashboard reload`
  );
  assert.match(
    qtyBody[0],
    /applyDashboardEquipmentMutation\(tid,\s*res,\s*\{[\s\S]*operation:\s*'qty'/,
    `${file} editEquipQty must apply a realtime qty mutation`
  );

  const addBody = html.match(/function confirmAddEquip\([\s\S]*?<\/script>/);
  assert.ok(addBody, `${file} must expose confirmAddEquip near the modal script end`);
  assert.doesNotMatch(
    addBody[0],
    /loadData\(true\)/,
    `${file} confirmAddEquip success must not trigger the full loading dashboard reload`
  );
  assert.match(
    addBody[0],
    /applyDashboardEquipmentMutation\(tid,\s*res,\s*\{[\s\S]*operation:\s*'add'/,
    `${file} confirmAddEquip must apply a realtime add mutation`
  );
});

console.log('dashboard equipment realtime static checks passed');
