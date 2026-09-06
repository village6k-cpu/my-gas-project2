const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const UTC_MS = /^(?!0000)[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const VIEWS = new Set(["now", "snoozed", "completed"]);
const PRIORITIES = new Set(["p0", "urgent", "normal", "low"]);
const STATES = new Set(["open", "in_progress", "snoozed", "resolved", "dismissed"]);
const CATEGORY_DEFS = Object.freeze([
  ["schedule", "예약·스케줄"],
  ["quote", "견적·가격"],
  ["settlement", "정산·서류"],
  ["customer", "고객 응대"],
  ["operations", "운영·예외"],
]);
const CATEGORY_KEYS = new Set(CATEGORY_DEFS.map(([key]) => key));
const CASE_KEYS = [
  "categories", "completedStepCount", "id", "nextActionSummary", "ownerBrief", "priority", "problemSummary", "receivedAt", "requestSummary", "state",
  "steps", "title", "totalStepCount", "updatedAt",
];
const STEP_KEYS = [
  "category", "dueAt", "id", "priority", "snoozedUntil", "state", "taskLabel",
  "updatedAt", "version", "workTypeLabel",
];
const UNSAFE_OWNER_TEXT = /(01[016789][ -]?[0-9]{3,4}[ -]?[0-9]{4}|rq-[0-9]|confirmation_request|automation[_ ]?error|timeout|exception|stack|payload|raw log)/i;
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

function invalidPayload() {
  return new Error("Heybilli inbox payload invalid");
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, expected) {
  if (!isRecord(value)) return false;
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  return actual.length === sorted.length && actual.every((key, index) => key === sorted[index]);
}

function timestamp(value, { nullable = false } = {}) {
  if (value === null && nullable) return null;
  if (typeof value !== "string" || !UTC_MS.test(value)) throw invalidPayload();
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== value) throw invalidPayload();
  return value;
}

function safeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function kstParts(timestampMs) {
  const shifted = new Date(timestampMs + KST_OFFSET_MS);
  return {
    year: shifted.getUTCFullYear(), month: shifted.getUTCMonth() + 1, day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(), minute: shifted.getUTCMinutes(),
  };
}

export function formatInquiryTiming(receivedAt, now) {
  const received = timestamp(receivedAt);
  const current = timestamp(now);
  const receivedMs = Date.parse(received);
  const nowMs = Date.parse(current);
  if (receivedMs > nowMs) throw invalidPayload();
  const receivedParts = kstParts(receivedMs);
  const nowParts = kstParts(nowMs);
  const receivedDay = Date.UTC(receivedParts.year, receivedParts.month - 1, receivedParts.day);
  const currentDay = Date.UTC(nowParts.year, nowParts.month - 1, nowParts.day);
  const ageDays = Math.floor((currentDay - receivedDay) / DAY_MS);
  const ageLabel = ageDays === 0 ? "오늘 문의" : ageDays === 1 ? "어제 문의" : `${ageDays}일 전`;
  return {
    receivedLabel: `접수 ${receivedParts.month}/${receivedParts.day} ${String(receivedParts.hour).padStart(2, "0")}:${String(receivedParts.minute).padStart(2, "0")}`,
    ageLabel,
  };
}

function safeStep(value) {
  if (!exactKeys(value, STEP_KEYS)
    || typeof value.id !== "string" || !UUID.test(value.id)
    || !Number.isSafeInteger(value.version) || value.version < 1
    || !CATEGORY_KEYS.has(value.category) || !PRIORITIES.has(value.priority) || !STATES.has(value.state)
    || typeof value.workTypeLabel !== "string" || !value.workTypeLabel || value.workTypeLabel.length > 40
    || typeof value.taskLabel !== "string" || !value.taskLabel || value.taskLabel !== value.taskLabel.trim()
    || value.taskLabel.length > 80 || UNSAFE_OWNER_TEXT.test(value.taskLabel)) throw invalidPayload();
  return {
    ...value,
    dueAt: timestamp(value.dueAt, { nullable: true }),
    snoozedUntil: timestamp(value.snoozedUntil, { nullable: true }),
    updatedAt: timestamp(value.updatedAt),
  };
}

