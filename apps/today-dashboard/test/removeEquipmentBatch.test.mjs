import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

function section(source, start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, `${start} section not found`);
  return source.slice(from, to);
}

// 실측: GAS 웹앱 왕복은 가벼운 호출도 2.5~3.5초. 제외를 품목마다 보내면 N배가 되고,
// 예전 코드는 진행 중인 제외가 있으면 다음 클릭을 조용히 버렸다(토스트조차 없음).
// 세트 제외처럼 N번 호출되는 경로에서는 첫 건만 반영되고 나머지가 사라졌다.

test("제외 클릭은 진행 중인 저장이 있어도 절대 버려지지 않는다", () => {
  const store = read("lib/data/store.ts");
  const remove = section(store, "function removeEquipmentAndRegenerateContract", "\n/** 여러 품목을 한 번에");

  assert.doesNotMatch(
    remove,
    /activeTradeTransitions\.has\(tradeId\)|pendingRemoveEquipmentTrades\.has\(tradeId\)/,
    "진행 중이라는 이유로 제외 클릭을 버리면 사장이 같은 버튼을 3초 간격으로 여러 번 눌러야 한다",
  );
  assert.doesNotMatch(remove, /showTransientError/, "제외는 거절이 아니라 큐잉되어야 한다");
  assert.match(remove, /putRemoveEquipmentOutbox_\(entry\)/, "의도를 먼저 내구 저장해야 한다");
  assert.match(remove, /armRemoveEquipmentBatch\(tradeId\)/, "저장은 배치로 합류해야 한다");
});

test("제외는 전역 전환 플래그를 잡지 않는다 (다른 버튼을 막지 않기 위해)", () => {
  const store = read("lib/data/store.ts");
  const remove = section(store, "function removeEquipmentAndRegenerateContract", "\n/** 여러 품목을 한 번에");
  assert.doesNotMatch(
    remove,
    /beginTradeTransition/,
    "activeTradeTransitions를 잡으면 setItemCheckout 최상단 가드가 다음 제외 클릭을 조용히 삼킨다",
  );

  // 순서 안전 가드 자체는 남아 있어야 한다 — 반출완료 같은 전환은 여전히 막혀야 한다.
  assert.match(
    store,
    /return activeTradeTransitions\.has\(tradeId\) \|\| pendingRemoveEquipmentTrades\.has\(tradeId\);/,
    "제외가 대기 중일 때 완료 전환은 여전히 막혀야 한다",
  );
});

