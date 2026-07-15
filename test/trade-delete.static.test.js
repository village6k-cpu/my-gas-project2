const assert = require('assert');
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');

const backend = read('checkAvailability.js');
const supa = read('supabaseSync.js');
const sheetApi = read('sheetAPI.js');
const confirmRoute = read('apps/today-dashboard/app/api/confirm/route.ts');
const card = read('apps/today-dashboard/components/ScheduleCard.tsx');
const tradeActions = read('apps/today-dashboard/components/TradeActions.tsx');
const store = read('apps/today-dashboard/lib/data/store.ts');

// ──────────────────────────────────────────────────────────────────────────
// 거래(예약) 완전 삭제 — 예시/테스트 데이터 정리용. 계약마스터+스케줄상세 시트행과
// Supabase(trades/schedule_items)를 모두 지운다(한쪽만 지우면 동기화로 되살아남).
// 되돌릴 수 없어 거래ID 입력 확인을 거친다. 확인요청 행은 건드리지 않는다.
// ──────────────────────────────────────────────────────────────────────────

// 1) 백엔드 deleteTrade — 두 시트 + Supabase + 취소와 달리 행을 실제 삭제.
const fn = backend.match(/function deleteTrade\(tradeId\) \{[\s\S]*?\n\}/);
assert(fn, 'deleteTrade 백엔드 함수를 찾지 못함');
assert(/getSheetByName\("스케줄상세"\)/.test(fn[0]) && /getSheetByName\("계약마스터"\)/.test(fn[0]), 'deleteTrade는 스케줄상세·계약마스터를 모두 대상으로 해야 한다');
assert((fn[0].match(/\.deleteRow\(/g) || []).length >= 2, 'deleteTrade는 두 시트에서 행을 삭제해야 한다');
assert(/supaDeleteTrade_\(tid\)/.test(fn[0]), 'deleteTrade는 Supabase 행도 지워야 한다(앱은 Supabase를 읽음)');
assert(/거래ID를 찾을 수 없음/.test(fn[0]), '없는 거래ID면 에러를 던져야 한다');
assert(!/getSheetByName\("확인요청"\)/.test(fn[0]), 'deleteTrade는 확인요청 시트를 건드리면 안 된다');

// 2) supaDeleteTrade_ — village 스키마의 schedule_items + trades DELETE.
const sfn = supa.match(/function supaDeleteTrade_\(tid\) \{[\s\S]*?\n\}/);
assert(sfn, 'supaDeleteTrade_ 헬퍼를 찾지 못함');
assert(/rest\/v1\/schedule_items/.test(sfn[0]) && /rest\/v1\/trades/.test(sfn[0]), 'schedule_items와 trades 둘 다 삭제해야 한다');
assert(/method: 'delete'/.test(sfn[0]), 'DELETE 메서드를 써야 한다');
assert(/'Content-Profile': 'village'/.test(sfn[0]), 'village 스키마를 지정해야 한다');
// 자식(schedule_items)을 부모(trades)보다 먼저 지운다.
assert(sfn[0].indexOf('schedule_items') < sfn[0].indexOf("'/rest/v1/trades'"), 'schedule_items를 trades보다 먼저 삭제해야 한다');

// 3) 화이트리스트 — 두 경로 모두 deleteTrade 허용.
assert(/"deleteTrade"/.test(sheetApi), 'sheetAPI allowedFunctions에 deleteTrade가 있어야 한다');
assert(/FUNCS = new Set\(\[[^\]]*"deleteTrade"/.test(confirmRoute), '/api/confirm FUNCS에 deleteTrade가 있어야 한다');

// 4) UI — 상세 펼친 뒤 노출 + 거래ID 입력 확인 + run 호출 + 낙관적 제거.
assert(/<TradeActions trade=\{trade\}/.test(card), 'ScheduleCard에 상시 예약 관리 버튼이 있어야 한다');
assert(/완전삭제/.test(tradeActions), 'TradeActions에 완전삭제 버튼이 있어야 한다');
assert(/window\.prompt\(/.test(tradeActions), '삭제는 prompt로 거래ID 입력을 받아야 한다(오삭제 방지)');
assert(/typed\.trim\(\) !== trade\.tradeId/.test(tradeActions), '입력한 거래ID가 일치할 때만 삭제해야 한다');
assert(/func: "deleteTrade", args: \{ tradeId: trade\.tradeId \}/.test(tradeActions), 'deleteTrade run을 호출해야 한다');
assert(/removeTradeLocally\(trade\.tradeId\)/.test(tradeActions), '삭제 성공 시 화면에서 즉시 제거해야 한다');

// 5) store 헬퍼.
assert(/export function removeTradeLocally\(tradeId: string\)/.test(store), 'store에 removeTradeLocally가 있어야 한다');

// 6) 클라이언트 세션으로도 Supabase 행을 지운다(봇 RLS와 무관하게 재등장 방지).
const remote = read('apps/today-dashboard/lib/data/remote.ts');
const rfn = remote.match(/export async function deleteTradeRemote\(tradeId: string\)[\s\S]*?\n\}/);
assert(rfn, 'deleteTradeRemote 헬퍼가 있어야 한다');
assert(/from\("schedule_items"\)\.delete\(\)\.eq\("trade_id", tradeId\)/.test(rfn[0]), 'schedule_items를 삭제해야 한다');
assert(/from\("trades"\)\.delete\(\)\.eq\("trade_id", tradeId\)/.test(rfn[0]), 'trades를 삭제해야 한다');
assert(/deleteTradeRemote\(trade\.tradeId\)/.test(tradeActions), 'TradeActions가 GAS 삭제 후 Supabase도 클라이언트로 지워야 한다');

console.log('trade delete static checks passed');
