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
  assert.match(fn, /scheduleReturnCountsPersist\(tradeId, scheduleId, durablePatch\)/);
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

test('반납완료는 기준선·수량 HTTP 검증 없이 완료 상태만 빠르게 확정한다', () => {
  const gas = read('checkAvailability.js');
  const toggleStart = gas.indexOf('function toggleReturnDone');
  const toggleEnd = gas.indexOf('\nfunction listDashboardCheckoutItemCheckSids_', toggleStart);
  const toggle = gas.slice(toggleStart, toggleEnd);

  assert.ok(toggleStart >= 0 && toggleEnd > toggleStart, '반납완료 구현을 찾을 수 있어야 한다');
  assert.doesNotMatch(toggle, /assertDashboardReturnComplete_|supaGetCheckoutBaselineState_|supaSetTradeReturnDone_/);
  assert.doesNotMatch(toggle, /completedProofs|returnCountsSnapshot/);
  assert.match(toggle, /nextDashboardCompletionRevision_\(props, tid, 'return'\)/);
  assert.match(toggle, /supaMarkTradeDirty_\(tid\)/);
});
