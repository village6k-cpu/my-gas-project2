const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

const backend = read('checkAvailability.js');
const supaSync = read('supabaseSync.js');
const storeTs = read('apps/today-dashboard/lib/data/store.ts');
const syncTs = read('apps/today-dashboard/lib/data/sync.ts');
const confirmView = read('apps/today-dashboard/components/ConfirmView.tsx');
const confirmRoute = read('apps/today-dashboard/app/api/confirm/route.ts');

// ── 스크립트 쓰기도 Supabase로 동기화: onEdit만으로는 등록 건이 누락된다 ──
assert(
  /function supaMarkTradeDirty_\(tid\)/.test(supaSync),
  'supabaseSync must expose a script-callable dirty marker (onEdit does not fire for script writes)'
);
const markCalls = (backend.match(/supaMarkTradeDirty_\(거래ID\)/g) || []).length;
assert(
  markCalls >= 4,
  `register/add/remove/change-dates must all mark the trade dirty for Supabase (found ${markCalls})`
);

// ── registerAsync 경쟁 수정: 단일 속성 덮어쓰기 금지, 큐 + 실행 시점 행 재탐색 ──
assert(
  backend.includes('_pendingRegisterQueue') &&
    !backend.includes('JSON.stringify({ reqID: reqID, row: targetRow })'),
  'scheduleRegister must queue reqIDs instead of overwriting a single property with a stale row number'
);

// ── 앱: 등록 직후 90초 폴링을 기다리지 않고 신규 거래 즉시 반영 ──
assert(
  /export async function pollSheetChangesNow/.test(storeTs),
  'store must expose pollSheetChangesNow for immediate sheet refresh'
);
assert(
  confirmView.includes('pollSheetChangesNow'),
  'ConfirmView must trigger an immediate poll after successful registration'
);

// ── 앱: 검색 복구가 스토어에 없는 신규 거래도 합류시킨다 ──
assert(
  /repairDashboardSearchResults[\s\S]*hasUnknown[\s\S]*pollTimelineChanges/.test(syncTs),
  'search repair must materialize sheet-only trades instead of skipping unknown tradeIds'
);

// ── 등록 응답 타임아웃 UX: 실패 단정 금지 + 함수 수명 연장 ──
assert(
  confirmRoute.includes('maxDuration') && confirmRoute.includes('110_000'),
  'confirm route must allow long-running registration before aborting'
);
assert(
  confirmView.includes('등록 자체는 계속 진행 중일 수 있으니') || confirmView.includes('계속 진행 중일 수 있'),
  'ConfirmView must explain that registration may still be in progress on timeout'
);

console.log('confirm-register-sync.static.test.js OK');

// ── 정산 금액 = 거래내역 I열 실 결제금액 (타임라인 단가합 추정치가 기준이 되면 안 됨) ──
assert(
  backend.includes('actualAmountCol = 9') && backend.includes('extra.actualAmount'),
  'dashboard trade extras must read the actual paid amount from 거래내역 I열'
);
assert(
  (backend.match(/actualAmount: typeof extra\.actualAmount === 'number'/g) || []).length >= 2,
  'both dashboard item builders must attach actualAmount'
);
assert(
  syncTs.includes('it.actualAmount') && /amountFix/.test(syncTs),
  'app must prefer the actual paid amount and trigger repair when it differs'
);
const timelineMerge = read('apps/today-dashboard/lib/data/timelineMerge.ts');
assert(
  timelineMerge.includes('existing.amount ?? timeline.amount'),
  'timeline polling must not overwrite the actual amount with the list-price sum'
);

// ── 발행처 드롭다운은 발행처DB(마스터) 우선 — 거래내역 과거 오타가 옵션이 되면 안 됨 ──
assert(
  /getTradeBillingCompanyOptionsFromIssuerDb_\(\);\s*\n\s*if \(options\.length > 0\) return options;\s*\n\s*return getTradeColumnOptionsFromSheet_\(7, \[\]\);/.test(backend),
  'billing company options must come from 발행처DB first, with 거래내역 G열 only as fallback'
);
console.log('settlement-amount & billing-company checks OK');

