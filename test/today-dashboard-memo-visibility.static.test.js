// 반출/반납 메모 가시성 회귀 방지 테스트.
// 요구사항(2026-07-07): ① 메모가 접힌 상태에서도 존재/내용이 보여야 함
// ② 반출 메모가 반납 카드에도(그 반대도) 뜨되, 출처(반출/반납) 태그로 구분돼야 함
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

const handover = read('apps/today-dashboard/components/HandoverChecklist.tsx');
const returns = read('apps/today-dashboard/components/ReturnChecklist.tsx');
const card = read('apps/today-dashboard/components/ScheduleCard.tsx');
const memoTag = read('apps/today-dashboard/components/MemoTag.tsx');

// ── ① 전체 메모는 details 안에 숨기지 않는다 ─────────────────────────

assert.doesNotMatch(
  handover,
  /<details|<summary/,
  'trade-level memos must not hide inside a collapsed <details> — content must be visible without expanding'
);
assert.match(
  handover,
  /function TradeNotes\(\{ trade, phase \}[\s\S]*trade\.noteCheckout[\s\S]*trade\.noteCheckin/,
  'TradeNotes must render BOTH checkout and checkin trade memos on every card'
);
assert.match(
  handover,
  /<MemoTag phase=\{n\.phase\}/,
  'each trade memo must carry its origin tag (반출/반납)'
);

// ── ② 품목 특이사항: 병합(||) 대신 출처별 분리 표시 ──────────────────

assert.doesNotMatch(
  handover,
  /memoCheckout \|\| e\.memoCheckin/,
  'HandoverChecklist must not merge checkout/checkin item memos into one unlabeled string'
);
assert.doesNotMatch(
  returns,
  /memoCheckout \|\| e\.memoCheckin/,
  'ReturnChecklist must not merge checkout/checkin item memos into one unlabeled string'
);
assert.match(
  returns,
  /itemMemoEntries\(\{ memoCheckout: e\.memoCheckout, memoCheckin: checkinMemo \}\)/,
  'the return card must build tagged entries from BOTH the checkout and checkin item memos'
);
assert.match(
  returns,
  /memos\.map\(\(m\) => \([\s\S]*?<MemoTag phase=\{m\.phase\} shared=\{m\.shared\}/,
  'each return-row memo chip must carry its origin tag (반출/반납/공통)'
);

// 편집 혼선 방지: 편집기는 자기 phase의 메모만 프리필해야 한다
assert.match(
  handover,
  /MemoInput value=\{checkoutMemo\}/,
  'checkout item memo editor must prefill only memoCheckout (not the checkin memo)'
);
assert.match(
  returns,
  /defaultValue=\{checkinMemo\}/,
  'return item memo editor must prefill only the checkin memo (not the checkout memo)'
);

// ── 카드가 접힌 상태에서도 메모 미리보기 ─────────────────────────────

assert.match(
  card,
  /\{!open && <CollapsedMemoPreview/,
  'a collapsed schedule card must still surface memo previews'
);
assert.match(
  card,
  /function CollapsedMemoPreview[\s\S]*noteCheckout[\s\S]*noteCheckin[\s\S]*itemMemoCount/,
  'collapsed preview must cover both trade memos and the item-memo count'
);

// ── 출처 보존: 저장은 자기 phase 필드에만, 병합 시 교차 복사 금지 ─────

const store = read('apps/today-dashboard/lib/data/store.ts');
const sync = read('apps/today-dashboard/lib/data/sync.ts');
assert.match(
  store,
  /phase === "checkout" \? \{ \.\.\.e, memoCheckout: memo \} : \{ \.\.\.e, memoCheckin: memo \}/,
  'setItemMemo must save under its own phase only — mirroring would erase the 반출/반납 distinction'
);
assert.doesNotMatch(
  sync,
  /prev\?\.memoCheckout \?\? prev\?\.memoCheckin/,
  'sync merge must not cross-copy memos between phases'
);

// 레거시 미러링 데이터(양쪽 동일 텍스트)는 중복 대신 "공통" 태그 하나로
assert.match(
  memoTag,
  /checkout === checkin[\s\S]*shared: true/,
  'identical legacy memos must collapse into one shared(공통) entry instead of showing twice'
);

// ── 태그 컴포넌트: 반출=파랑, 반납=초록 (카드 배지와 동일 계열) ───────

assert.match(memoTag, /checkout-bg[\s\S]*checkout-fg/, 'checkout tag must use the checkout color tokens');
assert.match(memoTag, /checkin-bg[\s\S]*checkin-fg/, 'checkin tag must use the checkin color tokens');

console.log('today-dashboard-memo-visibility.static.test.js OK');
