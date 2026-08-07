import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import "./helpers/tsResolve.mjs";

const { buildItems, computeConflicts } = await import("../lib/domain/timeline.ts");

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// 260803-003 정세미 재현: Slack 정정이 NiSi 필터의 actualTakenQty를 0으로 만들었고,
// 스케줄상세 시트에는 그대로 남아 있는데 헤이빌리 스케줄에서만 흔적 없이 사라졌다.
function trade(equipments) {
  return {
    tradeId: "260803-003",
    customerName: "정세미",
    contractStatus: "예약",
    checkoutAt: "2026-08-05T23:00:00+00:00",
    returnAt: "2026-08-07T11:00:00+00:00",
    contractUrl: null,
    amount: 119700,
    equipments,
  };
}

const NISI = {
  scheduleId: "260803-003-10",
  name: 'NiSi TrueColor PL 필터 4"x5.65"',
  qty: 1,
  actualTakenQty: 0,
  category: "필터",
  checkoutState: "taken",
};

const NORMAL = {
  scheduleId: "260803-003-06",
  name: "로닌 링그립",
  qty: 1,
  category: "로닌/짐벌",
  checkoutState: "taken",
};

test("실반출 0으로 정정된 품목도 스케줄에서 사라지지 않고 '제외' 막대로 남는다", () => {
  const items = buildItems([trade([NISI, NORMAL])]);
  const nisi = items.filter((it) => it.scheduleId === "260803-003-10");

  assert.equal(nisi.length, 1, "실반출 0이어도 막대 1개는 남아야 한다");
  assert.equal(nisi[0].statusKey, "제외");
  assert.equal(nisi[0].excluded, true);
  assert.equal(nisi[0].qty, 0, "재고 점유는 0이어야 한다");
  assert.equal(nisi[0].label, 'NiSi TrueColor PL 필터 4"x5.65"');

  const normal = items.filter((it) => it.scheduleId === "260803-003-06");
  assert.equal(normal.length, 1);
  assert.equal(normal[0].statusKey, "대기");
  assert.equal(normal[0].excluded, undefined);
});

test("checkout_state=excluded 품목도 지우지 않고 '제외'로 표시한다", () => {
  const items = buildItems([trade([{ ...NORMAL, actualTakenQty: undefined, checkoutState: "excluded" }])]);
  assert.equal(items.length, 1);
  assert.equal(items[0].statusKey, "제외");
  assert.equal(items[0].qty, 0);
});

test("'제외' 막대는 재고 충돌 계산에 끼지 않는다", () => {
  // 재고 1짜리 장비를 같은 날 두 거래가 잡아도, 한쪽이 실제로 안 나갔으면 충돌이 아니다.
  const a = { ...NISI, actualTakenQty: 0 };
  const b = { ...NISI, scheduleId: "260804-001-01", actualTakenQty: undefined };
  const items = buildItems([trade([a]), { ...trade([b]), tradeId: "260804-001", customerName: "다른고객" }])
    .map((it) => ({ ...it, stock: 1 }));

  assert.equal(items.length, 2, "두 막대 모두 화면에는 보여야 한다");
  assert.equal(computeConflicts(items).size, 0, "실반출 0은 점유가 없으므로 충돌이 아니다");
});

test("이름이 비어 있는 행만 막대에서 제외된다", () => {
  const items = buildItems([trade([{ ...NORMAL, name: "", actualName: null }])]);
  assert.equal(items.length, 0);
});

test("buildItems는 실반출 0을 continue로 버리지 않는다", () => {
  const source = fs.readFileSync(path.join(root, "lib/domain/timeline.ts"), "utf8");
  assert.doesNotMatch(
    source,
    /if \(rawQty <= 0\) continue/,
    "실반출 0을 조용히 버리면 시트에 있는 품목이 스케줄에서 흔적 없이 사라진다",
  );
  assert.doesNotMatch(
    source,
    /if \(e\.checkoutState === "excluded"\) continue/,
    "제외 상태도 조용히 버리면 안 된다",
  );
});
