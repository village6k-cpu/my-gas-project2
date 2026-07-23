const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const backend = fs.readFileSync(path.join(root, 'checkAvailability.js'), 'utf8');

// ──────────────────────────────────────────────────────────────────────────
// RQ-260712-010(고창현) 재현: 소니 FX3 바디세트·어퓨쳐 300X 등 세트 다수를 담은
// 예약에서, 세트 구성품(리더기·헤드·발라스터·루버 등 비추적 부속)이 "미등록/모델 선택
// 필요"로 잡히면 예약 전체 등록이 막히고 O열에 "❌ 등록 불가: 모델 선택 필요"가
// 눌어붙어 사장님이 "자꾸 등록 불가로 뜬다"고 겪던 문제. 가드가 세트 구성품·제외/거절/
// 보류 행을 건너뛰어야 하고(최상위 품목의 모델 미선택은 그대로 차단), 재확인 시 과거
// 배너를 지워야 한다.
// ──────────────────────────────────────────────────────────────────────────

// 순수 함수 getBlockingRegisterIssue_를 소스에서 뽑아 실제로 실행해 본다.
const m = backend.match(/function getBlockingRegisterIssue_\(data, reqID\) \{[\s\S]*?\n\}/);
assert(m, 'getBlockingRegisterIssue_ 함수를 소스에서 찾지 못함');
const getBlockingRegisterIssue_ = eval('(' + m[0] + ')');

// 18열 확인요청 행 생성 헬퍼. idx: 0=요청ID, 8=결과, 14=등록상태, 16=비고(세트태그)
function row(reqID, result, opts) {
  opts = opts || {};
  const r = new Array(18).fill('');
  r[0] = reqID;
  r[8] = result;
  r[13] = opts.action || '';
  r[14] = opts.status || '';
  r[16] = opts.setTag || '';
  return r;
}

// 1) 세트 구성품의 "모델 선택 필요"는 예약 전체 등록을 막지 않는다.
assert.strictEqual(
  getBlockingRegisterIssue_([
    row('R1', '세트'),
    row('R1', '⚠️ 모델 선택 필요', { setTag: '[세트]소니 FX3 바디세트' }),
  ], 'R1'),
  '',
  '세트 구성품의 모델 선택 필요는 등록을 막으면 안 된다'
);

// 2) 세트 구성품의 "미등록 장비"도 막지 않는다.
assert.strictEqual(
  getBlockingRegisterIssue_([
    row('R1', '세트'),
    row('R1', '❓ 미등록 장비', { setTag: '[세트]어퓨쳐 300X' }),
  ], 'R1'),
  '',
  '세트 구성품의 미등록은 등록을 막으면 안 된다'
);

// 3) 최상위(세트 아님) 품목의 "모델 선택 필요"는 여전히 막는다.
assert.strictEqual(
  getBlockingRegisterIssue_([
    row('R1', '⚠️ 모델 선택 필요'),
  ], 'R1'),
  '모델 선택 필요',
  '최상위 품목의 모델 선택 필요는 반드시 등록을 막아야 한다'
);

// 3-1) 헤이빌리의 '바로 등록'은 사장님이 모델/재고 경고까지 확인한 최종 승인이다.
//      구체 모델을 고르지 않은 품목은 그 이름 그대로 스케줄에 등록되어야 한다.
assert.strictEqual(
  getBlockingRegisterIssue_([
    row('R1', '⚠️ 모델 선택 필요'),
  ], 'R1', true),
  '',
  '바로 등록 승인은 최상위 품목의 모델 선택 경고도 통과시켜야 한다'
);

// 4) 날짜 오류는 여전히 막는다.
assert.strictEqual(
  getBlockingRegisterIssue_([
    row('R1', '❌ 날짜/시간 필요'),
  ], 'R1', true),
  '날짜/시간 필요',
  '바로 등록이어도 날짜 오류는 반드시 등록을 막아야 한다'
);

// 5) 제외/거절/보류 행은 (모델 선택 필요여도) 막지 않는다.
['제외', '거절', '보류'].forEach(function(st) {
  assert.strictEqual(
    getBlockingRegisterIssue_([
      row('R1', '⚠️ 모델 선택 필요', { status: st }),
    ], 'R1'),
    '',
    st + ' 행은 등록을 막으면 안 된다'
  );
});

