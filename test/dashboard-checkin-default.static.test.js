const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const backend = fs.readFileSync(path.join(root, 'checkAvailability.js'), 'utf8');

assert.match(
  backend,
  /function getDashboardCheckinItemDefault_[\s\S]*checkinProof[\s\S]*currentProof[\s\S]*return !!checkinProof && checkinProof === currentProof;[\s\S]*return false;/,
  '반납 체크는 명시 기록과 당시 행 정체성 증거가 현재 값과 맞을 때만 인정해야 한다'
);

assert.match(
  backend,
  /checkedCheckin:\s*getDashboardCheckinItemDefault_\([\s\S]{0,220}tid, eq\.qty, eq\.name, eq\.setName, eq\.isHeader/,
  '오늘 일정 대시보드 장비 목록은 반출 미체크 장비의 반납 기본 체크 규칙을 적용해야 한다'
);

assert.match(
  backend,
  /function buildDashboardSearchItem_[\s\S]*checkedCheckin:\s*getDashboardCheckinItemDefault_\([\s\S]{0,220}tid, eq\.qty, eq\.name, eq\.setName, eq\.isHeader/,
  '전체 검색/상세 대시보드 장비 목록도 같은 반납 기본 체크 규칙을 적용해야 한다'
);

assert.match(
  backend,
  /function toggleItemCheck[\s\S]{0,7500}else if \(phase === 'checkin'\)[\s\S]{0,1800}invalidateDashboardReturnInspectionForTrade_/,
  '반납 화면에서 직원이 체크를 직접 해제하면 증거 삭제와 계약 재오픈을 같은 경로로 처리해야 한다'
);

assert.match(
  backend,
  /function toggleItemCheck[\s\S]{0,1200}LockService\.getScriptLock\(\)[\s\S]{0,500}waitLock/,
  '반납 체크 해제는 거래 완료와 같은 ScriptLock을 사용해야 한다'
);