function safeCase(value, { view, category, now }) {
  if (!exactKeys(value, CASE_KEYS)
    || typeof value.id !== "string" || !UUID.test(value.id)
    || value.state !== view || !VIEWS.has(value.state) || !PRIORITIES.has(value.priority)
    || typeof value.title !== "string" || !value.title || value.title !== value.title.trim() || value.title.length > 120
    || typeof value.ownerBrief !== "string" || !value.ownerBrief || value.ownerBrief !== value.ownerBrief.trim()
    || value.ownerBrief.length > 160
    || typeof value.requestSummary !== "string" || !value.requestSummary || value.requestSummary !== value.requestSummary.trim() || value.requestSummary.length > 500
    || typeof value.problemSummary !== "string" || !value.problemSummary || value.problemSummary !== value.problemSummary.trim() || value.problemSummary.length > 500
    || typeof value.nextActionSummary !== "string" || !value.nextActionSummary || value.nextActionSummary !== value.nextActionSummary.trim() || value.nextActionSummary.length > 500
    || [value.title, value.ownerBrief, value.requestSummary, value.problemSummary, value.nextActionSummary].some((text) => UNSAFE_OWNER_TEXT.test(text))
    || !Array.isArray(value.categories) || value.categories.length < 1 || value.categories.length > CATEGORY_KEYS.size
    || new Set(value.categories).size !== value.categories.length
    || value.categories.some((entry) => !CATEGORY_KEYS.has(entry))
    || category !== null && !value.categories.includes(category)
    || !Array.isArray(value.steps) || value.steps.length < 1 || value.steps.length > 200
    || !safeInteger(value.completedStepCount) || !safeInteger(value.totalStepCount)
    || value.totalStepCount !== value.steps.length || value.completedStepCount > value.totalStepCount) throw invalidPayload();
  const receivedAt = timestamp(value.receivedAt);
  const updatedAt = timestamp(value.updatedAt);
  if (Date.parse(receivedAt) > Date.parse(updatedAt)) throw invalidPayload();
  const steps = value.steps.map(safeStep);
  if (new Set(steps.map(({ id }) => id)).size !== steps.length
    || steps.some((entry) => !value.categories.includes(entry.category))
    || steps.filter((entry) => ["resolved", "dismissed"].includes(entry.state)).length !== value.completedStepCount) throw invalidPayload();
  const nowMs = Date.parse(now);
  const hasNow = steps.some((entry) => ["open", "in_progress"].includes(entry.state)
    || entry.state === "snoozed" && entry.snoozedUntil !== null && Date.parse(entry.snoozedUntil) <= nowMs);
  const hasFutureSnooze = steps.some((entry) => entry.state === "snoozed"
    && entry.snoozedUntil !== null && Date.parse(entry.snoozedUntil) > nowMs);
  const allCompleted = steps.every((entry) => ["resolved", "dismissed"].includes(entry.state));
  if (view === "now" && !hasNow || view === "snoozed" && (hasNow || !hasFutureSnooze)
    || view === "completed" && !allCompleted) throw invalidPayload();
  return {
    ...value,
    receivedAt,
    updatedAt,
    steps,
    previewLines: [
      { label: "요청", text: value.requestSummary },
      { label: "문제", text: value.problemSummary },
      { label: "할 일", text: value.nextActionSummary },
    ],
    ...formatInquiryTiming(receivedAt, now),
    progressLabel: `${value.completedStepCount}/${value.totalStepCount} 완료`,
  };
}

function safeSummary(value) {
  if (!exactKeys(value, ["byCategory", "completed", "now", "p0", "snoozed"])
    || !exactKeys(value.byCategory, CATEGORY_DEFS.map(([key]) => key))) throw invalidPayload();
  const counts = [value.now, value.snoozed, value.completed, value.p0, ...Object.values(value.byCategory)];
  const activeCases = value.now + value.snoozed;
  if (counts.some((count) => !safeInteger(count)) || value.p0 > value.now
    || Object.values(value.byCategory).some((count) => count > activeCases)) throw invalidPayload();
  return value;
}

export function buildInboxView({ payload, view, category, selectedId, now } = {}) {
  if (payload === null || payload === undefined) throw new Error("Heybilli inbox unavailable");
  const currentNow = timestamp(now);
  if (!VIEWS.has(view) || category !== null && !CATEGORY_KEYS.has(category)
    || selectedId !== null && (typeof selectedId !== "string" || !UUID.test(selectedId))
    || !exactKeys(payload, ["cases", "nextCursor", "ok", "omittedCount", "source", "summary"])
    || payload.ok !== true || payload.source !== "work_items_v2_cases"
    || !Array.isArray(payload.cases) || payload.cases.length > 200
    || !safeInteger(payload.omittedCount)
    || !(payload.nextCursor === null || typeof payload.nextCursor === "string"
      && payload.nextCursor.length > 0 && payload.nextCursor.length <= 1000 && BASE64URL.test(payload.nextCursor))) throw invalidPayload();
  if ((payload.omittedCount > 0) !== (payload.nextCursor !== null)) throw invalidPayload();
  const summary = safeSummary(payload.summary);
  const rows = payload.cases.map((entry) => safeCase(entry, { view, category, now: currentNow }));
  if (new Set(rows.map(({ id }) => id)).size !== rows.length) throw invalidPayload();
  const selected = rows.find(({ id }) => id === selectedId) || rows[0] || null;
  const emptyLabel = category === null
    ? { now: "지금 할 일이 없습니다", snoozed: "미뤄둔 일이 없습니다", completed: "완료한 일이 없습니다" }[view]
    : "이 업무 분류에는 표시할 일이 없습니다";
  return {
    tabs: [
      { key: "now", label: "지금 할 일", count: summary.now },
      { key: "snoozed", label: "미뤄둔 일", count: summary.snoozed },
      { key: "completed", label: "완료", count: summary.completed },
    ],
    categories: CATEGORY_DEFS.map(([key, label]) => ({ key, label, count: summary.byCategory[key] })),
    rows,
    selected,
    emptyLabel,
  };
}

export function actionBody(item, action) {
  if (!isRecord(item) || typeof item.id !== "string" || !UUID.test(item.id)
    || !Number.isSafeInteger(item.version) || item.version < 1 || !isRecord(action)
    || typeof action.type !== "string") throw new Error("Heybilli work action invalid");
  const expected = action.type === "snooze" ? ["snoozedUntil", "type"] : ["type"];
  if (!exactKeys(action, expected)
    || !["progress", "snooze", "ack_p0", "request_resolve", "dismiss"].includes(action.type)) {
    throw new Error("Heybilli work action invalid");
  }
  if (action.type === "snooze") {
    try { timestamp(action.snoozedUntil); } catch { throw new Error("Heybilli work action invalid"); }
  }
  return { id: item.id, expectedVersion: item.version, action: structuredClone(action) };
}
