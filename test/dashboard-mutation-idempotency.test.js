const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

function section(source, start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, `${start} section not found`);
  return source.slice(from, to);
}

test('같은 논리 항목의 오래된 mutation retry만 폐기하고 다른 품목은 보존한다', () => {
  const gas = read('checkAvailability.js');
  const source = section(
    gas,
    'var DASHBOARD_SETUP_CLOSING_LEASE_MS_',
    '\nfunction dashboardSetupCanonicalResult_',
  );
  const values = new Map();
  const props = {
    getProperty(key) { return values.has(key) ? values.get(key) : null; },
    setProperty(key, value) { values.set(key, String(value)); },
    deleteProperty(key) { values.delete(key); },
    getProperties() { return Object.fromEntries(values); },
  };
  const context = {
    Date,
    JSON,
    Math,
    CacheService: { getScriptCache: () => ({ get: () => '1', put() {} }) },
  };
  vm.runInNewContext(`${source}\nthis.begin = beginDashboardMutation_; this.commit = commitDashboardMutation_;`, context);

  assert.equal(context.begin(props, '260728-001', 'return:a', 'return', '1').skip, false);
  assert.equal(context.begin(props, '260728-001', 'item:b', 'item:checkout:SID-B', '1').skip, false);
  context.commit(props, '260728-001', 'item:b', 'item:checkout:SID-B');

  // unrelated item B must not make a pending/retry of return A stale.
  assert.equal(context.begin(props, '260728-001', 'return:a', 'return', '1').skip, false);
  context.commit(props, '260728-001', 'return:a', 'return');

  assert.equal(context.begin(props, '260728-001', 'return:c', 'return', '0').skip, false);
  context.commit(props, '260728-001', 'return:c', 'return');
  const stale = context.begin(props, '260728-001', 'return:a', 'return', '1');
  assert.equal(stale.skip, true);
  assert.equal(stale.pendingLater, false);

});

test('반납완료와 상세 수량은 같은 JSON snapshot/완료 플래그 CAS로 맞물린다', () => {
  const supa = read('supabaseSync.js');
  const remote = read('apps/today-dashboard/lib/data/remote.ts');
  const helper = section(supa, 'function supaSetTradeReturnDone_', '\n/** 품목 반출 체크도');
  const count = section(remote, 'export async function persistReturnCounts', '\n/** 단일 품목 호출도');
  assert.match(helper, /return_counts=eq\.[\s\S]*JSON\.stringify\(snapshot\)/);
  assert.match(helper, /return_done\.is\.null,return_done\.eq\.false/);
  assert.match(count, /ReturnCompletionConflictError/);
  assert.match(count, /return_done\.is\.null,return_done\.eq\.false/);
});

