const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

const checkAvailability = read('checkAvailability.js');
const code = read('Code.js');
const sheetApi = read('sheetAPI.js');

assert.match(
  checkAvailability,
  /function setDashboardReturnContractStatus_[\s\S]{0,900}currentStatus\s*===\s*['"]취소['"][\s\S]{0,220}반납완료로 바꿀 수 없습니다/,
  'toggleReturnDone must block changing 취소 contracts to 반납완료'
);

assert.match(
  checkAvailability,
  /function updateDashboardContractStatus[\s\S]{0,900}status\s*===\s*["']반납완료["']\s*&&\s*currentStatus\s*===\s*["']취소["'][\s\S]{0,220}반납완료로 바꿀 수 없습니다/,
  'updateDashboardContractStatus must block 취소 -> 반납완료'
);

assert.match(
  code,
  /statusRowCount\s*>\s*1[\s\S]{0,500}handleContractMasterStatusEdit_/,
  'manual multi-row 계약마스터 J edits must process each edited status row'
);

assert.match(
  code,
  /previousStatus\s*===\s*["']취소["'][\s\S]{0,160}hadCancelStyle[\s\S]{0,160}!hasScheduleRows/,
  'manual status handler must restore likely cancelled rows instead of reviving them'
);

assert.match(
  checkAvailability,
  /function inspectContractCancelRecovery/,
  'recovery inspection function must exist'
);

assert.match(
  checkAvailability,
  /function restoreCancelledContractsByIds/,
  'batch restore function must exist'
);

assert.match(
  sheetApi,
  /"inspectContractCancelRecovery"[\s\S]{0,120}"restoreCancelledContractsByIds"/,
  'recovery functions must be exposed through runFunction allowlist'
);

console.log('contract cancel return guard static checks passed');
