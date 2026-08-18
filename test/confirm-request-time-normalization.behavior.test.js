const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'checkAvailability.js'), 'utf8');
const context = { console };
vm.runInNewContext(source, context);

assert.deepEqual(
  JSON.parse(JSON.stringify(context._normalizeConfirmRequestSchedule_({
    반출일: '2026-08-26',
    반출시간: '07:30',
    반납일: '2026-08-27',
    반납시간: '24:00',
    장비: [{ 이름: '소니 FX6 바디세트', 수량: 1 }]
  }))),
  {
    반출일: '2026-08-26',
    반출시간: '07:00',
    반납일: '2026-08-27',
    반납시간: '00:00',
    장비: [{ 이름: '소니 FX6 바디세트', 수량: 1 }],
    입력모드: 'full_plan'
  }
);

assert.deepEqual(
  JSON.parse(JSON.stringify(context._normalizeConfirmRequestSchedule_({
    반출일: '2026-06-01',
    반출시간: '12:59',
    반납일: '2026-06-02',
    반납시간: '23:01'
  }))),
  {
    반출일: '2026-06-01',
    반출시간: '12:00',
    반납일: '2026-06-03',
    반납시간: '00:00',
    입력모드: 'full_plan'
  }
);

assert.throws(
  () => context._normalizeConfirmRequestSchedule_({
    반출일: '2026-06-01',
    반출시간: '12:30',
    반납일: '2026-06-01',
    반납시간: '24:00'
  }),
  /반납.*반출.*이후/
);

assert.throws(
  () => context._insertAndCheckRequest({ 입력모드: 'additions_only' }),
  /전체 목록과 병합/
);

assert.match(
  source,
  /function _insertAndCheckRequest\(req\)\s*\{\s*req = _normalizeConfirmRequestSchedule_\(req\);/,
  'the shared GAS boundary must normalize before duplicate checks or writes'
);

console.log('confirm request time normalization behavior checks passed');
