const assert = require('assert');
const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(path.resolve(__dirname, '..', 'checkAvailability.js'), 'utf8');
const api = fs.readFileSync(path.resolve(__dirname, '..', 'sheetAPI.js'), 'utf8');

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
  /var replacedGroups = _selectAuthorizedConfirmRequestReplacementGroups_\(staffConfirmedPendingFence\);[\s\S]*_deleteConfirmRequestGroups_\(sheet, replacedGroups\)/,
  '직원확정 exact fence가 있는 RQ만 새 확인요청 쓰기 전에 교체해야 한다'
);

assert.doesNotMatch(
  source.slice(source.indexOf('function _insertAndCheckRequest'), source.indexOf('function _assertConfirmRequestEditableRows_')),
  /_findReplaceableConfirmRequestGroups_\(/,
  '일반 full_plan 입력은 같은 고객/기간의 기존 RQ를 추측으로 삭제하면 안 된다'
);

assert.doesNotMatch(
  source.slice(source.indexOf('function _insertAndCheckRequest'), source.indexOf('function _assertConfirmRequestEditableRows_')),
  /기존 등록 예약 변경은 확인요청으로 입력할 수 없습니다/,
  '이미 등록된 거래가 있어도 고객의 새 장비 문의 자체는 확인요청에 먼저 남겨야 한다'
);

assert.doesNotMatch(
  source.slice(source.indexOf('function _insertAndCheckRequest'), source.indexOf('function _assertConfirmRequestEditableRows_')),
  /checkDuplicateRequest\(/,
  '등록 스케줄과 장비가 같아도 고객의 새 장비 문의 접수를 막으면 안 되며 확인요청끼리만 완전 중복 제거해야 한다'
);

assert.match(
  source.slice(source.indexOf('function _insertAndCheckRequest'), source.indexOf('function _assertConfirmRequestEditableRows_')),
  /if \(registeredTradeId\) response\.matchedRegisteredTradeId = registeredTradeId;/,
  '기존 등록거래 고객의 새 문의를 입력한 경우 GAS 응답에 exact 거래ID를 남겨 후속 등록변경으로 연결해야 한다'
);

assert.match(
  api.slice(api.indexOf('if (funcName === "insertAndCheckRequest"'), api.indexOf('if (funcName === "updateRequest"')),
  /response\.matchedRegisteredTradeId\s*=\s*matchedRegisteredTradeId/,
  'sheetAPI runFunction 응답도 검증한 exact 거래ID를 버리지 않고 worker에 전달해야 한다'
);

const insertRequestSource = source.slice(
  source.indexOf('function _insertAndCheckRequest'),
  source.indexOf('function _assertConfirmRequestEditableRows_')
);
assert.match(
  insertRequestSource,
  /var duplicateResponse = \{[\s\S]*if \(registeredTradeId\) duplicateResponse\.matchedRegisteredTradeId = registeredTradeId;/,
  '기존 RQ 완전중복을 재사용하는 응답도 등록거래 연결 ID를 보존해야 한다'
);
assert.match(
  insertRequestSource,
  /var completedResponse = \{[\s\S]*if \(registeredTradeId\) completedResponse\.matchedRegisteredTradeId = registeredTradeId;/,
  '일정미완성 RQ를 완성하는 응답도 등록거래 연결 ID를 보존해야 한다'
);

assert.match(
  source,
  /function _finalizeRegisteredTradeSourceRequest_\([\s\S]*등록완료\(기존거래 보강\)[\s\S]*markRequestRegistered_\(/,
  '등록변경 성공 뒤에는 exact source RQ를 기존 거래ID로 종결하는 전용 경계가 있어야 한다'
);

assert.match(
  source,
  /function finalizeRegisteredTradeSourceRequestRecovery\([\s\S]*recoveredWithoutScheduleReplay[\s\S]*customerNotificationSent:\s*false/,
  '이미 적용된 등록변경은 스케줄 재실행이나 고객발송 없이 exact RQ만 복구할 수 있어야 한다'
);

assert(
  api.includes('"finalizeRegisteredTradeSourceRequestRecovery"') &&
    /if \(funcName === "finalizeRegisteredTradeSourceRequestRecovery"\)/.test(api),
  'exact source RQ 복구는 내부 run allowlist와 구조화 인자 경계를 통해서만 호출되어야 한다'
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
