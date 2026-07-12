// 2026-07-12 전체 시스템 점검에서 수정한 확정 버그들의 회귀 방지 가드.
// 각 assert는 "고친 상태"가 유지되는지 코드 패턴으로 검증한다.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const backend = fs.readFileSync(path.join(root, 'checkAvailability.js'), 'utf8');
const code = fs.readFileSync(path.join(root, 'Code.js'), 'utf8');
const contract = fs.readFileSync(path.join(root, 'generatecontract.js'), 'utf8');
const protection = fs.readFileSync(path.join(root, 'sheetProtection.js'), 'utf8');
const supa = fs.readFileSync(path.join(root, 'supabaseSync.js'), 'utf8');
const manageRoot = fs.readFileSync(path.join(root, 'requestManage.html'), 'utf8');
const manageDocs = fs.readFileSync(path.join(root, 'docs', 'manage.html'), 'utf8');
const requestDocs = fs.readFileSync(path.join(root, 'docs', 'request.html'), 'utf8');

// #1 — 확인요청 삽입은 품목 수만큼 "연속" 빈 행을 찾아야 한다(중간 갭 덮어쓰기 방지).
assert(
  /var need = items\.length \|\| 1;[\s\S]*?if \(runLen >= need\) \{ foundStart = runStart; break; \}[\s\S]*?startRow = \(foundStart >= 0\) \? foundStart \+ 2 : lastRow \+ 1;/.test(backend),
  '#1 _insertAndCheckRequest must scan for a contiguous empty run of items.length rows, else append at lastRow+1'
);

// #1(updateRequest 재입력) — 동일한 연속 빈 행 가드
assert(
  /startRow = \(foundStart >= 0\) \? foundStart \+ 2 : newLastRow \+ 1;/.test(backend),
  '#1 updateRequest re-insert must also use the contiguous-empty-run guard (newLastRow+1 fallback)'
);

// #10 — updateRequest는 장비 변경 시에도 할인유형(M)·비고(Q)를 보존해야 한다.
assert(
  /var 할인유형 = req\.할인유형 !== undefined \? req\.할인유형 : origFirst\[12\];/.test(backend) &&
    /var 비고 = req\.비고 !== undefined \? req\.비고 : origFirst\[16\];/.test(backend) &&
    /j === 0 \? 할인유형 : "", "", "", "",\s*\n\s*j === 0 \? 비고 : "",/.test(backend),
  '#10 updateRequest must preserve 할인유형(M idx12) and 비고(Q idx16) instead of blanking them'
);

// #7 — 동명이인 방어: 요청 연락처가 DB와 모순되면 이름-only 매칭의 할인/연락처를 쓰지 않는다.
assert(
  /var phoneContradicts = false;[\s\S]*?anyPhoneMatch = customerDbMatches\.some\(function\(m\) \{ return m\.phoneKey && m\.phoneKey === reqPhoneKey; \}\);[\s\S]*?var trustedMatches = phoneContradicts \? \[\] : customerDbMatches;/.test(backend) &&
    /_bestConfirmRequestCustomerDbDiscount_\(trustedMatches\)/.test(backend),
  '#7 discount/phone resolution must ignore name-only matches when the request phone contradicts the DB (동명이인)'
);

// #32 — 합침(merge) 등록도 계약서를 재생성해야 한다.
assert(
  /if \(mergeMode && mergeTargetTID\) \{\s*\n\s*try \{ scheduleContractRegen\(mergeTargetTID\); \} catch/.test(backend),
  '#32 mergeMode registration must call scheduleContractRegen so merged equipment appears on the contract'
);

// #33 — addEquipmentToContract는 스케줄ID를 "최대 suffix + 1"로 발번(개수 기반 금지).
assert(
  /const newSchedNum = maxSchedNum \+ 1;/.test(backend) &&
    !/const existingScheds = schedSheet\.getLastRow\(\) >= 2/.test(backend),
  '#33 addEquipmentToContract must derive newSchedNum from max suffix, not the count of existing rows'
);

// #36 — cancelContract는 계약서 Drive 파일을 정리해야 한다(공용 헬퍼 사용).
assert(
  /function trashContractFilesForTrade_\(거래ID\)/.test(contract),
  '#36 shared trashContractFilesForTrade_ helper must exist in generatecontract.js'
);
assert(
  /trashContractFilesForTrade_\(거래ID\)/.test(code),
  '#36 cancelContract must trash the trade\'s contract files on cancel'
);

// #56 — 확인요청 보호에서 R열(추가요청)이 편집 가능해야 한다.
assert(
  /unprotected3\.push\(confirmSheet\.getRange\('M2:R' \+ lr3\)\)/.test(protection),
  '#56 protectSheets must leave 확인요청 R열(추가요청) editable (M2:R, not M2:Q)'
);

// #14/#30 — Supabase flush는 성공했을 때만 dirty를 지운다.
assert(
  /if \(ok\) \{[\s\S]*?p\.setProperty\('SUPA_DIRTY', JSON\.stringify\(after\)\);/.test(supa) &&
    /function supaUpsert_\(cfg, table, rows, conflict\) \{[\s\S]*?return true;\s*\n\}/.test(supa),
  '#14/#30 flushDirtyToSupabase must clear dirty only when upsert succeeded; supaUpsert_ must return a boolean'
);

// #31 — 시트에서 삭제된 스케줄 행을 Supabase에서도 제거(단, keepIds 비면 절대 삭제 금지).
assert(
  /function supaDeleteStaleItems_\(cfg, tradeId, keepIds\) \{\s*\n\s*if \(!tradeId \|\| !keepIds \|\| !keepIds\.length\) return true;/.test(supa),
  '#31 supaDeleteStaleItems_ must exist and never delete when keepIds is empty'
);

// #38 — 확인요청 관리 화면은 고객 입력을 escHtml로 이스케이프해야 한다(루트 + docs).
for (const [name, html] of [['requestManage.html', manageRoot], ['docs/manage.html', manageDocs]]) {
  assert(/function escHtml\(s\)\{return String/.test(html), `#38 ${name} must define escHtml`);
  assert(/escHtml\(req\.예약자명/.test(html) && /escHtml\(e\.장비명\)/.test(html),
    `#38 ${name} must escape 예약자명 and 장비명 before innerHTML`);
}

// #29 — request.html '바로 등록'은 registerAsync를 호출해야 한다(scan&do=등록 금지).
assert(
  /action=registerAsync&reqID=/.test(requestDocs) &&
    !/action=scan&reqID=[^]*?&do=/.test(requestDocs),
  '#29 request.html registerNow must call registerAsync (not the no-op scan&do=등록)'
);

console.log('2026-07-12 시스템 점검 수정 가드 통과');
