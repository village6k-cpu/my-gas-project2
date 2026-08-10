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

test("다중선택 제외 UI가 있고 반출 이후에는 뜨지 않는다", () => {
  const view = read("components/HandoverChecklist.tsx");
  assert.match(view, /여러 개 제외/);
  assert.match(view, /선택 \{picked\.length\}개 제외/);
  assert.match(
    view,
    /phase === "checkout" && !baselineLocked && selectableCount > 1/,
    "이미 반출된 거래나 품목 1개짜리에 일괄 제외를 노출하면 안 된다",
  );
  // 선택 모드에서는 개별 제외 버튼을 숨겨 오조작을 막는다.
  assert.match(view, /\{selecting \? null : e\.onsite \?/);
  assert.match(view, /disabled=\{excluded\}/, "이미 제외된 품목은 다시 고를 수 없어야 한다");
});

test("일괄 제외는 예약분과 현장추가를 각각 맞는 경로로 보낸다", () => {
  const view = read("components/HandoverChecklist.tsx");
  const apply = section(view, "const applyBulkExclude", "\n  const selectableCount");
  assert.match(apply, /if \(item\.onsite\) removeItem\(trade\.tradeId, id\);/);
  assert.match(apply, /else setItemCheckout\(trade\.tradeId, id, "excluded"\);/);
  assert.match(apply, /confirm\(/, "여러 건을 한 번에 지우기 전에는 확인을 받아야 한다");
});

test("removeItems는 반출 기준선이 잡힌 거래를 막는다", () => {
  const store = read("lib/data/store.ts");
  const bulk = section(store, "export function removeItems", "\n// ── 반납:");
  assert.match(bulk, /isCheckoutBaselineLocked\(trade\)/);
  assert.match(bulk, /new Set\(scheduleIds/, "같은 ID가 두 번 오면 한 번만 처리해야 한다");
});
