import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const modelUrl = pathToFileURL(path.join(appRoot, "lib/followups/inbox-model.mjs")).href;
const viewPath = path.join(appRoot, "components/FollowUpView.tsx");
const now = "2026-09-06T00:00:00.000Z";

function step(id, overrides = {}) {
  return {
    id,
    version: 7,
    category: "schedule",
    workTypeLabel: "스케줄 확인",
    priority: "normal",
    state: "open",
    taskLabel: "촬영 일정 확인",
    dueAt: null,
    snoozedUntil: null,
    updatedAt: "2026-09-03T12:51:00.000Z",
    ...overrides,
  };
}

function inquiryCase(id, overrides = {}) {
  return {
    id,
    state: "now",
    priority: "p0",
    title: "고객가 문의",
    ownerBrief: "스케줄 확인 외 2개 업무",
    requestSummary: "고객이 촬영 일정과 서류 확인을 요청했습니다.",
    problemSummary: "일정 가능 여부와 계약서 확인이 남아 있습니다.",
    nextActionSummary: "일정과 계약서를 확인한 뒤 고객에게 안내하세요.",
    receivedAt: "2026-09-03T12:29:00.000Z",
    updatedAt: "2026-09-03T12:51:00.000Z",
    categories: ["schedule", "settlement", "customer"],
    completedStepCount: 1,
    totalStepCount: 3,
    steps: [
      step("11111111-1111-4111-8111-111111111111"),
      step("22222222-2222-4222-8222-222222222222", {
        category: "settlement", workTypeLabel: "계약·서류 처리", taskLabel: "계약서 확인",
        state: "resolved",
      }),
      step("33333333-3333-4333-8333-333333333333", {
        category: "customer", workTypeLabel: "고객 답변 필요", taskLabel: "고객에게 안내",
        priority: "urgent", state: "in_progress",
      }),
    ],
    ...overrides,
  };
}

const orderedCases = [
  inquiryCase("11111111-1111-4111-8111-111111111111"),
  inquiryCase("44444444-4444-4444-8444-444444444444", {
    priority: "normal", title: "고객나 문의", ownerBrief: "스케줄 확인",
    receivedAt: "2026-09-05T15:30:00.000Z", updatedAt: "2026-09-05T15:35:00.000Z",
    categories: ["schedule"], completedStepCount: 0, totalStepCount: 1,
    steps: [step("44444444-4444-4444-8444-444444444444")],
  }),
];

function payload(overrides = {}) {
  return {
    ok: true,
    source: "work_items_v2_cases",
    summary: {
      now: 2,
      snoozed: 1,
      completed: 2,
      p0: 1,
      byCategory: { schedule: 2, quote: 1, settlement: 1, customer: 1, operations: 0 },
    },
    cases: orderedCases,
    nextCursor: null,
    omittedCount: 0,
    ...overrides,
  };
}

async function loadModel() {
  return import(`${modelUrl}?test=${Date.now()}-${Math.random()}`);
}

test("inquiry inbox exposes case counts and allows overlapping business categories", async () => {
  const { buildInboxView } = await loadModel();
  const model = buildInboxView({ payload: payload(), view: "now", category: null, selectedId: null, now });

  assert.deepEqual(model.tabs, [
    { key: "now", label: "지금 할 일", count: 2 },
    { key: "snoozed", label: "미뤄둔 일", count: 1 },
    { key: "completed", label: "완료", count: 2 },
  ]);
  assert.deepEqual(model.categories, [
    { key: "schedule", label: "예약·스케줄", count: 2 },
    { key: "quote", label: "견적·가격", count: 1 },
    { key: "settlement", label: "정산·서류", count: 1 },
    { key: "customer", label: "고객 응대", count: 1 },
    { key: "operations", label: "운영·예외", count: 0 },
  ]);
  assert.equal(model.rows.length, 2);
  assert.equal(model.rows[0].steps.length, 3);
  assert.equal(model.selected.id, orderedCases[0].id);
});

test("a receipt clock ahead of the database clock does not hide any inquiry or change its action version", async () => {
  const { buildInboxView, actionBody } = await loadModel();
  const data = structuredClone(payload());
  data.cases[1].receivedAt = "2026-09-05T15:35:00.536Z";
  const model = buildInboxView({ payload: data, view: "now", category: null, selectedId: null, now });
  assert.equal(model.rows.length, data.cases.length);
  assert.equal(model.rows[1].receivedAt, data.cases[1].receivedAt);
  assert.equal(model.rows[1].updatedAt, data.cases[1].updatedAt);
  assert.deepEqual(actionBody(model.rows[1].steps[0], { type: "complete" }), {
    id: data.cases[1].steps[0].id, expectedVersion: 7, action: { type: "complete" },
  });
  for (const field of ["receivedAt", "updatedAt"]) {
    const malformed = structuredClone(data);
    malformed.cases[1][field] = "invalid-date";
    assert.throws(() => buildInboxView({ payload: malformed, view: "now", category: null, selectedId: null, now }), /payload invalid/);
  }
});

