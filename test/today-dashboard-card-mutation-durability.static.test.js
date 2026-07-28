const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const store = fs.readFileSync(path.join(root, "apps/today-dashboard/lib/data/store.ts"), "utf8");
const gas = fs.readFileSync(path.join(root, "checkAvailability.js"), "utf8");
const api = fs.readFileSync(path.join(root, "sheetAPI.js"), "utf8");

function section(start, end) {
  const from = store.indexOf(start);
  const to = store.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, `${start} 구현을 찾을 수 있어야 한다`);
  return store.slice(from, to);
}

const setup = section("export async function toggleSetup", "\nexport type ToggleReturnResult");
const checkin = section("export async function toggleReturn", "\n/** 응답 유실된 반납완료");
const durableReplay = section("async function replayCompletionMutationEntry_", "\nlet durableMutationOutboxesReplayed");
const resumeCounts = section("function resumeDurableReturnCountOutbox_", "\n/** 반납 수량은 바뀐");
const countPersist = section("function enqueueReturnCountsPersist", "\nfunction scheduleReturnCountsRetry_");
const remove = section("function removeEquipmentAndRegenerateContract", "\nfunction isSheetBackedScheduleId");

assert.match(store, /COMPLETION_MUTATION_OUTBOX_KEY\s*=\s*"heybilly:completion-mutation-outbox:v1"/);
assert.ok(
  setup.indexOf("putCompletionMutationOutbox") < setup.indexOf('gasMutation("toggleSetup"'),
  "반출완료 의도는 GAS 호출 전에 영구 outbox에 기록해야 한다",
);
assert.ok(
  checkin.indexOf("putCompletionMutationOutbox") < checkin.indexOf('gasMutationRetrying("toggleReturn"'),
  "반납완료 의도는 GAS 호출 전에 영구 outbox에 기록해야 한다",
);
assert.match(durableReplay, /mutationId:\s*latest\.mutationId/);
assert.match(durableReplay, /COMPLETION_MUTATION_OUTBOX_TTL_MS/);
assert.match(store, /replayDurableMutationOutboxes[\s\S]*replayCompletionMutationOutboxes_\(\)/);

