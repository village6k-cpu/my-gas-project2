const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

const code = read('Code.js');
const backend = read('checkAvailability.js');

assert.match(
  code,
  /function queueScheduleDetailContractRegensForRows_\(sheet,\s*rows,\s*extraTradeIds\)[\s\S]*scheduleContractRegen\(tradeId\)/,
  'schedule detail row helper must queue contract regeneration for every affected trade id'
);

assert.match(
  code,
  /function queueScheduleDetailContractRegensForEdit_\(sheet,\s*range,\s*oldValue\)[\s\S]*getNumRows\(\)[\s\S]*getNumColumns\(\)[\s\S]*oldValue[\s\S]*queueScheduleDetailContractRegensForRows_/,
  'direct 스케줄상세 edits must handle multi-cell edits and B-column trade id changes'
);

assert.match(
  code,
  /스케줄상세 수정 시 계약서 재생성[\s\S]*queueScheduleDetailContractRegensForEdit_\(sheet,\s*e\.range,\s*e\.oldValue\)/,
  'onEditInstallable must use the shared 스케줄상세 edit helper instead of only the top-left edited row'
);

const updateScheduleTime = backend.match(/function updateScheduleTime\([\s\S]*?\n}\n\n/);
assert.ok(updateScheduleTime, 'updateScheduleTime must exist');
assert.match(
  updateScheduleTime[0],
  /queueScheduleDetailContractRegensForRows_\(sheet,\s*rows\)/,
  'script-driven schedule time edits must queue contract regeneration because onEdit does not fire for script writes'
);
assert.match(
  updateScheduleTime[0],
  /contractRegenPending:\s*true/,
  'updateScheduleTime responses must tell callers the contract link is temporarily stale'
);

console.log('schedule-detail-contract-regen.static.test.js OK');
