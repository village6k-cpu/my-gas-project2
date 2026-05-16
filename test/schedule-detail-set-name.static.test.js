const assert = require('assert');
const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(path.resolve(__dirname, '..', 'checkAvailability.js'), 'utf8');

assert.doesNotMatch(
  source,
  /순수 장비마스터 장비만 C를 비운다|세트마스터품목명|setNameForSingle/,
  '스케줄상세 C열 세트명을 비우는 레거시 분기와 변수명이 남아있으면 안 된다'
);

assert.match(
  source,
  /tid,\s*equipName,\s*equipName,\s*qty,\s*반출일,\s*반출시간,\s*반납일,\s*반납시간/,
  '오늘일정 장비추가 단독 품목도 스케줄상세 C=장비명, D=장비명으로 저장해야 한다'
);

assert.match(
  source,
  /schedID,\s*거래ID,\s*장비명,\s*장비명,\s*수량,\s*[\r\n]+\s*반출일str,\s*반출시간str,\s*반납일str,\s*반납시간str/,
  '확인요청 등록/추가 단독 품목도 스케줄상세 C=장비명, D=장비명으로 저장해야 한다'
);

assert.doesNotMatch(
  source,
  /isSetMasterName\([^)]*\)\s*\?\s*[^:]+:\s*""/,
  '세트마스터에 없다는 이유로 스케줄상세 C열을 빈 값으로 만드는 분기는 금지한다'
);

console.log('schedule detail set-name static checks passed');