assert.match(resumeCounts, /if \(!hasReturnCountTargets\(tradeId\)\)/);
assert.match(resumeCounts, /clearTimeout\(returnCountOutboxResumeTimers\[tradeId\]\)/);
assert.match(store, /RETURN_COUNT_OUTBOX_VERSION\s*=\s*2/);
assert.match(store, /type ReturnCountOutboxEntry[\s\S]*createdAt:\s*number[\s\S]*observedReturnDoneAt:\s*string \| null[\s\S]*reopenMutationId:\s*string/);
assert.match(store, /function normalizeReturnCountOutboxEntry_[\s\S]*version:\s*1[\s\S]*createdAt:\s*0[\s\S]*observedReturnDone:\s*false/);
assert.match(
  resumeCounts,
  /isReturnCountOutboxSupersededByCompletion_\(durableEntry, trade\)[\s\S]*convergeAfterDiscardedReturnCountOutbox_\(tradeId\)[\s\S]*return;[\s\S]*reopenReturnForCountMutation/,
  "재시작 복구는 오래된 outbox를 폐기한 뒤에만 완료 재오픈 여부를 판단해야 한다",
);
const returnCountInput = section("export async function setReturnCount", "\n// ── 결제·정산");
assert.match(
  returnCountInput,
  /if \(wasReturnComplete\) discardAllReturnCountTargets_\(tradeId\)[\s\S]*putReturnCountOutboxPatch\(tradeId, scheduleId, durablePatch, \{[\s\S]*createdAt:\s*Date\.now\(\)[\s\S]*observedReturnDone:\s*wasReturnComplete[\s\S]*observedReturnDoneAt:[\s\S]*reopenMutationId,/,
  "완료 뒤 명시적 새 입력은 오래된 큐를 버리고 완료 시각과 생성시각을 함께 기록해야 한다",
);
assert.match(
  store,
  /replayDurableMutationOutboxes[\s\S]*isReturnCountOutboxSupersededByCompletion_\(returnEntry, trade\)[\s\S]*convergeAfterDiscardedReturnCountOutbox_/,
  "앱 재시작 시 오래된 수량을 화면이나 전송 target에 합치기 전에 폐기해야 한다",
);
assert.match(countPersist, /ReturnCompletionConflictError[\s\S]*discardAllReturnCountTargets_\(tradeId\)/);

assert.match(store, /REMOVE_EQUIPMENT_OUTBOX_KEY\s*=\s*"heybilly:remove-equipment-outbox:v1"/);
assert.match(store, /function hasTradePending\(tradeId: string\)[\s\S]*pendingRemoveEquipmentTrades\.has\(tradeId\)/);
assert.match(store, /function hasTradeSyncPending[\s\S]*hasTradePending\(tradeId\)/);
assert.ok(
  remove.indexOf("putRemoveEquipmentOutbox_") < remove.indexOf("commitRemoveEquipmentMutation_"),
  "장비 제외 의도와 mutationId는 원장 호출 전에 영구 저장해야 한다",
);
assert.match(store, /gasMutationRetrying\("removeEquip"[\s\S]*mutationId:\s*entry\.mutationId/);
assert.match(store, /isRetryableLedgerError\(error\)[\s\S]*scheduleRemoveEquipmentReplay_/);
const removeCommit = section("async function commitRemoveEquipmentMutation_", "\nasync function replayRemoveEquipmentMutation_");
const retryStart = removeCommit.indexOf("if (isRetryableLedgerError(error))");
const terminalStart = removeCommit.indexOf("acknowledgeRemoveEquipmentOutbox_(entry)", retryStart);
assert.ok(retryStart >= 0 && terminalStart > retryStart);
assert.doesNotMatch(
  removeCommit.slice(retryStart, terminalStart),
  /restoreRemovedItem/,
  "응답 유실/일시 오류에서 이미 삭제된 장비를 다시 살리면 안 된다",
);

assert.match(store, /function isPositiveExternalActionResult_/);
for (const action of ["requestProofIssue", "sendEstimate", "sendStatement", "sendPayAppPaymentLink"]) {
  const start = `export async function ${action}`;
  const from = store.indexOf(start);
  assert.ok(from >= 0, `${action} 구현이 있어야 한다`);
  const next = store.indexOf("\nexport ", from + start.length);
  const body = store.slice(from, next >= 0 ? next : store.length);
  assert.match(body, /isPositiveExternalActionResult_\(result\)/, `${action}은 양의 성공 증거가 필요하다`);
}

function gasSection(start, end) {
  const from = gas.indexOf(start);
  const to = gas.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, `${start} GAS 구현을 찾을 수 있어야 한다`);
  return gas.slice(from, to);
}

const insertRequest = gasSection("function insertAndCheckRequest", "\nfunction _insertAndCheckRequest");
const checkRequest = gasSection("function processByReqID", "\nfunction _processByReqID");
assert.match(insertRequest, /LockService\.getUserLock\(\)/);
assert.doesNotMatch(insertRequest, /LockService\.getScriptLock\(\)/);
assert.match(checkRequest, /LockService\.getUserLock\(\)/);
assert.doesNotMatch(checkRequest, /LockService\.getScriptLock\(\)/);

for (const [start, end] of [
  ["function updateTradePaymentMethod", "\nfunction applyTradePaymentSideEffects_"],
  ["function updateTradeBillingCompany", "\nfunction updateTradeProofField"],
  ["function updateTradeProofField", "\nfunction requestTradeEstimate"],
]) {
  const body = gasSection(start, end);
  assert.match(body, /claimDashboardAuxMutation_/);
  assert.doesNotMatch(body, /LockService\.getScriptLock\(\)/, `${start} 외부시트 I/O가 전역 잠금을 잡으면 안 된다`);
}

assert.match(gas, /DASHBOARD_EXTERNAL_ACTION_RECENT_MS_/);
assert.match(gas, /function claimDashboardExternalAction_/);
assert.match(gas, /idempotencyKey:[\s\S]*externalClaim\.token/);
assert.match(gas, /code:\s*'DUPLICATE_RECENT'/);
assert.match(api, /case "sendEstimate":[\s\S]*mutationId/);
assert.match(api, /case "sendStatement":[\s\S]*mutationId/);
assert.match(api, /case "sendPayAppPaymentLink":[\s\S]*mutationId/);
assert.match(api, /case "toggleReturn":[\s\S]*enforceExpectedReturnDoneAt:[\s\S]*expectedReturnDoneAt:/);
assert.match(gas, /function toggleReturnDone[\s\S]*dashboardDoneAtMatches_\(currentReturnDoneAt, expectedReturnDoneAt\)[\s\S]*RETURN_COMPLETION_CHANGED/);
assert.match(gas, /dashboardDoneAtMatches_\(currentReturnDoneAt, expectedReturnDoneAt\)[\s\S]*commitDashboardMutation_\(props, tid, mutationId, 'return'\)[\s\S]*rejectedMutationCommitted\s*=\s*true/);

console.log("today-dashboard durable card mutation static checks passed");
