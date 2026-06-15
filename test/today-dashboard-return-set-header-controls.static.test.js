const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const checklist = fs.readFileSync(path.join(root, 'apps/today-dashboard/components/ReturnChecklist.tsx'), 'utf8');

// 세트 판정 헬퍼는 status.ts 단일 소스에서 import (반출/반납 동일 규칙)
assert(
  /import \{[^}]*singleControllableSetItem[^}]*\} from "@\/lib\/domain\/status"/.test(checklist) &&
    /import \{[^}]*isRealDeviceHeader[^}]*\} from "@\/lib\/domain\/status"/.test(checklist),
  'return checklist must import shared set helpers (singleControllableSetItem, isRealDeviceHeader) from status'
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
  /singleSetItem \? \([\s\S]*?<SetSingleList key=\{g\.key\}>[\s\S]*?<ReturnRow[\s\S]*?e=\{singleSetItem\}[\s\S]*?setBadge setTone/.test(checklist),
  'single-row sets in return cards must render as one controllable return row with set styling'
);
// 구성품 있는 세트의 실제 메인 장비(대표행)는 headerRow로 회수 체크 가능하게 노출
assert(
  /<SetBox[\s\S]*?headerRow=\{isRealDeviceHeader\(g\.header, g\.rows\)[\s\S]*?<ReturnRow[\s\S]*?e=\{g\.header!\}[\s\S]*?setBadge setTone/.test(checklist),
  'real-device set headers must render as an interactive return row via SetBox headerRow'
);
assert(
  /function ReturnRow\([\s\S]*?setBadge = false[\s\S]*?setTone = false/.test(checklist),
  'return rows must accept setBadge and setTone flags for standalone/main set equipment'
);
assert(
  /setBadge && <span[\s\S]*?>세트<\/span>[\s\S]*?<button[\s\S]*?aria-label="회수 완료 체크"/.test(checklist),
  'set badge must render before the return checkbox button'
);
assert(
  checklist.includes('EquipmentNameCombobox') &&
    checklist.includes('장비명') &&
    checklist.includes('onSave={(v) => setItemName(t.tradeId, e.scheduleId, v)}'),
  'expanded return details must allow editing the registered equipment name with a catalog dropdown'
);
assert(
  /function EquipmentNameCombobox\([\s\S]*?useEquipmentCatalog\(\)[\s\S]*?const matches = searchEquipmentCatalog\(catalog\.items, q\)/.test(checklist),
  'return equipment name editor must search the sheet-master catalog while typing'
);
assert(
  /function FloatingCatalogMenu[\s\S]*?createPortal[\s\S]*?document\.body/.test(checklist),
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
