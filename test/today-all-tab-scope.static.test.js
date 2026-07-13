const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const status = fs.readFileSync(path.join(root, 'apps/today-dashboard/lib/domain/status.ts'), 'utf8');

// ──────────────────────────────────────────────────────────────────────────
// 오늘일정 '전체' 탭은 이 날짜에 걸치는 거래(오늘 반출/반납 + 진행중)만 세야 한다.
// 예전엔 필터가 없어 로드된 -30일~+365일 전체(예: 435건)를 다 세서, 날짜와 무관한
// 미래 예약·과거 완료까지 섞이고 "전체 435인데 화면엔 몇 개"로 보였다.
// ──────────────────────────────────────────────────────────────────────────

const fn = status.match(/export function tradesForTab\([\s\S]*?\n\}/);
assert(fn, 'tradesForTab 함수를 찾지 못함');

// 'all' 분기가 존재하고, 대여기간이 해당 날짜와 겹치는지로 필터해야 한다.
assert(
  /else if \(tab === "all"\) \{/.test(fn[0]),
  "'전체'(all) 탭은 더 이상 무필터가 아니라 날짜 스코프 분기를 가져야 한다"
);
assert(
  /co <= dayEnd && ro >= dayStart/.test(fn[0]),
  "'전체' 탭은 대여기간(반출~반납)이 이 날짜와 겹치는 거래만 포함해야 한다"
);
// dayStart/dayEnd가 해당 날짜의 하루 범위로 잡혀야 한다.
assert(
  /const dayStart = new Date\(`\$\{date\}T00:00:00`\)\.getTime\(\);/.test(fn[0]) &&
    /const dayEnd = new Date\(`\$\{date\}T23:59:59\.999`\)\.getTime\(\);/.test(fn[0]),
  "'전체' 탭 범위는 해당 날짜 00:00:00 ~ 23:59:59로 잡아야 한다"
);
// 반출/반납 탭은 기존 phaseForDate 기준을 유지해야 한다(회귀 방지).
assert(
  /if \(tab === "checkout"\)[\s\S]*?p === "checkout" \|\| p === "both"/.test(fn[0]),
  '반출 탭은 phaseForDate checkout/both 기준을 유지해야 한다'
);

console.log('today all-tab scope static checks passed');
