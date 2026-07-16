const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

// 벌크 완료 배치화(duplicateFollowUpIdsForItems)가 단건 판정(duplicateFollowUpIdsForItem)의
// 합집합과 항상 같은 결과를 내는지 — 의미키 매칭·저정보 진단행 두 경로 모두 검증한다.

const appRoot = path.resolve(__dirname, "..");
const source = fs
  .readFileSync(path.join(appRoot, "lib/followups/logic.ts"), "utf8")
  .replace(/^export /gm, "");

const context = {};
vm.runInNewContext(
  `${source}\nthis.api = { duplicateFollowUpIdsForItem, duplicateFollowUpIdsForItems };`,
  context,
);
const { duplicateFollowUpIdsForItem, duplicateFollowUpIdsForItems } = context.api;

const candidates = [
  { id: "a1", customer_name: "김철수", type: "quote_send", room_key: "room-kim", title: "견적서 발송", summary: "7/20 대여 견적", evidence: ["7/20 예약 문의"] },
  { id: "a2", customer_name: "김철수", type: "quote_send", room_key: "room-kim", title: "견적 재요청", summary: "7/20 대여 견적 다시", evidence: [] },
  { id: "b1", customer_name: "이영희", type: "payment_check", room_key: "room-lee", title: "입금 확인", summary: "35만원 입금 확인 필요", evidence: [] },
  { id: "b2", customer_name: "이영희", type: "reply_needed", room_key: "room-lee", title: "채팅방 본문 확인 필요", summary: "카카오 대화 확인 필요 — 메시지 본문 확인", evidence: [] },
  { id: "c1", customer_name: "박민수", type: "return_extension", room_key: "room-park", title: "반납 연장", summary: "7/22 반납 연장 문의", evidence: [] },
];

test("배치 판정은 단건 판정의 합집합과 동일하다", () => {
  const currents = [candidates[0], candidates[2]];
  const expected = new Set();
  for (const current of currents) {
    for (const id of duplicateFollowUpIdsForItem(current, candidates)) expected.add(id);
  }
  const actual = new Set(duplicateFollowUpIdsForItems(currents, candidates));
  assert.deepEqual(actual, expected);
});

test("같은 고객의 저정보 진단행도 함께 닫힌다 (되살아남 방지 경로 보존)", () => {
  const ids = duplicateFollowUpIdsForItems([candidates[2]], candidates);
  assert.ok(ids.includes("b2"), "이영희의 저정보 진단행(b2)이 포함돼야 한다");
  assert.ok(!ids.includes("c1"), "무관한 고객(박민수)의 행은 포함되면 안 된다");
});

test("빈 입력·후보 없음에도 안전하다", () => {
  // vm 컨텍스트 배열은 프로토타입 realm이 달라 스프레드로 복사 후 비교한다
  assert.deepEqual([...duplicateFollowUpIdsForItems([], candidates)], []);
  assert.deepEqual([...duplicateFollowUpIdsForItems([candidates[0]], [])], []);
  assert.deepEqual([...duplicateFollowUpIdsForItems(null, null)], []);
});
