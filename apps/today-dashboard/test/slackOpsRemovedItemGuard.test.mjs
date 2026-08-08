import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import "./helpers/tsResolve.mjs";

const { validateActions } = await import("../lib/server/slackOps.ts");

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// 260803-003 정세미 실제 사고 재현.
// 09:10 사장이 Black Pro-Mist(-11)를 예약에서 뺐고(removed_at), 10:47 Slack 초안이
// "BP 필터 제외" 한 줄을 보고 -11 과 -10(NiSi, 실제로 나간 필터) 둘 다 실반출 0으로 만들었다.
const SLACK_EVENT = {
  channel_id: "C0B6ZJZ2XU3",
  message_ts: "1785971291.596999",
  raw_context: {
    root: { ts: "1785971291.596999", text: "[반출] 정세미 감독님 : 특이사항\n• BP 필터 제외 문의" },
    replies: [],
  },
};

function item(overrides) {
  return {
    schedule_id: "260803-003-10",
    trade_id: "260803-003",
    name: 'NiSi TrueColor PL 필터 4"x5.65"',
    qty: 1,
    taken_qty: null,
    actual_name: null,
    actual_taken_qty: null,
    actual_source: null,
    set_name: null,
    is_set_header: true,
    is_component: false,
    onsite: false,
    settlement: null,
    checkout_state: "taken",
    memo_checkout: null,
    memo_checkin: null,
    removed_at: null,
    ...overrides,
  };
}

const NISI = item({});
const BP_REMOVED = item({
  schedule_id: "260803-003-11",
  name: "Black Pro-Mist 1/4 사각",
  removed_at: "2026-08-06T00:10:06.616+00:00",
});

function plan(actions) {
  return {
    channelId: "C0B6ZJZ2XU3",
    messageTs: "1785971291.596999",
    sourceHash: "3ca48d69f2079597611ef80b9d9d6de0970bb923fcc65eb722e79fc1dca0be88",
    tradeId: "260803-003",
    phase: "checkout",
    summary: "테스트",
    actions,
  };
}

test("이미 예약에서 빠진 품목을 정정하려는 계획은 통째로 막힌다", () => {
  assert.throws(
    () => validateActions(
      plan([
        { type: "item_correction", scheduleId: "260803-003-10", actualTakenQty: 0, memo: "BP 필터 제외" },
        { type: "item_correction", scheduleId: "260803-003-11", actualTakenQty: 0, memo: "BP 필터 제외" },
      ]),
      [NISI, BP_REMOVED],
      SLACK_EVENT,
    ),
    /이미 예약에서 제외된 품목/,
    "유령 행이 낀 계획은 사람 확인으로 넘어가야 한다 — 같은 계획의 멀쩡한 행까지 0이 되는 걸 끊는다",
  );
});

test("반출 기준선이 잡힌 행(taken_qty>0)은 removed_at 이 있어도 정정 대상이다", () => {
  // remote.ts attachScheduleItems 와 같은 규칙 — 실제 나간 이력은 반납 검수에 살아 있어야 한다.
  const takenThenRemoved = item({ schedule_id: "260803-003-11", taken_qty: 1, removed_at: "2026-08-06T00:10:06.616+00:00" });
  assert.doesNotThrow(() => validateActions(
    plan([{ type: "item_correction", scheduleId: "260803-003-11", actualTakenQty: 0, memo: "미반출" }]),
    [takenThenRemoved],
    SLACK_EVENT,
  ));
});

test("정상 품목 정정은 그대로 통과한다", () => {
  assert.doesNotThrow(() => validateActions(
    plan([{ type: "item_correction", scheduleId: "260803-003-10", actualTakenQty: 0, memo: "미반출" }]),
    [NISI],
    SLACK_EVENT,
  ));
});

test("거래에 없는 scheduleId 는 여전히 막힌다", () => {
  assert.throws(
    () => validateActions(
      plan([{ type: "item_correction", scheduleId: "260803-003-99", actualTakenQty: 0 }]),
      [NISI],
      SLACK_EVENT,
    ),
    /거래에 없는 scheduleId/,
  );
});

test("Slack 후보 목록과 검증 조회가 모두 removed_at 을 읽는다", () => {
  const source = fs.readFileSync(path.join(root, "lib/server/slackOps.ts"), "utf8");
  const selects = source.match(/\.select\("schedule_id,trade_id,name,qty[^"]*"\)/g) ?? [];
  assert.ok(selects.length >= 2, "schedule_items 조회가 2군데 이상 있어야 한다");
  for (const select of selects) {
    assert.match(select, /removed_at/, `removed_at 없이 조회하면 유령 행이 초안 모델에 그대로 간다: ${select}`);
  }
  assert.match(
    source,
    /items\.filter\(\(item\) => item\.trade_id === trade\.trade_id && !isRemovedFromReservation\(item\)\)/,
    "후보 품목 목록에서 예약에서 빠진 행을 걸러야 한다",
  );
});
