const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

const checklist = read('apps/today-dashboard/components/HandoverChecklist.tsx');
const store = read('apps/today-dashboard/lib/data/store.ts');
const gasRoute = read('apps/today-dashboard/app/api/gas/route.ts');
const sheetApi = read('sheetAPI.js');
const checkAvailability = read('checkAvailability.js');

assert(
  checklist.includes('SetSingleList'),
  'single set equipment must keep the set-header tinted container instead of falling back to a plain loose list'
);
assert(
  /function CheckoutRow\([\s\S]*setTone = false/.test(checklist),
  'checkout row must accept a setTone flag for set-header background styling'
);
assert(
  /setBadge && <span[\s\S]*>세트<\/span>[\s\S]*<button[\s\S]*setItemCheckout/.test(checklist),
  'set badge must render before the checkbox button'
);
assert(
  checklist.includes('EquipmentNameCombobox') &&
    checklist.includes('장비명') &&
    checklist.includes('onSave={(v) => setItemName(t.tradeId, e.scheduleId, v)}'),
  'expanded equipment details must allow editing the registered equipment name with a catalog dropdown'
);
assert(
  checklist.includes('useEffect') && /if \(!dirty\)[\s\S]*setQ\(value\)/.test(checklist),
  'equipment name editor must follow remote value changes when the input is not dirty'
);
assert(
  /function EquipmentNameCombobox\([\s\S]*useEquipmentCatalog\(\)[\s\S]*const matches = searchEquipmentCatalog\(catalog\.items, q\)/.test(checklist),
  'equipment name editor must search the sheet-master catalog while typing'
);
assert(
  /function FloatingCatalogMenu[\s\S]*items\.map\(\(m\)[\s\S]*onClick=\{\(\) => onSelect\(m\)\}/.test(checklist) &&
    /function EquipmentNameCombobox[\s\S]*<FloatingCatalogMenu[\s\S]*onSelect=\{select\}/.test(checklist),
  'equipment name editor must show a selectable dropdown of catalog matches'
);
assert(
  /selected[\s\S]*재고 연동됨/.test(checklist) &&
    /자유입력 저장/.test(checklist),
  'equipment name editor must distinguish catalog-linked selections from free-input saves'
);
assert(
  checklist.includes('예약 수량') &&
    checklist.includes('Stepper value={e.qty}') &&
    checklist.includes('onChange={(v) => setItemQty(t.tradeId, e.scheduleId, v)}'),
  'expanded equipment details must edit the registered reservation quantity, not only taken quantity'
);

assert(
  /export function setItemName\(tradeId: string, scheduleId: string, name: string\)/.test(store),
  'store must expose setItemName for registered equipment edits'
);
assert(
  /setItemName[\s\S]*mapItem\(t, scheduleId, \(e\) => \(\{[\s\S]*name: clean[\s\S]*setName:[\s\S]*category: categoryOf\(clean\)/.test(store),
  'setItemName must optimistically update name, matching standalone setName, and category'
);
assert(
  /gasWrite\("updateEquipName", \{ tid: tradeId, scheduleId, equipName: clean \}\)/.test(store),
  'setItemName must write through to GAS so sheet-master data does not revert'
);
assert(
  /setItemQty[\s\S]*qty: safeQty[\s\S]*takenQty: e\.takenQty != null \? Math\.min\(e\.takenQty, safeQty\) : undefined[\s\S]*gasMutation\("updateEquipQty", \{ tid: tradeId, scheduleId, qty: safeQty \}\)/.test(store),
  'setItemQty must update registered qty and write through updateEquipQty (gasMutation so set-component scaling is applied back)'
);

assert(
  gasRoute.includes('"updateEquipQty"') && gasRoute.includes('"updateEquipName"'),
  'Next GAS proxy must whitelist equipment quantity and name write actions'
);
assert(
  /case "updateEquipName":[\s\S]*dashboardUpdateEquipmentName/.test(sheetApi),
  'sheetAPI must expose updateEquipName to the GAS dashboard mutation API'
);
assert(
  /function dashboardUpdateEquipmentName\(tid, scheduleId, equipName, options\)/.test(checkAvailability),
  'GAS backend must implement dashboardUpdateEquipmentName'
);
assert(
  /sched\.getRange\(targetRow, 4\)\.setValue\(newName\)/.test(checkAvailability) &&
    /if \(setName === oldName\) sched\.getRange\(targetRow, 3\)\.setValue\(newName\)/.test(checkAvailability),
  'equipment name writeback must update 스케줄상세 D and the matching C set-name header when applicable'
);

console.log('today-dashboard booked equipment edit static checks passed');