// ── 감사 1차 수정분 회귀 가드 ──
const supaSync2 = read('supabaseSync.js');
assert(
  supaSync2.includes('supaUpsertGrouped_') && /skeleton/.test(supaSync2) && supaSync2.includes("wm.status || '취소'"),
  'flush must use grouped partial upserts, never overwrite ops fields with defaults, and propagate cancellations'
);
assert(
  read('Code.js').includes('supaMarkTradeDirty_(거래ID); // 취소'),
  'cancelContract must mark the trade dirty for Supabase'
);
assert(
  backend.includes('getTradeBillingCompanyOptions_() || []') && backend.includes('masterOpts.concat(ruleOpts)'),
  'billing company write validation must accept the 발행처DB master list'
);
assert(
  /drainLock/.test(backend) && /qLock/.test(backend),
  'register queue read-modify-write must be lock-protected'
);
assert(
  /toMs\(ex\.checkoutAt\) !== toMs\(tl\.checkoutAt\)/.test(syncTs) && /tl\.customerName !== tl\.tradeId/.test(syncTs),
  'timeline polling must compare epochs (not ISO strings) and ignore the tradeId name fallback'
);
console.log('audit-round-1 checks OK');

// ── 감사 2차: 병합 보존 규칙 + 품목 삭제 시트 반영 ──
const syncTs2 = read('apps/today-dashboard/lib/data/sync.ts');
assert(
  syncTs2.includes('appOnly') && syncTs2.includes('e.onsite || e.offCatalog') &&
    syncTs2.includes('prev?.checkoutState === "excluded"') && syncTs2.includes('extrasFailed'),
  'dashboard merge must preserve onsite items, excluded state, and skip payment merge on extras failure'
);
assert(
  /rc\.damaged ?\?\? 0\) > 0 \|\| \(rc\.lost ?\?\? 0\) > 0/.test(syncTs2),
  'dashboard merge must preserve app-recorded damaged/lost return counts'
);
const storeTs2 = read('apps/today-dashboard/lib/data/store.ts');
assert(
  /removeItem[\s\S]{0,600}gasWrite\("removeEquip"/.test(storeTs2) &&
    read('apps/today-dashboard/app/api/gas/route.ts').includes('"removeEquip"'),
  'removing a sheet-derived item must also delete the 스케줄상세 row via removeEquip'
);
console.log('audit-round-2 checks OK');

// ── 감사 3차: 영향 날짜 캐시 무효화 (모레 이후 15분 stale 방지) ──
const backend3 = read('checkAvailability.js');
assert(
  /function invalidateDashboardCache\(extraDates\)/.test(backend3) &&
    backend3.includes('invalidateDashboardCache([반출일, 반납일])') &&
    backend3.includes('invalidateDashboardCache([newStart, newEnd])') &&
    (backend3.match(/invalidateDashboardCacheForTrade_\(거래ID\)/g) || []).length >= 3,
  'mutations must invalidate the dashboard cache for the affected dates, not just today±1'
);
assert(
  read('Code.js').includes('invalidateDashboardCacheForTrade_(거래ID)'),
  'contract cancellation must invalidate the cancelled trade dates'
);
console.log('audit-round-3 checks OK');

// ── 감사 4차: 전체 동기화 보존 + 금액 중복합산 + 합성 ID 가드 ──
const syncTs3 = read('apps/today-dashboard/lib/data/sync.ts');
assert(
  (syncTs3.includes('seenAmountKeys') || syncTs3.includes('seenRowKeys')) && syncTs3.includes('replace(/[^0-9]/g, "")'),
  'timeline amount must not multiply by set bar count, and qty must parse "2세트"-style strings'
);
assert(
  /syncTimelineToSupabase[\s\S]*?existingMap[\s\S]*?mergeTimelineTradeSnapshot\(ex, t\)/.test(syncTs3),
  'full sync must merge-preserve existing trades instead of wholesale overwrite'
);
assert(
  syncTs3.includes('synthetic: true'),
  'timeline-derived items must be marked synthetic'
);
const storeTs3 = read('apps/today-dashboard/lib/data/store.ts');
assert(
  storeTs3.includes('if (isSynthetic) return;') && storeTs3.includes('rcItem?.synthetic'),
  'item toggles must not write synthetic schedule IDs back to the sheet'
);
console.log('audit-round-4 checks OK');

// ── 감사 5차: 결제필드 보존·세트수량 비대칭·반납해제 복원 ──
const supaSync3 = read('supabaseSync.js');
assert(
  supaSync3.includes('extrasFailed') && !supaSync3.includes('payment_warning: !!d.paymentWarning'),
  'flush must skip payment fields on extras failure and never write the app-only payment_warning flag'
);
const storeTs4 = read('apps/today-dashboard/lib/data/store.ts');
assert(
  /gasMutation\("toggleReturn"[\s\S]{0,400}restored/.test(storeTs4),
  'toggleReturn off must apply the contract status restored by GAS'
);
assert(
  /gasMutation\("updateEquipQty"[\s\S]{0,500}updatedItems/.test(storeTs4),
  'set-header qty changes must apply GAS component scaling to app state'
);
console.log('audit-round-5 checks OK');

// ── 감사 6차: 드래그 날짜 텍스트 포맷·다중행 dirty ──
const backend6 = read('checkAvailability.js');
assert(
  /updateScheduleTime[\s\S]{0,1200}setNumberFormat\("@"\)\.setValue\(startDateStr\)/.test(backend6),
  'timeline drag must write dates as text-formatted strings like registration does'
);
assert(
  read('supabaseSync.js').includes('getNumRows()'),
  'multi-row edits must mark every affected trade dirty'
);
console.log('audit-round-6 checks OK');

// ── 감사 7차: 운영판 — 조기 반납 점유 제외 ──
const sheetApi7 = read('sheetAPI.js');
assert(
  (sheetApi7.match(/status !== "반납완료"/g) || []).length >= 2,
  'operations utilization and conflict maps must exclude early-returned rows like the availability engine'
);
console.log('audit-round-7 checks OK');

// ── 감사 8차: 타임라인 드래그/상태변경도 Supabase 동기화 마킹 ──
const backend8 = read('checkAvailability.js');
assert(
  /function supaMarkScheduleRowsDirty_/.test(backend8) &&
    (backend8.match(/supaMarkScheduleRowsDirty_\(sheet, rows\)/g) || []).length >= 2,
  'updateScheduleTime/updateScheduleStatus must mark affected trades dirty for Supabase'
);
console.log('audit-round-8 checks OK');

// ── 감사 9차: 취소 거래는 작업 카드·타임라인 점유에서 제외 ──
assert(
  read('apps/today-dashboard/lib/domain/status.ts').includes('t.contractStatus !== "취소"'),
  'cancelled trades must be excluded from today work cards'
);
assert(
  read('apps/today-dashboard/lib/domain/timeline.ts').includes('t.contractStatus === "취소"'),
  'cancelled trades must not occupy timeline bars or conflict math'
);
console.log('audit-round-9 checks OK');

// ── 감사 10차: 확인요청 편집이 세트 구조를 파괴하지 않도록 ──
assert(
  read('sheetAPI.js').includes('비고: String(data[i][16] || "")'),
  'list API must expose the Q-column set-component marker'
);
const confirmView10 = read('apps/today-dashboard/components/ConfirmView.tsx');
assert(
  confirmView10.includes('markedComponent') &&
    /buildConfirmEquipmentRows\(req\.장비목록 \|\| \[\]\)[\s\S]{0,200}role !== "set-component"/.test(confirmView10),
  'edit modal must keep sets as set-name rows and drop components (GAS re-expands), with marker-based roles'
);
console.log('audit-round-10 checks OK');

// ── 감사 11차(#11): 타임라인 재고충돌은 장비마스터 실재고 우선 ──
assert(
  read('checkAvailability.js').includes('stocks: stocks') &&
    read('apps/today-dashboard/lib/data/equipmentCatalog.ts').includes('catalogStockOf') &&
    read('apps/today-dashboard/lib/domain/timeline.ts').includes('catalogStockOf(e.name) ?? stockOf(e.category)'),
  'timeline stock conflicts must use real 장비마스터 stock with category estimates only as fallback'
);
console.log('audit-round-11 checks OK');

// ── 핫픽스: 타임라인 바 복제 → 품목 N배 중복 표시 ──
const syncDup = read('apps/today-dashboard/lib/data/sync.ts');
assert(
  /seenRowKeys[\s\S]{0,800}if \(seenRowKeys\.has\(rowKey\)\) return;/.test(syncDup),
  'parseTimeline must emit one equipment row per schedule row, not per visual bar (qty N = N bars)'
);
assert(
  /hasSynthetic/.test(syncDup) && /base\.equipments\.some\(\(e\) => e\.synthetic\)/.test(syncDup),
  'dashboard repair must replace synthetic (possibly inflated) equipment lists regardless of count'
);
console.log('timeline-dup hotfix checks OK');

// ── 계약서 실시간 반영: 재생성 트리거 범위 + 새 링크 전파 ──
const codeJs12 = read('Code.js');
assert(
  codeJs12.includes('((col >= 3 && col <= 9) || col === 12)') &&
    /계약마스터" && col >= 2 && col <= 4/.test(codeJs12),
  'contract regen must also trigger on 스케줄상세 dates/price and 계약마스터 customer-info edits'
);
assert(
  (codeJs12.match(/supaMarkTradeDirty_\(거래ID\)/g) || []).length >= 2 &&
    (read('generatecontract.js').match(/supaMarkTradeDirty_/g) || []).length >= 2,
  'every contract regen completion path must mark the trade dirty so the new link reaches the app'
);
assert(
  read('apps/today-dashboard/lib/data/sync.ts').includes('contractUrlChanged'),
  'app repair must refresh when the contract link CHANGES, not only when missing'
);
console.log('contract-realtime checks OK');

// ── 품목 메모는 접힌 상태에서도 항상 노출 (펼쳐야만 보이면 특이사항 누락) ──
assert(
  /\{!open && \(e\.memoCheckout \?\? ""\)\.trim\(\)/.test(read('apps/today-dashboard/components/HandoverChecklist.tsx')),
  'item memos must be visible on collapsed rows, not only when expanded'
);
console.log('memo-visibility checks OK');

// ── 팝빌 연동: 공식 SDK 스펙 준수 (linkhub 2.0 토큰 + /ATS 발송) ──
{
  const ca = read('checkAvailability.js');
  assert(
    /computeHmacSha256Signature\(\s*Utilities\.newBlob\(digestTarget\)\.getBytes\(\),\s*Utilities\.base64Decode\(secretKey\)\s*\)/.test(ca),
    'popbill token signing must pass Byte[] for both value and key (String+Byte[] throws in GAS)'
  );
  assert(
    /access_id:\s*corpNum/.test(ca) && !/access_id:\s*linkID/.test(ca),
    'linkhub token access_id must be the corpNum (사업자번호), not the LinkID'
  );
  assert(
    /SHA_256,\s*reqBody/.test(ca) && /\\n' \+ '2\.0\\n' \+ uri/.test(ca.replace(/\s+/g,' ')) || /'2\.0\\n'/.test(ca),
    'token signature must use SHA256 body digest and include the 2.0 version line'
  );
  assert(
    /popbill\.linkhub\.co\.kr\/ATS'/.test(ca) && !/url \+ '\/' \+ corpNum/.test(ca),
    'alimtalk send must POST to /ATS (corpNum is bound to the token, not the path)'
  );
  assert(
    /x-lh-forwarded/.test(ca),
    'token request must use forwarded-IP wildcard — GAS egress IPs change between calls'
  );
}
console.log('popbill-hmac checks OK');

// ── 반출/반납 안내 테스트 발송 도구 — 승인 템플릿으로 실물 도착 검증용 ──
{
  const ca = read('checkAvailability.js');
  const api = read('sheetAPI.js');
  assert(
    /function testGuideAlimtalk\(args\)/.test(ca) &&
      /TPL_CHECKIN : TPL_CHECKOUT/.test(ca) &&
      /_buildCheckinMsg\(이름\) : _buildCheckoutMsg\(이름\)/.test(ca),
    'testGuideAlimtalk must reuse the exact approved guide templates and message builders'
  );
  assert(
    api.includes('"testGuideAlimtalk"') && api.includes('funcName === "testGuideAlimtalk"'),
    'testGuideAlimtalk must be whitelisted AND dispatched in sheetAPI run'
  );
  assert(
    !/GUIDE_SENT_/.test(ca.slice(ca.indexOf('function testGuideAlimtalk'), ca.indexOf('function testGuideAlimtalk') + 900)),
    'test send must not touch GUIDE_SENT_ dedupe flags'
  );
}
console.log('guide-alimtalk-test-tool checks OK');

// ── 알림톡 발송 신뢰성: 접수 성공시에만 플래그 + 날짜 경계 무관 중복방지 ──
{
  const ca = read('checkAvailability.js');
  assert(
    /function _alimtalkAccepted_\(res\)/.test(ca) && /res\.receiptNum/.test(ca),
    'popbill responses must be checked for receiptNum — error JSON is not an exception'
  );
  assert(
    /if \(!_alimtalkAccepted_\(res\)\)[\s\S]{0,300}return \{ error/.test(ca) &&
      ca.indexOf('_alimtalkAccepted_(res)') < ca.indexOf("props.setProperty(sentFlag"),
    'register alimtalk must NOT set REG_ALIM_SENT_ flag when popbill rejects (e.g. template under review)'
  );
  assert(
    /_alimtalkAccepted_\(outRes\)/.test(ca) && /_alimtalkAccepted_\(inRes\)/.test(ca),
    'guide alimtalk must only mark sent when popbill issued a receiptNum'
  );
  assert(
    /GUIDE_SENT_V2/.test(ca) && !/sentKey = 'GUIDE_SENT_' \+ todayStr/.test(ca),
    'guide dedupe must use a single date-independent key — per-day keys resend after midnight (checkin window spans 2 days)'
  );
  assert(
    /yyyyMMdd HH:mm'\)/.test(ca) && /d < cutoffStr\) delete sentData\[f\]/.test(ca),
    'V2 flags must carry their date so stale entries (>7d) can be pruned in place'
  );
}
console.log('alimtalk-reliability checks OK');
