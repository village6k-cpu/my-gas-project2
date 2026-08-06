// 동일 세트를 두 번째 헤더 행으로 추가하면 두 번째 세트의 구성품이 전개되지 않던 회귀 방지.
// 판정을 '세트 구성품이 요청에 하나라도 있는가'(전역)에서 '이 헤더 바로 아래에 구성품이
// 있는가'(위치 기반)로 바꿔, 헤더마다 자기 몫의 구성품을 정확히 전개한다.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const backend = fs.readFileSync(path.resolve(__dirname, '..', 'checkAvailability.js'), 'utf8');

// 전역 존재 여부 판정(reqRows.some)이 세트 전개 가드로 더 이상 쓰이면 안 된다
assert(
  !/var hasExisting = reqRows\.some\(function\(rr\) \{ return rr\.qTag === "\[세트\]" \+ ri\.장비명; \}\);/.test(backend),
  '세트 전개 가드가 전역 some 판정이면 두 번째 동일 세트 헤더가 전개되지 않는다'
);
// 위치 기반 판정: 헤더 바로 아래 행(row+1)이 이 세트의 구성품인지 확인
assert(
  /alreadyExpanded/.test(backend) && /ri\.row \+ 1/.test(backend),
  '헤더 바로 아래 행 기준의 위치 기반 전개 판정이 필요하다'
);

console.log('# duplicate set expansion checks passed');
