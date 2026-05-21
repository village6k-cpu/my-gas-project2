const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

const backend = read('checkAvailability.js');

assert.match(
  backend,
  /function dashboardAddedItemsFromRows_\([\s\S]*scheduleId:[\s\S]*quantity:/,
  'dashboard add responses must include scheduleId and quantity-compatible fields'
);

const batchAddBody = backend.match(/function dashboardAddEquipments\([\s\S]*?\n}\n\nfunction dashboardRecordOnsiteAddon/);
assert.ok(batchAddBody, 'dashboardAddEquipments must exist before dashboardRecordOnsiteAddon');
assert.match(
  batchAddBody[0],
  /addedItems:\s*dashboardAddedItemsFromRows_\(newRows\)/,
  'dashboardAddEquipments must return actual added row details so the UI does not need a slow full dashboard refresh'
);
assert.match(
  batchAddBody[0],
  /requestedItems:\s*addEntries\.map/,
  'dashboardAddEquipments must keep requestedItems separate for onsite-addon logging'
);
assert.match(
  backend,
  /items:\s*addResult\.requestedItems\s*\|\|\s*addResult\.addedItems/,
  'dashboardRecordOnsiteAddon must not use expanded component rows as the onsite-addon request payload'
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

  const applyBody = html.match(/function applyDashboardEquipmentMutation\([\s\S]*?\n}\n\nfunction showDashboardToast/);
  assert.ok(applyBody, `${file} must expose applyDashboardEquipmentMutation before showDashboardToast`);
  assert.doesNotMatch(
    applyBody[0],
    /queueDashboardSilentRefresh/,
    `${file} equipment mutation must not enqueue the slow full dashboard refresh after every edit`
  );

  const renderMutationBody = html.match(/function renderDashboardEquipmentMutation\([\s\S]*?\n}\n\nfunction queueDashboardSilentRefresh/);
  assert.ok(renderMutationBody, `${file} must expose renderDashboardEquipmentMutation before queueDashboardSilentRefresh`);
  assert.doesNotMatch(
    renderMutationBody[0],
    /scheduleDashboardSectionWarmup|clearDashboardCacheForDate/,
    `${file} mutation render must only update the active view without cache churn or hidden-section warmup`
  );

  const silentRefreshBody = html.match(/function queueDashboardSilentRefresh\([\s\S]*?\n}\n\nfunction applyDashboardEquipmentMutation/);
  assert.ok(silentRefreshBody, `${file} must expose queueDashboardSilentRefresh before applyDashboardEquipmentMutation`);
  assert.doesNotMatch(
    silentRefreshBody[0],
    /renderDashboard\(/,
    `${file} silent refresh must not force a second full dashboard render`
  );
});

console.log('dashboard equipment realtime static checks passed');
