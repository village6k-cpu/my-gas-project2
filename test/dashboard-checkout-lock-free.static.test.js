const fs = require('fs');
const path = require('path');
const assert = require('assert');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

const backend = read('checkAvailability.js');
const store = read('apps/today-dashboard/lib/data/store.ts');
const remote = read('apps/today-dashboard/lib/data/remote.ts');
const card = read('apps/today-dashboard/components/ScheduleCard.tsx');

const setupStart = backend.indexOf('function toggleSetupDone(tid, done, options)');
const setupEnd = backend.indexOf('\nfunction normalizeDashboardReturnSetKey_', setupStart);
assert.ok(setupStart >= 0 && setupEnd > setupStart, 'toggleSetupDone must exist');
const toggleSetupDone = backend.slice(setupStart, setupEnd);
assert.doesNotMatch(
  toggleSetupDone,
  /\.waitLock\(/,
  '반출 완료는 장기 전역 ScriptLock 대기 때문에 막히면 안 된다'
);
assert.match(
  toggleSetupDone,
  /transitionLock\.tryLock\(1000\)[\s\S]*transitionLock\.releaseLock\(\)[\s\S]*supaCaptureCheckoutBaseline_/,
  '품목 체크와 기준선 시작 경계만 짧게 잠그고 외부 기준선 저장 전에 즉시 풀어야 한다'
);
assert.match(
  toggleSetupDone,
  /supaCaptureCheckoutBaseline_\(tid, checkable, true\)/,
  '반출 완료 전 Supabase 불변 기준선 저장은 계속 필수다'
);
assert.match(
  toggleSetupDone,
  /props\.setProperties\(completed, false\)/,
  '기준선 저장 성공 뒤에만 반출 완료 속성을 확정해야 한다'
);

const toggleSetup = store.match(/export async function toggleSetup\(tradeId: string\): Promise<ToggleSetupResult> \{[\s\S]*?\n\}/);
assert.ok(toggleSetup, 'toggleSetup must exist');
// 즉시 확정 UX: 클릭 경로는 낙관 표시+내구 outbox+백그라운드 확정 예약만 하고 즉시 반환한다.
// 서버 왕복(3~10초) 동안 카드를 잠그던 beginTradeTransition/await gasMutation은 제거됐다.
assert.match(
  toggleSetup[0],
  /mutateTrade\(tradeId[\s\S]*?setupDone:\s*done[\s\S]*?false\);[\s\S]*?scheduleCompletionMutationReplay_\("setup", tradeId, 0\)/,
  '카드는 GAS 응답 전에 즉시 완료 상태가 되어야 한다'
);
assert.doesNotMatch(
  toggleSetup[0],
  /beginTradeTransition|await gasMutation/,
  '클릭 경로가 카드를 잠그거나 서버를 기다리면 안 된다 (즉시 확정 UX)'
);
assert.match(
  toggleSetup[0],
  /if \(activeTradeTransitions\.has\(tradeId\) \|\| pendingRemoveEquipmentTrades\.has\(tradeId\)\)[\s\S]*?return \{ ok: false, error \};/,
  '전환 위험 구간(편집/취소/제외)과의 순서 역전은 계속 막아야 한다'
);
// 확정·응답 유실 재확인·거절 롤백은 백그라운드 엔진이 담당한다
const confirmEngine = store.match(/async function replayCompletionMutationEntry_[\s\S]*?\nfunction replayCompletionMutationOutboxes_/);
assert.ok(confirmEngine, '백그라운드 확정 엔진이 있어야 한다');
assert.match(confirmEngine[0], /gasMutation\("toggleSetup"/, '확정 엔진이 GAS 반출완료를 전송한다');
assert.match(confirmEngine[0], /fetchSetupCompletion\(latest\.tradeId\)/, '응답 유실은 정본 재확인으로 수렴한다');
assert.match(confirmEngine[0], /reconcileCompletionMutationCanonical_/, '명확한 거절만 정본 재조회로 되돌린다');
assert.doesNotMatch(
  toggleSetup[0],
  /flushTradePersist\(tradeId\)/,
  '반출완료 뒤 거래와 장비 전체를 재저장하면 안 된다'
);
assert.match(
  remote,
  /const tradeRow = tradeToRow\(trade\)[\s\S]*upsert\(tradeRow, \{[\s\S]*ignoreDuplicates: true/,
  '신규 거래는 전체 초기 상태로 추가하되 기존 행은 덮지 않아야 한다'
);
assert.match(
  remote,
  /function tradeStructureRow[\s\S]*delete row\.setup_done;[\s\S]*delete row\.setup_done_at;/,
  '기존 행의 서버 권한 반출완료는 구조 저장이 덮어쓰면 안 된다'
);

assert.match(
  store,
  /activeTradeTransitions\.has\(tradeId\)/,
  '일반 수량 저장과 완료 전환을 구분하고 완료 전환 자체만 중복 차단해야 한다'
);
assert.doesNotMatch(
  card,
  /disabled=\{saving\}/,
  '수량 저장 중에도 완료 버튼은 장벽을 기다리며 눌릴 수 있어야 한다'
);
assert.match(
  card,
  /done\s*\?\s*"반출 완료됨"\s*:\s*saving\s*\?\s*"상태 변경 중…"/,
  '클릭 직후 반출완료 상태를 최우선으로 표시해야 한다'
);
assert.doesNotMatch(
  card,
  /반출 완료됨 · 저장 확인 중|반출 처리 중|저장 중…/,
  '느린 원격 확인이 사용자의 완료 처리를 계속 저장 중처럼 보이게 하면 안 된다'
);
assert.match(
  card,
  /saving[\s\S]{0,160}백그라운드 동기화/,
  '원격 확인은 카드 완료 상태와 분리된 보조 정보로만 보여야 한다'
);

assert.match(
  backend,
  /function getDashboardRowsByTradeId_\(schedSheet, tid\)/,
  '반출완료는 대상 거래의 스케줄 행만 찾는 헬퍼를 사용해야 한다'
);
assert.match(
  toggleSetupDone,
  /getDashboardRowsByTradeId_\(sched, tid\)[\s\S]*?getDashboardSearchGroupsForIds_\(sched, \[tid\], rowsByTid\)/,
  '반출완료 기준선 생성 때 스케줄상세 전체 12열을 읽지 않아야 한다'
);

console.log('dashboard checkout lock-free static checks passed');
