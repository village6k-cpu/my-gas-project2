const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const backend = fs.readFileSync(path.resolve(__dirname, '..', 'checkAvailability.js'), 'utf8');

function extractFunction(name) {
  const start = backend.indexOf(`function ${name}(`);
  assert(start >= 0, `missing function ${name}`);
  const open = backend.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < backend.length; i++) {
    if (backend[i] === '{') depth++;
    if (backend[i] === '}') depth--;
    if (depth === 0) return backend.slice(start, i + 1);
  }
  throw new Error(`unterminated function ${name}`);
}

const context = vm.createContext({
  console,
  _confirmRequestPhoneKey_: (value) => String(value || '').replace(/\D/g, ''),
  parseDT: (dateText, timeText) => new Date(`${dateText}T${timeText}:00+09:00`),
  Utilities: {
    formatDate: (value) => {
      const shifted = new Date(value.getTime() + 9 * 60 * 60 * 1000);
      const pad = (number) => String(number).padStart(2, '0');
      return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())} ${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}`;
    }
  }
});
[
  '_scheduleCloneDateTime_',
  '_scheduleCloneNumber_',
  'buildScheduleCloneComparableSignature_',
  '_findScheduleCloneTargetCandidates_'
].forEach((name) => vm.runInContext(extractFunction(name), context));

function row(tid, setName, equipmentName, qty, status = '대기', memo = '', price = 0, customer = '박재인') {
  return [
    `${tid}-01`, tid, setName, equipmentName, String(qty),
    '2026-07-22', '20:00', '2026-07-23', '23:00',
    status, memo, String(price), customer
  ];
}

function contract(tid, phone = '010-2584-6668') {
  return [
    tid, '박재인', phone, '',
    '2026-07-22', '20:00', '2026-07-23', '23:00',
    '2', '예약', '일반', ''
  ];
}

function sheet(values) {
  return {
    getLastRow: () => values.length + 1,
    getRange: () => ({ getDisplayValues: () => values })
  };
}

function sourceRows() {
  return [
    row('SOURCE', '소니 A7S3 바디세트', '소니 A7S3 바디세트', 1, '대기', '', 40000),
    row('SOURCE', '소니 A7S3 바디세트', '소니 A7S3 바디(케이지)', 1),
    row('SOURCE', '파이로 7', '파이로 7', 2, '대기', '', 20000)
  ];
}

function candidates(targetRows, targetContract = contract('TARGET')) {
  const ss = {
    getSheetByName: (name) => name === '스케줄상세'
      ? sheet(targetRows)
      : sheet([targetContract])
  };
  const source = {
    tradeId: 'SOURCE',
    customerName: '박재인',
    phone: '010-2584-6668',
    rows: sourceRows()
  };
  return context._findScheduleCloneTargetCandidates_(
    ss,
    source,
    { date: '2026-07-22', time: '20:00' },
    { date: '2026-07-23', time: '23:00' }
  );
}

const sameRowsDifferentStatus = sourceRows().map((value) => {
  const clone = value.slice();
  clone[0] = clone[0].replace('SOURCE', 'TARGET');
  clone[1] = 'TARGET';
  clone[9] = '반출완료';
  return clone;
});
let result = candidates(sameRowsDifferentStatus);
assert.strictEqual(result.length, 1);
assert.strictEqual(result[0].tradeId, 'TARGET');
assert.strictEqual(result[0].exact, true, 'operational status changes must not create a duplicate clone');

const changedComponentQty = sameRowsDifferentStatus.map((value) => value.slice());
changedComponentQty[1][4] = '2';
result = candidates(changedComponentQty);
assert.strictEqual(result.length, 1);
assert.strictEqual(result[0].exact, false, 'component quantity drift must be a conflict, not an exact duplicate');

result = candidates(sameRowsDifferentStatus, contract('TARGET', '010-9999-9999'));
assert.strictEqual(result.length, 0, 'same-name different-phone schedule must not be collapsed');

const validDateTime = context._scheduleCloneDateTime_('2026-07-22 7:00', '', '', 'targetStart');
assert.strictEqual(validDateTime.date, '2026-07-22');
assert.strictEqual(validDateTime.time, '07:00');
assert.throws(
  () => context._scheduleCloneDateTime_('2026-02-30 20:00', '', '', 'targetStart'),
  /올바르지 않습니다/
);
assert.throws(
  () => context._scheduleCloneDateTime_('2026-07-22 24:00', '', '', 'targetStart'),
  /올바르지 않습니다/
);
assert.throws(
  () => context._scheduleCloneDateTime_('2025-02-29 20:00', '', '', 'targetStart'),
  /올바르지 않습니다/
);

console.log('schedule-clone-nosend.behavior.test.js OK');
