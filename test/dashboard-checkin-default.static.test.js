const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const backend = fs.readFileSync(path.join(root, 'checkAvailability.js'), 'utf8');

assert.match(
  backend,
  /function getDashboardCheckinItemDefault_\(props, scheduleId, checkoutChecked, setupDoneForTrade\)[\s\S]*if \(checkinValue === '1'\) return true;[\s\S]*if \(checkinValue === '0'\) return false;[\s\S]*return setupDoneForTrade === true && checkoutChecked !== true;/,
  '반납 체크 기본값은 명시적 반납 체크/해제를 우선하고, 반출 완료 후 반출 미체크 장비는 기본 체크되어야 한다'
);

assert.match(
  backend,
  /checkedCheckin:\s*getDashboardCheckinItemDefault_\(props, eq\.scheduleId, checkoutChecked, setupDoneForTrade\)/,
  '오늘 일정 대시보드 장비 목록은 반출 미체크 장비의 반납 기본 체크 규칙을 적용해야 한다'
);

assert.match(
  backend,
  /function buildDashboardSearchItem_[\s\S]*checkedCheckin:\s*getDashboardCheckinItemDefault_\(props, eq\.scheduleId, checkoutChecked, setupDoneForTrade\)/,
  '전체 검색/상세 대시보드 장비 목록도 같은 반납 기본 체크 규칙을 적용해야 한다'
);

assert.match(
  backend,
  /else if \(phase === 'checkin'\) \{[\s\S]*props\.setProperty\(key, '0'\);[\s\S]*\} else \{[\s\S]*props\.deleteProperty\(key\);/,
  '반납 화면에서 직원이 체크를 직접 해제한 상태는 0으로 보존되어 기본 체크에 다시 덮이면 안 된다'
);
