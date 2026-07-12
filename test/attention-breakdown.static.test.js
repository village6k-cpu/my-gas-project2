const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const status = fs.readFileSync(path.join(root, 'apps/today-dashboard/lib/domain/status.ts'), 'utf8');
const todayView = fs.readFileSync(path.join(root, 'apps/today-dashboard/components/TodayView.tsx'), 'utf8');

// ──────────────────────────────────────────────────────────────────────────
// 오늘일정 '확인필요' 배지(예: 129)가 왜 이 숫자인지 이유별로 분해해 보여준다.
// 분해 합계는 반드시 확인필요 총합과 일치해야 하므로, 같은 needsAttention 로직을
// 재사용하고(취소 제외 동일), 한 거래는 우선순위상 하나의 이유로만 센다.
// ──────────────────────────────────────────────────────────────────────────

// needsAttention은 attentionReason에 위임 → 배지 숫자와 분해가 절대 어긋나지 않는다.
assert(
  /export function needsAttention\(t: Trade, date: string\): boolean \{\s*return attentionReason\(t, date\) !== null;/.test(status),
  'needsAttention은 attentionReason에 위임해야 분해 합계가 배지와 일치한다'
);

// attentionReason 우선순위: damage → overdue → deposit → payment → risk (하나만 대표).
const reasonFn = status.match(/export function attentionReason\([\s\S]*?\n\}/);
assert(reasonFn, 'attentionReason 함수를 찾지 못함');
const order = ['"damage"', '"overdue"', '"deposit"', '"payment"', '"risk"'];
let last = -1;
for (const token of order) {
  const at = reasonFn[0].indexOf('return ' + token);
  assert(at > last, `attentionReason 이유 우선순위가 어긋남: ${token}`);
  last = at;
}

// overdue 정의: 반납일이 지났고 아직 반납완료가 아님.
assert(
  /const overdue = new Date\(t\.returnAt\) < new Date\(`\$\{date\}T00:00:00`\) && !t\.returnDone;/.test(reasonFn[0]),
  'overdue(미마감)는 반납일 경과 + 미반납완료로 정의돼야 한다'
);

// 위험(카드주의)은 아직 처리 안 된 단계에만 유효 — 완료 거래·지난 단계는 제외(94건 부풀림 방지).
assert(
  /if \(r\.phase === "checkout"\) return !t\.setupDone;/.test(reasonFn[0]),
  '위험은 반출 안내면 반출 전(!setupDone)일 때만 확인필요여야 한다'
);
assert(
  /return !t\.returnDone;/.test(reasonFn[0]),
  '위험은 반납/기타 안내면 반납완료 전(!returnDone)일 때만 확인필요여야 한다'
);

// 확인필요 탭은 완료 카드를 접지 않는다(배지 숫자 = 실제 보이는 카드).
const cardDoneFn = status.match(/export function cardDone\([\s\S]*?\n\}/);
assert(cardDoneFn, 'cardDone 함수를 찾지 못함');
assert(
  /if \(tab === "attention"\) return false;/.test(cardDoneFn[0]),
  '확인필요 탭에서는 어떤 카드도 완료로 접히면 안 된다(배지와 목록 일치)'
);

// attentionBreakdown은 취소 거래를 제외한다(tradesForTab attention과 동일 → 합계 일치).
const bdFn = status.match(/export function attentionBreakdown\([\s\S]*?\n\}/);
assert(bdFn, 'attentionBreakdown 함수를 찾지 못함');
assert(
  /if \(isCancelledTrade\(t\)\) continue;/.test(bdFn[0]),
  'attentionBreakdown은 취소 거래를 제외해야 배지 숫자와 합계가 일치한다'
);

// 라벨 5종.
['파손/분실', '미마감', '보증금', '결제', '위험'].forEach(function (lbl) {
  assert(status.indexOf(lbl) >= 0, 'ATTENTION_REASON_LABEL에 ' + lbl + ' 라벨이 있어야 한다');
});

// TodayView는 확인필요 탭에서 분해를 렌더한다.
assert(
  /tab === "attention" && counts\.attention > 0 && attnBreakdown/.test(todayView),
  'TodayView는 확인필요 탭일 때만 이유별 분해를 보여줘야 한다'
);
assert(
  /attentionBreakdown\(data\.trades, date\)/.test(todayView),
  'TodayView 분해는 배지와 동일한 data.trades/date로 계산해야 한다'
);

console.log('attention breakdown static checks passed');
