const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const backend = fs.readFileSync(path.resolve(__dirname, '..', 'checkAvailability.js'), 'utf8');

function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} must exist`);
  const bodyStart = source.indexOf('{', start);
  let depth = 0;
  for (let i = bodyStart; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`${name} function body is incomplete`);
}

function loadContext(names) {
  const context = {};
  vm.createContext(context);
  vm.runInContext(
    names.map((n) => extractFunction(backend, n)).join('\n') +
      '\n' +
      names.map((n) => `this.${n} = ${n};`).join('\n'),
    context
  );
  return context;
}

test('빈 카카오+빈 고객DB는 M열에 일반을 물질화하지 않는다 (공란 유지)', () => {
  const ctx = loadContext(['_normalizeDiscountTypeOrBlank_', '_resolveConfirmRequestDiscountOrBlank_']);
  assert.equal(ctx._resolveConfirmRequestDiscountOrBlank_('', ''), '');
  assert.equal(ctx._resolveConfirmRequestDiscountOrBlank_(undefined, undefined), '');
  assert.equal(ctx._resolveConfirmRequestDiscountOrBlank_('학생', ''), '학생');
  assert.equal(ctx._resolveConfirmRequestDiscountOrBlank_('', '단골'), '단골');
  // 확인요청 삽입은 공란 보존 리졸버를 사용해야 한다
  assert.match(backend, /var resolvedDiscount = _resolveConfirmRequestDiscountOrBlank_\(/);
});

test('고객DB 강한 할인(단골/제휴/학생)을 확인요청의 일반이 조용히 덮어쓰지 않는다', () => {
  const ctx = loadContext(['_normalizeDiscountTypeOrBlank_', '_confirmRequestPhoneKey_', '_planCustomerDbRegistrationWrite_']);
  const rows = [['010-1234-5678', '김단골', '', '', '', '', '', '', '단골']];
  // 물질화된(또는 자동 폴백) '일반'은 단골을 덮으면 안 된다
  const plan = ctx._planCustomerDbRegistrationWrite_(rows, '김단골', '010-1234-5678', '일반');
  assert.equal(plan.action, 'keep-existing');
  // 진짜 카톡 확정 학생은 여전히 갱신한다
  const upgrade = ctx._planCustomerDbRegistrationWrite_(rows, '김단골', '010-1234-5678', '학생');
  assert.equal(upgrade.action, 'update-discount');
  assert.equal(upgrade.discount, '학생');
});

test('M열 공란이면 등록 시 고객DB 할인 폴백을 수행한다', () => {
  const registerIdx = backend.indexOf('function registerByReqID(');
  assert.notEqual(registerIdx, -1);
  const registerBody = backend.slice(registerIdx, backend.indexOf('function ', registerIdx + 30000));
  assert.match(
    extractFunction(backend, 'registerByReqID'),
    /if \(!할인유형\)[\s\S]{0,400}_bestConfirmRequestCustomerDbDiscount_/,
    '등록 시 M열 공란 → 고객DB I열 폴백이 있어야 한다'
  );
});

test('합침(merge) 등록도 계약마스터 K열과 고객DB 할인유형을 갱신한다', () => {
  const registerBody = extractFunction(backend, 'registerByReqID');
  // 계약마스터 K 갱신 (merge 대상 거래)
  assert.match(registerBody, /mergeMode[\s\S]{0,600}_updateContractDiscountIfDiffers_/, 'merge 시 K열 갱신 경로 필요');
  // 고객DB 기록이 !mergeMode 게이트 밖에서 실행되어야 한다
  assert.match(registerBody, /_applyCustomerDbRegistrationWrite_\(/, '고객DB 기록 헬퍼 호출 필요');
  assert.doesNotMatch(
    registerBody,
    /if \(!mergeMode\) \{[\s\S]{0,200}고객DB에 신규고객 저장/,
    '고객DB 기록이 더 이상 !mergeMode 안에 갇혀 있으면 안 된다'
  );
});

test('등록대기 재시도 완료 경로도 할인유형·고객DB를 반영한다', () => {
  const finalize = extractFunction(backend, 'finalizeQueuedRequestFromExistingTrade_');
  assert.match(finalize, /_reconcileRegisteredDiscount_|_updateContractDiscountIfDiffers_/, '재시도 완료 시 할인 반영 필요');
  assert.match(finalize, /_applyCustomerDbRegistrationWrite_|_reconcileRegisteredDiscount_/, '재시도 완료 시 고객DB 반영 필요');
});

test('고객DB 저장 실패는 pending 속성으로 남겨 재시도한다', () => {
  assert.match(backend, /customerDbPending_v1_/, '고객DB 실패 pending 마커 필요');
  assert.match(backend, /function drainPendingCustomerDbWrites_\(/, 'pending 고객DB 드레인 함수 필요');
});
