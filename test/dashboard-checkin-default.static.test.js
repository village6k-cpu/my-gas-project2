const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const backend = fs.readFileSync(path.join(root, 'checkAvailability.js'), 'utf8');
const toggleItemCheckStart = backend.indexOf('function toggleItemCheck');
const toggleItemCheckEnd = backend.indexOf('\nfunction getEquipmentCheckMap_', toggleItemCheckStart);
const toggleItemCheck = backend.slice(toggleItemCheckStart, toggleItemCheckEnd);

assert.ok(toggleItemCheckStart >= 0 && toggleItemCheckEnd > toggleItemCheckStart, 'toggleItemCheck 함수 구간을 찾아야 한다');

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
  toggleItemCheck,
  /if \(phase === 'checkout'\)[\s\S]*return \{[\s\S]*invalidateDashboardReturnInspectionForTrade_/,
  '반납 화면에서 직원이 체크를 직접 해제하면 증거 삭제와 계약 재오픈을 같은 경로로 처리해야 한다'
);

assert.match(
  toggleItemCheck,
  /LockService\.getScriptLock\(\)[\s\S]*tryLock\(1000\)[\s\S]*retryable:\s*true[\s\S]*invalidateDashboardReturnInspectionForTrade_/,
  '반납 체크 해제는 짧은 ScriptLock을 잡고, 경합 시 재시도 가능한 busy 응답을 반환해야 한다'
);
