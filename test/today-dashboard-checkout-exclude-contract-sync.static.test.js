const fs = require('fs');
const path = require('path');
const assert = require('assert');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

const store = read('apps/today-dashboard/lib/data/store.ts');
const sheetApi = read('sheetAPI.js');
const backend = read('checkAvailability.js');
const paymentControls = read('apps/today-dashboard/components/PaymentControls.tsx');

const setItemCheckout = store.match(/export function setItemCheckout\([\s\S]*?\n}\nexport async function setItemName/);
assert.ok(setItemCheckout, 'setItemCheckout must exist before setItemName');
assert.match(
  setItemCheckout[0],
  /final === "excluded"[\s\S]*removeEquipmentAndRegenerateContract\(tradeId,\s*targetItem\)/,
  'checkout 제외 must use the same 원장 삭제 + 계약서 갱신 path, not Supabase-only state'
);

assert.match(
  store,
  /function removeEquipmentAndRegenerateContract\(tradeId:\s*string,\s*item:\s*EquipmentItem\)[\s\S]*contractRegenPending:\s*true[\s\S]*gasMutation\("removeEquip",\s*\{[\s\S]*directRegenerate:\s*false/,
  'app removal must ask GAS to delete 스케줄상세 and queue contract regeneration via the background worker (contractRegenPending badge → polling merge)'
);
assert.match(
  store,
  /amount:\s*amount \?\? t\.amount[\s\S]*contractUrl:\s*url \|\| t\.contractUrl \|\| null/,
  'returned finalAmount and new contract URL must be applied to the app trade'
);
assert.match(
  store,
  /restoreRemovedItem\(tradeId,\s*item,[\s\S]*장비 제외\/계약서 갱신 실패/,
  'failed exclude write-back must restore the item instead of silently lying to the operator'
);

assert.match(
  sheetApi,
  /case "removeEquip":[\s\S]*dashboardRemoveEquipment\([\s\S]*directRegenerate:[\s\S]*params\.directRegenerate/,
  'sheetAPI removeEquip must forward the directRegenerate option'
);
assert.match(
  backend,
  /function dashboardRemoveEquipment\(tid,\s*equipName,\s*scheduleId,\s*options\)[\s\S]*directRegenerate[\s\S]*deleteAndRegenerateContract\(ss,\s*tid\)/,
  'dashboardRemoveEquipment must support direct contract regeneration after deletion'
);
assert.match(
  backend,
  /url:\s*contractResult && contractResult\.url[\s\S]*finalAmount:\s*contractResult && contractResult\.finalAmount[\s\S]*removedScheduleIds:/,
  'removeEquip response must include new contract URL, final amount, and removed schedule ids'
);

assert.match(
  paymentControls,
  /const canOpenContract = !!trade\.contractUrl && !trade\.contractRegenPending/,
  'contract link must be disabled while regeneration is pending'
);
assert.match(
  paymentControls,
  /window\.alert\("계약서 재생성 실패:/,
  'manual regeneration failures must be visible to the operator'
);

console.log('today-dashboard checkout exclude contract sync static checks passed');
