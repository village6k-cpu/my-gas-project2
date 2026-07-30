// 반납완료 기준선 가드 회귀 방지:
// B1) 클라이언트가 로컬 기준선 없음을 근거로 확인 없이 force를 자동 전송해
//     서버의 모든 반납 검증(assertDashboardReturnComplete_)이 우회되던 문제.
//     → 자동 force 제거: 작업자 확인 다이얼로그 후에만 force, autoForce는 서버가
//       Supabase 정본 기준선을 재검증해 낡은 화면의 우회를 거부한다.
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

// ── B1 클라이언트: 무단 자동 force 금지 + 확인 다이얼로그 요구 ──
assert(!/const force = !!opts\?\.force \|\| \(on && !hasCheckoutBaseline\);/.test(store),
  '기준선 없음을 근거로 확인 없이 force를 자동 전송하면 안 된다');
assert(/needsBaselineConfirm/.test(store), '기준선 없음은 확인 필요 신호로 반환해야 한다');
assert(/autoForce:\s*1/.test(store), '기준선 없음 확인 후 force에는 autoForce 표식을 붙인다');
assert(/needsBaselineConfirm/.test(card) && /window\.confirm/.test(card),
  '카드가 기준선 없음 확인 다이얼로그를 보여줘야 한다');

// ── B1 서버: autoForce는 Supabase 정본 기준선 재검증 ──
const toggleReturnFn = extractFunction(backend, 'toggleReturnDone');
assert(/autoForce/.test(toggleReturnFn) && /STALE_BASELINE/.test(toggleReturnFn),
  '서버는 autoForce 요청에서 정본 기준선이 있으면 우회를 거부해야 한다');
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
