const fs = require('fs');
const path = require('path');
const assert = require('assert');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

const store = read('apps/today-dashboard/lib/data/store.ts');
const sheetApi = read('sheetAPI.js');
const backend = read('checkAvailability.js');
const paymentControls = read('apps/today-dashboard/components/PaymentControls.tsx');

const setItemCheckoutStart = store.indexOf('export function setItemCheckout');
const setItemCheckoutEnd = store.indexOf('\nconst itemNameTargets:', setItemCheckoutStart);
const setItemCheckout = setItemCheckoutStart >= 0 && setItemCheckoutEnd > setItemCheckoutStart
  ? store.slice(setItemCheckoutStart, setItemCheckoutEnd)
  : '';
assert.ok(setItemCheckout, 'setItemCheckout must exist before the item-name queue');
assert.match(
  setItemCheckout,
  /const baselineStarted = !!currentTrade && isCheckoutBaselineLocked\(currentTrade\)[\s\S]*if \(baselineStarted\)[\s\S]*next === "excluded"[\s\S]*이미 반출된 품목은 제외할 수 없습니다[\s\S]*return;/,
  'checkout 기준선이 시작된 뒤에는 제외 클릭이 어떤 로컬 상태도 바꾸기 전에 차단되어야 한다'
);
assert.ok(
  setItemCheckout.indexOf('if (baselineStarted)') < setItemCheckout.indexOf('mutateTrade(tradeId'),
  'checkout baseline guard must run before optimistic mutation',
);
assert.match(
  setItemCheckout,
  /final === "excluded"[\s\S]*removeEquipmentAndRegenerateContract\(tradeId,\s*targetItem\)/,
  '반출 전 제외만 원장 삭제 + 계약서 갱신 경로를 사용해야 한다'
);

assert.match(
  store,
  /async function commitRemoveEquipmentMutation_[\s\S]*gasMutationRetrying\("removeEquip",\s*\{[\s\S]*mutationId:\s*entry\.mutationId[\s\S]*directRegenerate:\s*false[\s\S]*function removeEquipmentAndRegenerateContract[\s\S]*putRemoveEquipmentOutbox_\(entry\)[\s\S]*contractRegenPending:\s*true/,
  'app removal must durably ask GAS to delete 스케줄상세 and queue contract regeneration via the background worker (contractRegenPending badge → polling merge)'
);
assert.match(
  store,
  /amount:\s*amount \?\? t\.amount[\s\S]*contractUrl:\s*url \|\| t\.contractUrl \|\| null/,
  'returned finalAmount and new contract URL must be applied to the app trade'
);
assert.match(
  store,
  /if \(isMissingScheduleRowError_\(message\)\)[\s\S]*await finalizeAlreadyMissingScheduleItem_\(entry\.tradeId, entry\.scheduleId, entry\.equipName\)[\s\S]*return;[\s\S]*if \(originalItem\) restoreRemovedItem\(entry\.tradeId, originalItem, "장비 제외 실패:/,
  'an already-missing canonical row must converge as removed, while other terminal failures still restore the original item'
);

assert.match(
  sheetApi,
  /case "removeEquip":[\s\S]*dashboardRemoveEquipment\([\s\S]*directRegenerate:[\s\S]*params\.directRegenerate/,
  'sheetAPI removeEquip must forward the directRegenerate option'
);
const removeBody = backend.match(/function dashboardRemoveEquipment[\s\S]*?\n}\n\n\n\/\*\* "yyyy-MM-dd"/)?.[0] ?? '';
assert.match(
  removeBody,
  /isDashboardTradeCheckoutStarted_\(ss,\s*tid\)[\s\S]*이미 반출된 품목은 삭제할 수 없습니다/,
  'GAS must independently reject removal after checkout so stale clients cannot bypass the baseline policy'
);
assert.ok(
  removeBody.indexOf('isDashboardTradeCheckoutStarted_(ss, tid)') < removeBody.indexOf('deleteDashboardRowsDescending_'),
  'GAS checkout guard must run before any schedule row deletion',
);
assert.doesNotMatch(
  removeBody,
  /deleteAndRegenerateContract/,
  'equipment removal must not block every card on synchronous Drive work'
);
assert.match(
  removeBody,
  /scheduleContractRegenUnderLock_\(tid\)[\s\S]*contractRegenQueued = true[\s\S]*if \(contractRegenQueued\) ensureContractRegenTrigger_\(\)/,
  'permitted pre-checkout removal must mark durable regeneration under lock and wake the worker after unlock',
);
assert.match(
  backend,
  /contractRegenPending:\s*contractRegenPending[\s\S]*removedScheduleIds:/,
  'removeEquip response must expose pending regeneration and the exact removed schedule ids'
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
