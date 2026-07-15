const fs = require('fs');
const path = require('path');
const assert = require('assert');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

const backend = read('checkAvailability.js');
const store = read('apps/today-dashboard/lib/data/store.ts');
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
  /const saveId = beginTradeSave\(tradeId\);[\s\S]*?await gasMutation\("toggleSetup"/,
  '카드는 GAS 응답 전에 즉시 저장 중 상태가 되어야 한다'
);
assert.match(
  toggleSetup[0],
  /if \(state\.savingTrades\[tradeId\]\)[\s\S]*?return \{ ok: false, error \};/,
  '빠른 연속 클릭이 들어와도 같은 거래의 반출완료 요청은 한 번만 실행해야 한다'
);
assert.match(
  toggleSetup[0],
  /finishTradeSave\(tradeId, saveId, "saved", "저장됨"\)/,
  '완료 표시는 원장과 앱 저장이 모두 성공한 뒤에만 보여야 한다'
);
assert.match(
  toggleSetup[0],
  /finishTradeSave\(tradeId, saveId, "error", `⚠️ 반출 상태 변경 실패 — \$\{error\}`\)/,
  '실패하면 저장 중 상태를 해제하고 오류를 보여야 한다'
);

assert.match(
  card,
  /disabled=\{saving\}/,
  '반출완료 저장 중에는 같은 버튼을 다시 눌러 중복 요청할 수 없어야 한다'
);
assert.match(
  card,
  /saving\s*\?\s*"반출 처리 중…"/,
  '클릭 직후 큰 버튼 자체가 반출 처리 중으로 바뀌어야 한다'
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
