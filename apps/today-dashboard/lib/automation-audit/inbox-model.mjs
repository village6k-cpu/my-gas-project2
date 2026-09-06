const EVENT_KEYS = [
  'actionType', 'changeItems', 'customerLabel', 'effectType', 'eventKey', 'evidence',
  'historicalImport', 'jobId', 'occurredAt', 'operationId', 'outboundText', 'outcome',
  'receiptId', 'recordedAt', 'roomRevision', 'sourceMessageAt', 'summary', 'targetId', 'targetType',
];
const PAYLOAD_KEYS = ['items', 'nextCursor', 'ok', 'source', 'sync'];
const EVENT_KEY = /^kakao:(auto_reply|confirmation_request|registered_reservation_change|document_send):[0-9a-f]{64}$/;
const UTC_MS = /^(?!0000)[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/;
const DATE = /^(?!0000)([0-9]{4})-([0-9]{2})-([0-9]{2})$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const PHONE = /01[016789][ -]?[0-9]{3,4}[ -]?[0-9]{4}/i;
const SECRET = /(bearer\s+[a-z0-9._~-]+|(?:token|secret|password|apikey|api[ _-]?key)\s*[:=])/i;
const BANK_ACCOUNT = /(?:계좌|은행|account)(?:번호)?[^0-9\r\n]{0,20}[0-9][0-9 -]{7,}[0-9]/i;
const EFFECTS = new Set(['auto_reply', 'confirmation_request', 'registered_reservation_change', 'document_send']);
const ACTIONS = new Set(['send', 'create', 'update', 'add', 'remove', 'replace', 'quantity_change', 'date_time_change']);
const OUTCOMES = new Set(['success', 'partial_success', 'failed', 'blocked', 'no_action']);
const TARGETS = new Set(['room', 'request', 'trade', 'document']);
const CHANGE_FIELDS = new Set(['equipment', 'quantity', 'start_at', 'end_at', 'tax_mode', 'document']);
const EVIDENCE_KEYS = new Set(['schema', 'status', 'readback', 'applied_stages', 'attempted_stage', 'error_type']);
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

const EFFECT_LABELS = Object.freeze({
  auto_reply: '자동응대',
  confirmation_request: '확인요청',
  registered_reservation_change: '등록 예약 변경',
  document_send: '견적·서류 발송',
});
const ACTION_LABELS = Object.freeze({
  send: '발송', create: '생성', update: '수정', add: '추가', remove: '삭제', replace: '교체',
  quantity_change: '수량 변경', date_time_change: '날짜·시간 변경',
});
const OUTCOME_PRESENTATION = Object.freeze({
  success: ['완료', '✓'],
  partial_success: ['일부 완료', '!'],
  failed: ['실패', '×'],
  blocked: ['차단', '⊘'],
  no_action: ['처리 없음', '—'],
});
const CHANGE_LABELS = Object.freeze({
  equipment: '장비', quantity: '수량', start_at: '시작', end_at: '종료', tax_mode: '세금', document: '문서',
});

export const AUDIT_FILTERS = Object.freeze({
  ranges: Object.freeze([
    Object.freeze({ value: 'today', label: '오늘' }),
    Object.freeze({ value: '7d', label: '7일' }),
    Object.freeze({ value: 'custom', label: '기간 지정' }),
  ]),
  effects: Object.freeze([
    Object.freeze({ value: '', label: '전체 처리' }),
    ...Object.entries(EFFECT_LABELS).map(([value, label]) => Object.freeze({ value, label })),
  ]),
  outcomes: Object.freeze([
    Object.freeze({ value: '', label: '전체 결과' }),
    Object.freeze({ value: 'success', label: '완료' }),
    Object.freeze({ value: 'partial_success', label: '일부 완료' }),
    Object.freeze({ value: 'failed', label: '실패' }),
    Object.freeze({ value: 'blocked', label: '차단' }),
  ]),
});

function invalidPayload() {
  return new Error('automation audit payload invalid');
}

function invalidFilter() {
  return new Error('automation audit filter invalid');
}

function containsPrivateText(value) {
  return PHONE.test(value) || SECRET.test(value) || BANK_ACCOUNT.test(value);
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value, expected) {
  if (!isRecord(value)) return false;
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function timestamp(value, nullable = false) {
  if (nullable && value === null) return null;
  if (typeof value !== 'string' || !UTC_MS.test(value)) throw invalidPayload();
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== value) throw invalidPayload();
  return value;
}

function safeText(value, max, nullable = false) {
  if (nullable && value === null) return null;
  if (typeof value !== 'string' || !value || value !== value.trim() || value.length > max
    || containsPrivateText(value)) throw invalidPayload();
  return value;
}

function safeIdentifier(value, max, nullable = false) {
  if (nullable && value === null) return null;
  if (typeof value !== 'string' || !value || value !== value.trim() || value.length > max
    || containsPrivateText(value)) throw invalidPayload();
  return value;
}

function safeChangeItems(value) {
  if (!Array.isArray(value) || value.length > 20) throw invalidPayload();
  return value.map((entry) => {
    if (!exactKeys(entry, ['after', 'before', 'field']) || !CHANGE_FIELDS.has(entry.field)) throw invalidPayload();
    const before = safeText(entry.before, 1000, true);
    const after = safeText(entry.after, 1000, true);
    if (before === null && after === null) throw invalidPayload();
    return { field: entry.field, before, after };
  });
}

function safeEvidence(value) {
  if (!isRecord(value) || Object.keys(value).some((key) => !EVIDENCE_KEYS.has(key))
    || typeof value.schema !== 'string' || !value.schema || value.schema.length > 160
    || typeof value.status !== 'string' || !value.status || value.status.length > 80
    || typeof value.readback !== 'boolean') throw invalidPayload();
  const evidence = { schema: value.schema, status: value.status, readback: value.readback };
  if (value.applied_stages !== undefined) {
    if (!Array.isArray(value.applied_stages) || value.applied_stages.length > 20
      || value.applied_stages.some((stage) => typeof stage !== 'string' || !stage || stage.length > 120)) throw invalidPayload();
    evidence.applied_stages = [...value.applied_stages];
  }
  for (const key of ['attempted_stage', 'error_type']) {
    if (value[key] !== undefined) evidence[key] = safeIdentifier(value[key], 120);
  }
  if (containsPrivateText(JSON.stringify(evidence))) throw invalidPayload();
  return evidence;
}

function formatKst(value) {
  const shifted = new Date(Date.parse(value) + KST_OFFSET_MS);
  return `${shifted.getUTCMonth() + 1}/${shifted.getUTCDate()} ${String(shifted.getUTCHours()).padStart(2, '0')}:${String(shifted.getUTCMinutes()).padStart(2, '0')}`;
}

function safeItem(value) {
  if (!exactKeys(value, EVENT_KEYS)
    || typeof value.eventKey !== 'string' || !EVENT_KEY.test(value.eventKey)
    || !Number.isSafeInteger(value.roomRevision) || value.roomRevision < 1
    || !EFFECTS.has(value.effectType) || !ACTIONS.has(value.actionType)
    || !OUTCOMES.has(value.outcome) || !TARGETS.has(value.targetType)
    || typeof value.historicalImport !== 'boolean') throw invalidPayload();
  if (!value.eventKey.startsWith(`kakao:${value.effectType}:`)) throw invalidPayload();
  const occurredAt = timestamp(value.occurredAt);
  const recordedAt = timestamp(value.recordedAt);
  if (Date.parse(recordedAt) < Date.parse(occurredAt)) throw invalidPayload();
  const customerLabel = safeText(value.customerLabel, 120);
  const summary = safeText(value.summary, 500);
  const changes = safeChangeItems(value.changeItems);
  const [outcomeLabel, outcomeIcon] = OUTCOME_PRESENTATION[value.outcome];
  return {
    eventKey: value.eventKey,
    jobId: safeIdentifier(value.jobId, 160),
    roomRevision: value.roomRevision,
    operationId: safeIdentifier(value.operationId, 160, true),
    receiptId: safeIdentifier(value.receiptId, 200, true),
    occurredAt,
    recordedAt,
    effectType: value.effectType,
    actionType: value.actionType,
    outcome: value.outcome,
    customerLabel,
    targetType: value.targetType,
    targetId: safeIdentifier(value.targetId, 160, true),
    summary,
    changeItems: changes,
    outboundText: safeText(value.outboundText, 2000, true),
    evidence: safeEvidence(value.evidence),
    sourceMessageAt: timestamp(value.sourceMessageAt, true),
    historicalImport: value.historicalImport,
    occurredLabel: formatKst(occurredAt),
    effectLabel: EFFECT_LABELS[value.effectType],
    actionLabel: ACTION_LABELS[value.actionType],
    outcomeLabel,
    outcomeIcon,
    ownerLine: `${customerLabel} · ${summary}`,
    changeLines: changes.map(({ field, before, after }) => `${CHANGE_LABELS[field]}: ${before ?? '없음'} → ${after ?? '없음'}`),
  };
}

export function buildAutomationAuditView({ payload, selectedEventKey = null, range = 'today' } = {}) {
  if (!exactKeys(payload, PAYLOAD_KEYS) || payload.ok !== true || payload.source !== 'kakao_automation_audit_events'
    || !Array.isArray(payload.items) || payload.items.length > 500
    || !exactKeys(payload.sync, ['delayed']) || typeof payload.sync.delayed !== 'boolean'
    || !(payload.nextCursor === null || typeof payload.nextCursor === 'string' && payload.nextCursor.length <= 1000
      && BASE64URL.test(payload.nextCursor))
    || !(selectedEventKey === null || typeof selectedEventKey === 'string' && EVENT_KEY.test(selectedEventKey))
    || !['today', '7d', 'custom'].includes(range)) throw invalidPayload();
  const rows = payload.items.map(safeItem);
  if (new Set(rows.map(({ eventKey }) => eventKey)).size !== rows.length) throw invalidPayload();
  return {
    rows,
    selected: rows.find(({ eventKey }) => eventKey === selectedEventKey) || rows[0] || null,
    nextCursor: payload.nextCursor,
    syncDelayed: payload.sync.delayed,
    emptyLabel: range === 'today' ? '오늘 자동처리 기록이 없습니다'
      : range === '7d' ? '최근 7일 자동처리 기록이 없습니다' : '선택한 기간의 자동처리 기록이 없습니다',
  };
}

function parseLocalDate(value) {
  if (typeof value !== 'string' || !DATE.test(value)) throw invalidFilter();
  const timestampMs = Date.parse(`${value}T00:00:00+09:00`);
  if (!Number.isFinite(timestampMs)) throw invalidFilter();
  const roundTrip = new Date(timestampMs + KST_OFFSET_MS).toISOString().slice(0, 10);
  if (roundTrip !== value) throw invalidFilter();
  return timestampMs;
}

export function buildAutomationAuditQuery({
  range, customFrom, customTo, effect = '', outcome = '', search = '', limit = 50, after = null,
} = {}) {
  if (!['today', '7d', 'custom'].includes(range) || !['', ...EFFECTS].includes(effect)
    || !['', 'success', 'partial_success', 'failed', 'blocked'].includes(outcome)
    || typeof search !== 'string' || search !== search.trim() || search.length > 120
    || containsPrivateText(search) || !Number.isSafeInteger(limit) || limit < 1 || limit > 100
    || !(after === null || typeof after === 'string' && after.length <= 1000 && BASE64URL.test(after))) throw invalidFilter();
  if (search && !/^[\p{L}\p{N} _.-]+$/u.test(search)) throw invalidFilter();
  const params = new URLSearchParams({ range });
  if (range === 'custom') {
    const fromMs = parseLocalDate(customFrom);
    const toMs = parseLocalDate(customTo) + DAY_MS;
    if (toMs <= fromMs || toMs - fromMs > 31 * DAY_MS) throw invalidFilter();
    params.set('from', new Date(fromMs).toISOString());
    params.set('to', new Date(toMs).toISOString());
  } else if (customFrom !== undefined || customTo !== undefined) throw invalidFilter();
  if (effect) params.set('effect', effect);
  if (outcome) params.set('outcome', outcome);
  if (search) params.set('search', search);
  params.set('limit', String(limit));
  if (after) params.set('after', after);
  return params.toString();
}