test("inquiry timing is KST owner-readable and uses calendar-day age", async () => {
  const { buildInboxView, formatInquiryTiming } = await loadModel();
  assert.deepEqual(formatInquiryTiming("2026-09-03T12:29:00.000Z", now), {
    receivedLabel: "접수 9/3 21:29",
    ageLabel: "3일 전",
  });
  assert.deepEqual(formatInquiryTiming("2026-09-05T15:30:00.000Z", now), {
    receivedLabel: "접수 9/6 00:30",
    ageLabel: "오늘 문의",
  });
  const model = buildInboxView({ payload: payload(), view: "now", category: null, selectedId: null, now });
  assert.equal(model.rows[0].receivedLabel, "접수 9/3 21:29");
  assert.equal(model.rows[0].ageLabel, "3일 전");
  assert.equal(model.rows[0].progressLabel, "1/3 완료");
});

test("case selection is stable and actions target the exact checklist step version", async () => {
  const { actionBody, buildInboxView } = await loadModel();
  const selected = buildInboxView({ payload: payload(), view: "now", category: null, selectedId: orderedCases[1].id, now });
  assert.equal(selected.selected.id, orderedCases[1].id);
  assert.deepEqual(actionBody(orderedCases[0].steps[2], { type: "progress" }), {
    id: orderedCases[0].steps[2].id,
    expectedVersion: 7,
    action: { type: "progress" },
  });
  assert.deepEqual(actionBody(orderedCases[0].steps[0], { type: "snooze", snoozedUntil: "2026-09-06T01:00:00.000Z" }), {
    id: orderedCases[0].steps[0].id,
    expectedVersion: 7,
    action: { type: "snooze", snoozedUntil: "2026-09-06T01:00:00.000Z" },
  });
  assert.deepEqual(actionBody(orderedCases[0].steps[1], { type: "complete" }), {
    id: orderedCases[0].steps[1].id,
    expectedVersion: 7,
    action: { type: "complete" },
  });
});

test("semantic inquiry report keeps request problem and next action facts", async () => {
  const { buildInboxView } = await loadModel();
  const semantic = inquiryCase(orderedCases[0].id, {
    requestSummary: "예약한 애플박스 풀과 풀세트를 무인 반출하려는 문의입니다.",
    problemSummary: "현장에는 풀 하나만 있고 계약서도 확인되지 않았습니다.",
    nextActionSummary: "전화 안내 후 누락 장비와 계약서를 확인하세요.",
  });
  const model = buildInboxView({ payload: payload({ cases: [semantic], summary: { ...payload().summary, now: 1 } }), view: "now", category: null, selectedId: null, now });
  assert.equal(model.rows[0].requestSummary, semantic.requestSummary);
  assert.equal(model.rows[0].problemSummary, semantic.problemSummary);
  assert.equal(model.rows[0].nextActionSummary, semantic.nextActionSummary);
  assert.deepEqual(model.rows[0].previewLines, [
    { label: "요청", text: semantic.requestSummary },
    { label: "문제", text: semantic.problemSummary },
    { label: "할 일", text: semantic.nextActionSummary },
  ]);
});

test("case model rejects raw evidence, duplicate steps, malformed clocks, and unavailable payloads", async () => {
  const { buildInboxView, formatInquiryTiming } = await loadModel();
  for (const badPayload of [
    payload({ cases: [inquiryCase(orderedCases[0].id, { summary: "raw" })] }),
    payload({ cases: [inquiryCase(orderedCases[0].id, { totalStepCount: 4 })] }),
    payload({ cases: [inquiryCase(orderedCases[0].id, { steps: [orderedCases[0].steps[0], orderedCases[0].steps[0]], totalStepCount: 2, completedStepCount: 0 })] }),
  ]) assert.throws(() => buildInboxView({ payload: badPayload, view: "now", category: null, selectedId: null, now }), /payload invalid/);
  assert.throws(() => formatInquiryTiming("infinity", now), /payload invalid/);
  assert.throws(() => buildInboxView({ payload: null, view: "now", category: null, selectedId: null, now }), /inbox unavailable/);
});

test("FollowUpView is a semantic inquiry report with mobile detail dismissal", () => {
  const source = readFileSync(viewPath, "utf8");
  for (const label of [
    "지금 할 일", "미뤄둔 일", "완료", "예약·스케줄", "견적·가격", "정산·서류",
    "고객 응대", "운영·예외", "고객 요청", "현재 문제", "처리할 일", "접수 정보", "닫기",
  ]) assert.equal(source.includes(label), true, `missing ${label}`);
  for (const rawPresentation of [
    "item.summary", "item.recommendedAction", "직원이 정리한 내용", "권장 처리",
    "confirmation_request", "automation_error_review",
  ]) assert.equal(source.includes(rawPresentation), false, `raw presentation remains: ${rawPresentation}`);
  assert.match(source, /caseItem\.receivedLabel/);
  assert.match(source, /caseItem\.ageLabel/);
  assert.match(source, /caseItem\.steps\.map/);
  assert.match(source, /lg:grid-cols-\[minmax\(320px,0\.9fr\)_minmax\(420px,1\.1fr\)\]/);
  assert.match(source, /absolute inset-x-0 bottom-0/);
  assert.match(source, /aria-label="상세 배경 닫기"/);
  assert.match(source, /keydown/);
  assert.match(source, /Escape/);
  assert.match(source, /document\.body\.style\.overflow/);
  assert.match(source, /onPointerDown/);
  assert.match(source, /onPointerUp/);
  assert.match(source, /onAction\(stepItem, \{ type: "complete" \}\)/);
  assert.match(source, /setMobileDetailOpen\(false\)[\s\S]*?setNotice\("완료 처리했습니다\."\)/);
});
