const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const source = fs.readFileSync(path.resolve(__dirname, '..', 'checkAvailability.js'), 'utf8');

function extractFunction(name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} must exist`);
  let depth = 0;
  let opened = false;
  for (let i = start; i < source.length; i += 1) {
    if (source[i] === '{') {
      depth += 1;
      opened = true;
    } else if (source[i] === '}') {
      depth -= 1;
      if (opened && depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`unterminated function: ${name}`);
}

const context = {};
vm.createContext(context);
vm.runInContext(extractFunction('planMergedScheduleRows_'), context);
vm.runInContext(extractFunction('buildDashboardDuplicateRepairPlan_'), context);

function requestRow({ req = 'RQ-1', name, qty = 1, result = '', setName = '', status = '', extra = '' }) {
  const row = Array(18).fill('');
  row[0] = req;
  row[5] = name;
  row[6] = qty;
  row[8] = result;
  row[14] = status;
  row[16] = setName ? `[세트]${setName}` : '';
  row[17] = extra;
  return row;
}

function scheduleRow({ id, tid = '260719-004', setName, name, qty = 1, status = '대기' }) {
  return [id, tid, setName, name, qty, '2026-07-20', '13:00', '2026-07-21', '13:00', status, '', '0', '고객'];
}

const existing = [
  scheduleRow({ id: '260719-004-03', setName: '소니 단렌즈 세트', name: '소니 단렌즈 세트' }),
  scheduleRow({ id: '260719-004-04', setName: '어퓨쳐 스톰 80C', name: '어퓨쳐 스톰 80C' }),
  scheduleRow({ id: '260719-004-05', setName: '어퓨쳐 스톰 80C', name: '헤드 / AC 라인' }),
  scheduleRow({ id: '260719-004-07', setName: '스크림 세트', name: '스크림 세트' }),
  scheduleRow({ id: '260719-004-08', setName: 'C스탠드', name: 'C스탠드', qty: 2 }),
  scheduleRow({ id: '260719-004-09', setName: 'C스탠드', name: '그립헤드, 그립암', qty: 2 }),
];

const incoming = [
  requestRow({ name: '소니 FX9 바디세트', result: '세트' }),
  requestRow({ name: '소니 FX9 바디', setName: '소니 FX9 바디세트' }),
  requestRow({ name: '소니 단렌즈 세트', result: '세트' }),
  requestRow({ name: '어퓨쳐 스톰 80C', result: '세트' }),
  requestRow({ name: '헤드 / AC 라인', setName: '어퓨쳐 스톰 80C' }),
  requestRow({ name: '스크림 세트', result: '세트' }),
  requestRow({ name: 'C스탠드', qty: 2, result: '세트' }),
  requestRow({ name: '그립헤드, 그립암', qty: 2, setName: 'C스탠드' }),
];

const merged = context.planMergedScheduleRows_(incoming, 'RQ-1', '260719-004', existing);
assert.deepEqual(Array.from(merged.writeSourceIndexes), [0, 1], 'merge must append only genuinely new rows');
assert.equal(merged.skippedDuplicateRows.length, 6, 'all existing rows must be skipped from a mixed merge');

const fresh = context.planMergedScheduleRows_(incoming, 'RQ-1', '', []);
assert.deepEqual(Array.from(fresh.writeSourceIndexes), incoming.map((_, i) => i), 'new trade must keep every valid row');

const cancelledExisting = [scheduleRow({ id: '260719-004-03', setName: '소니 단렌즈 세트', name: '소니 단렌즈 세트', status: '취소' })];
const cancelledPlan = context.planMergedScheduleRows_([incoming[2]], 'RQ-1', '260719-004', cancelledExisting);
assert.deepEqual(Array.from(cancelledPlan.writeSourceIndexes), [0], 'cancelled rows must not suppress a new active item');

const identicalAddOn = context.planMergedScheduleRows_(
  [requestRow({ req: 'RQ-ADD', name: 'C스탠드', qty: 2, result: '세트' })],
  'RQ-ADD',
  '260719-004',
  existing,
);
assert.deepEqual(
  Array.from(identicalAddOn.writeSourceIndexes),
  [0],
  'a separate add-on request containing only an identical active item must not become a successful no-op',
);
assert.equal(identicalAddOn.skippedDuplicateRows.length, 0);

const mixedAddOn = context.planMergedScheduleRows_(
  [
    requestRow({ req: 'RQ-MIXED-ADD', name: 'C스탠드', qty: 2, result: '세트', extra: '기존 예약에 장비 추가' }),
    requestRow({ req: 'RQ-MIXED-ADD', name: '새 조명', qty: 1 }),
  ],
  'RQ-MIXED-ADD',
  '260719-004',
  existing,
);
assert.deepEqual(
  Array.from(mixedAddOn.writeSourceIndexes),
  [0, 1],
  'an explicitly additive mixed request must keep both repeated and new equipment',
);
assert.equal(mixedAddOn.skippedDuplicateRows.length, 0);

const repairRows = [
  scheduleRow({ id: '260719-004-03', setName: '소니 단렌즈 세트', name: '소니 단렌즈 세트' }),
  scheduleRow({ id: '260719-004-17', setName: '소니 단렌즈 세트', name: '소니 단렌즈 세트' }),
  scheduleRow({ id: '260719-004-24', setName: '미라지', name: '미라지' }),
];
const repair = context.buildDashboardDuplicateRepairPlan_(
  '260719-004',
  [{ keepId: '260719-004-03', removeId: '260719-004-17' }],
  repairRows,
);
assert.equal(repair.ok, true, 'exact later duplicate must be repairable');
assert.deepEqual(Array.from(repair.removeIds), ['260719-004-17']);

const mismatchRows = repairRows.map((row) => row.slice());
mismatchRows[1][4] = 2;
const mismatch = context.buildDashboardDuplicateRepairPlan_(
  '260719-004',
  [{ keepId: '260719-004-03', removeId: '260719-004-17' }],
  mismatchRows,
);
assert.equal(mismatch.ok, false, 'repair must fail closed when quantities differ');

assert.match(source, /var mergeSchedulePlan = planMergedScheduleRows_\(/);
assert.match(source, /var neededRows = mergeSchedulePlan\.writeSourceIndexes\.length/);
assert.match(source, /mergeSchedulePlan\.writeSourceIndexes\.forEach\(function\(sourceIndex\)/);
assert.match(source, /var _mergeRequestPhoneKey = _confirmRequestPhoneKey_\(연락처\)/);
assert.match(source, /if \(!_mergeRequestPhoneKey \|\| !_candidatePhoneKey \|\| _candidatePhoneKey !== _mergeRequestPhoneKey\) continue/);
const repairSource = extractFunction('repairDashboardDuplicateScheduleRows');
assert.match(source, /supaMarkTradeDirty_\(tid\)/);
assert.match(repairSource, /scheduleContractRegen\(tid\)/, 'duplicate-row repair must regenerate the affected contract');

console.log('merge registration duplicate regression tests passed');
