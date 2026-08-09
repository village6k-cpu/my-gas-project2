import assert from "node:assert/strict";
import test from "node:test";

import "./helpers/tsResolve.mjs";

const { isSameApplyContent } = await import("../lib/server/slackOps.ts");

// 260806-010 이동교 실제 사고 재현.
// 8/9 직원 답글로 source_hash가 바뀌어 applied 사건이 pending으로 돌아왔고, 에이전트가
// 요약 문구만 다시 쓴 동일 계획을 재실행해 "반영 완료" 공지가 두 번 올라갔다.
const plan = {
  channelId: "C0B6ZJZ2XU3",
  messageTs: "1786231018.260949",
  sourceHash: "a".repeat(64),
  tradeId: "260806-010",
  phase: "checkout",
  summary: "재작성된 요약 문구",
  actions: [
    { type: "item_correction", scheduleId: "260806-010-15", actualTakenQty: 0, memo: "600C 미반출, F22C로 교체" },
    { type: "onsite_add", settlement: "미정", items: [{ name: "어퓨쳐 LS 60X", qty: 2 }] },
  ],
};

test("같은 거래·단계·action이면 요약 문구가 달라도 중복으로 판정한다", () => {
  assert.equal(isSameApplyContent({ ...plan, summary: "원래 요약" }, plan), true);
});

test("계획 내용이 실제로 달라졌을 때만 재적용을 허용한다", () => {
  assert.equal(isSameApplyContent(null, plan), false);
  assert.equal(isSameApplyContent(undefined, plan), false);
  assert.equal(isSameApplyContent({ ...plan, tradeId: "260806-011" }, plan), false);
  assert.equal(isSameApplyContent({ ...plan, phase: "checkin" }, plan), false);
  assert.equal(isSameApplyContent({ ...plan, actions: [] }, plan), false);
  assert.equal(isSameApplyContent({ ...plan, actions: [plan.actions[0]] }, plan), false);
});
