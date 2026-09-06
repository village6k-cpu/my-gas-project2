const assert = require('node:assert/strict');
const fs = require('node:fs');

const followUp = fs.readFileSync('apps/today-dashboard/components/FollowUpView.tsx', 'utf8');
const audit = fs.readFileSync('apps/today-dashboard/components/AutomationAuditView.tsx', 'utf8');
const auditModel = fs.readFileSync('apps/today-dashboard/lib/automation-audit/inbox-model.mjs', 'utf8');

assert.equal((followUp.match(/"자동처리"/g) || []).length, 1, 'the fourth top tab must be declared exactly once');
assert.match(followUp, /type FollowUpSection = ViewKey \| "automation"/);
assert.match(followUp, /<AutomationAuditView active=\{/);
for (const existing of ['"지금 할 일"', '"미뤄둔 일"', '"완료"']) {
  assert(followUp.includes(existing), `existing work tab must remain: ${existing}`);
}
for (const existingAction of ['type: "complete"', 'type: "snooze"', 'type: "progress"', 'type: "dismiss"']) {
  assert(followUp.includes(existingAction), `existing work action must remain: ${existingAction}`);
}

assert.match(audit, /authFetch\(`\/api\/automation-audit\?\$\{params\}`\)/);
assert.match(audit, /setInterval\(tick, 30_000\)/);
assert.match(audit, /document\.hidden/);
assert.match(audit, /visibilitychange/);
assert.match(audit, /lg:grid-cols-\[minmax\(320px,0\.9fr\)_minmax\(420px,1\.1fr\)\]/);
assert.match(audit, /role="dialog"/);
for (const state of ['기록을 불러오는 중', '자동처리 기록이 없습니다', '마지막으로 확인한 기록', '기록 동기화 지연']) {
  assert(audit.includes(state), `audit state must be visible: ${state}`);
}
for (const filter of ['오늘', '7일', '기간 지정', '처리 종류', '결과', '고객명 또는 요청·거래번호']) {
  assert(audit.includes(filter) || auditModel.includes(filter), `read-only filter must be visible: ${filter}`);
}
for (const forbidden of [
  'method: "PATCH"', 'method: "POST"', 'method: "DELETE"', 'onAction=',
  '완료 처리', '미루기', '다시 열기', '일괄', 'Slack', '슬랙', '카카오 발송', '메시지 보내기',
]) assert(!audit.includes(forbidden), `audit view must stay read-only: ${forbidden}`);

console.log('today-dashboard Kakao automation audit read-only UI checks passed');
