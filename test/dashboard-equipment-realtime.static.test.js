const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

const backend = read('checkAvailability.js');
const code = read('Code.js');
const sheetApi = read('sheetAPI.js');
const generateContract = read('generatecontract.js');

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
  /contractRegenPending:\s*true/,
  'dashboardAddEquipments must tell the UI that the contract link is temporarily stale'
);
assert.match(
  batchAddBody[0],
  /requestedItems:\s*addEntries\.map/,
  'dashboardAddEquipments must keep requestedItems separate for onsite-addon logging'
);
assert.match(
  batchAddBody[0],
  /var scheduleData\s*=\s*getDashboardAvailabilityScheduleData_\(sched,\s*lastRow,\s*targetEquipmentNames\)/,
  'dashboardAddEquipments must use cached availability schedule data instead of reading matched rows live'
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
  /if \(!dryRun\)\s*\{[\s\S]{0,120}LockService\.getScriptLock\(\)/,
  'dashboard add/quantity dry-run checks must not wait on the write lock'
);

assert.match(
  backend,
  /scheduleId:\s*update\.scheduleId/,
  'dashboardUpdateEquipmentQty must include scheduleId in updatedItems'
);
assert.match(
  backend,
  /contractRegenPending:\s*!dryRun/,
  'dashboardUpdateEquipmentQty must mark the contract link stale after real quantity edits'
);

const availabilityRowsBody = backend.match(/function findDashboardScheduleRowsForEquipments_\([\s\S]*?\n}\n\nfunction buildDashboardScheduleData_/);
assert.ok(availabilityRowsBody, 'findDashboardScheduleRowsForEquipments_ must exist before buildDashboardScheduleData_');
assert.doesNotMatch(
  availabilityRowsBody[0],
  /createTextFinder/,
  'availability checks must not do a slow live sheet search for every add request'
);
assert.match(
  availabilityRowsBody[0],
  /var rowsCacheKey\s*=\s*getDashboardAvailabilityRowsCacheKey_\(lastRow,\s*targetNames\)[\s\S]*getDashboardCacheJson_\(cache,\s*rowsCacheKey\)[\s\S]*getDashboardAvailabilityRowIndex_\(sheet,\s*lastRow\)[\s\S]*putDashboardCacheJson_\(cache,\s*rowsCacheKey,\s*rowsToRead,\s*300\)/,
  'availability checks should cache matched row numbers for repeated add-equipment checks'
);
assert.match(
  availabilityRowsBody[0],
  /readDashboardScheduleRows_\(sheet,\s*rowsToRead,\s*10\)/,
  'availability checks should read full schedule columns only for matched equipment rows'
);

assert.match(
  backend,
  /function getDashboardAvailabilityRowIndex_\(sheet,\s*lastRow\)[\s\S]*getDashboardCacheJson_\(cache,\s*cacheKey\)[\s\S]*putDashboardCacheJson_\(cache,\s*cacheKey,\s*index,\s*300\)/,
  'dashboard availability row index must be cached between add-equipment checks'
);

assert.match(
  backend,
  /function getDashboardAvailabilityRowsCacheKey_\(lastRow,\s*targetNames\)[\s\S]*Utilities\.computeDigest/,
  'dashboard availability matched-row cache key must be stable and compact'
);

assert.match(
  backend,
  /function getDashboardAvailabilityScheduleMap_\(sheet,\s*lastRow\)[\s\S]*getDashboardCacheJson_\(cache,\s*cacheKey\)[\s\S]*sheet\.getRange\(2,\s*1,\s*lastRow - 1,\s*10\)\.getValues\(\)[\s\S]*putDashboardCacheJson_\(cache,\s*cacheKey,\s*map,\s*300\)/,
  'dashboard availability schedule map must be cached so add-equipment checks avoid live schedule scans'
);

assert.match(
  backend,
  /function warmDashboardAvailabilityRowIndex_\(\)[\s\S]*getDashboardAvailabilityRowIndex_\(sched,\s*lastRow\)[\s\S]*getDashboardAvailabilityScheduleMap_\(sched,\s*lastRow\)/,
  'dashboard warmer must prebuild availability row and schedule caches in the background'
);

assert.match(
  backend,
  /function warmDashboardMutationCaches_\(\)[\s\S]*getDashboardEquipNameList_\(ss\)[\s\S]*buildDashboardSetLookup_\(ss\.getSheetByName\("세트마스터"\)\)[\s\S]*buildDashboardEquipmentMeta_\(equipSheet\)/,
  'dashboard warmer must prebuild add-equipment mutation caches in the background'
);

assert.match(
  sheetApi,
  /case "dashboardEquipNames":[\s\S]*names:\s*getDashboardEquipNameList_\(SpreadsheetApp\.getActiveSpreadsheet\(\)\)/,
  'sheetAPI must expose a cached dedicated dashboardEquipNames endpoint instead of forcing the UI through generic sheet reads'
);

assert.match(
  sheetApi,
  /var INITIAL_EQUIP_NAMES = null;[\s\S]*var INITIAL_EQUIP_NAMES = ' \+ JSON\.stringify\(initialEquipNames\) \+ ';'/,
  'GAS dashboard page must inline cached equipment names when available'
);

assert.match(
  code,
  /CONTRACT_REGEN_TRIGGER_PROP_[\s\S]{0,900}hasRecentScheduledTrigger[\s\S]{0,260}ScriptApp\.getProjectTriggers\(\)/,
  'contract regen scheduling must skip trigger-list scans when a recent regen trigger is already scheduled'
);
assert.match(
  code,
  /function scheduleContractRegen\(거래ID\)[\s\S]*invalidateDashboardTradeExtraCache_\(\[거래ID\]\)/,
  'contract regen scheduling must invalidate cached contract links immediately'
);

assert.match(
  code,
  /function regenPendingContracts\([\s\S]*props\.deleteProperty\(CONTRACT_REGEN_TRIGGER_PROP_\)[\s\S]*props\.setProperty\(CONTRACT_REGEN_TRIGGER_PROP_/,
  'contract regen worker must clear and refresh the scheduled-trigger marker'
);
assert.match(
  code,
  /deleteAndRegenerateContract\(ss,\s*거래ID\)[\s\S]*invalidateDashboardTradeExtraCache_\(\[거래ID\]\)/,
  'contract regen worker must invalidate cached contract links after regeneration'
);
assert.match(
  generateContract,
  /function clearDirectContractRegenPending_\(거래ID\)[\s\S]*deleteProperty\('contractEditTS_' \+ 거래ID\)[\s\S]*invalidateDashboardTradeExtraCache_\(\[거래ID\]\)/,
  'direct contract regeneration must clear pending state and stale contract-link caches'
);
assert.match(
  generateContract,
  /function regenerateContractById\(거래ID,\s*추가요청\)[\s\S]*deleteAndRegenerateContract\(ss,\s*거래ID,\s*extraText\)[\s\S]*clearDirectContractRegenPending_\(거래ID\)/,
  'regenerateContractById must prevent the fallback trigger from regenerating the same contract again after immediate regeneration succeeds'
);
assert.match(
  backend,
  /function getDashboardContractExtrasByIds_\(ids\)[\s\S]*getTradeExtrasForIds_\(tradeIds,\s*props\)/,
  'dashboard must expose a lightweight contract-extra lookup so stale pending buttons can self-heal without reloading a whole date'
);
assert.match(
  sheetApi,
  /case ["']dashboardContractExtras["'][\s\S]{0,260}getDashboardContractExtrasByIds_\(/,
  'sheetAPI must expose dashboardContractExtras for contract pending reconciliation'
);

const removeBackendBody = backend.match(/function dashboardRemoveEquipment\([\s\S]*?\n}\n\n\n\/\*\* "yyyy-MM-dd"/);
assert.ok(removeBackendBody, 'dashboardRemoveEquipment must exist before parseDT');
assert.match(
  removeBackendBody[0],
  /deleteDashboardRowsDescending_\(sched,\s*rowsToDelete\)/,
  'dashboardRemoveEquipment must batch contiguous row deletion'
);
assert.match(
  removeBackendBody[0],
  /var contractRegenPending = true[\s\S]*contractRegenPending = false[\s\S]*catch \(regenErr\)[\s\S]*scheduleContractRegen\(tid\)[\s\S]*contractRegenPending:\s*contractRegenPending/,
  'dashboardRemoveEquipment must clear pending after direct regeneration and keep pending when fallback regeneration is queued'
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
    'function captureDashboardTradeFieldsSnapshot(',
    'function markDashboardContractRegenPending(',
    'function syncDashboardContractFieldsFromData(',
    'function dashboardHasPendingContractRegen(',
    'function collectDashboardPendingContractTids(',
    'function collectDashboardContractStatusRefreshTids(',
    'function dashboardContractNeedsLookup(',
    'function syncDashboardContractFieldsFromExtras(',
    'function queueDashboardPendingContractStatusRefresh(',
    'function refreshDashboardPendingContractStatus(',
    'function queueDashboardContractRegeneration(',
    'function startDashboardContractRegeneration('
  ].forEach((contract) => {
    assert.ok(html.includes(contract), `${file} must include realtime equipment helper: ${contract}`);
  });

  assert.match(
    html,
    /contractRegenPending[\s\S]{0,140}계약서 갱신 중/,
    `${file} must not open stale contract links while regeneration is pending`
  );
  assert.match(
    html,
    /dashboardContractNeedsLookup\(item\)[\s\S]{0,180}계약서 확인 중/,
    `${file} must not render fast-search or stale cached cards as 계약서 없음 before checking live contract links`
  );

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
    /queueDashboardSilentRefresh\(6500\)/,
    `${file} removeEquip must refresh after the contract regen debounce window, not before it`
  );
  assert.match(
    removeBody[0],
    /queueDashboardContractRegeneration\(tid\)/,
    `${file} removeEquip must start contract regeneration immediately after the schedule edit succeeds`
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
    /queueDashboardSilentRefresh\(6500\)/,
    `${file} editEquipQty must refresh after the contract regen debounce window, not before it`
  );
  assert.match(
    qtyBody[0],
    /queueDashboardContractRegeneration\(tid\)/,
    `${file} editEquipQty must start contract regeneration immediately after the schedule edit succeeds`
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

  const itemsForTradeBody = html.match(/function dashboardItemsForTrade\(tid\)[\s\S]*?\n}\n\nfunction dashboardEquipmentMutationTargets/);
  assert.ok(itemsForTradeBody, `${file} must expose dashboardItemsForTrade before dashboardEquipmentMutationTargets`);
  assert.match(
    itemsForTradeBody[0],
    /collect\(dashboardData\)[\s\S]*collect\(dashboardGlobalSearchData\)/,
    `${file} trade-level edits must update active search results as well as selected-date data`
  );

  assert.match(
    html,
    /function dashboardItemsForScheduleId\(scheduleId\)[\s\S]*collect\(dashboardData\)[\s\S]*collect\(dashboardGlobalSearchData\)/,
    `${file} equipment check edits must update search-result equipment rows as well as selected-date rows`
  );

  const syncItemBody = html.match(/function syncItemCheckInMemory\(scheduleId,\s*phase,\s*done\)[\s\S]*?persistCurrentDashboardCache\(\);\n}/);
  assert.ok(syncItemBody, `${file} must expose syncItemCheckInMemory before escHtml`);
  assert.match(
    syncItemBody[0],
    /dashboardItemsForScheduleId\(scheduleId\)\.forEach/,
    `${file} equipment row checks must sync the global-search in-memory card immediately`
  );
  assert.doesNotMatch(
    syncItemBody[0],
    /if \(!dashboardData\) return/,
    `${file} equipment row checks must still sync when the active card only lives in global search results`
  );

  [
    'syncContractStatusInMemory',
    'syncEquipmentCheckInMemory',
    'syncTradeProofInMemory',
    'syncBillingCompanyInMemory',
    'syncPaymentInMemory',
    'syncTaskDoneInMemory'
  ].forEach((fn) => {
    const body = html.match(new RegExp('function ' + fn + '\\([\\s\\S]*?\\n}\\n\\nfunction '));
    assert.ok(body, `${file} must expose ${fn}`);
    assert.doesNotMatch(
      body[0],
      /if \(!dashboardData\) return/,
      `${file} ${fn} must not skip active global-search cards`
    );
  });

  assert.match(
    html,
    /data-task-action="' \+ taskAction \+ '" data-trade-id="' \+ escAttr\(item\.tradeId\) \+ '"/,
    `${file} task toggle buttons must carry trade ids for instant duplicate-card syncing`
  );
  assert.match(
    html,
    /function syncTaskToggleDom\(tid,\s*action,\s*done,\s*doneAt\)[\s\S]*data-task-action[\s\S]*data-trade-id[\s\S]*setTaskToggleLabel/,
    `${file} task toggle DOM must update all visible cards immediately`
  );
  assert.match(
    html,
    /function toggleTask\(btn,\s*tid,\s*action\)[\s\S]*var optimisticDoneAt[\s\S]*syncTaskToggleDom\(tid,\s*action,\s*nowDone,\s*optimisticDoneAt\)[\s\S]*fetch\(/,
    `${file} return/setup toggles must show the checked result before the slow GAS write returns`
  );
  assert.match(
    html,
    /var dashboardTaskToggleInFlight\s*=\s*\{\};[\s\S]*function dashboardTaskToggleKey\(tid,\s*action\)/,
    `${file} task toggles must track in-flight saves by trade/action`
  );
  assert.match(
    html,
    /function toggleTask\(btn,\s*tid,\s*action\)[\s\S]*beginDashboardMutation\(\)[\s\S]*captureDashboardTaskDoneSnapshot\(tid,\s*action\)[\s\S]*dashboardTaskToggleInFlight\[key\]\s*=\s*true[\s\S]*setTaskToggleSaving\(tid,\s*action,\s*true\)[\s\S]*delete dashboardTaskToggleInFlight\[key\][\s\S]*setTaskToggleSaving\(tid,\s*action,\s*false\)/,
    `${file} task toggles must lock duplicate clicks and protect optimistic state from stale refreshes`
  );
  assert.match(
    html,
    /function toggleTask\(btn,\s*tid,\s*action\)[\s\S]*method:\s*'POST'[\s\S]*action:\s*action[\s\S]*done:\s*nowDone \? '1' : '0'/,
    `${file} task toggles must use POST mutations instead of cache-prone GET mutations`
  );
  assert.match(
    html,
    /function toggleTask\(btn,\s*tid,\s*action\)[\s\S]*catch\(function\(\) \{[\s\S]*restoreDashboardTaskDoneSnapshot\(snapshot\)[\s\S]*finishDashboardMutation\(mutationToken\)/,
    `${file} task toggles must rollback optimistic state on failed saves`
  );

  assert.match(
    html,
    /data-schedule-id="' \+ escAttr\(eq\.scheduleId\)[\s\S]*data-phase="' \+ phaseStr/,
    `${file} equipment checkboxes must carry schedule ids for instant duplicate-row syncing`
  );
  assert.match(
    html,
    /function syncEquipmentCheckDom\(scheduleId,\s*phase,\s*done\)[\s\S]*data-schedule-id[\s\S]*data-phase[\s\S]*row\.classList\.toggle\('checked',\s*done\)/,
    `${file} equipment checkbox DOM must update all visible copies immediately`
  );
  assert.match(
    html,
    /function toggleItem\(cb,\s*scheduleId,\s*phase\)[\s\S]*syncEquipmentCheckDom\(scheduleId,\s*phase,\s*nowDone\)[\s\S]*fetch\(/,
    `${file} equipment checkbox clicks must update visible search rows before GAS returns`
  );
  assert.match(
    html,
    /var dashboardItemToggleInFlight\s*=\s*\{\};[\s\S]*function dashboardItemToggleKey\(scheduleId,\s*phase\)/,
    `${file} equipment checkboxes must track in-flight saves by schedule/phase`
  );
  assert.match(
    html,
    /function toggleItem\(cb,\s*scheduleId,\s*phase\)[\s\S]*beginDashboardMutation\(\)[\s\S]*captureDashboardItemCheckSnapshot\(scheduleId,\s*phase\)[\s\S]*dashboardItemToggleInFlight\[key\]\s*=\s*true[\s\S]*setEquipmentCheckSaving\(scheduleId,\s*phase,\s*true\)[\s\S]*delete dashboardItemToggleInFlight\[key\][\s\S]*setEquipmentCheckSaving\(scheduleId,\s*phase,\s*false\)/,
    `${file} equipment checkboxes must lock duplicate clicks and protect optimistic state from stale refreshes`
  );
  assert.match(
    html,
    /function toggleItem\(cb,\s*scheduleId,\s*phase\)[\s\S]*method:\s*'POST'[\s\S]*action:\s*'toggleItem'[\s\S]*done:\s*nowDone \? '1' : '0'/,
    `${file} equipment checkboxes must use POST mutations instead of cache-prone GET mutations`
  );
  assert.match(
    html,
    /function toggleItem\(cb,\s*scheduleId,\s*phase\)[\s\S]*catch\(function\(\) \{[\s\S]*restoreDashboardItemCheckSnapshot\(snapshot\)[\s\S]*finishDashboardMutation\(mutationToken\)/,
    `${file} equipment checkboxes must rollback optimistic state on failed saves`
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
    /queueDashboardSilentRefresh\(6500\)/,
    `${file} confirmAddEquip must refresh after the contract regen debounce window, not before it`
  );
  assert.match(
    addBody[0],
    /queueDashboardContractRegeneration\(tid\)/,
    `${file} confirmAddEquip must start contract regeneration immediately after the schedule edit succeeds`
  );
  assert.match(
    html,
    /function startDashboardContractRegeneration\(tid\)[\s\S]*action:\s*'run'[\s\S]*func:\s*'regenerateContractById'[\s\S]*tradeId:\s*tid[\s\S]*contractRegenPending\s*=\s*false/,
    `${file} must regenerate the contract in the background and clear the pending button state when the new link is ready`
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

  const equipListBody = html.match(/function loadEquipList\([\s\S]*?\n}\n\nfunction hideEquipSuggestions/);
  assert.ok(equipListBody, `${file} must expose loadEquipList before suggestion helpers`);
  assert.match(
    equipListBody[0],
    /action=dashboardEquipNames/,
    `${file} add-equipment dropdown must use the cached dedicated equipment-name API`
  );
  assert.doesNotMatch(
    equipListBody[0],
    /action=read[\s\S]*sheet=/,
    `${file} add-equipment dropdown must not use the slow generic 목록 sheet read`
  );
  assert.match(
    html,
    /function attachEquipDropdown\([\s\S]*openEquipSuggestions/,
    `${file} add-equipment rows must attach a visible suggestion dropdown`
  );
  assert.match(
    html,
    /attachEquipDropdown\(input\)/,
    `${file} addEquipRow must attach the equipment suggestion dropdown to every row`
  );
  assert.match(
    html,
    /var EQUIP_LIST_LOCAL_KEY\s*=\s*'dashboardEquipNames_v1';/,
    `${file} equipment names must keep a local cache for repeated add-equipment opens`
  );
  assert.match(
    html,
    /function hydrateInitialEquipList\([\s\S]*INITIAL_EQUIP_NAMES/,
    `${file} equipment names must hydrate from embedded data or local cache before the modal is used`
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
  assert.match(
    html,
    /var DASHBOARD_MUTATION_REFRESH_MIN_DELAY_MS\s*=\s*5000;/,
    `${file} must keep post-mutation refresh delayed enough to avoid overwriting optimistic edits`
  );
  assert.match(
    silentRefreshBody[0],
    /Math\.max\(Number\(delayMs\) \|\| 0,\s*DASHBOARD_MUTATION_REFRESH_MIN_DELAY_MS\)/,
    `${file} must enforce the minimum post-mutation silent refresh delay`
  );
  assert.doesNotMatch(
    silentRefreshBody[0],
    /renderDashboard\(/,
    `${file} silent refresh must not force a second full dashboard render`
  );
  assert.match(
    silentRefreshBody[0],
    /collectDashboardContractStatusRefreshTids\(\)\.length[\s\S]*queueDashboardPendingContractStatusRefresh\(1000\)/,
    `${file} silent refresh must reconcile stale pending and missing contract buttons in search results, not only the current date`
  );
  assert.match(
    html,
    /function refreshDashboardPendingContractStatus\(\)[\s\S]*action=dashboardContractExtras[\s\S]*syncDashboardContractFieldsFromExtras\(/,
    `${file} must poll lightweight contract extras to clear stale regeneration buttons after background regen finishes`
  );
  assert.match(
    html,
    /function renderDashboardGlobalSearch\(data\)[\s\S]*queueDashboardPendingContractStatusRefresh\(1000\)/,
    `${file} fast global search summaries must immediately reconcile missing contract links instead of leaving 계약서 없음 buttons`
  );
});

console.log('dashboard equipment realtime static checks passed');
