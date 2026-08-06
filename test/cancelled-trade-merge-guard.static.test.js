const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');
const backend = fs.readFileSync(path.join(root, 'checkAvailability.js'), 'utf8');

function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notStrictEqual(start, -1, `${name} 함수를 찾지 못함`);
  const bodyStart = source.indexOf('{', start);
  let depth = 0;
  for (let i = bodyStart; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`${name} 함수 끝을 찾지 못함`);
}

const eligibilitySource = extractFunction(backend, 'isRegisterMergeEligibleContractStatus_');
const candidateSource = extractFunction(backend, 'isRegisterMergeCandidate_');
const sandbox = {};
vm.runInNewContext(
  `${eligibilitySource}; ${candidateSource}; this.isEligible = isRegisterMergeEligibleContractStatus_; this.isCandidate = isRegisterMergeCandidate_;`,
  sandbox,
);

assert.strictEqual(sandbox.isEligible('예약'), true, '예약 거래는 합침 대상으로 허용해야 한다');
['취소', '반출', '반납완료', '', null, undefined].forEach((status) => {
  assert.strictEqual(
    sandbox.isEligible(status),
    false,
    `${String(status)} 상태 거래는 합침 대상으로 사용하면 안 된다`,
  );
});

function scheduleRow(overrides = {}) {
  const row = Array(13).fill('');
  row[1] = overrides.tradeId || '260802-001';
  row[5] = overrides.checkoutDate || '2026-08-03';
  row[6] = overrides.checkoutTime || '09:00';
  row[7] = overrides.returnDate || '2026-08-04';
  row[8] = overrides.returnTime || '18:00';
  row[12] = overrides.customerName || '테스트 고객';
  return row;
}

const expected = {
  customerName: '테스트 고객',
  checkoutDate: '2026-08-03',
  checkoutTime: '09:00',
  returnDate: '2026-08-04',
  returnTime: '18:00',
  requestPhoneKey: '01012345678',
};

assert.strictEqual(
  sandbox.isCandidate(scheduleRow(), { phone: '01012345678', status: '예약' }, expected),
  true,
  '동일 고객·일정·연락처의 활성 예약만 기존 거래 합침 대상으로 허용해야 한다',
);
['취소', '반출', '반납완료', ''].forEach((status) => {
  assert.strictEqual(
    sandbox.isCandidate(scheduleRow(), { phone: '01012345678', status }, expected),
    false,
    `${status || '공란'} 계약에 스케줄 행이 남아 있어도 합침 대상으로 사용하면 안 된다`,
  );
});
assert.strictEqual(sandbox.isCandidate(scheduleRow(), null, expected), false, '계약 없는 고아 스케줄은 합치면 안 된다');
assert.strictEqual(
  sandbox.isCandidate(scheduleRow(), { phone: '01099999999', status: '예약' }, expected),
  false,
  '연락처가 다른 동명이인 예약은 합치면 안 된다',
);

const registerBody = extractFunction(backend, 'registerByReqID');
assert.match(
  registerBody,
  /getRange\(2,\s*1,\s*_mergeContractLastRow\s*-\s*1,\s*10\)/,
  '합침 판정은 계약마스터 J열 상태까지 읽어야 한다',
);
assert.match(
  registerBody,
  /_mergeContractByTid\[contractTid\]\s*=\s*\{[\s\S]{0,240}status:/,
  '합침 후보 맵에는 연락처와 계약 상태가 함께 있어야 한다',
);
assert.match(
  registerBody,
  /isRegisterMergeCandidate_\(_sData\[si\],\s*_candidateContract,\s*_mergeExpected\)/,
  '실제 등록 루프가 행동 테스트를 거친 합침 후보 판정을 사용해야 한다',
);

console.log('cancelled trade merge guard static checks passed');
