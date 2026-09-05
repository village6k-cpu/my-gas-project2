import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const modelUrl = pathToFileURL(path.join(appRoot, "lib/followups/inbox-model.mjs")).href;
const viewPath = path.join(appRoot, "components/FollowUpView.tsx");
const now = "2026-09-05T09:00:00.000Z";

function item(id, overrides = {}) {
  return {
    id,
    version: 7,
    category: "schedule",
    workType: "schedule_check",
    workTypeLabel: "스케줄 확인",
    priority: "normal",
    state: "open",
    title: "김OO 촬영 일정 확인",
    summary: "직원이 확인한 안전한 요약",
    recommendedAction: "후보 일정 하나를 선택",
    dueAt: null,
    snoozedUntil: null,
    firstOpenedAt: "2026-09-05T08:00:00.000Z",
    updatedAt: "2026-09-05T08:30:00.000Z",
    ...overrides,
  };
}

const orderedRows = [
  item("11111111-1111-4111-8111-111111111111", { priority: "p0", title: "P0 확인" }),
  item("22222222-2222-4222-8222-222222222222", { dueAt: "2026-09-05T08:59:59.999Z", title: "기한 지난 확인" }),
  item("33333333-3333-4333-8333-333333333333", { priority: "urgent", title: "긴급 일정 확인" }),
  item("44444444-4444-4444-8444-444444444444", { firstOpenedAt: "2026-09-01T08:00:00.000Z", title: "오래된 일정 확인" }),
];

function payload(overrides = {}) {
  return {
    ok: true,
    source: "work_items_v2",
    summary: {
      now: 4,
      snoozed: 1,
      completed: 2,
      p0: 1,
      byCategory: { schedule: 4, quote: 1, settlement: 0, customer: 0, operations: 0 },
    },
    items: orderedRows,
    nextCursor: null,
    omittedCount: 0,
    ...overrides,
  };
}

async function loadModel() {
  return import(`${modelUrl}?test=${Date.now()}-${Math.random()}`);
}

test("inbox model exposes three status tabs and the five server-counted business categories", async () => {
  const { buildInboxView } = await loadModel();
  const model = buildInboxView({ payload: payload(), view: "now", category: "schedule", selectedId: null, now });

  assert.deepEqual(model.tabs, [
    { key: "now", label: "지금 할 일", count: 4 },
    { key: "snoozed", label: "미뤄둔 일", count: 1 },
    { key: "completed", label: "완료", count: 2 },
  ]);
  assert.deepEqual(model.categories, [
    { key: "schedule", label: "예약·스케줄", count: 4 },
    { key: "quote", label: "견적·가격", count: 1 },
    { key: "settlement", label: "정산·서류", count: 0 },
    { key: "customer", label: "고객 응대", count: 0 },
    { key: "operations", label: "운영·예외", count: 0 },
  ]);
});

test("inbox model preserves the server priority order and assigns every row exactly once", async () => {
  const { buildInboxView } = await loadModel();
  const model = buildInboxView({ payload: payload(), view: "now", category: "schedule", selectedId: null, now });

  assert.deepEqual(model.rows.map(({ id }) => id), orderedRows.map(({ id }) => id));
  assert.equal(model.rows.every((row) => row.category === "schedule"), true);
  assert.equal(new Set(model.rows.map(({ id }) => id)).size, model.rows.length);
  assert.equal(model.selected.id, orderedRows[0].id);
});

test("inbox selection keeps a matching row and falls back after a stale refresh", async () => {
  const { buildInboxView } = await loadModel();
  const selected = buildInboxView({ payload: payload(), view: "now", category: "schedule", selectedId: orderedRows[2].id, now });
  const refreshed = buildInboxView({
    payload: payload({ items: orderedRows.slice(1) }),
    view: "now",
    category: "schedule",
    selectedId: orderedRows[0].id,
    now,
  });

  assert.equal(selected.selected.id, orderedRows[2].id);
  assert.equal(refreshed.selected.id, orderedRows[1].id);
});

test("inbox model preserves server-filtered snooze membership across client clock drift", async () => {
  const { buildInboxView } = await loadModel();
  const expired = item("55555555-5555-4555-8555-555555555555", {
    state: "snoozed",
    snoozedUntil: now,
  });
  const future = item("66666666-6666-4666-8666-666666666666", {
    state: "snoozed",
    snoozedUntil: "2026-09-05T10:00:00.000Z",
  });

  assert.equal(buildInboxView({ payload: payload({ items: [expired] }), view: "now", category: "schedule", selectedId: null, now }).rows[0].id, expired.id);
  assert.equal(buildInboxView({ payload: payload({ items: [future] }), view: "snoozed", category: "schedule", selectedId: null, now }).rows[0].id, future.id);
  const justExpiredOnClient = item("77777777-7777-4777-8777-777777777777", {
    state: "snoozed",
    snoozedUntil: "2026-09-05T09:00:00.001Z",
  });
  assert.equal(buildInboxView({
    payload: payload({ items: [justExpiredOnClient] }),
    view: "snoozed",
    category: "schedule",
    selectedId: null,
    now: "2026-09-05T09:00:00.002Z",
  }).rows[0].id, justExpiredOnClient.id);
});

test("inbox action body is exact and unavailable payload is not presented as an empty inbox", async () => {
  const { actionBody, buildInboxView } = await loadModel();
  assert.deepEqual(actionBody(orderedRows[0], { type: "progress" }), {
    id: orderedRows[0].id,
    expectedVersion: orderedRows[0].version,
    action: { type: "progress" },
  });
  assert.deepEqual(actionBody(orderedRows[0], { type: "snooze", snoozedUntil: "2026-09-05T10:00:00.000Z" }), {
    id: orderedRows[0].id,
    expectedVersion: orderedRows[0].version,
    action: { type: "snooze", snoozedUntil: "2026-09-05T10:00:00.000Z" },
  });
  assert.throws(() => actionBody(orderedRows[0], { type: "progress", extra: true }), /Heybilli work action invalid/);
  assert.throws(
    () => buildInboxView({ payload: null, view: "now", category: null, selectedId: null, now }),
    /Heybilli inbox unavailable/,
  );
});

test("FollowUpView source is a master-detail inbox without kanban, checkboxes, or bulk actions", () => {
  const source = readFileSync(viewPath, "utf8");
  for (const label of ["지금 할 일", "미뤄둔 일", "완료", "예약·스케줄", "견적·가격", "정산·서류", "고객 응대", "운영·예외"]) {
    assert.equal(source.includes(label), true, `missing ${label}`);
  }
  for (const removed of ["LANE_DEFS", 'type="checkbox"', "BulkBtn", "응답·견적", "운영·기타", "4레인 칸반"]) {
    assert.equal(source.includes(removed), false, `legacy source remains: ${removed}`);
  }
  assert.match(source, /lg:grid-cols-\[minmax\(320px,0\.9fr\)_minmax\(420px,1\.1fr\)\]/);
  assert.match(source, /lg:sticky/);
  assert.match(source, /fixed inset-x-0 bottom-0/);
});
