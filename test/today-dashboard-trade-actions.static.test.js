const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

const card = read('apps/today-dashboard/components/ScheduleCard.tsx');
const timeline = read('apps/today-dashboard/components/VillageTimeline.tsx');
const store = read('apps/today-dashboard/lib/data/store.ts');
const remote = read('apps/today-dashboard/lib/data/remote.ts');
const gasRoute = read('apps/today-dashboard/app/api/gas/route.ts');
const sheetApi = read('sheetAPI.js');
const backend = read('checkAvailability.js');
const code = read('Code.js');
const supabaseSync = read('supabaseSync.js');
const actionsPath = path.join(root, 'apps/today-dashboard/components/TradeActions.tsx');

assert(fs.existsSync(actionsPath), '등록 예약용 공통 TradeActions 컴포넌트가 필요하다');
const actions = fs.existsSync(actionsPath) ? fs.readFileSync(actionsPath, 'utf8') : '';

assert(
  /<TradeActions\s+trade=\{trade\}/.test(card),
  '오늘일정 카드는 접지 않아도 TradeActions를 보여야 한다',
);
assert(
  /<TradeActions\s+trade=\{trade\}/.test(timeline),
  '스케줄 상세에도 동일한 TradeActions를 보여야 한다',
);
assert(
  actions.includes('편집') && actions.includes('취소') && actions.includes('완전삭제'),
  '편집·취소·완전삭제를 명시적인 버튼으로 구분해야 한다',
);
assert(
  /예약자명/.test(actions) && /연락처/.test(actions) && /업체명/.test(actions) &&
    /반출 일시/.test(actions) && /반납 일시/.test(actions),
  '예약 편집기는 고객정보와 반출·반납 일시를 모두 제공해야 한다',
);
assert(
  /timeZone:\s*"Asia\/Seoul"/.test(actions) &&
    !/const direct = [^\n]*match/.test(actions),
  '편집 일시는 ISO 문자열을 잘라 쓰지 말고 Asia/Seoul 시간으로 변환해야 한다',
);
assert(
  /장비명/.test(actions) && /예약 수량/.test(actions) &&
    /setItemName/.test(actions) && /setItemQty/.test(actions),
  '예약 편집기에서 등록 장비명과 수량을 수정할 수 있어야 한다',
);
assert(
  /window\.prompt\([\s\S]*trade\.tradeId/.test(actions) &&
    /typed\.trim\(\) !== trade\.tradeId/.test(actions),
  '완전삭제는 거래ID 재입력 확인을 유지해야 한다',
);

assert(
  /export async function updateTradeDetails/.test(store) &&
    /gasMutation\("updateTrade"/.test(store) &&
    /flushTradePersist\(tradeId\)/.test(store),
  '거래 편집은 GAS 원장 성공 뒤 Supabase까지 즉시 저장해야 한다',
);
assert(
  /export async function cancelTrade/.test(store) &&
    /gasMutation\("updateContractStatus"[\s\S]*status: "취소"/.test(store) &&
    /cancelTradeRemote\(tradeId\)/.test(store),
  '취소는 GAS 취소 처리와 Supabase 취소 처리를 모두 실행해야 한다',
);
assert(
  /export async function cancelTradeRemote/.test(remote) &&
    /from\("schedule_items"\)\.delete\(\)\.eq\("trade_id", tradeId\)/.test(remote) &&
    /from\("trades"\)[\s\S]{0,120}\.update\([\s\S]*contract_status: "취소"/.test(remote),
  '취소된 거래는 Supabase 점유 행을 지우고 거래 상태를 취소로 남겨야 한다',
);

assert(
  gasRoute.includes('"updateTrade"') && gasRoute.includes('"updateContractStatus"'),
  '인증된 GAS 프록시가 거래 편집과 취소 액션을 허용해야 한다',
);
assert(
  /case "updateTrade":[\s\S]*dashboardUpdateTradeDetails/.test(sheetApi),
  'sheetAPI가 등록 예약 편집을 dashboardUpdateTradeDetails로 연결해야 한다',
);

const editFn = backend.match(/function dashboardUpdateTradeDetails\([\s\S]*?\n\}/);
assert(editFn, 'dashboardUpdateTradeDetails 백엔드 함수가 필요하다');
if (editFn) {
  assert(/getSheetByName\(['"]계약마스터['"]\)/.test(editFn[0]), '계약마스터를 기준으로 편집해야 한다');
  assert(/getRange\(row,\s*2,\s*1,\s*7\)\.setValues/.test(editFn[0]), '계약마스터 B:H를 한 번에 갱신해야 한다');
  assert(/propagateContractDates\(/.test(editFn[0]), '일정 변경을 스케줄상세와 거래내역으로 전파해야 한다');
  assert(/getRange\([^\n]*13\)\.setValue\(customerName\)/.test(editFn[0]), '스케줄상세 M열 예약자명도 갱신해야 한다');
  assert(/deleteAndRegenerateContract|scheduleContractRegen/.test(editFn[0]), '변경 후 계약서를 재생성해야 한다');
  assert(/supaMarkTradeDirty_\(tradeId\)/.test(editFn[0]), 'Supabase 재동기화 대상으로 표시해야 한다');
  assert(/invalidateDashboardCache/.test(editFn[0]) && /invalidateTimelineCache/.test(editFn[0]), '대시보드와 타임라인 캐시를 비워야 한다');
}

assert(
  /function supaCancelTrade_/.test(supabaseSync) &&
    /supaCancelTrade_\(거래ID\)/.test(code),
  'GAS 취소 처리도 Supabase의 스케줄 점유를 즉시 제거해야 한다',
);

console.log('today-dashboard registered trade actions checks passed');
