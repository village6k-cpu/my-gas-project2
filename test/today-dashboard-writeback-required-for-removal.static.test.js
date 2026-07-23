const fs = require('fs');
const path = require('path');
const assert = require('assert');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

const writeback = read('apps/today-dashboard/lib/data/writeback.ts');
const store = read('apps/today-dashboard/lib/data/store.ts');
const sync = read('apps/today-dashboard/lib/data/sync.ts');

assert.match(
  writeback,
  /export const writeBackDisabledReason =/,
  'writeback module must expose a user-visible disabled reason'
);

assert.match(
  store,
  /import \{[^}]*gasMutation[^}]*gasRead[^}]*gasWrite[^}]*writeBackDisabledReason[^}]*writeBackEnabled[^}]*\} from "\.\/writeback"/,
  'store must import the disabled reason so failed 원장 writes are visible'
);

assert.match(
  store,
  /function rejectSheetBackedRemovalWithoutWriteBack\(tradeId: string, scheduleId\?: string\)[\s\S]*checkoutState: "pending"[\s\S]*issueNote: message/,
  'sheet-backed exclusions must be rolled back and surfaced when writeback is disabled'
);

assert.match(
  store,
  /if \(final === "excluded" && targetItem\) \{[\s\S]*if \(writeBackEnabled\) \{[\s\S]*removeEquipmentAndRegenerateContract\(tradeId, targetItem\);[\s\S]*\} else \{[\s\S]*rejectSheetBackedRemovalWithoutWriteBack\(tradeId, scheduleId\);/,
  'checkout exclude must refuse Supabase-only hiding when 원장 writeback is disabled'
);

assert.match(
  store,
  /if \(item && isSheetBackedScheduleId\(tradeId, scheduleId\)\) \{[\s\S]*if \(writeBackEnabled\) \{[\s\S]*removeEquipmentAndRegenerateContract\(tradeId, item\);[\s\S]*\}[\s\S]*rejectSheetBackedRemovalWithoutWriteBack\(tradeId\);/,
  'delete/remove must not hide sheet-backed rows locally when writeback is disabled'
);

assert.ok(
  !sync.includes('prev?.checkoutState === "excluded" ? "excluded"'),
  'dashboard repair must not preserve excluded state when GAS still returns the schedule row'
);
assert.match(
  sync,
  /원장에 다시 보이는 행은 앱 캐시의 excluded 상태로 숨기지 않는다/,
  'sync merge must document that GAS rows beat stale excluded cache state'
);

console.log('today-dashboard writeback-required removal static checks passed');
