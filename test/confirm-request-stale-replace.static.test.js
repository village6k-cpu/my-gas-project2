const assert = require('assert');
const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(path.resolve(__dirname, '..', 'checkAvailability.js'), 'utf8');

assert.match(
  source,
  /function _findReplaceableConfirmRequestGroups_\(sheet, req, requestedEquipItems\)/,
  '확인요청 입력 시 같은 고객/같은 일정의 교체 가능한 기존 RQ를 찾는 헬퍼가 있어야 한다'
);

assert.match(
  source,
  /김재우 건처럼 장비를 계속 바꾼 경우, 최신 확인요청 1개만 남긴다/,
  '장비 변경 반복 시 최신 확인요청 1개만 남기는 운영 규칙이 코드에 명시되어야 한다'
);

assert.match(
  source,
  /_confirmRequestEquipListEquivalent_\(group\.topLevelEquipItems, requestedEquipItems\)/,
  '중복 판정은 세트 구성품을 포함한 전체 행이 아니라 최상위 장비와 수량의 정확 일치로 해야 한다'
);

assert.match(
  source,
  /var replacedGroups = _findReplaceableConfirmRequestGroups_\(sheet, reqForDedupe, requestedEquipItems\);[\s\S]*_deleteConfirmRequestGroups_\(sheet, replacedGroups\)/,
  '새 확인요청을 쓰기 전에 stale RQ 그룹을 삭제해야 한다'
);

assert.match(
  source,
  /if \(\(group\.tradeIds \|\| \[\]\)\.filter\(Boolean\)\.length > 0\) return false;/,
  '이미 거래ID가 붙은 등록 완료/진행 건은 자동 삭제하면 안 된다'
);

assert.match(
  source,
  /response\.replacedReqIDs = replacedReqIDs;[\s\S]*response\.replacedRows = replacedRows;/,
  '교체가 발생하면 응답에 삭제된 RQ와 행 수를 남겨 추적 가능해야 한다'
);

console.log('confirm request stale replacement static checks passed');
