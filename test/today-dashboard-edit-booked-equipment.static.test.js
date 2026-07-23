const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

const checklist = read('apps/today-dashboard/components/HandoverChecklist.tsx');
const tradeActions = read('apps/today-dashboard/components/TradeActions.tsx');
const store = read('apps/today-dashboard/lib/data/store.ts');
const status = read('apps/today-dashboard/lib/domain/status.ts');
const gasRoute = read('apps/today-dashboard/app/api/gas/route.ts');
const sheetApi = read('sheetAPI.js');
const checkAvailability = read('checkAvailability.js');
const remote = read('apps/today-dashboard/lib/data/remote.ts');
const mappers = read('apps/today-dashboard/lib/data/mappers.ts');
const migration = read('apps/today-dashboard/supabase/migrations/20260723033000_schedule_item_removed_at.sql');

assert(
  checklist.includes('SetSingleList'),
  'single set equipment must keep the set-header tinted container instead of falling back to a plain loose list'
);
assert(
  migration.includes('add column if not exists removed_at timestamptz') &&
    /q\.in\("trade_id", chunk\)\.is\("removed_at", null\)/.test(remote) &&
    !mappers.includes('removed_at'),
  'removed checkout baseline rows must stay auditable without reappearing in live equipment lists'
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
  'pre-checkout equipment details must allow editing the registered equipment name with a catalog dropdown'
);
assert(
  /export function isCheckoutBaselineLocked\(t: Trade\)/.test(status) &&
    !tradeActions.includes('isCheckoutBaselineLocked'),
  'checkout completion may preserve the actual handover record but must not lock reservation editing'
);
assert(
  !checklist.includes('반출 기준선 원본 보존') &&
    !tradeActions.includes('반출 후 수정 잠김') &&
    /function CheckoutRow[\s\S]*EquipmentNameCombobox[\s\S]*queueItemQty/.test(checklist),
  'checkout rows and the reservation editor must keep name and quantity editing available after checkout'
);
assert(
  /disabled=\{baselineLocked\}/.test(checklist) &&
    /baselineStarted && next !== "excluded"/.test(store) &&
    /setItemCheckout\(t\.tradeId, e\.scheduleId, "excluded"\)/.test(checklist),
  'checkout facts stay fixed while deleting an item remains available after checkout'
);
assert(
  /export function clearToast\(\)/.test(store) &&
    /function showTransientError\([\s\S]{0,420}setTimeout[\s\S]{0,220}toast: null/.test(store) &&
    /setItemName[\s\S]*showTransientError\(`⚠️ 장비명 변경 실패/.test(store) &&
    /function OnsiteCombobox[\s\S]*const submit = async \(\) => \{[\s\S]{0,320}clearToast\(\)/.test(checklist),
  'stale rename failures must expire and be cleared before a separate on-site add operation starts'
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
    checklist.includes('onChange={(v) => queueItemQty(t.tradeId, e.scheduleId, v)}'),
  'expanded equipment details must edit the registered reservation quantity, not only taken quantity'
);

assert(
  /export async function setItemName\(tradeId: string, scheduleId: string, name: string\)/.test(store),
  'store must expose fail-closed async setItemName for registered equipment edits'
);
assert(
  /setItemName[\s\S]*await gasMutation\("updateEquipName"[\s\S]*name: nextName[\s\S]*setName:[\s\S]*category: categoryOf\(nextName\)/.test(store),
  'setItemName must apply the canonical GAS name, matching standalone setName, and category after write success'
);
assert(
  /await gasMutation\("updateEquipName", \{ tid: tradeId, scheduleId, equipName: clean \}\)/.test(store),
  'setItemName must await GAS so sheet-master failure cannot leave a Supabase-only rename'
);
assert(
  /function applyEquipQtyResult\([\s\S]*const nextQty = byId\.get\(e\.scheduleId\)![\s\S]*takenQty: e\.takenQty/.test(store) &&
    /setItemQty[\s\S]*await gasMutation\("updateEquipQty", \{ tid: tradeId, scheduleId, qty: safeQty \}\)[\s\S]*applyEquipQtyResult\(/.test(store) &&
    /commitQueuedItemQty[\s\S]*await gasMutation\("updateEquipQty", \{ tid: tradeId, scheduleId, qty: target \}\)[\s\S]*applyEquipQtyResult\(/.test(store) &&
    !/takenQty: e\.takenQty != null \? Math\.min/.test(store),
  'qty edits (setItemQty and debounced commitQueuedItemQty) must await updateEquipQty, apply authoritative set-component scaling via applyEquipQtyResult, and never rewrite the checkout baseline'
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
  !/function dashboardUpdateEquipmentQty[\s\S]{0,2600}isDashboardTradeCheckoutStarted_/.test(checkAvailability) &&
    !/function dashboardUpdateEquipmentName[\s\S]{0,2600}isDashboardTradeCheckoutStarted_/.test(checkAvailability),
  'GAS must allow registered equipment quantity and name edits after checkout'
);
assert(
  /sched\.getRange\(targetRow, 4\)\.setValue\(newName\)/.test(checkAvailability) &&
    /if \(setName === oldName\) sched\.getRange\(targetRow, 3\)\.setValue\(newName\)/.test(checkAvailability),
  'equipment name writeback must update 스케줄상세 D and the matching C set-name header when applicable'
);

console.log('today-dashboard booked equipment edit static checks passed');
