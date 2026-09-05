const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const UTC_MS = /^(?!0000)[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const VIEWS = new Set(["now", "snoozed", "completed"]);
const PRIORITIES = new Set(["p0", "urgent", "normal", "low"]);
const STATES = new Set(["open", "in_progress", "snoozed", "resolved", "dismissed"]);
const TAXONOMY = Object.freeze({
  reservation_review: ["schedule", "예약 확인"],
  schedule_check: ["schedule", "스케줄 확인"],
  schedule_register: ["schedule", "스케줄 등록"],
  schedule_change: ["schedule", "스케줄 변경"],
  return_extension: ["schedule", "반납·연장"],
  quote_send: ["quote", "견적서 발송"],
  price_review: ["quote", "가격·할인 확인"],
  payment_check: ["settlement", "입금·결제 확인"],
  tax_invoice: ["settlement", "세금계산서 발행"],
  contract_document: ["settlement", "계약·서류 처리"],
  reply_needed: ["customer", "고객 답변 필요"],
  human_review: ["operations", "기타 사람 확인"],
  damage_repair: ["operations", "파손·수리"],
  sheet_duplicate_check: ["operations", "중복 확인"],
});
const CATEGORY_DEFS = Object.freeze([
  ["schedule", "예약·스케줄"],
  ["quote", "견적·가격"],
  ["settlement", "정산·서류"],
  ["customer", "고객 응대"],
  ["operations", "운영·예외"],
]);
const CATEGORY_KEYS = new Set(CATEGORY_DEFS.map(([key]) => key));
const ITEM_KEYS = [
  "category", "dueAt", "firstOpenedAt", "id", "priority", "recommendedAction", "snoozedUntil",
  "state", "summary", "title", "updatedAt", "version", "workType", "workTypeLabel",
];

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

function safeItem(value, { view, category, now }) {
  if (!exactKeys(value, ITEM_KEYS)
    || typeof value.id !== "string" || !UUID.test(value.id)
    || !Number.isSafeInteger(value.version) || value.version < 1
    || typeof value.workType !== "string" || !Object.hasOwn(TAXONOMY, value.workType)
    || TAXONOMY[value.workType][0] !== value.category || TAXONOMY[value.workType][1] !== value.workTypeLabel
    || !PRIORITIES.has(value.priority) || !STATES.has(value.state)
    || typeof value.title !== "string" || !value.title || value.title.length > 300 || value.title !== value.title.trim()
    || typeof value.summary !== "string" || value.summary.length > 2000
    || typeof value.recommendedAction !== "string" || value.recommendedAction.length > 1200) throw invalidPayload();
  const dueAt = timestamp(value.dueAt, { nullable: true });
  const snoozedUntil = timestamp(value.snoozedUntil, { nullable: true });
  timestamp(value.firstOpenedAt);
  timestamp(value.updatedAt);
  if (category !== null && value.category !== category) throw invalidPayload();
  if (view === "now" && !new Set(["open", "in_progress", "snoozed"]).has(value.state)) throw invalidPayload();
  if (view === "snoozed" && !(value.state === "snoozed" && snoozedUntil !== null)) throw invalidPayload();
  if (view === "completed" && !new Set(["resolved", "dismissed"]).has(value.state)) throw invalidPayload();
  return { ...value, dueAt, snoozedUntil };
}

function safeSummary(value) {
  if (!exactKeys(value, ["byCategory", "completed", "now", "p0", "snoozed"])
    || !exactKeys(value.byCategory, CATEGORY_DEFS.map(([key]) => key))) throw invalidPayload();
  const counts = [value.now, value.snoozed, value.completed, value.p0, ...Object.values(value.byCategory)];
  if (counts.some((count) => !safeInteger(count)) || value.p0 > value.now
    || Object.values(value.byCategory).reduce((sum, count) => sum + count, 0) !== value.now + value.snoozed) throw invalidPayload();
  return value;
}

export function buildInboxView({ payload, view, category, selectedId, now } = {}) {
  if (payload === null || payload === undefined) throw new Error("Heybilli inbox unavailable");
  const currentNow = timestamp(now);
  if (!VIEWS.has(view) || category !== null && !CATEGORY_KEYS.has(category)
    || selectedId !== null && (typeof selectedId !== "string" || !UUID.test(selectedId))
    || !exactKeys(payload, ["items", "nextCursor", "ok", "omittedCount", "source", "summary"])
    || payload.ok !== true || payload.source !== "work_items_v2"
    || !Array.isArray(payload.items) || payload.items.length > 200
    || !safeInteger(payload.omittedCount)
    || !(payload.nextCursor === null || typeof payload.nextCursor === "string"
      && payload.nextCursor.length > 0 && payload.nextCursor.length <= 1000 && BASE64URL.test(payload.nextCursor))) throw invalidPayload();
  if ((payload.omittedCount > 0) !== (payload.nextCursor !== null)) throw invalidPayload();
  const summary = safeSummary(payload.summary);
  const rows = payload.items.map((entry) => safeItem(entry, { view, category, now: currentNow }));
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
