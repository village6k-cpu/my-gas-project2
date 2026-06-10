const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const checklist = fs.readFileSync(path.join(root, 'apps/today-dashboard/components/ReturnChecklist.tsx'), 'utf8');

assert(
  checklist.includes('function singleControllableSetItem'),
  'return checklist must detect single-row sets instead of rendering them as a non-controllable set header'
);
assert(
  checklist.includes('function SetSingleList'),
  'single set return rows must keep the same set-header tinted container as checkout'
);
assert(
  /const singleSetItem = singleControllableSetItem\(g\)/.test(checklist),
  'return set rendering must compute a single controllable set row for each set group'
);
assert(
  /singleSetItem \? \([\s\S]*<SetSingleList key=\{g\.key\}>[\s\S]*<ReturnRow[\s\S]*e=\{singleSetItem\}[\s\S]*setBadge[\s\S]*setTone/.test(checklist),
  'single-row sets in return cards must render as one controllable return row with set styling'
);
assert(
  /function ReturnRow\([\s\S]*setBadge = false[\s\S]*setTone = false/.test(checklist),
  'return rows must accept setBadge and setTone flags for standalone set equipment'
);
assert(
  /setBadge && <span[\s\S]*>세트<\/span>[\s\S]*<button[\s\S]*aria-label="회수 완료 체크"/.test(checklist),
  'set badge must render before the return checkbox button'
);
assert(
  checklist.includes('EquipmentNameCombobox') &&
    checklist.includes('장비명') &&
    checklist.includes('onSave={(v) => setItemName(t.tradeId, e.scheduleId, v)}'),
  'expanded return details must allow editing the registered equipment name with a catalog dropdown'
);
assert(
  /function EquipmentNameCombobox\([\s\S]*useEquipmentCatalog\(\)[\s\S]*const matches = searchEquipmentCatalog\(catalog\.items, q\)/.test(checklist),
  'return equipment name editor must search the sheet-master catalog while typing'
);
assert(
  /function FloatingCatalogMenu[\s\S]*createPortal[\s\S]*document\.body/.test(checklist),
  'return equipment dropdown must use a body portal so set/card containers cannot clip it'
);
assert(
  checklist.includes('예약 수량') &&
    checklist.includes('Stepper value={e.qty}') &&
    checklist.includes('onChange={(v) => setItemQty(t.tradeId, e.scheduleId, v)}'),
  'expanded return details must edit the registered reservation quantity'
);
assert(
  checklist.includes('setItemMemo(t.tradeId, e.scheduleId, "checkin", v)'),
  'expanded return details must keep saving item-level return memo'
);

console.log('today-dashboard return set header controls static checks passed');
