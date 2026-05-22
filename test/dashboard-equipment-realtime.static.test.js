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

const availabilityRowsBody = backend.match(/function findDashboardScheduleRowsForEquipments_\([\s\S]*?\n}\n\nfunction buildDashboardScheduleData_/);
assert.ok(availabilityRowsBody, 'findDashboardScheduleRowsForEquipments_ must exist before buildDashboardScheduleData_');
assert.doesNotMatch(
  availabilityRowsBody[0],
  /createTextFinder|findDashboardRowsByValue_/,
  'availability checks must not run one TextFinder scan per equipment name'
);
assert.match(
  availabilityRowsBody[0],
  /getRange\(2,\s*4,\s*lastRow - 1,\s*1\)\.getValues\(\)/,
  'availability checks should scan only the equipment-name column before reading matched schedule rows'
);
assert.match(
  availabilityRowsBody[0],
  /readDashboardScheduleRows_\(sheet,\s*rowsToRead,\s*10\)/,
  'availability checks should read full schedule columns only for matched equipment rows'
);

const removeBackendBody = backend.match(/function dashboardRemoveEquipment\([\s\S]*?\n}\n\n\n\/\*\* "yyyy-MM-dd"/);
assert.ok(removeBackendBody, 'dashboardRemoveEquipment must exist before parseDT');
assert.match(
  removeBackendBody[0],
  /deleteDashboardRowsDescending_\(sched,\s*rowsToDelete\)/,
  'dashboardRemoveEquipment must batch contiguous row deletion'
);
assert.doesNotMatch(
  removeBackendBody[0],
  /formatScheduleSheet\(sched\)/,
  'dashboardRemoveEquipment must not reformat the full schedule sheet after deletion'
);

['dashboard.html', 'docs/dashboard.html'].forEach((file) => {
  const html = read(file);

  [
    'function applyDashboardEquipmentMutation(',
    'function syncDashboardEquipmentAdditions(',
    'function syncDashboardEquipmentRemoval(',
    'function syncDashboardEquipmentQtyUpdate(',
    'function renderDashboardEquipmentMutation(',
    'function queueDashboardSilentRefresh(',
    'function beginDashboardMutation(',
    'function finishDashboardMutation(',
    'function canApplyDashboardResponse(',
    'function hasDashboardVisibleDataForDate(',
    'function captureDashboardTradeFieldsSnapshot('
  ].forEach((contract) => {
    assert.ok(html.includes(contract), `${file} must include realtime equipment helper: ${contract}`);
  });

  const loadDataBody = html.match(/function loadData\(forceFresh\)[\s\S]*?\n}\n\nfunction refreshData/);
  assert.ok(loadDataBody, `${file} must expose loadData before refreshData`);
  assert.match(
    loadDataBody[0],
    /hasDashboardVisibleDataForDate\(dateStr\)[\s\S]*showDashboardLoading\(dateStr,\s*renderedCached \|\| hasVisibleData\)/,
    `${file} force-fresh dashboard reloads must keep the current card UI visible`
  );
  assert.match(
    loadDataBody[0],
    /canApplyDashboardResponse\(mutationSeqAtRequest\)/,
    `${file} stale dashboard responses must not overwrite local in-flight edits`
  );

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
  assert.match(
    removeBody[0],
    /var snapshot\s*=\s*captureDashboardEquipmentSnapshot\(tid\)[\s\S]*applyDashboardEquipmentMutation\(tid,\s*\{\},\s*\{[\s\S]*fetch\(/,
    `${file} removeEquip must update the card before waiting for the slow GAS request`
  );
  assert.match(
    removeBody[0],
    /beginDashboardMutation\(\)[\s\S]*finishDashboardMutation\(mutationToken\)/,
    `${file} removeEquip must protect optimistic deletion from stale dashboard reloads`
  );
  assert.match(
    removeBody[0],
    /restoreDashboardEquipmentSnapshot\(snapshot\)/,
    `${file} removeEquip must restore the card if the save fails`
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
  assert.match(
    qtyBody[0],
    /var snapshot\s*=\s*captureDashboardEquipmentSnapshot\(tid\)[\s\S]*applyDashboardEquipmentMutation\(tid,\s*\{\},\s*\{[\s\S]*fetch\(/,
    `${file} editEquipQty must update the card before waiting for the slow GAS request`
  );
  assert.match(
    qtyBody[0],
    /beginDashboardMutation\(\)[\s\S]*finishDashboardMutation\(mutationToken\)/,
    `${file} editEquipQty must protect optimistic quantity edits from stale dashboard reloads`
  );

  const memoBody = html.match(/function updateEquipmentCheck\([\s\S]*?\n}\n\nfunction updateContractStatus/);
  assert.ok(memoBody, `${file} must expose updateEquipmentCheck before updateContractStatus`);
  assert.doesNotMatch(
    memoBody[0],
    /loadData\(true\)/,
    `${file} memo/status saves must not trigger a full loading dashboard reload`
  );
  assert.match(
    memoBody[0],
    /beginDashboardMutation\(\)[\s\S]*captureDashboardTradeFieldsSnapshot\(payload\.tid\)[\s\S]*syncEquipmentCheckInMemory\(payload,\s*null\)[\s\S]*fetch\(/,
    `${file} memo/status saves must update dashboard memory before waiting for GAS`
  );
  assert.match(
    memoBody[0],
    /restoreDashboardTradeFieldsSnapshot\(snapshot\)[\s\S]*finishDashboardMutation\(mutationToken\)/,
    `${file} memo/status saves must rollback local memory on failure`
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
  assert.match(
    addBody[0],
    /var snapshot\s*=\s*captureDashboardEquipmentSnapshot\(tid\)[\s\S]*closeAddEquipModal\(\)[\s\S]*applyDashboardEquipmentMutation\(tid,\s*\{\},\s*\{[\s\S]*request\.then/,
    `${file} confirmAddEquip must close the modal and show a pending row before the slow GAS request returns`
  );
  assert.match(
    addBody[0],
    /beginDashboardMutation\(\)[\s\S]*finishDashboardMutation\(mutationToken\)/,
    `${file} confirmAddEquip must protect pending add rows from stale dashboard reloads`
  );
  assert.match(
    html,
    /function captureDashboardEquipmentSnapshot\(|function restoreDashboardEquipmentSnapshot\(|is-pending|pending:\s*true|저장중/,
    `${file} must include optimistic equipment mutation state and rollback helpers`
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
