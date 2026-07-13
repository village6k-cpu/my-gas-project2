const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');

const confirmView = read('apps/today-dashboard/components/ConfirmView.tsx');
const confirmRoute = read('apps/today-dashboard/app/api/confirm/route.ts');
const backend = read('checkAvailability.js');

// ──────────────────────────────────────────────────────────────────────────
// 확인요청 카드에 '삭제'가 있어야 한다. 삭제는 확인요청 시트의 해당 reqID 행만 지우고,
// 이미 등록된 예약(계약·스케줄)은 건드리지 않는다. 되돌릴 수 없으니 확인 다이얼로그 필수.
// 경로: UI 버튼 → runFunc("deleteRequest") → POST /api/confirm(run) → GAS deleteRequest.
// ──────────────────────────────────────────────────────────────────────────

// 1) UI: 삭제 버튼 + 확인 다이얼로그 + onDelete 배선.
assert(/🗑\s*삭제/.test(confirmView), 'ConfirmCard 헤더에 삭제 버튼이 있어야 한다');
assert(/onDelete: \(reqID: string\) => void;/.test(confirmView), 'ConfirmCard는 onDelete prop을 받아야 한다');
assert(/onDelete=\{deleteReq\}/.test(confirmView), 'ConfirmCard에 deleteReq 핸들러가 연결돼야 한다');
assert(
  /const deleteReq = useCallback\([\s\S]*?runFunc\("deleteRequest", \{ reqID \}\)/.test(confirmView),
  'deleteReq는 runFunc("deleteRequest", { reqID })를 호출해야 한다'
);
// 삭제 클릭은 confirm() 다이얼로그를 거쳐야 한다(되돌릴 수 없음).
const delBtn = confirmView.match(/aria-label="확인요청 삭제"[\s\S]{0,40}/);
assert(
  /confirm\(\s*\n?\s*`'\$\{req\.예약자명[\s\S]*?onDelete\(req\.reqID\)/.test(confirmView),
  '삭제는 confirm() 확인 후에만 onDelete를 호출해야 한다'
);
// 다이얼로그가 '예약 자체는 남는다'는 점을 알려야 한다(안전 안내).
assert(
  /이미 등록된 예약.*그대로 남습니다|계약·스케줄\)?은 그대로 남/.test(confirmView),
  '삭제 다이얼로그는 등록된 예약은 삭제되지 않음을 안내해야 한다'
);

// 2) API: run 화이트리스트에 deleteRequest가 있어야 한다.
assert(/FUNCS = new Set\(\[[^\]]*"deleteRequest"/.test(confirmRoute), '/api/confirm run 화이트리스트에 deleteRequest가 있어야 한다');

// 3) 백엔드: deleteRequest는 확인요청 시트 행만 지운다(계약마스터/스케줄상세는 건드리지 않음).
const fn = backend.match(/function deleteRequest\(reqID\) \{[\s\S]*?\n\}/);
assert(fn, 'deleteRequest 백엔드 함수를 찾지 못함');
assert(/getSheetByName\("확인요청"\)/.test(fn[0]), 'deleteRequest는 확인요청 시트를 대상으로 해야 한다');
assert(/\.deleteRow\(/.test(fn[0]), 'deleteRequest는 해당 행을 삭제해야 한다');
assert(
  !/계약마스터|스케줄상세/.test(fn[0]),
  'deleteRequest는 계약마스터/스케줄상세(등록된 예약)를 건드리면 안 된다'
);

console.log('confirm request delete static checks passed');
