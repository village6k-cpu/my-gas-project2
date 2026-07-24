const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

test('반납 수량 체크는 거래 전체 저장이나 품목별 GAS 호출 없이 부분 저장한다', () => {
  const store = read('apps/today-dashboard/lib/data/store.ts');
  const start = store.indexOf('export async function setReturnCount');
  const end = store.indexOf('\n// ── 결제', start);
  const fn = store.slice(start, end);

  assert.ok(start >= 0 && end > start, 'setReturnCount 구현을 찾을 수 있어야 한다');
  assert.match(fn, /scheduleReturnCountsPersist\(tradeId\)/);
  assert.match(fn, /await flushReturnCountsPersist\(tradeId\)/);
  assert.doesNotMatch(fn, /flushTradePersist\(/);
  assert.doesNotMatch(fn, /gasMutation\(["']toggleItem["']/);
});

test('반납 상세 저장은 trades.return_counts 한 필드만 갱신한다', () => {
  const remote = read('apps/today-dashboard/lib/data/remote.ts');
  const start = remote.indexOf('export async function persistReturnCounts');
  const end = remote.indexOf('\n// 거래 완전 삭제', start + 1);
  const fn = remote.slice(start, end > start ? end : undefined);

  assert.ok(start >= 0, 'persistReturnCounts 구현이 있어야 한다');
  assert.match(fn, /\.from\(["']trades["']\)/);
  assert.match(fn, /\.update\(\{\s*return_counts:/);
  assert.match(fn, /\.eq\(["']trade_id["'],\s*tradeId\)/);
  assert.doesNotMatch(fn, /schedule_items/);
});

test('반납 부분 저장은 다른 거래 저장과 같은 직렬 큐를 사용한다', () => {
  const store = read('apps/today-dashboard/lib/data/store.ts');
  const start = store.indexOf('function enqueueReturnCountsPersist');
  const end = store.indexOf('\nfunction scheduleReturnCountsPersist', start);
  const fn = store.slice(start, end);

  assert.match(fn, /const previous = persistInFlight\[tradeId\]/);
  assert.match(fn, /persistInFlight\[tradeId\] = task/);
  assert.match(fn, /returnCountPersistInFlight\[tradeId\] = task/);
});

test('최종 반납완료 검증은 내구 수량을 신뢰하고 품목 증거를 한 번에 기록한다', () => {
  const gas = read('checkAvailability.js');
  const start = gas.indexOf('function assertDashboardReturnComplete_');
  const end = gas.indexOf('\n/** 수량 정정 시', start);
  const fn = gas.slice(start, end);

  assert.ok(start >= 0 && end > start, '서버 최종 반납 검증을 찾을 수 있어야 한다');
  assert.doesNotMatch(fn, /getDashboardCheckinItemDefault_/);
  assert.match(fn, /dashboardReturnIncompleteItems_/);
  assert.match(gas, /function dashboardReturnIncompleteItems_[\s\S]{0,1000}accounted\s*!==\s*expected/);
  assert.match(fn, /props\.setProperties\(completedProofs,\s*false\)/);
});
