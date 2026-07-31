const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const appRoot = path.resolve(__dirname, "..");
const repoRoot = path.resolve(appRoot, "../..");
const store = fs.readFileSync(path.join(appRoot, "lib/data/store.ts"), "utf8");
const status = fs.readFileSync(path.join(appRoot, "lib/domain/status.ts"), "utf8");
const route = fs.readFileSync(path.join(appRoot, "app/api/gas/route.ts"), "utf8");
const gas = fs.readFileSync(path.join(repoRoot, "checkAvailability.js"), "utf8");
const sheetApi = fs.readFileSync(path.join(repoRoot, "sheetAPI.js"), "utf8");
const completionCasMigration = fs.readFileSync(
  path.join(appRoot, "supabase/migrations/20260731041845_completion_state_revision_cas.sql"),
  "utf8",
);

function section(source, start, end) {
  const from = source.indexOf(start);
  assert.ok(from >= 0, `missing section: ${start}`);
  const to = source.indexOf(end, from + start.length);
  assert.ok(to > from, `missing end marker: ${end}`);
  return source.slice(from, to);
}

test("반출완료는 불변 기준선 저장 없이 완료 상태만 확정한다", () => {
  const replay = section(store, "async function replayCompletionMutationEntry_", "function replayCompletionMutationOutboxes_");
  assert.doesNotMatch(replay, /baselineItems|setupBaselineItems|baselineFingerprint/);

  assert.match(route, /persistCompletionAuthority_/);
  assert.doesNotMatch(route, /CheckoutBaselineItem|checkoutBaselineFingerprint_|taken_qty/);
  const post = section(route, "async function callPost", "export async function GET");
  assert.ok(
    post.indexOf("await fetch(GAS_URL") < post.indexOf("await persistCompletionAuthority_"),
    "GAS mutation 원장이 순서를 확정한 뒤 Supabase 완료 상태를 저장해야 한다",
  );

  const setup = section(gas, "function toggleSetupDone", "function normalizeDashboardReturnSetKey_");
  assert.doesNotMatch(setup, /supaCaptureCheckoutBaseline_|dashboardCheckoutBaselineFingerprint_|markDashboardCheckoutBaselineStarted_/);
  assert.doesNotMatch(setup, /supaSetTradeSetupDone_/);
});

test("반납완료는 반출 기준선과 무관하고 서버 직결 확정 뒤 GAS는 HTTP를 다시 호출하지 않는다", () => {
  const toggle = section(store, "export async function toggleReturn", "// ── 품목 체크 원장 쓰기 신뢰화");
  assert.doesNotMatch(toggle, /hasCheckoutBaseline|needsBaselineConfirm|autoForce/);

  const returnGas = section(gas, "function toggleReturnDone", "/** 거래의 반출 체크 속성키");
  assert.doesNotMatch(returnGas, /supaGetCheckoutBaselineState_/);
  assert.doesNotMatch(returnGas, /supaSetTradeReturnDone_/);

  const apiReturn = section(sheetApi, 'case "toggleReturn"', 'case "toggleItem"');
  assert.doesNotMatch(apiReturn, /remoteConfirmed|baselineFingerprint/);
  assert.match(
    fs.readFileSync(path.join(appRoot, "lib/data/writeback.ts"), "utf8"),
    /action === "toggleSetup" \|\| action === "toggleReturn"/,
    "반출·반납 완료 모두 서버 정본 경로를 거치는 POST여야 한다",
  );
});

test("품목 수량과 장비명 저장은 카드 전체 savingTrades를 잠그지 않는다", () => {
  const name = section(store, "export async function setItemName", "/** GAS updateEquipQty");
  assert.doesNotMatch(name, /beginTradeTransition|beginTradeSave|hasTradePending/);
  assert.match(name, /itemNameTargets\[itemNameKey\] !== clean/, "연속 장비명 입력에서 옛 응답이 최신 화면을 덮으면 안 된다");

  const qty = section(store, "async function commitQueuedItemQty", "async function reconcileItemQtyCanonical");
  assert.doesNotMatch(qty, /beginTradeSave|finishTradeSave/);
  const modalQty = section(store, "export async function setItemQty", "// ── 스테퍼용 낙관적 수량 변경");
  assert.match(modalQty, /queueItemQty\(tradeId, scheduleId, safeQty\)/);
  assert.doesNotMatch(modalQty, /beginTradeTransition|beginTradeSave|finishTradeSave|hasTradePending/);
});

test("완료/해제 원격 저장은 GAS revision CAS로 역순 응답을 거부한다", () => {
  assert.match(gas, /completionRevision: ensureDashboardCompletionRevision_/);
  assert.match(gas, /completionRevision: nextDashboardCompletionRevision_/);
  assert.match(route, /client\.rpc\("apply_trade_completion"/);
  assert.match(route, /completionRevision: confirmed\.completionRevision/);
  assert.doesNotMatch(
    section(route, "async function persistCompletionAuthority_", "// 읽기 응답 짧게 캐시"),
    /\.from\("trades"\)[\s\S]*\.update\(/,
    "trade_id만 조건으로 한 무조건 UPDATE를 다시 쓰면 안 된다",
  );
  assert.match(completionCasMigration, /for update/i);
  assert.match(completionCasMigration, /p_revision > v_trade\.setup_state_revision/);
  assert.match(completionCasMigration, /p_revision > v_trade\.return_state_revision/);
  assert.match(completionCasMigration, /revoke execute[\s\S]*from public, anon, authenticated/i);

  const apply = (state, revision, done) => revision > state.revision ? { revision, done } : state;
  const newerFirst = apply({ revision: 0, done: false }, 102, false);
  const staleAfter = apply(newerFirst, 101, true);
  assert.deepEqual(staleAfter, { revision: 102, done: false });
});

test("반출 후에도 품목 편집이 가능하고 완료 카드는 재개방 경고로 부활하지 않는다", () => {
  const lock = section(status, "export function isCheckoutBaselineLocked", "// ── 반납:");
  assert.doesNotMatch(lock, /setupDone|takenQty|contractStatus === "반출"/);

  const blockers = section(status, "export function returnCompletionBlockers", "export function returnBadge");
  assert.match(blockers, /if \(t\.returnDone\) return \[\]/);

  const itemBatch = section(gas, "function toggleItemChecksBatch", "function toggleItemCheck");
  assert.doesNotMatch(itemBatch, /isDashboardTradeCheckoutStarted_|checkoutBaselineStarted_/);
  const itemSingle = section(gas, "function toggleItemCheck", "function markDashboardCheckoutBaselineStarted_");
  assert.doesNotMatch(itemSingle, /supaGetCheckoutBaselineState_|checkoutBaselineStarted_/);
});
