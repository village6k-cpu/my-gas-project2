// 반납완료 빠른 경로 회귀 방지:
// B1) 기준선 조회·자동복구를 완료 버튼에 다시 연결하면 UrlFetch quota와 긴 저장중이
//     재발한다. 완료 버튼은 로컬 상세수량만 안내하고, 작업자 확인 뒤 force만 전송한다.
// B2) repairTradeProjection이 이미 반납완료된 레거시 거래에 오늘 시트값으로 기준선을
//     만들어 닫힌 카드를 '확인필요'로 되살리던 문제.
// B3) 모든 품목이 actual_taken_qty=0으로 정정된 거래가 영영 닫히지 않던 문제.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const backend = fs.readFileSync(path.resolve(__dirname, '..', 'checkAvailability.js'), 'utf8');
const store = fs.readFileSync(
  path.resolve(__dirname, '..', 'apps', 'today-dashboard', 'lib', 'data', 'store.ts'), 'utf8');
const card = fs.readFileSync(
  path.resolve(__dirname, '..', 'apps', 'today-dashboard', 'components', 'ScheduleCard.tsx'), 'utf8');

function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} must exist`);
  const bodyStart = source.indexOf('{', start);
  let depth = 0;
  for (let i = bodyStart; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`${name} incomplete`);
}

// ── B1 클라이언트: 기준선 전용 확인/autoForce 제거 + 품목 확인 다이얼로그 유지 ──
assert(!/const force = !!opts\?\.force \|\| \(on && !hasCheckoutBaseline\);/.test(store),
  '기준선 없음을 근거로 확인 없이 force를 자동 전송하면 안 된다');
assert(!/needsBaselineConfirm|autoForce:\s*1/.test(store),
  '기준선 전용 확인 상태와 autoForce를 완료 경로에 되살리면 안 된다');
assert(!/needsBaselineConfirm/.test(card) && /window\.confirm/.test(card),
  '카드는 기준선 팝업 없이 미확인 품목에 대해서만 작업자 확인을 받아야 한다');

// ── B1 서버: 완료 버튼에서 Supabase 기준선 HTTP 재검증 금지 ──
const toggleReturnFn = extractFunction(backend, 'toggleReturnDone');
assert(!/autoForce|STALE_BASELINE|supaGetCheckoutBaselineState_|assertDashboardReturnComplete_/.test(toggleReturnFn),
  '서버 완료 버튼은 기준선 조회·복구·검증을 실행하면 안 된다');
assert(/returnForced_v1_/.test(toggleReturnFn),
  '강제 종결은 감사 가능한 내구 마커를 남겨야 한다');

// ── B2: 이미 반납완료된 거래는 기준선 재생성 생략 ──
const repairFn = extractFunction(backend, 'repairDashboardTradeProjection_');
assert(/tradeAlreadyCompleted/.test(repairFn),
  '이미 반납완료된 레거시 거래에 빈 기준선 복구를 수행하면 안 된다');

// ── B3: 전 품목 actual=0 정정 거래는 반납 의무 없음으로 종결 가능 ──
const assertFn = extractFunction(backend, 'assertDashboardReturnComplete_');
assert(/recordedBaselineItems\.length[\s\S]{0,600}checkedCount:\s*0/.test(assertFn),
  '모든 품목이 actual_taken_qty=0으로 정정된 거래는 하드 차단 대신 종결 가능해야 한다');

console.log('# return force/baseline guard checks passed');
