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
    /var itemNote = items\[j\]\.비고 !== undefined[\s\S]{0,140}\(j === 0 \? 비고 : ""\);/.test(backend) &&
    /j === 0 \? 할인유형 : "", "", itemStatus, "",\s*\n\s*itemNote,/.test(backend),
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
  /if \(mergeMode && mergeTargetTID && mergeSchedulePlan\.writeSourceIndexes\.length > 0\) \{\s*\n\s*try \{ scheduleContractRegen\(mergeTargetTID\); \} catch/.test(backend),
  '#32 mergeMode registration must call scheduleContractRegen so merged equipment appears on the contract'
);

// #33 — addEquipmentToContract는 스케줄ID를 "최대 suffix + 1"로 발번(개수 기반 금지).
assert(
  /const newSchedNum = maxSchedNum \+ 1;/.test(backend) &&
    !/const existingScheds = schedSheet\.getLastRow\(\) >= 2/.test(backend),
  '#33 addEquipmentToContract must derive newSchedNum from max suffix, not the count of existing rows'
);

// #36 — cancelContract는 계약서 Drive 파일 정리를 재시도 가능한 외부 워커에 맡겨야 한다.
assert(
  /function trashContractFilesForTrade_\(거래ID\)/.test(contract),
  '#36 shared trashContractFilesForTrade_ helper must exist in generatecontract.js'
);
assert(
  /function runCancelledTradeCleanupOutsideLock_\(state\)[\s\S]*trashCancelledContractFiles_\(거래ID\)/.test(code) &&
    /function cancelContract\(ss, 거래ID, contractRow\)[\s\S]*scheduleCancelledTradeCleanup_\(거래ID\)/.test(code),
  '#36 cancelContract must queue strict Drive cleanup in the retryable outside-lock worker'
);

// #56 — 확인요청 보호에서 R열(추가요청)이 편집 가능해야 한다.
assert(
  /unprotected3\.push\(confirmSheet\.getRange\('M2:R' \+ lr3\)\)/.test(protection),
  '#56 protectSheets must leave 확인요청 R열(추가요청) editable (M2:R, not M2:Q)'
);

// #14/#30 — Supabase flush는 성공했고 같은 거래의 dirty 버전이 그대로일 때만 지운다.
const flushDirtyBody = supa.slice(
  supa.indexOf('function flushDirtyToSupabase'),
  supa.indexOf('\n/** 거래ID 배열', supa.indexOf('function flushDirtyToSupabase')),
);
assert(
  /if \(ok\) \{[\s\S]*if \(p\.getProperty\(dirtyKey\) === snapshot\[dirtyKey\]\) p\.deleteProperty\(dirtyKey\)/.test(flushDirtyBody) &&
    /function supaUpsert_\(cfg, table, rows, conflict\) \{[\s\S]*?return true;\s*\n\}/.test(supa),
  '#14/#30 flushDirtyToSupabase must clear only the successfully uploaded, unchanged per-trade dirty marker; supaUpsert_ must return a boolean'
);

// #31 — stale keep-set 정리는 반출 기준선을 지우지 않으며, 주기 flush가 이를 호출하지 않는다.
assert(
  /function supaDeleteStaleItems_\(cfg, tradeId, keepIds\) \{\s*\n\s*if \(!tradeId \|\| !keepIds \|\| !keepIds\.length\) return true;[\s\S]{0,900}taken_qty=is\.null/.test(supa) &&
    !/supaDeleteStaleItems_\(/.test(flushDirtyBody),
  '#31 stale cleanup must fail closed on an empty keep-set, preserve taken_qty baselines, and stay out of periodic snapshot flushes'
);

// #38 — 실행 가능한 확인요청 관리 화면은 고객 입력을 escHtml로 이스케이프해야 한다.
for (const [name, html] of [['requestManage.html', manageRoot]]) {
  assert(/function escHtml\(s\)\{return String/.test(html), `#38 ${name} must define escHtml`);
  assert(/escHtml\(req\.예약자명/.test(html) && /escHtml\(e\.장비명\)/.test(html),
    `#38 ${name} must escape 예약자명 and 장비명 before innerHTML`);
}

console.log('2026-07-12 시스템 점검 수정 가드 통과');