test("배치 커밋은 한 거래의 밀린 제외를 한 번의 GAS 호출로 보낸다", () => {
  const store = read("lib/data/store.ts");
  const batch = section(store, "async function commitRemoveEquipmentBatch_", "\nasync function commitRemoveEquipmentMutation_");

  assert.match(batch, /gasMutationRetrying\("removeEquips"/, "배치 액션을 써야 왕복이 1회가 된다");
  assert.match(batch, /items: JSON\.stringify\(entries\.map/);
  assert.doesNotMatch(batch, /for \([^)]*\) \{[\s\S]{0,400}await gasMutationRetrying/, "품목마다 await로 보내면 배치가 아니다");
});

test("전환 중이면 버리지 않고 다시 예약한다", () => {
  const store = read("lib/data/store.ts");
  const batch = section(store, "async function commitRemoveEquipmentBatch_", "\nasync function commitRemoveEquipmentMutation_");
  assert.match(
    batch,
    /if \(activeTradeTransitions\.has\(tradeId\)\) \{\s*armRemoveEquipmentBatch\(tradeId, \d+\);\s*return;/,
    "양보는 하되 재예약 없이 return 하면 큐가 고아가 된다",
  );
});

test("배치가 도는 동안 눌린 제외도 이어서 처리한다", () => {
  const store = read("lib/data/store.ts");
  const batch = section(store, "async function commitRemoveEquipmentBatch_", "\nasync function commitRemoveEquipmentMutation_");
  const finallyBlock = batch.slice(batch.lastIndexOf("} finally {"));
  assert.match(
    finallyBlock,
    /pendingRemoveEquipmentEntries_\(tradeId\)\.length[\s\S]{0,80}armRemoveEquipmentBatch\(tradeId\)/,
    "in-flight 중 들어온 클릭을 이어받지 않으면 마지막 몇 건이 영영 안 나간다",
  );
});

test("되돌릴 수 없는 실패는 품목별로 원본을 되살린다", () => {
  const store = read("lib/data/store.ts");
  const batch = section(store, "async function commitRemoveEquipmentBatch_", "\nasync function commitRemoveEquipmentMutation_");
  assert.match(batch, /removeEquipmentOriginals\.get\(key\)/);
  assert.match(batch, /restoreRemovedItem\(entry\.tradeId, original/, "화면에서 지운 품목을 사실과 다시 맞춰야 한다");
  assert.match(batch, /isRetryableLedgerError\(error\)/, "일시 오류는 되살리지 말고 재시도해야 한다");
});

test("재시도도 배치에 합류한다", () => {
  const store = read("lib/data/store.ts");
  const replay = section(store, "async function replayRemoveEquipmentMutation_", "\n/**");
  assert.match(replay, /armRemoveEquipmentBatch\(latest\.tradeId, 0\)/);
  assert.doesNotMatch(replay, /commitRemoveEquipmentMutation_/, "재시도가 1건씩 돌면 밀린 제외가 다시 N배가 된다");
  assert.doesNotMatch(replay, /beginTradeTransition/, "재시도도 다른 버튼을 막으면 안 된다");
});

test("세트 제외는 removeItem N번이 아니라 한 번의 배치로 나간다", () => {
  const view = read("components/HandoverChecklist.tsx");
  assert.doesNotMatch(
    view,
    /g\.headers\.forEach\(\(header\) => removeItem\(/,
    "루프 호출은 첫 건만 반영되고 나머지가 버려졌다",
  );
  assert.match(view, /removeItems\(trade\.tradeId, \[[\s\S]{0,200}g\.headers\.map[\s\S]{0,200}g\.rows\.map/);
});

test("선택 모드·체크박스·확인창이 없다 (연타로 처리)", () => {
  const view = read("components/HandoverChecklist.tsx");
  // 모드 진입 → 체크 → 스크롤 back → 네이티브 confirm 은 탭이 너무 많았다.
  // 제외가 배치로 묶이므로 그냥 연타하면 왕복 1회로 나간다.
  assert.doesNotMatch(view, /여러 개 제외/, "모드 진입 버튼이 남아 있으면 안 된다");
  assert.doesNotMatch(view, /선택 \{picked\.length\}개 제외/);
  assert.doesNotMatch(view, /applyBulkExclude/);
  assert.doesNotMatch(view, /confirm\(`선택한/, "제외에 네이티브 확인창을 띄우지 않는다");
  assert.match(view, /onClick=\{\(\) => setItemCheckout\(t\.tradeId, e\.scheduleId, "excluded"\)\}/,
    "줄마다 있는 제외 버튼이 유일한 진입점이다");
});

test("제외하면 되돌리기 토스트가 뜬다", () => {
  const store = read("lib/data/store.ts");
  const remove = section(store, "function removeEquipmentAndRegenerateContract", "\n/** 여러 품목을 한 번에");
  assert.match(remove, /개 제외됨/);
  assert.match(remove, /label: "되돌리기"/);
  assert.match(remove, /undoStagedRemoveEquipment_\(tradeId, staged\)/);
  // 연타분을 누적해서 한 토스트로 보여준다.
  assert.match(remove, /pendingRemoveEquipmentEntries_\(tradeId\)/);
});

test("되돌리기는 전송 전 취소라 서버 보정이 필요 없다", () => {
  const store = read("lib/data/store.ts");
  const undo = section(store, "function undoStagedRemoveEquipment_", "\nfunction pendingRemoveEquipmentEntries_");
  assert.match(undo, /clearTimeout\(removeEquipmentBatchTimers\[tradeId\]\)/, "예약된 전송을 취소해야 한다");
  assert.match(undo, /if \(removeEquipmentReplayInFlight\.has\(key\)\) continue/,
    "이미 전송이 시작된 건은 되돌리면 서버와 어긋난다");
  assert.match(undo, /restoreRemovedItem\(tradeId, item/);
  assert.doesNotMatch(undo, /gasMutation/, "전송 전 취소이므로 보정 호출이 없어야 한다");
});

test("되돌리기 창이 다른 명령을 지연시키지 않는다", () => {
  const store = read("lib/data/store.ts");
  const begin = section(store, "function beginTradeTransition", "\n/** 완전삭제처럼");
  assert.match(begin, /flushRemoveEquipmentBatch_\(tradeId\)/,
    "완료 전환 전에 대기 중인 제외를 먼저 보내야 창만큼 밀리지 않는다");
  const flush = section(store, "function flushRemoveEquipmentBatch_", "\n/**");
  assert.match(flush, /clearTimeout[\s\S]*commitRemoveEquipmentBatch_\(tradeId\)/);
});

test("토스트는 액션이 있을 때만 클릭을 받는다", () => {
  const toast = read("components/Toast.tsx");
  assert.match(toast, /toast\.action \? "" : "pointer-events-none "/,
    "항상 클릭을 받으면 토스트가 화면 조작을 가린다");
  assert.match(toast, /onClick=\{toast\.action\.run\}/);
});

test("removeItems는 반출 기준선이 잡힌 거래를 막는다", () => {
  const store = read("lib/data/store.ts");
  const bulk = section(store, "export function removeItems", "\n// ── 반납:");
  assert.match(bulk, /isCheckoutBaselineLocked\(trade\)/);
  assert.match(bulk, /new Set\(scheduleIds/, "같은 ID가 두 번 오면 한 번만 처리해야 한다");
});
