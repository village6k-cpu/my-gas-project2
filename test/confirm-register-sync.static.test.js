const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

const backend = read('checkAvailability.js');
const api = read('sheetAPI.js');
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
assert(
  /function normalizeRegisterQueueStatus_\(status\)/.test(backend) &&
    /function isRegisterCompletedStatus_\(status\)/.test(backend) &&
    /function markRegisterQueued_\(sheet, row\)/.test(backend) &&
    /function markRequestRegistered_\(sheet, allData, reqID, tradeID, statusLabel\)/.test(backend) &&
    /function enqueuePendingRegister_\(reqID, delayMs\)/.test(backend) &&
    /function isRecoverableRegisterStatus_\(status\)/.test(backend),
  'registration queue status must be normalized and must have reusable enqueue/completion paths'
);
assert(
  /if \(!regLock\.tryLock\(30000\)\) \{[\s\S]{0,220}markRegisterQueued_\(sheet, triggerRow\);[\s\S]{0,220}enqueuePendingRegister_\(pendingReqID, 30000\);[\s\S]{0,80}return;[\s\S]{0,40}\}/.test(backend),
  'registerByReqID lock contention must mark 등록대기 and schedule a retry instead of leaving a dead sheet state'
);
assert(
  /function _runPendingRegister\(\)[\s\S]*var sheet = ss\.getSheetByName\("확인요청"\);[\s\S]*if \(!queue\.length\) \{[\s\S]{0,160}processRegistrationQueue_\(sheet\);[\s\S]{0,80}return;[\s\S]{0,40}\}/.test(backend) &&
    !/if \(!queue\.length\) return;/.test(backend) &&
    /collectPendingRegisterReqIDs_\(sheet\)/.test(backend) &&
    /findConfirmRequestRowByReqID_\(sheet, pendingReqID\)/.test(backend),
  '_runPendingRegister must recover O-column 등록대기 rows even when the property queue is empty, and processRegistrationQueue_ must use reqID-based fresh row lookup'
);
assert(
  /if \(REGISTER_QUEUE_PROCESSING_\) return;/.test(backend) &&
    /try \{\s*registerByReqID\(sheet, pendingRow\);[\s\S]{0,260}catch \(e\) \{[\s\S]{0,160}등록 실패/.test(backend),
  'processRegistrationQueue_ must prevent nested drains and isolate each reqID failure so later registrations keep moving'
);
assert(
  /finally \{[\s\S]{0,80}regLock\.releaseLock\(\);[\s\S]{0,1200}processRegistrationQueue_\(sheet\);/.test(backend),
  'registerByReqID must drain 등록대기 in finally so validation returns and exceptions do not strand later requests (releaseLock 뒤 락 밖 알림톡 블록을 사이에 허용)'
);
assert(
  /const startedFromRegisterQueue = requestHasRecoverableRegisterStatus_\(allData, reqID\);/.test(backend) &&
    /function getRequestExistingTradeID_\(data, reqID\)/.test(backend) &&
    /function finalizeQueuedRequestFromExistingTrade_\(sheet, allData, reqID, tradeID\)/.test(backend) &&
    /if \(startedFromRegisterQueue && completedTradeID\) \{[\s\S]{0,180}finalizeQueuedRequestFromExistingTrade_\(sheet, allData, reqID, completedTradeID\);/.test(backend) &&
    /if \(startedFromRegisterQueue\) \{[\s\S]{0,220}markRequestRegistered_\(sheet, allData, reqID, dupTid, "등록완료"\);/.test(backend),
  'a retry that already created schedule/contract rows must finalize 확인요청 with the existing 거래ID instead of leaving a duplicate/already-registered warning'
);
assert(
  /function getBlockingRegisterIssue_\(data, reqID\)/.test(backend) &&
    /markRequestRegisterFailed_\(sheet, allData, reqID, blockingRegisterIssue\);/.test(backend),
  'structurally invalid requests such as 날짜 오류 must leave 등록대기 with a visible failure instead of retrying forever'
);
assert(
  backend.includes('s.match(/(\\d{4})\\D+(\\d{1,2})\\D+(\\d{1,2})/)') &&
    /dateStr = normalizeTimelineDateKey_\(dateVal\) \|\| String\(dateVal\)\.trim\(\);/.test(backend),
  'date parsing must normalize common sheet display dates such as 2026. 6. 28 before registration'
);
assert(
  /function _confirmRequestPhoneKey_\(v\)[\s\S]{0,260}digits\.length > 10 \? digits\.slice\(-10\) : digits/.test(backend) &&
    /var phoneKey = _confirmRequestPhoneKey_\(phone\);/.test(backend) &&
    /var rowPhoneKey = _confirmRequestPhoneKey_\(rows\[i\] && rows\[i\]\[0\]\);/.test(backend) &&
    /rowPhoneKey === phoneKey/.test(backend),
  'registration/customer DB matching must treat 010-prefixed and bare 10-digit phone values as the same customer'
);
assert(
  /function recoverPendingRegistrations\(\)/.test(backend) &&
    /function recoverPartiallyRegisteredRequests\(\)/.test(backend) &&
    /function recoverPendingRegistrations\(\)[\s\S]{0,900}recoverPartiallyRegisteredRequests_\(sheet\);[\s\S]{0,1200}processRegistrationQueue_\(sheet\);/.test(backend),
  'there must be callable repair functions that finalize partially registered rows and drain already-stuck 등록대기 rows'
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
assert(
  /function normalizeRegisterStatus\(status\?: string\)/.test(confirmView) &&
    /const status = normalizeRegisterStatus\(req\.등록상태\);/.test(confirmView) &&
    /status === "등록대기"/.test(confirmView),
  'ConfirmView must treat old ⏳ 등록대기/등록 처리중 statuses as actionable 등록대기'
);
assert(
    /normalizeRegisterQueueStatus_\(rowStatus\)/.test(api) &&
    /isRegisterCompletedStatus_\(rowStatus\)/.test(api) &&
    api.includes('"recoverPendingRegistrations"') &&
    api.includes('"recoverPartiallyRegisteredRequests"') &&
    confirmRoute.includes('"recoverPendingRegistrations"'),
  'confirm API must normalize pending/completed queue statuses and expose the repair function'
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
assert(
  backend.includes('"상호명"') && /companyCol\s*=\s*_findHeaderCol_\(headers,\s*getTradeBillingCompanyHeaderCandidates_\(\)\)\s*\|\|\s*\(lastCol\s*>=\s*2\s*\?\s*2\s*:\s*1\)/.test(backend),
  'billing company options must read 발행처DB 상호명/B열 instead of 사업자번호 A열'
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
  !backend.includes('발행처 목록에 없는 값입니다') && backend.includes('knownBillingCompany'),
  'billing company write path must allow directly typed values while still reporting whether they are in 발행처DB'
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
    syncTs2.includes('원장에 다시 보이는 행은 앱 캐시의 excluded 상태로 숨기지 않는다.') &&
    !syncTs2.includes('prev?.checkoutState === "excluded"') && syncTs2.includes('extrasFailed'),
  'dashboard merge must preserve onsite items, avoid stale excluded-state revival, and skip payment merge on extras failure'
);
assert(
  /Object\.entries\(base\.returnCounts[\s\S]{0,800}sameReturnEvidenceIdentity[\s\S]{0,300}returnCounts\[sid\]\s*=\s*rc/.test(syncTs2),
  'dashboard merge must preserve partial return counts only while the schedule row identity is unchanged'
);
const storeTs2 = read('apps/today-dashboard/lib/data/store.ts');
assert(
  /removeItem[\s\S]{0,900}removeEquipmentAndRegenerateContract/.test(storeTs2) &&
    /gasMutation\("removeEquip",\s*\{[\s\S]*directRegenerate:\s*false/.test(storeTs2) &&
    read('apps/today-dashboard/app/api/gas/route.ts').includes('"removeEquip"'),
  'removing a sheet-derived item must delete 스케줄상세 via removeEquip and queue contract regeneration via the background worker'
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
const returnCountStart = storeTs3.indexOf('export async function setReturnCount');
const returnCountEnd = storeTs3.indexOf('\n// ── 결제', returnCountStart);
const returnCountFn = storeTs3.slice(returnCountStart, returnCountEnd);
assert(
  storeTs3.includes('if (isSynthetic) return;') && !/gasMutation\(["']toggleItem["']/.test(returnCountFn),
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
  /gasMutation(?:Retrying)?\("toggleReturn"[\s\S]{0,400}contractStatus: res\.contractStatus/.test(storeTs4),
  'toggleReturn off must apply the contract status restored by GAS'
);
assert(
  /gasMutation\("updateEquipQty"[\s\S]{0,500}applyEquipQtyResult/.test(storeTs4) &&
    /applyEquipQtyResult\([\s\S]{0,400}updatedItems/.test(storeTs4),
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
  read('apps/today-dashboard/lib/domain/status.ts').includes('!isCancelledTrade(t)'),
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
    /catalogStockOf\((?:e\.name|actualName)\) \?\? stockOf\(e\.category\)/.test(read('apps/today-dashboard/lib/domain/timeline.ts')),
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
  /function queueScheduleDetailContractRegensForEdit_/.test(codeJs12) &&
    /scheduleDetailContractRegenColumnsTouched_/.test(codeJs12) &&
    /queueScheduleDetailContractRegensForEdit_\(sheet,\s*e\.range,\s*e\.oldValue\)/.test(codeJs12) &&
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
// 2026-07-07부터 반출/반납 메모를 출처 태그와 함께 각각 노출 (itemMemoEntries)
assert(
  /function CheckoutRow\([\s\S]*const memos = itemMemoEntries\(e\);[\s\S]*\{!open && memos\.length > 0 &&/.test(read('apps/today-dashboard/components/HandoverChecklist.tsx')),
  'shared item memos must be visible on collapsed checkout rows, not only when expanded'
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
      /isCheckin \? TPL_CHECKIN : _getCheckoutGuideTemplate_\(\)/.test(ca) &&
      /isCheckin \? _buildCheckinMsg\(이름\) : _buildCheckoutGuideMsg\(이름\)/.test(ca),
    'testGuideAlimtalk must reuse the exact guide template/message pair that automatic sends use'
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

// ── 반출 안내톡 문구: 계좌이체 + 토스 프론트 셀프결제 흐름 안내 ──
{
  const ca = read('checkAvailability.js');
  const checkoutMsg = ca.slice(ca.indexOf('function _buildCheckoutMsg'), ca.indexOf('function _buildCheckoutLegacyMsg'));
  assert(
    checkoutMsg.includes('2. 결제') &&
      checkoutMsg.includes('1) 계좌이체: 안내받으신 견적서 상 금액을 [우리은행 1005-404-109661 최재형(빌리지)] 계좌로 이체해주시면 됩니다.(세금계산서/현금영수증 시 반드시 부가세포함가 입금)') &&
      checkoutMsg.includes('2) 카드결제: 카운터의 토스 프론트 단말기에서 셀프 카드결제 부탁드립니다.') &&
      checkoutMsg.includes('전화번호로 결제') &&
      checkoutMsg.includes('예약번호로 결제') &&
      checkoutMsg.includes('예약 조회') &&
      checkoutMsg.includes('결제가 완료되면 자동으로 확인됩니다'),
    'checkout guide alimtalk must explain bank transfer and the Toss Front self-payment flow'
  );
  assert(
    checkoutMsg.indexOf('1) 계좌이체') < checkoutMsg.indexOf('2) 카드결제') &&
      checkoutMsg.indexOf('2) 카드결제') < checkoutMsg.indexOf('이미 결제하신 경우'),
    'checkout guide alimtalk must present bank transfer before card payment, then the already-paid note'
  );
  assert(
    !checkoutMsg.includes('2. 미결제 예약은') &&
      !checkoutMsg.includes("금액 입력 (계약서상 \\'VAT포함가\\')") &&
      !checkoutMsg.includes('녹색 버튼') &&
      !checkoutMsg.includes('영수증 1부는 테이블 위'),
    'checkout guide alimtalk must remove the old manual card-terminal amount-entry instructions'
  );
  assert(
    /function _buildCheckoutLegacyMsg\(customerName\)/.test(ca) &&
      /function _getCheckoutGuideTemplate_\(\)/.test(ca) &&
      ca.includes("var TPL_CHECKOUT = '026060000711'") &&
      /function _hasSelfPaymentCheckoutTemplate_\(\) \{\s*return true;\s*\}/.test(ca),
    'checkout guide alimtalk must use the approved self-payment Popbill template by default'
  );
  const guideFn = ca.slice(ca.indexOf('function checkGuideAlimtalk'), ca.indexOf('// ── 발송 기록 저장'));
  assert(
    guideFn.includes('_buildCheckoutGuideMsg(cust.name)') &&
      guideFn.includes('_getCheckoutGuideTemplate_()'),
    'automatic checkout guide sends must switch template and message together'
  );
}
console.log('checkout-guide-self-payment-copy checks OK');

// ── 등록완료 알림톡 테스트 발송 — 실거래 테스트는 마스킹된 myPage 이름이 아니라 계약마스터 원본 이름을 사용 ──
{
  const ca = read('checkAvailability.js');
  const testFn = ca.slice(ca.indexOf('function testRegisterAlimtalk'), ca.indexOf('/**\n * 반출/반납 안내 알림톡 테스트 발송'));
  assert(
    /function getRegisterAlimtalkTradeSnapshot_\(tradeId\)/.test(ca) &&
      /contractSheet\.getRange\(2,\s*1,\s*contractSheet\.getLastRow\(\) - 1,\s*8\)/.test(ca) &&
      ca.includes('myPageScheduleSnapshot_(ss, tradeId)'),
    'register alimtalk test must read original customer name from 계약마스터 and date-times from 스케줄상세'
  );
  assert(
    testFn.includes('getRegisterAlimtalkTradeSnapshot_(tid)') &&
      !testFn.includes('customerName.replace(/\\*/g'),
    'register alimtalk test must not reconstruct names from masked myPage customerName'
  );
  assert(
    /sendAlimtalk\(tpl, 연락처, 고객명, msg, vars, btns, \{ altSendType: '' \}\)/.test(testFn),
    'register alimtalk test sends must block Popbill SMS/LMS fallback'
  );
  assert(
    /myPagePrimeFastCaches_\(tid\)/.test(testFn),
    'register alimtalk test sends must prewarm my-page caches so the tester does not wait on first open'
  );
}
console.log('register-alimtalk-test-tool checks OK');

// ── 알림톡 발송 신뢰성: 접수 성공시에만 플래그 + 날짜 경계 무관 중복방지 ──
{
  const ca = read('checkAvailability.js');
  const sendStart = ca.indexOf('function sendAlimtalk');
  const sendFn = ca.slice(sendStart, ca.indexOf('// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━', sendStart));
  const registerFn = ca.slice(ca.indexOf('function sendRegisterCompleteAlimtalk_'), ca.indexOf('/**\n * 등록완료 알림톡 테스트 발송'));
  assert(
    /function sendAlimtalk\(templateCode, receiver, receiverName, content, vars, btns, options\)/.test(sendFn) &&
      sendFn.includes("Object.prototype.hasOwnProperty.call(options, 'altSendType')") &&
      /altSendType:\s*altSendType/.test(sendFn),
    'sendAlimtalk must allow callers to explicitly disable Popbill SMS/LMS fallback'
  );
  assert(
    /sendAlimtalk\(tpl, String\(연락처\), String\(예약자명\), msg, vars, btns, \{ altSendType: '' \}\)/.test(registerFn),
    'register-complete alimtalk must never fall back to SMS/LMS when Kakao delivery is unavailable'
  );
  assert(
    /myPagePrimeFastCaches_\(거래ID\)/.test(registerFn),
    'register-complete alimtalk must prewarm my-page caches before the customer opens the link'
  );
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

// ── 계약서 재생성 디바운스: 좀비 트리거 고착 방지 (실제 15일 대기열 고아화 발생) ──
{
  const code = read('Code.js');
  const sched = code.slice(code.indexOf('function scheduleContractRegen'), code.indexOf('function regenPendingContracts'));
  assert(
    !/var exists = ScriptApp\.getProjectTriggers\(\)\.some/.test(sched) &&
      /deleteTrigger\(t\)/.test(sched) && /newTrigger\('regenPendingContracts'\)/.test(sched),
    'scheduleContractRegen must delete possibly-consumed one-shot triggers and always create a fresh one when stale (fired one-shots stay listed → "exists" check orphans the queue)'
  );
  const regen = code.slice(code.indexOf('function regenPendingContracts'), code.indexOf('function regenPendingContracts') + 1600);
  assert(
    /waitLock\(10000\);[\s\S]{0,120}catch \(lockErr\) \{[\s\S]{0,120}stillPending = true;[\s\S]{0,80}break;/.test(code) &&
      /if \(stillPending\) \{[\s\S]{0,120}newTrigger\('regenPendingContracts'\)/.test(code),
    'lock-timeout path must reschedule a retry trigger — silent return orphans the queue (observed: 10s lock wait → bail)'
  );
  assert(
    /BUDGET_MS/.test(regen) && /stillPending = true; break;/.test(regen),
    'regen loop must stop before the 6-min execution cap and reschedule (20-item backlog hit the cap)'
  );
}
console.log('contract-regen-stuck-queue checks OK');

// ── 반출/반납 안내: 취소·반납완료 계약 스킵 (조기 반납 고객에게 "반납일 다가와" 오발송 방지) ──
{
  const ca = read('checkAvailability.js');
  const fn = ca.slice(ca.indexOf('function checkGuideAlimtalk'), ca.indexOf('// ── 발송 기록 저장'));
  assert(
    /\/취소\|완료\/\.test\(cust\.status\)/.test(fn) && /contractSheet\.getRange\(2, 1, cmLastRow - 1, 10\)/.test(fn),
    'guide alimtalk must skip trades whose 계약상태 is 취소/완료 (J열까지 로드 필요)'
  );
}
console.log('guide-skip-completed checks OK');

// ── 반출/반납 안내: 빌리지2.0 고객DB 누적이용횟수 3회 미만 고객에게만 발송 ──
{
  const ca = read('checkAvailability.js');
  const fn = ca.slice(ca.indexOf('function checkGuideAlimtalk'), ca.indexOf('// ── 발송 기록 저장'));
  const helpers = ca.slice(ca.indexOf('function normalizeGuideCustomerPhone_'), ca.indexOf('function _getGuideSentData_'));
  const diag = ca.slice(ca.indexOf('function diagGuideAlimtalkSchedule'), ca.indexOf('function markGuideAlimtalkSent'));

  assert(
    /var GUIDE_MAX_VISIT_COUNT_ = 3/.test(ca) &&
      /rec\.visitCount < GUIDE_MAX_VISIT_COUNT_/.test(helpers),
    'guide alimtalk visit limit must be a single 3-visit threshold'
  );
  assert(
    /getProperty\('개고생2_URL'\)/.test(helpers) &&
      /SpreadsheetApp\.openByUrl\(url\)\.getSheetByName\('고객DB'\)/.test(helpers) &&
      /getRange\(2, 1, dbSheet\.getLastRow\(\) - 1, 3\)/.test(helpers),
    'guide alimtalk must read A:C from the Village 2.0 고객DB via 개고생2_URL'
  );
  assert(
    /function normalizeGuideCustomerPhone_\(value\)/.test(helpers) &&
      (
        (
          /replace\(\s*\/\[\^0-9\]\/g,\s*''\s*\)/.test(helpers) &&
          /s\.length > 10 \? s\.slice\(-10\) : s/.test(helpers)
        ) ||
        (
          /return _confirmRequestPhoneKey_\(value\);/.test(helpers) &&
          /function _confirmRequestPhoneKey_\(v\)[\s\S]{0,220}replace\(\/\\D\/g,\s*""\)[\s\S]{0,220}digits\.length > 10 \? digits\.slice\(-10\) : digits/.test(ca)
        )
      ),
    'guide alimtalk must normalize phone numbers by comparing the last 10 digits'
  );
  assert(
    /var phoneMatches = visitMap\.byPhone\[phone\] \|\| \[\]/.test(helpers) &&
      /phoneMatches\.length === 1/.test(helpers) &&
      /phoneMatches\.length > 1/.test(helpers) &&
      helpers.includes('고객DB 연락처 미매칭'),
    'guide alimtalk must match customers by phone first and fail closed on duplicate/missing phone matches'
  );
  assert(
    /var visitMap = readGuideCustomerVisitMap_\(\)/.test(fn) &&
      /getGuideCustomerVisitInfo_\(visitMap, cust\.name, cust\.tel\)/.test(fn) &&
      /if \(!visitInfo\.eligible\)/.test(fn),
    'automatic guide sends must pass through the visit-count eligibility gate immediately before sending'
  );
  assert(
    !/ss\.getSheetByName\('고객DB'\)/.test(fn) && !/usageCount/.test(fn),
    'automatic guide sends must not use the active spreadsheet 고객DB or default missing customers to 0 visits'
  );
  assert(
    /customerDb: \{/.test(diag) &&
      /guideEligible: visitInfo\.eligible/.test(diag) &&
      /visitCount: visitInfo\.visitCount/.test(diag) &&
      /visitSkipReason: visitInfo\.eligible \? '' : visitInfo\.reason/.test(diag),
    'guide diagnostics must expose customer DB load state and visit-count eligibility per trade'
  );
}
console.log('guide-visit-count-gate checks OK');

// ── 반납 안내톡 발송 시점: 반납-12h ↔ 반출+3h 중 늦은 시각 ──
// 다일 대여는 반납 임박에, 당일 반출-반납은 반출+3h에 (반출 전 발송 방지). 절대 반출 전엔 안 감.
{
  const ca = read('checkAvailability.js');
  const fn = ca.slice(ca.indexOf('function checkGuideAlimtalk'), ca.indexOf('// ── 발송 기록 저장'));
  assert(
    /var 반납일 = schedData\[si\]\[7\]/.test(fn) && /var 반납시간 = schedData\[si\]\[8\]/.test(fn),
    'guide alimtalk must read 반납일/반납시간 (H/I) to anchor the check-in reminder on the return time'
  );
  assert(
    /returnDT: returnDT/.test(fn),
    'tradeInfo must carry returnDT so the check-in reminder is scheduled off the return datetime'
  );
  assert(
    /function _getGuideCheckinSendMs_\(checkoutMs, returnMs\)/.test(ca) &&
      /var inSendMs = _getGuideCheckinSendMs_\(checkoutMs, returnMs\)/.test(fn),
    'check-in reminder timing must be centralized in _getGuideCheckinSendMs_ so regressions cannot re-inline checkout+3h logic'
  );
  assert(
    /Math\.max\(checkoutMs \+ GUIDE_CHECKIN_MIN_AFTER_CHECKOUT_MS, returnMs - GUIDE_CHECKIN_LEAD_MS\)/.test(ca) &&
      /if \(sendMs >= returnMs\) sendMs = checkoutMs \+ Math\.floor\(\(returnMs - checkoutMs\) \/ 2\)/.test(ca),
    'ultra-short same-day rentals (checkout+3h past return) must fall back to the checkout~return midpoint'
  );
  assert(
    /var inDeadlineMs = returnMs/.test(fn),
    'check-in reminder must not be sent after the return time'
  );
  assert(
    /var GUIDE_CHECKIN_LEAD_MS = 12 \* 60 \* 60 \* 1000/.test(ca) &&
      /var GUIDE_CHECKIN_MIN_AFTER_CHECKOUT_MS = 3 \* 60 \* 60 \* 1000/.test(ca),
    'lead time (12h before return) and minimum offset (3h after checkout) constants must be defined'
  );
}
console.log('guide-checkin-timing checks OK');

// ── 반출/반납 안내 진단 도구: 실거래별 다음 발송 예정시각을 live API로 확인 가능해야 함 ──
{
  const ca = read('checkAvailability.js');
  const api = read('sheetAPI.js');
  assert(
    /function diagGuideAlimtalkSchedule\(args\)/.test(ca),
    'diagGuideAlimtalkSchedule must expose dry-run schedule diagnostics for live trade ids'
  );
  assert(
    api.includes('"diagGuideAlimtalkSchedule"') && api.includes('funcName === "diagGuideAlimtalkSchedule"'),
    'diagGuideAlimtalkSchedule must be whitelisted and dispatched in sheetAPI run'
  );
  assert(
    /function markGuideAlimtalkSent\(args\)/.test(ca) &&
      api.includes('"markGuideAlimtalkSent"') &&
      api.includes('funcName === "markGuideAlimtalkSent"'),
    'markGuideAlimtalkSent must allow already-sent guide messages to be flagged so they are not resent'
  );
}
console.log('guide-alimtalk-schedule-diagnostics checks OK');

// ── 확인요청 품목 단위 수정: 단건 재확인 + "제외" 전용 마커 + 행 타게팅 ──
{
  const ca = read('checkAvailability.js');
  const api = read('sheetAPI.js');
  const view = read('apps/today-dashboard/components/ConfirmView.tsx');
  const route = read('apps/today-dashboard/app/api/confirm/route.ts');
  assert(
    /function updateRequestItem\(req\)/.test(ca) &&
      /getRange\(target, 9, 1, 2\)\.clearContent\(\)/.test(ca) &&
      /processByReqID\(sheet, target\)/.test(ca),
    'updateRequestItem must clear only the edited row result then reuse processByReqID (preserves other rows)'
  );
  // 행 단위 제외는 "보류"가 아닌 "제외" — registerByReqID 재등록 리셋이 보류를 지워서
  // 제외 품목이 그대로 등록되던 P1 (기존 선택등록 경로도 동일 버그였음)
  assert(
    /setValue\("제외"\)/.test(ca) && !/setValues\(\[\["보류", "보류"\]\]\)/.test(ca),
    'row-level exclusion must use the dedicated 제외 marker, never 보류'
  );
  const exFn = ca.slice(ca.indexOf('function excludeEquipFromRequest'), ca.indexOf('function updateRequestItem'));
  assert(
    exFn.includes('setValue("제외")') && !exFn.includes('setValue("보류")'),
    'excludeEquipFromRequest (선택등록 경로) must also write 제외 — 보류 is wiped by the re-register reset'
  );
  assert(
    (ca.match(/=== ["']제외["']\) continue;|!== "제외"\) neededRows/g) || []).length >= 4,
    'every registration skip loop must also skip 제외 rows'
  );
  assert(
    /var wantTag = req\.비고/.test(ca) && /var ordinal = Number\(req\.순번\)/.test(ca),
    'updateRequestItem must target rows by (장비명, Q-marker, ordinal) — name-only matching edits the wrong duplicate'
  );
  assert(
    api.includes('"updateRequestItem"') && api.includes('funcName === "updateRequestItem"'),
    'updateRequestItem must be whitelisted and dispatched in sheetAPI run'
  );
  assert(
    /제외: String\(data\[i\]\[14\] \|\| ""\)\.trim\(\) === "제외"/.test(api),
    'doListPending items must expose the row-level 제외 flag'
  );
  assert(
    /groupStatus !== "제외"\) g\.status = groupStatus/.test(api) && /등록상태: g\.status \|\| "대기"/.test(api),
    'group 등록상태 must ignore row-level 제외 (first-row exclusion must not disable the card)'
  );
  assert(
    route.includes('"updateRequestItem"'),
    'app /api/confirm FUNCS must allow updateRequestItem'
  );
  assert(
    /function ItemEditSheet/.test(view) && view.includes('runFunc("updateRequestItem"') &&
      /순번: itemOrdinal\(row\)/.test(view) && /!row\.제외/.test(view),
    'ConfirmView must offer per-item edit with ordinal targeting and exclude 제외 rows from default selection'
  );
}
console.log('request-item-edit checks OK');

// ── 확인요청 날짜 오염 방지: 시트 타임존 어긋남(16:00/1899-LMT) 루프 차단 ──
{
  const api = read('sheetAPI.js');
  const ca = read('checkAvailability.js');
  const view = read('apps/today-dashboard/components/ConfirmView.tsx');
  assert(
    /getSpreadsheetTimeZone\(\)/.test(api) && /fmtDateCell/.test(api) && /fmtTimeCell/.test(api) &&
      !/Utilities\.formatDate\(v, "Asia\/Seoul", "yyyy-MM-dd HH:mm"\)/.test(api),
    'doListPending must restore as-typed date/time using the SPREADSHEET timezone, never Asia/Seoul datetime'
  );
  assert(
    (ca.match(/getRange\(row, 2, 1, 4\)\.setNumberFormat\("@"\)/g) || []).length >= 2,
    'request rows must force B~E to text on write (insert + updateRequest re-entry) so sheets never auto-convert'
  );
  assert(
    /function normalizeConfirmRequestDates\(\)/.test(ca) && api.includes('"normalizeConfirmRequestDates"'),
    'one-time repair for already-corrupted B~E cells must exist and be whitelisted'
  );
  assert(
    /useState\(req\.반출시간 \|\| out\.t\)/.test(view) && /useState\(req\.반납시간 \|\| ret\.t\)/.test(view),
    'EditPanel must take times from 반출시간/반납시간 fields — splitDT(반출일).t was the corruption loop'
  );
}
console.log('request-date-integrity checks OK');

// ── 등록완료 자동 정리: 트리거 설치 함수 존재 + 건 단위 정리 ──
{
  const ca = read('checkAvailability.js');
  const api = read('sheetAPI.js');
  assert(
    /function setupAutoClearTrigger\(\)/.test(ca) && /everyHours\(1\)/.test(ca),
    'autoClearRequests had no trigger installer — hourly setup function must exist'
  );
  assert(
    /doneReqIDs/.test(ca) && /doneReqIDs\.has\(rid\)/.test(ca),
    'auto-clear must remove the whole completed request group (제외/보류 rows would otherwise linger forever)'
  );
  assert(
    api.includes('"setupAutoClearTrigger"') && api.includes('"autoClearRequests"'),
    'auto-clear functions must be whitelisted for remote install/run'
  );
}
console.log('auto-clear checks OK');

// ── 반출 특이사항을 반납 카드에서도 보여줘야 함 (반납 검수 활용 목적) ──
// 2026-07-07: 병합 텍스트 대신 출처(반출/반납) 태그가 붙은 개별 칩으로 노출
{
  const ret = read('apps/today-dashboard/components/ReturnChecklist.tsx');
  assert(
    /itemMemoEntries\(\{ memoCheckout: e\.memoCheckout, memoCheckin: checkinMemo \}\)/.test(ret),
    'ReturnChecklist must surface both checkout and checkin item memos — return staff needs the handover note'
  );
  assert(
    /memos\.length > 0 &&[\s\S]{0,600}<MemoTag phase=\{m\.phase\}/.test(ret),
    'shared item memo must be visible on the return row (always-on badge with origin tag, not hidden behind expand)'
  );
}
console.log('return-shows-checkout-memo checks OK');

// ── 품목 특이사항: 반출/반납 카드 모두에 보이되 출처별로 저장/구분 ──
// 2026-07-07: 미러링(양쪽 필드 동일 저장) 제거 — 출처 구분 요구사항. 가시성은 태그 칩이 담당.
{
  const checkout = read('apps/today-dashboard/components/HandoverChecklist.tsx');
  const ret = read('apps/today-dashboard/components/ReturnChecklist.tsx');
  const store = read('apps/today-dashboard/lib/data/store.ts');
  const sync = read('apps/today-dashboard/lib/data/sync.ts');

  assert(
    /const memos = itemMemoEntries\(e\);/.test(checkout),
    'checkout card must render item memos from both phase fields (with origin tags)'
  );
  assert(
    /setItemMemo\(t\.tradeId, e\.scheduleId, "checkout", v\)/.test(checkout) &&
      /setItemMemo\(t\.tradeId, e\.scheduleId, "checkin", v\)/.test(ret),
    'each card must still save through its own phase so write-back provenance is preserved'
  );
  assert(
    /phase === "checkout" \? \{ \.\.\.e, memoCheckout: memo \} : \{ \.\.\.e, memoCheckin: memo \}/.test(store),
    'setItemMemo must store the memo only under its own phase (mirroring erases 반출/반납 provenance)'
  );
  assert(
    !/prev\?\.memoCheckout \?\? prev\?\.memoCheckin/.test(sync) &&
      /memoCheckout: prev\?\.memoCheckout,/.test(sync) &&
      /memoCheckin: prev\?\.memoCheckin,/.test(sync),
    'sheet refresh merge must preserve each memo field as-is without cross-copying phases'
  );
}
console.log('roundtrip-item-memo-sync checks OK');

// ── 체크/제외/현장추가 동기화 — 전체 라운드트립 + 반납 카드 반영 가드 ──
{
  const map = read('apps/today-dashboard/lib/data/mappers.ts');
  const sync = read('apps/today-dashboard/lib/data/sync.ts');
  const remote = read('apps/today-dashboard/lib/data/remote.ts');
  const ret = read('apps/today-dashboard/components/ReturnChecklist.tsx');

  // 저장(write): 체크상태/현장추가/부분반출/정산 전부 Supabase 컬럼으로
  assert(
    /checkout_state: e\.checkoutState/.test(map) && /onsite: !!e\.onsite/.test(map) &&
      /taken_qty: e\.takenQty/.test(map) && /settlement: e\.settlement/.test(map),
    'itemToRow must persist checkout_state(체크/제외)/onsite(추가)/taken_qty/settlement to Supabase'
  );
  // 복원(read): 같은 필드 되읽기
  assert(
    /checkoutState: r\.checkout_state/.test(map) && /onsite: r\.onsite/.test(map) && /takenQty: r\.taken_qty/.test(map),
    'fromRow must restore checkoutState/onsite/takenQty'
  );
  // GAS 새로고침 머지가 시트에 다시 보이는 행을 stale excluded로 숨기지 않음
  assert(
    sync.includes('원장에 다시 보이는 행은 앱 캐시의 excluded 상태로 숨기지 않는다.') &&
      !/prev\?\.checkoutState === "excluded" \? "excluded"/.test(sync),
    'mergeDashboard must not revive stale excluded state for sheet-backed rows'
  );
  assert(
    /e\.onsite \|\| e\.offCatalog\)/.test(sync) && /appOnly/.test(sync),
    'mergeDashboard must keep onsite(현장추가) items the sheet does not know about'
  );
  // 합성 품목은 Supabase에 쓰지 않음 (유령 행/엉뚱한 체크 방지)
  assert(
    /filter\(\(e\) => !e\.synthetic\)\.map/.test(remote),
    'uniqueScheduleRows must skip synthetic items (row-id fakes) when persisting to Supabase'
  );
  // 반납 카드 반영: 제외 숨김 + 현장추가 별도 노출
  assert(
    /filter\(\(e\) => !e\.onsite && e\.checkoutState !== "excluded"/.test(ret) &&
      /filter\(\(e\) => e\.onsite && e\.checkoutState !== "excluded"/.test(ret),
    'ReturnChecklist must hide excluded and surface onsite-added items'
  );
}
console.log('checkout-state-sync checks OK');