test('GAS만 완료/품목 권한 필드를 쓰고 주기 snapshot은 제외한다', () => {
  const gas = read('checkAvailability.js');
  const supa = read('supabaseSync.js');
  const store = read('apps/today-dashboard/lib/data/store.ts');
  const periodic = section(supa, 'function buildSupabaseTrades_', '\n/** payload 키 구성이 같은 행끼리');
  assert.match(gas, /supaSetTradeReturnDone_\(/);
  assert.match(gas, /supaSetScheduleItemCheckoutState_\(/);
  assert.doesNotMatch(store, /persistReturnCompletion/);
  assert.doesNotMatch(store, /persistItemCheckoutState/);
  assert.doesNotMatch(periodic, /return_done\s*:/);
  assert.doesNotMatch(periodic, /checkout_state\s*:/);
});

test('완료 전환은 debounce 수량을 drain하고 옛 스테퍼 응답은 최신 표시를 덮지 않는다', () => {
  const store = read('apps/today-dashboard/lib/data/store.ts');
  // 즉시 확정 UX: drain은 백그라운드 확정 엔진이 GAS 전송 직전에 수행한다
  const replay = section(store, 'async function replayCompletionMutationEntry_', '\nfunction replayCompletionMutationOutboxes_');
  const qty = section(store, 'async function commitQueuedItemQty', '/** 수량 스테퍼의 350ms debounce');
  assert.match(replay, /flushQueuedItemQtyForTrade\(latest\.tradeId\)/, '완료 확정 전 수량 debounce를 drain해야 한다');
  assert.ok(
    replay.indexOf('flushQueuedItemQtyForTrade(latest.tradeId)') < replay.indexOf('gasMutation("toggleSetup"'),
    'drain이 GAS 확정보다 먼저여야 한다',
  );
  assert.match(qty, /if \(qtyCommitTargets\[key\] !== undefined\)[\s\S]*return;/);
  assert.ok(
    qty.indexOf('if (qtyCommitTargets[key] !== undefined)') < qty.indexOf('applyEquipQtyResult'),
    'old qty response must be discarded before local apply',
  );
  // drain 실패(재시도 가능)는 확정 엔진 백오프로 이어지고, GAS 미전송을 성공으로 오인하지 않는다
  assert.match(replay, /isRetryableLedgerError\(error\)/);
  assert.match(replay, /requireCompletionMutationResult_/, 'GAS 확정 응답 스키마 없이는 성공 처리하지 않는다');
});

test('반출 후 누락 품목은 브라우저가 기준선 없이 insert하지 않는다', () => {
  const remote = read('apps/today-dashboard/lib/data/remote.ts');
  const store = read('apps/today-dashboard/lib/data/store.ts');
  const gas = read('checkAvailability.js');
  const supa = read('supabaseSync.js');
  const route = read('apps/today-dashboard/app/api/gas/route.ts');
  const api = read('sheetAPI.js');
  const persist = section(remote, 'export async function persistTrade', '\n/** 반납 체크의 빠른 경로');
  const worker = section(gas, 'function flushDashboardStructureProjectionQueue_', '\n/** 앱 자동 복구용');
  const repair = section(gas, 'function repairDashboardTradeProjection_', '\nfunction normalizeDashboardMutationId_');

  assert.match(persist, /const checkoutLocked = isCheckoutBaselineLocked\(trade\)/);
  assert.match(persist, /const insertRows = checkoutLocked[\s\S]*Number\(row\.taken_qty\) > 0/);
  assert.match(route, /"repairTradeProjection"/);
  assert.match(api, /case "repairTradeProjection":[\s\S]*repairDashboardTradeProjection_/);
  assert.match(repair, /canDashboardRecoverMissingCheckoutBaseline_\(tid, props, baselineItems\)/,
    '전체 기준선이 빈 완료 거래는 명시적 복구 증거가 있어야 한다');
  assert.match(repair, /isDashboardTradeCheckoutStarted_\(ss, tid\)/,
    '로컬 속성이 유실돼도 계약/스케줄 상태를 확인해야 한다');
  assert.match(repair, /supaGetCheckoutBaselineState_\(tid\)/,
    'Supabase 완료 상태와 taken_qty 기준선을 함께 확인해야 한다');
  assert.match(repair, /currentIds\.join\('\|'\) !== baselineIds\.join\('\|'\)/,
    '부분 기준선 누락을 현재 시트 수량으로 자동 승격하면 안 된다');
  assert.match(worker, /localCheckoutStarted = isDashboardTradeCheckoutStarted_\(ssForProjection, tid\)/,
    '구조 투영은 반출 시작 여부를 권위 시트에서 다시 확인해야 한다');
  assert.match(worker, /checkoutStarted[\s\S]*supaPatchExistingScheduleItems_[\s\S]*supaUpsertGrouped_\(cfg, 'schedule_items'/,
    '반출 후에는 기존 행만 patch하고 기준선 없는 누락 행을 upsert하면 안 된다');
  assert.match(worker, /supaPatchExistingScheduleItems_\(cfg, built\.items\)/,
    '반출 후 구조 동기화는 존재하는 행만 PATCH해야 한다');
  assert.match(worker, /var checkoutStarted = localCheckoutStarted/,
    '운영에서 제거된 Supabase 기준선 조회를 되살리지 말고 권위 시트 반출 상태로 판정해야 한다');
  assert.match(supa, /function supaPatchExistingScheduleItems_[\s\S]*method: 'patch'[\s\S]*returned\.length !== 1/);
});

test('느린 구조 투영 lease는 카드 입력을 막지 않고 큐 merge만 원자화한다', () => {
  const gas = read('checkAvailability.js');
  const leases = section(gas, 'function dashboardTradeMutationLeaseError_', '\nvar DASHBOARD_STRUCTURE_QUEUE_PREFIX_');
  const schedule = section(gas, 'function scheduleDashboardStructureProjection_', '\nfunction ensureDashboardStructureProjectionTrigger_');
  assert.match(leases, /activeDashboardReturnProjectionLease_\(props, tid\)/);
  assert.doesNotMatch(leases, /ownKind === 'equipmentQty'[\s\S]*dashboardStructureMutation_/);
  assert.match(schedule, /queueLock\.tryLock\(3000\)/);
  assert.match(schedule, /scheduleDashboardStructureProjectionUnderLock_/);
  assert.doesNotMatch(schedule, /queueLock\.hasLock\(\)/);
  assert.match(schedule, /task\.revision = Number\(task\.revision \|\| 0\) \+ 1/);
});

test('구조 투영 watchdog은 새 트리거 성공 후에만 예전 트리거를 지운다', () => {
  const gas = read('checkAvailability.js');
  const ensure = section(gas, 'function ensureDashboardStructureProjectionTrigger_', '\n/** 거래별 큐의 외부 HTTP');
  // 순서 보장은 공용 프리미티브가 한다: 1개 남긴 채 create → 성공 뒤 잔여 삭제.
  // 인라인으로 "create 먼저"만 지키면 개수가 단조증가해 20개 쿼터를 먹는다.
  assert.ok(
    ensure.includes("replaceOneShotTrigger_('flushDashboardStructureProjectionQueue_'"),
    'create 실패가 기존 watchdog을 없애면 안 되고, 중복이 쌓여 쿼터를 먹어도 안 된다',
  );
  assert.match(ensure, /if \(!existingTriggers\.length\) props\.deleteProperty/);
});

test('사진 삭제의 Drive 휴지통 이동은 전역 ScriptLock 밖에서 실행한다', () => {
  const gas = read('checkAvailability.js');
  const photo = section(gas, 'function deleteDashboardPhoto', '\nfunction invalidateDashboardPhotoCache_');
  assert.match(photo, /lock\.tryLock\(1500\)/);
  assert.doesNotMatch(photo, /waitLock/);
  const releaseAt = photo.indexOf('lock.releaseLock()');
  const driveAt = photo.indexOf('DriveApp.getFileById(fileId).setTrashed(true)');
  assert.ok(releaseAt >= 0 && driveAt > releaseAt, 'Drive API 왕복이 다른 거래 버튼을 막으면 안 된다');
});

test('연속 품목 체크는 150ms 거래 배치와 내구 outbox로 유실 없이 합쳐진다', () => {
  const store = read('apps/today-dashboard/lib/data/store.ts');
  const gas = read('checkAvailability.js');
  const supa = read('supabaseSync.js');
  const api = read('sheetAPI.js');
  const proxy = read('apps/today-dashboard/app/api/gas/route.ts');
  const writer = read('apps/today-dashboard/lib/data/writeback.ts');

  const clientBatch = section(store, 'function armItemCheckBatch', '\n/** 잠금 경합');
  assert.match(clientBatch, /ITEM_CHECK_BATCH_DEBOUNCE_MS/);
  assert.match(store, /heybilly:item-check-outbox:v1/);
  assert.match(store, /window\.addEventListener\("online"/);
  assert.match(api, /case "toggleItems"/);
  assert.match(proxy, /"toggleItems"/);
  assert.match(writer, /action === "toggleItems"/);

  const batch = section(gas, 'function toggleItemChecksBatch', '\nfunction updateEquipmentCheck');
  const remoteAt = batch.indexOf('supaSetScheduleItemCheckoutStatesBatch_');
  const firstReleaseAt = batch.indexOf('lock.releaseLock()');
  assert.ok(firstReleaseAt >= 0 && remoteAt > firstReleaseAt, 'Supabase HTTP는 전역 잠금 밖에서 실행해야 한다');
  assert.match(batch, /mutationId/);
  assert.match(batch, /commitLock\.tryLock\(2000\)/);

  const parallel = section(supa, 'function supaSetScheduleItemCheckoutStatesBatch_', '\nfunction supaActualTakenQty_');
  assert.match(parallel, /UrlFetchApp\.fetchAll\(requests\)/);
});

test('수량·반납 상세은 네트워크 실패에도 사용자 목표를 보존하고 요청 폭주 없이 재시도한다', () => {
  const store = read('apps/today-dashboard/lib/data/store.ts');
  const qty = section(store, 'async function commitQueuedItemQty', '\nasync function reconcileItemQtyCanonical');
  assert.match(qty, /if \(isRetryableLedgerError\(e\)\)/);
  assert.match(qty, /qtyCommitTargets\[key\] = target/);
  assert.match(qty, /armQtyCommitRetry_\(tradeId, scheduleId, key\)/);
  const retryBranch = section(qty, 'if (isRetryableLedgerError(e)) {', '\n      showTransientError("⚠️ 수량 저장에 실패했습니다. 다시 조정해주세요")');
  assert.doesNotMatch(retryBranch, /acknowledgeQtyOutboxTarget\(key, target\)/,
    '일시 오류에서 사용자 목표 outbox를 지우면 안 된다');

  const retry = section(store, 'function scheduleReturnCountsRetry_', '\nfunction armReturnCountsPersist');
  assert.match(retry, /Math\.min\(1_500 \* 2 \*\* Math\.min\(attempt, 5\), 30_000\)/);
  const count = section(store, 'export async function setReturnCount', '\n// ── 결제·정산');
  assert.match(count, /if \(countUnchanged\) return true/,
    '최소값 − 또는 같은 메모 blur가 완료 거래를 재오픈하면 안 된다');
  assert.match(count, /putReturnCountOutboxPatch[\s\S]*await reopenReturnForCountMutation/,
    '재오픈보다 사용자 목표를 먼저 내구 기록해야 한다');
  assert.match(count, /resumeDurableReturnCountOutbox_\(tradeId, 1\)/,
    '재오픈 일시 실패도 현재 세션에서 자동 재개해야 한다');

  const checkout = section(store, 'export function setItemCheckout', '\nexport async function setItemName');
  assert.doesNotMatch(checkout, /plannedFinal[\s\S]*hasTradePending/,
    '앞선 저장이 있다는 이유로 장비 제외 클릭을 버리고 다시 누르게 하면 안 된다');
  const remove = section(store, 'function removeEquipmentAndRegenerateContract', '\nfunction isSheetBackedScheduleId');
  assert.match(remove, /putRemoveEquipmentOutbox_\(entry\)[\s\S]*equipments\.filter/,
    '장비 제외는 의도를 내구 기록한 뒤 화면에서 즉시 제거하고 거래별 원장 큐로 수렴해야 한다');
});

test('오래된 오프라인 반납수량은 다른 직원의 최신 반납완료를 자동 재오픈하지 않는다', () => {
  const store = read('apps/today-dashboard/lib/data/store.ts');
  const source = section(
    store,
    'function isReturnCountOutboxSupersededByCompletion_',
    '\nfunction convergeAfterDiscardedReturnCountOutbox_',
  ).replace(
    'function isReturnCountOutboxSupersededByCompletion_(entry: ReturnCountOutboxEntry, trade: Trade): boolean',
    'function isReturnCountOutboxSupersededByCompletion_(entry, trade)',
  );
  const context = { Date, String };
  // 확정 대기 창(낙관 close)에서는 superseded 아님 — 하니스 기본값은 '확정 대기 없음'
  vm.runInNewContext(
    `this.hasPendingReturnCompletionClose_ = () => false;\n${source}\nthis.isSuperseded = isReturnCountOutboxSupersededByCompletion_;`,
    context
  );

  const doneAt = '2026-07-28T12:00:00.000Z';
  const completed = { returnDone: true, contractStatus: '반납완료', returnDoneAt: doneAt };
  assert.equal(context.isSuperseded({
    version: 2,
    createdAt: Date.parse(doneAt) - 1,
    observedReturnDone: false,
    observedReturnDoneAt: null,
  }, completed), true, '완료보다 먼저 생긴 오프라인 입력은 폐기해야 한다');
  assert.equal(context.isSuperseded({
    version: 2,
    createdAt: Date.parse(doneAt) + 1,
    observedReturnDone: false,
    observedReturnDoneAt: null,
  }, completed), true, '완료를 보지 못한 기기의 입력은 시계가 앞서도 자동 재오픈하면 안 된다');
  assert.equal(context.isSuperseded({
    version: 2,
    createdAt: Date.parse(doneAt) + 1,
    observedReturnDone: true,
    observedReturnDoneAt: doneAt,
  }, completed), false, '같은 완료 화면에서 명시적으로 시작한 새 편집만 재오픈할 수 있다');
  assert.equal(context.isSuperseded({
    version: 2,
    createdAt: Date.parse(doneAt) + 1,
    observedReturnDone: true,
    observedReturnDoneAt: '2026-07-28T21:00:00.000+09:00',
  }, completed), false, '같은 완료 시각의 다른 ISO 표기도 동일 완료로 봐야 한다');
  assert.equal(context.isSuperseded({
    version: 2,
    createdAt: Date.parse(doneAt) + 1,
    observedReturnDone: true,
    observedReturnDoneAt: '2026-07-28T11:00:00.000Z',
  }, completed), true, '더 최신 완료가 생겼으면 예전 완료에 대한 편집도 폐기해야 한다');
});

test('응답 유실 뒤 재오픈 retry는 관찰한 완료시각과 같은 mutationId로만 CAS한다', () => {
  const store = read('apps/today-dashboard/lib/data/store.ts');
  const gas = read('checkAvailability.js');
  const api = read('sheetAPI.js');
  const reopen = section(store, 'async function reopenReturnForCountMutation', '\nfunction resumeDurableReturnCountOutbox_');
  assert.match(reopen, /mutationId:\s*mutationId \|\| createLedgerMutationId\("return-reopen"\)/);
  assert.match(reopen, /enforceExpectedReturnDoneAt:\s*true/);
  assert.match(reopen, /expectedReturnDoneAt:\s*String\(expectedReturnDoneAt \|\| ""\)/);
  assert.match(reopen, /if \(confirmedDone\) throw new ReturnCompletionConflictError\(tradeId\)/);

  const resume = section(store, 'function resumeDurableReturnCountOutbox_', '\n/** 반납 수량은 바뀐');
  assert.match(resume, /ensureReturnCountReopenMutationId_\(tradeId, durableEntry!\)/);
  assert.match(resume, /durableEntry!\.observedReturnDoneAt[\s\S]*reopenMutationId/);
  assert.match(store, /type ReturnCountOutboxEntry[\s\S]*reopenMutationId:\s*string/);

  const toggle = section(gas, 'function toggleReturnDone', '\n/** 거래의 반출 체크 속성키');
  const beginAt = toggle.indexOf('beginDashboardMutation_');
  const skipAt = toggle.indexOf('if (mutation.skip)');
  const casAt = toggle.indexOf('dashboardDoneAtMatches_(currentReturnDoneAt, expectedReturnDoneAt)');
  const writeAt = toggle.indexOf('setDashboardReturnContractStatus_');
  assert.ok(beginAt >= 0 && skipAt > beginAt && casAt > skipAt && writeAt > casAt,
    '같은 mutation 응답 재확인을 먼저 멱등 처리하고, 새 재오픈은 Sheet 쓰기 전에 완료시각 CAS를 해야 한다');
  assert.match(toggle, /expectedReturnDoneAtMismatch\s*=\s*true/);
  assert.match(toggle, /code\s*=\s*'RETURN_COMPLETION_CHANGED'/);
  const casReject = section(
    toggle,
    'if (!currentReturnDone || !dashboardDoneAtMatches_(currentReturnDoneAt, expectedReturnDoneAt))',
    '\n    if (!returnLease)',
  );
  assert.match(casReject, /commitDashboardMutation_\(props, tid, mutationId, 'return'\)/);
  assert.ok(
    casReject.indexOf("commitDashboardMutation_(props, tid, mutationId, 'return')") <
      casReject.indexOf('return changedCanonical'),
    'CAS 거절 mutation을 no-op committed로 마감한 뒤 canonical을 반환해야 한다',
  );
  assert.match(casReject, /rejectCommitErr[\s\S]*code:\s*'BUSY'[\s\S]*retryable:\s*true/);
  assert.match(api, /case "toggleReturn":[\s\S]*enforceExpectedReturnDoneAt:[\s\S]*expectedReturnDoneAt:/);

  const compareSource = section(
    gas,
    'function dashboardDoneAtEpoch_',
    '\nfunction setDashboardReturnContractStatus_',
  );
  const compareContext = { Date, String, Number, isNaN };
  vm.runInNewContext(`${compareSource}\nthis.matches = dashboardDoneAtMatches_;`, compareContext);
  assert.equal(
    compareContext.matches('2026-07-28 21:00:00', '2026-07-28T12:00:00.000Z'),
    true,
    '기존 KST 속성과 Supabase ISO 시각이 같은 순간이면 CAS가 통과해야 한다',
  );
  assert.equal(
    compareContext.matches('2026-07-28T12:00:00.001Z', '2026-07-28T12:00:00.002Z'),
    false,
    '밀리초가 다른 더 최신 완료는 같은 완료로 오인하면 안 된다',
  );
});

test('결제·증빙은 GAS 원장 성공 뒤에만 Supabase 보조필드로 확정되고 J:M은 직렬화된다', () => {
  const store = read('apps/today-dashboard/lib/data/store.ts');
  const gas = read('checkAvailability.js');
  const proof = section(store, 'async function setTradeProofField_', '\nexport function setDepositStatus');
  assert.match(proof, /gasMutationRetrying\("updateTradeProof"/);
  assert.match(proof, /result\.success !== true \|\| result\.field !== field/);
  assert.ok(proof.indexOf('gasMutationRetrying("updateTradeProof"') < proof.indexOf('schedulePersistTrade(latest, previous)'),
    '원장 확인 전 Supabase 보조필드를 확정하면 안 된다');

  const payment = section(gas, 'function updateTradePaymentMethod', '\nfunction applyTradePaymentSideEffects_');
  const auxClaim = section(gas, 'function claimDashboardAuxMutation_', '\nfunction releaseDashboardAuxMutation_');
  assert.match(auxClaim, /lock\.tryLock\(1000\)/);
  assert.match(auxClaim, /code: ['"]BUSY['"], retryable: true/);
  assert.match(payment, /claimDashboardAuxMutation_\(tid, ['"]payment['"]\)/);
  assert.match(payment, /applyTradePaymentSideEffects_/);
  assert.match(payment, /releaseDashboardAuxMutation_\(paymentClaim\)/);
});

test('사진·현장추가는 응답 유실과 비동기 투영 지연을 정상 실패로 오인하지 않는다', () => {
  const store = read('apps/today-dashboard/lib/data/store.ts');
  const photoQueue = read('apps/today-dashboard/lib/data/photoUploadQueue.ts');
  const gas = read('checkAvailability.js');

  const photoRead = section(store, 'async function loadTradePhotosBatch_', '\nexport function ensureTradePhotos');
  assert.match(photoRead, /hasOwnProperty\.call\(rawMap, tradeId\)/);
  assert.match(photoRead, /dashboardPhotoReadError_\(raw\)/);
  assert.ok(photoRead.indexOf('dashboardPhotoReadError_(raw)') < photoRead.indexOf('loadedPhotoTrades.add'),
    '경고/오류 응답을 빈 정본으로 확정하면 삭제되지 않은 사진까지 사라질 수 있다');
  // 네트워크 원인 소진 잡만 조건부 부활하고, 영구 거절·원인 불명 잡은 수동 재시도용으로 보존
  assert.match(photoQueue, /수동 재시도용으로 그대로 복원/);
  assert.match(photoQueue, /!job\.permanent && job\.attempts >= MAX_ATTEMPTS && NETWORK_ERROR_RE\.test/);
  assert.doesNotMatch(photoQueue, /attempts >= MAX_ATTEMPTS[\s\S]{0,300}idbDelete/,
    '자동 재시도 소진이 증빙 원본을 삭제하면 안 된다');

  const upload = section(gas, 'function uploadDashboardPhoto', '\nfunction deleteDashboardPhoto');
  assert.match(upload, /DASHBOARD_PHOTO_UPLOAD_CLAIM_PREFIX_|dashboardPhotoUploadClaimKey_/);
  assert.match(upload, /claimLock\.tryLock\(1500\)/);
  assert.match(upload, /findDashboardPhotoUploadRow_/);
  assert.ok(upload.indexOf('claimLock.releaseLock()') < upload.indexOf('folder.createFile(blob)'),
    'Drive 생성은 claim 전역 잠금 밖에서 실행해야 한다');

  const onsite = section(store, 'export async function addOnsiteItems', '\nexport function setOnsiteSettlement');
  assert.match(onsite, /if \(out\?\.duplicate \|\| res\?\.duplicate\)/);
  assert.match(onsite, /applyGasOnsiteItems_\(tradeId, recoveredItems/,
    'GAS가 검증한 중복 응답은 느린 Supabase 투영을 기다리지 않고 로컬에 수렴해야 한다');
});

test('장비 삭제는 응답 유실 뒤 같은 mutationId로 수렴하고 legacy 부재 요청은 실패한다', () => {
  const gas = read('checkAvailability.js');
  const api = read('sheetAPI.js');
  const helpers = section(gas, 'function normalizeDashboardMutationId_', '\nfunction dashboardSetupCanonicalResult_');
  const remove = section(gas, 'function dashboardRemoveEquipment', '\n/** "yyyy-MM-dd"');
  const removeApi = section(api, 'case "removeEquip":', '\n      case "repairDuplicateScheduleRows":');
  assert.match(removeApi, /mutationId:\s*params\.mutationId \|\| postBody\.mutationId/,
    'removeEquip API must forward the client mutation identity');

  const values = new Map();
  const props = {
    getProperty(key) { return values.has(key) ? values.get(key) : null; },
    setProperty(key, value) { values.set(key, String(value)); },
    deleteProperty(key) { values.delete(key); },
    getProperties() { return Object.fromEntries(values); },
  };
  let rows = [
    ['260728-001-01', '260728-001', 'FX6 세트', 'FX6 세트'],
    ['260728-001-02', '260728-001', 'FX6 세트', 'FX6'],
    ['260728-001-03', '260728-001', 'FX6 세트', '배터리'],
  ];
  const sheet = {
    getLastRow() { return rows.length + 1; },
    getRange(row, col, rowCount, colCount) {
      assert.equal(row, 2);
      assert.equal(col, 1);
      assert.equal(rowCount, rows.length);
      assert.equal(colCount, 4);
      return { getValues: () => rows.map((item) => item.slice()) };
    },
  };
  let lockHeld = false;
  let failAfterDelete = true;
  const projectionCalls = [];
  const regenCalls = [];
  const triggerLockStates = [];
  const context = {
    Date,
    JSON,
    Math,
    DASHBOARD_MUTATION_LOG_PREFIX_: 'dashboardMutationLog_v2_',
    DASHBOARD_MUTATION_LOG_TTL_MS_: 30 * 60 * 1000,
    CacheService: { getScriptCache: () => ({ get: () => '1', put() {} }) },
    PropertiesService: { getScriptProperties: () => props },
    LockService: {
      getScriptLock: () => ({
        tryLock() { lockHeld = true; return true; },
        releaseLock() { lockHeld = false; },
      }),
    },
    SpreadsheetApp: {
      getActiveSpreadsheet: () => ({ getSheetByName: (name) => name === '스케줄상세' ? sheet : null }),
    },
    dashboardTradeMutationLeaseError_: () => null,
    isDashboardTradeCheckoutStarted_: () => false,
    invalidateDashboardReturnInspectionForTrade_: () => ({}),
    deleteDashboardRowsDescending_: (_sheet, deleteRows) => {
      assert.deepEqual(Array.from(deleteRows), [4, 3, 2]);
      rows = [];
    },
    scheduleDashboardStructureProjectionUnderLock_: (tid, payload) => {
      assert.equal(lockHeld, true);
      if (failAfterDelete) throw new Error('simulated response-loss boundary');
      projectionCalls.push({ tid, payload });
    },
    scheduleContractRegenUnderLock_: (tid) => regenCalls.push(tid),
    invalidateDashboardCache() {},
    invalidateTimelineCache() {},
    ensureDashboardStructureProjectionTrigger_: () => triggerLockStates.push(lockHeld),
    ensureContractRegenTrigger_: () => triggerLockStates.push(lockHeld),
  };
  vm.runInNewContext(`${helpers}\n${remove}\nthis.remove = dashboardRemoveEquipment;`, context);

  assert.throws(
    () => context.remove('260728-001', 'FX6 세트', '260728-001-01', { mutationId: 'remove:one' }),
    /simulated response-loss boundary/,
  );
  assert.equal(rows.length, 0, 'first execution must have committed the sheet deletion before the lost response');

  failAfterDelete = false;
  const recovered = context.remove('260728-001', 'FX6 세트', '260728-001-01', { mutationId: 'remove:one' });
  assert.equal(recovered.success, true);
  assert.equal(recovered.deduped, true);
  assert.equal(recovered.recovered, true);
  assert.deepEqual(Array.from(recovered.removedScheduleIds), [
    '260728-001-03',
    '260728-001-02',
    '260728-001-01',
  ]);
  assert.deepEqual(projectionCalls.map((call) => call.tid), ['260728-001']);
  assert.deepEqual(Array.from(projectionCalls[0].payload.removeScheduleIds), [
    '260728-001-03',
    '260728-001-02',
    '260728-001-01',
  ], 'response-loss recovery must retain every removed set component id');
  assert.deepEqual(regenCalls, ['260728-001']);
  assert.deepEqual(triggerLockStates, [false, false], 'durable workers must be woken only after releasing ScriptLock');

  const legacyAbsent = context.remove('260728-001', 'FX6 세트', '260728-001-01', {});
  assert.equal(legacyAbsent.success, undefined);
  assert.match(legacyAbsent.error, /스케줄상세 비어있음|해당 장비 행 없음/);
});
