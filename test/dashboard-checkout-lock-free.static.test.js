const fs = require('fs');
const path = require('path');
const assert = require('assert');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

const backend = read('checkAvailability.js');
const store = read('apps/today-dashboard/lib/data/store.ts');
const remote = read('apps/today-dashboard/lib/data/remote.ts');
const card = read('apps/today-dashboard/components/ScheduleCard.tsx');

const toggleSetupDone = backend.match(/function toggleSetupDone\(tid, done\) \{[\s\S]*?\n\}/);
assert.ok(toggleSetupDone, 'toggleSetupDone must exist');
assert.doesNotMatch(
  toggleSetupDone[0],
  /LockService\.getScriptLock\(\)|\.waitLock\(/,
  '반출 완료는 장기 전역 ScriptLock 대기 때문에 막히면 안 된다'
);
assert.match(
  toggleSetupDone[0],
  /supaCaptureCheckoutBaseline_\(tid, checkable, true\)/,
  '반출 완료 전 Supabase 불변 기준선 저장은 계속 필수다'
);
assert.match(
  toggleSetupDone[0],
  /props\.setProperties\(completed, false\)/,
  '기준선 저장 성공 뒤에만 반출 완료 속성을 확정해야 한다'
);

const toggleSetup = store.match(/export async function toggleSetup\(tradeId: string\): Promise<ToggleSetupResult> \{[\s\S]*?\n\}/);
assert.ok(toggleSetup, 'toggleSetup must exist');
assert.match(
  toggleSetup[0],
  /const saveId = beginTradeSave\(tradeId\);[\s\S]*?mutateTrade\(tradeId[\s\S]*?setupDone:\s*done[\s\S]*?false\);[\s\S]*?await gasMutation\("toggleSetup"/,
  '카드는 GAS 응답 전에 즉시 완료 상태가 되어야 한다'
);
assert.match(
  toggleSetup[0],
  /if \(state\.savingTrades\[tradeId\]\)[\s\S]*?return \{ ok: false, error \};/,
  '빠른 연속 클릭이 들어와도 같은 거래의 반출완료 요청은 한 번만 실행해야 한다'
);
assert.match(
  toggleSetup[0],
  /finishTradeSave\(tradeId, saveId, "saved", "저장됨"\)/,
  '원장과 앱 저장이 모두 성공하면 저장 완료를 표시해야 한다'
);
assert.match(
  toggleSetup[0],
  /if \(isGasOutcomeUnknownError\(e\)\)[\s\S]*queueSetupOutcomeRetry\(tradeId[\s\S]*return \{ ok: true, warning \}/,
  'GAS 응답만 유실된 결과 미확정은 완료 표시를 유지하고 같은 상태를 재시도해야 한다'
);
assert.match(
  toggleSetup[0],
  /if \(isGasOutcomeUnknownError\(e\)\)[\s\S]*return \{ ok: true, warning \}[\s\S]*setupDone:\s*previousDone[\s\S]*반출 상태 변경 실패/,
  '확정 실패일 때만 즉시 완료 상태를 되돌려야 한다'
);
assert.doesNotMatch(
  toggleSetup[0],
  /flushTradePersist\(tradeId\)/,
  '반출완료 뒤 거래와 장비 전체를 재저장하면 안 된다'
);
assert.match(
  remote,
  /const tradeRow = tradeToRow\(trade\)[\s\S]*delete tradeRow\.setup_done;[\s\S]*delete tradeRow\.setup_done_at;[\s\S]*upsert\(tradeRow/,
  '브라우저 전체 저장은 서버 권한 반출완료 필드를 덮어쓰면 안 된다'
);

assert.match(
  card,
  /disabled=\{saving\}/,
  '반출완료 저장 중에는 같은 버튼을 다시 눌러 중복 요청할 수 없어야 한다'
);
assert.match(
  card,
  /saving\s*\?\s*done\s*\?\s*"반출 완료됨 · 저장 확인 중…"\s*:\s*"반출 처리 중…"/,
  '클릭 직후 완료를 표시하고 응답이 늦으면 저장 확인 중 상태를 유지해야 한다'
);

assert.match(
  backend,
  /function getDashboardRowsByTradeId_\(schedSheet, tid\)/,
  '반출완료는 대상 거래의 스케줄 행만 찾는 헬퍼를 사용해야 한다'
);
assert.match(
  toggleSetupDone[0],
  /getDashboardRowsByTradeId_\(sched, tid\)[\s\S]*?getDashboardSearchGroupsForIds_\(sched, \[tid\], rowsByTid\)/,
  '반출완료 기준선 생성 때 스케줄상세 전체 12열을 읽지 않아야 한다'
);

console.log('dashboard checkout lock-free static checks passed');
