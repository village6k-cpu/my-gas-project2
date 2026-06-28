const assert = require('assert');
const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(path.resolve(__dirname, '..', 'checkAvailability.js'), 'utf8');

assert.match(
  source,
  /var samePhone = !!\(reqPhone && group\.phone && reqPhone === group\.phone\);/,
  '확인요청 중복 체크는 예약자명만 보지 말고 연락처 일치도 같은 실제 고객으로 봐야 한다'
);

assert.match(
  source,
  /if \(!sameName && !samePhone\) return false;/,
  '예약자명 또는 연락처 중 하나라도 같은 실제 고객 단서가 있어야 같은 요청 후보로 비교해야 한다'
);

assert.match(
  source,
  /연락처가 같으면 카카오 닉네임\/예약자명 표기가 달라도 같은 실제 고객으로 보아 중복 차단한다/,
  '찬승 같은 카카오 닉네임과 김민솔 같은 예약자명이 번갈아 들어와도 같은 연락처면 중복 차단해야 한다'
);

assert.doesNotMatch(
  source,
  /NO_CONTACT: 연락처가 없으면 예약 등록이 불가능합니다/,
  '연락처 없는 예약도 확인요청 입력은 허용해야 한다'
);

assert.match(
  source,
  /i === 0 \? resolvedPhone : ""/,
  '연락처 조회 실패 시 확인요청 L열은 빈칸으로 입력되어야 한다'
);

assert.match(
  source,
  /❌ 연락처 입력 필요/,
  '연락처 부족 안내는 입력 차단이 아니라 확인/등록 단계 상태로 남겨야 한다'
);

console.log('confirm request identity duplicate static checks passed');
