const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const checklist = fs.readFileSync(path.join(root, 'apps/today-dashboard/components/ReturnChecklist.tsx'), 'utf8');

// 세트 판정 헬퍼는 status.ts 단일 소스에서 import (반출/반납 동일 규칙)
assert(
  /import \{[^}]*singleControllableSetItem[^}]*\} from "@\/lib\/domain\/status"/.test(checklist) &&
    /import \{[^}]*realDeviceHeaders[^}]*\} from "@\/lib\/domain\/status"/.test(checklist),
  'return checklist must import shared set helpers (singleControllableSetItem, realDeviceHeaders) from status'
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
  /<SetBox[\s\S]*?headerRow=\{realDeviceHeaders\(g\)\.map\(\(header\)[\s\S]*?<ReturnRow[\s\S]*?e=\{header\}[\s\S]*?setBadge setTone/.test(checklist),
  'all real-device set headers must render as interactive return rows via SetBox headerRow'
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
  checklist.includes('반출 기준') &&
    checklist.includes('e.name} · {expected}개') &&
    checklist.includes('반출 당시 실제 수량 기준') &&
    !checklist.includes('EquipmentNameCombobox') &&
    !checklist.includes('setItemQty(t.tradeId'),
  'return details must display the immutable checkout identity and must not edit its equipment name or booked quantity'
);
assert(
  checklist.includes('setItemMemo(t.tradeId, e.scheduleId, "checkin", v)'),
  'expanded return details must keep saving item-level return memo'
);

console.log('today-dashboard return set header controls static checks passed');