// 6) 실제 RQ-260712-010 형태: 세트 헤더/개별 장비는 세트·가용, 구성품은 미등록/부족 →
//    등록 가능(빈 문자열)이어야 한다.
const real = [
  row('RQ', '세트'),                                            // 소니 FX3 바디세트(헤더)
  row('RQ', '⚠️ 부족(가용1/2)', { setTag: '[세트]소니 FX3 바디세트' }),
  row('RQ', '⚠️ 부족(가용3/4)', { setTag: '[세트]소니 FX3 바디세트' }),
  row('RQ', '❓ 미등록 장비',    { setTag: '[세트]소니 FX3 바디세트' }),  // 소니 CF-A 리더기
  row('RQ', '✅ 가용9',          { setTag: '[세트]소니 FX3 바디세트' }),
  row('RQ', '✅ 가용2'),                                        // 소니 GM 24-70mm II
  row('RQ', '세트'),                                            // 어퓨쳐 300X(헤더)
  row('RQ', '❓ 미등록 장비',    { setTag: '[세트]어퓨쳐 300X' }),       // 헤드/발라스터/클램프
  row('RQ', '❓ 미등록 장비',    { setTag: '[세트]어퓨쳐 300X', status: '제외' }), // 라이트돔 II
];
assert.strictEqual(
  getBlockingRegisterIssue_(real, 'RQ'),
  '',
  'RQ-260712-010 형태의 예약은 등록 가능해야 한다(세트 구성품이 전체를 막으면 안 됨)'
);

// ── Fix A 소스 가드: 세트 구성품·상태 스킵이 실제로 들어있는지 ──
assert(
  /indexOf\("\[세트\]"\) === 0\) continue;/.test(m[0]),
  'getBlockingRegisterIssue_는 세트 구성품([세트] 태그) 행을 건너뛰어야 한다'
);
assert(
  /status === "제외" \|\| status === "거절" \|\| status === "보류"\) continue;/.test(m[0]),
  'getBlockingRegisterIssue_는 제외/거절/보류 행을 건너뛰어야 한다'
);

// ── Fix B: 재확인 시 과거 "❌ 등록 불가" O열 배너를 지우는 로직이 _processByReqID에 있어야 한다 ──
assert(
  /\/\^❌\\s\*등록\\s\*불가\/\.test\(String\(allData\[ci\]\[14\]/.test(backend),
  '_processByReqID는 재확인 시 과거 "❌ 등록 불가" 배너(O열)를 지워야 한다'
);

// ── Fix C: registerByReqID의 "카테고리 미선택 장비 체크"(❌ 모델 미선택) 루프도
//    제외/거절/보류 행을 건너뛰어야 한다. 세트 구성품 '소프트박스'를 제외했는데도
//    "❌ 모델 미선택: N행 …"으로 계속 막히던 문제. ──
const guard2 = backend.match(/카테고리 미선택 장비 체크[\s\S]*?미선택목록\.push\(label\);/);
assert(guard2, 'registerByReqID의 카테고리 미선택 체크 루프를 찾지 못함');
assert(
  /행상태 === "제외" \|\| 행상태 === "거절" \|\| 행상태 === "보류"\) continue;/.test(guard2[0]),
  '카테고리 미선택 체크는 제외/거절/보류 행을 건너뛰어야 한다(사장님이 제외한 행은 등록을 막으면 안 됨)'
);
// 상태 스킵이 findEquipment 판정보다 먼저 와야 한다(스킵 전에 미선택목록에 담기면 안 됨).
assert(
  guard2[0].indexOf('행상태 === "제외"') < guard2[0].indexOf('findEquipment(장비명'),
  '제외/거절/보류 스킵은 findEquipment 판정보다 앞에 있어야 한다'
);

// ── Fix D: registerAsync('바로 등록')의 승인은 시트에 남아 비동기 트리거까지
//    전달되어야 하며, 그 승인이 있으면 카테고리 모델 강제 검사를 건너뛰어야 한다.
const directApproval = backend.match(/function requestHasDirectRegisterApproval_\(data, reqID\) \{[\s\S]*?\n\}/);
assert(directApproval, '바로 등록 승인을 비동기 트리거까지 전달할 시트 마커 판독 함수가 필요하다');
const requestHasDirectRegisterApproval_ = eval('(' + directApproval[0] + ')');
assert.strictEqual(
  requestHasDirectRegisterApproval_([row('R1', '', { action: '바로등록' })], 'R1'),
  true,
  'N열 바로등록 마커를 최종 승인으로 인식해야 한다'
);
assert(
  /function scheduleRegister\(reqID\)[\s\S]*?getRange\(targetRow, 14\)\.setValue\("바로등록"\)[\s\S]*?markRegisterQueued_/.test(backend),
  'scheduleRegister는 대기상태를 표시하기 전에 바로 등록 승인을 N열에 남겨야 한다'
);
assert(
  /if \(directRegisterApproved\) continue;/.test(guard2[0]),
  '바로 등록 승인이 있으면 카테고리 모델 미선택 검사를 건너뛰어야 한다'
);

console.log('confirm register block guard static checks passed');
