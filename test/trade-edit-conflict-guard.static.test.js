// 회귀 방지: 예약 편집 모달이 통째 스냅샷(B:H)을 last-write-wins로 덮어써서,
// 다른 직원이 먼저 고친 연락처/일정을 몇 분 뒤 저장된 낡은 모달이 조용히 되돌리던 문제.
// 클라이언트가 편집 시작 시점의 값(expected)을 보내면 서버가 현재 원장과 비교해
// 달라져 있으면 CONFLICT로 거부한다.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const backend = fs.readFileSync(path.resolve(__dirname, '..', 'checkAvailability.js'), 'utf8');
const api = fs.readFileSync(path.resolve(__dirname, '..', 'sheetAPI.js'), 'utf8');
const store = fs.readFileSync(
  path.resolve(__dirname, '..', 'apps', 'today-dashboard', 'lib', 'data', 'store.ts'), 'utf8');
const tradeActions = fs.readFileSync(
  path.resolve(__dirname, '..', 'apps', 'today-dashboard', 'components', 'TradeActions.tsx'), 'utf8');

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

const updateFn = extractFunction(backend, 'dashboardUpdateTradeDetails');
assert(/input\.expected/.test(updateFn), '서버가 expected 스냅샷을 받아야 한다');
assert(/CONFLICT/.test(updateFn), '스냅샷 불일치 시 CONFLICT로 거부해야 한다');
// 전화번호는 포맷 차이가 흔하므로 숫자 정규화 비교
assert(/replace\(\/\\D\/g,\s*''\)/.test(updateFn), '연락처는 숫자 정규화 후 비교해야 한다');

assert(/case "updateTrade":[\s\S]{0,900}expected/.test(api), 'updateTrade 라우트가 expected를 전달해야 한다');
assert(/expected:\s*JSON\.stringify/.test(tradeActions) || /expected:\s*JSON\.stringify/.test(store),
  '클라이언트가 편집 시작 시점 스냅샷을 expected로 보내야 한다');

console.log('# trade edit conflict guard checks passed');
