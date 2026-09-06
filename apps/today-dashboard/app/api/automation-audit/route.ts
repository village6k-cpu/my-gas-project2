import { NextRequest, NextResponse } from 'next/server';
import { getAuthedUser } from '@/lib/server/authCache';

const EVENT_FIELDS = [
  'event_key', 'job_id', 'room_revision', 'operation_id', 'receipt_id', 'occurred_at', 'recorded_at',
  'effect_type', 'action_type', 'outcome', 'customer_label', 'target_type', 'target_id', 'summary',
  'change_items', 'outbound_text', 'evidence', 'source_message_at', 'historical_import'
] as const;
const QUERY_FIELDS = new Set(['range', 'from', 'to', 'effect', 'outcome', 'search', 'limit', 'after']);
const EFFECT_TYPES = new Set(['auto_reply', 'confirmation_request', 'registered_reservation_change', 'document_send']);
const ACTION_TYPES = new Set(['send', 'create', 'update', 'add', 'remove', 'replace', 'quantity_change', 'date_time_change']);
const OUTCOMES = new Set(['success', 'partial_success', 'failed', 'blocked', 'no_action']);
const TARGET_TYPES = new Set(['room', 'request', 'trade', 'document']);
const CHANGE_FIELDS = new Set(['equipment', 'quantity', 'start_at', 'end_at', 'tax_mode', 'document']);
const PHONE_PATTERN = /01[016789][ -]?[0-9]{3,4}[ -]?[0-9]{4}/i;
const SECRET_PATTERN = /(bearer\s+[a-z0-9._~-]+|(?:token|secret|password|apikey|api[ _-]?key)\s*[:=])/i;
const BANK_ACCOUNT_PATTERN = /(?:계좌|은행|account)(?:번호)?[^0-9\r\n]{0,20}[0-9][0-9 -]{7,}[0-9]/i;
const EVENT_KEY_PATTERN = /^kakao:(auto_reply|confirmation_request|registered_reservation_change|document_send):[0-9a-f]{64}$/;
const UTC_MS = /^(?!0000)[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/;
const CURSOR_KEYS = ['occurredAt', 'eventKey'];
const STATUS_KEYS = ['singleton', 'pending_count', 'conflict_count', 'oldest_pending_at', 'last_success_at', 'updated_at'];

class QueryError extends Error {}

function containsPrivateText(value: string): boolean {
  return PHONE_PATTERN.test(value) || SECRET_PATTERN.test(value) || BANK_ACCOUNT_PATTERN.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value: unknown, expected: readonly string[]): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function canonicalTimestamp(value: unknown, nullable = false): string | null {
  if (nullable && value === null) return null;
  if (typeof value !== 'string' || !UTC_MS.test(value)) throw new Error('audit response invalid');
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== value) throw new Error('audit response invalid');
  return value;
}

function normalizeDatabaseTimestamp(value: unknown, nullable = false): string | null {
  if (nullable && value === null) return null;
  if (typeof value !== 'string' || !value || value.length > 100) throw new Error('audit response invalid');
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new Error('audit response invalid');
  return parsed.toISOString();
}

function safeText(value: unknown, max: number, nullable = false): string | null {
  if (nullable && value === null) return null;
  if (typeof value !== 'string' || !value || value.length > max || containsPrivateText(value)) {
    throw new Error('audit response invalid');
  }
  return value;
}

function safeIdentifier(value: unknown, max: number, nullable = false): string | null {
  if (nullable && value === null) return null;
  if (typeof value !== 'string' || !value || value.length > max || value !== value.trim()
    || containsPrivateText(value)) {
    throw new Error('audit response invalid');
  }
  return value;
}

function normalizeChangeItems(value: unknown) {
  if (!Array.isArray(value) || value.length > 20) throw new Error('audit response invalid');
  return value.map((item) => {
    if (!exactKeys(item, ['field', 'before', 'after']) || !CHANGE_FIELDS.has(String(item.field))) {
      throw new Error('audit response invalid');
    }
    const before = safeText(item.before, 1000, true);
    const after = safeText(item.after, 1000, true);
    if (before === null && after === null) throw new Error('audit response invalid');
    return { field: item.field, before, after };
  });
}

function normalizeEvidence(value: unknown) {
  if (!isRecord(value)) throw new Error('audit response invalid');
  const allowed = new Set(['schema', 'status', 'readback', 'applied_stages', 'attempted_stage', 'error_type']);
  if (Object.keys(value).some((key) => !allowed.has(key))
    || typeof value.schema !== 'string' || !value.schema || value.schema.length > 160
    || typeof value.status !== 'string' || !value.status || value.status.length > 80
    || typeof value.readback !== 'boolean') throw new Error('audit response invalid');
  const result: Record<string, unknown> = {
    schema: value.schema,
    status: value.status,
    readback: value.readback
  };
  if (value.applied_stages !== undefined) {
    if (!Array.isArray(value.applied_stages) || value.applied_stages.length > 20
      || value.applied_stages.some((stage) => typeof stage !== 'string' || !stage || stage.length > 120)) {
      throw new Error('audit response invalid');
    }
    result.applied_stages = value.applied_stages;
  }
  for (const key of ['attempted_stage', 'error_type']) {
    if (value[key] !== undefined) {
      if (typeof value[key] !== 'string' || !value[key] || value[key].length > 120) throw new Error('audit response invalid');
      result[key] = value[key];
    }
  }
  if (containsPrivateText(JSON.stringify(result))) throw new Error('audit response invalid');
  return result;
}

function normalizeRow(value: unknown) {
  if (!exactKeys(value, EVENT_FIELDS)
    || typeof value.event_key !== 'string' || !EVENT_KEY_PATTERN.test(value.event_key)
    || !Number.isSafeInteger(value.room_revision) || Number(value.room_revision) <= 0
    || !EFFECT_TYPES.has(String(value.effect_type))
    || !ACTION_TYPES.has(String(value.action_type))
    || !OUTCOMES.has(String(value.outcome))
    || !TARGET_TYPES.has(String(value.target_type))
    || typeof value.historical_import !== 'boolean') throw new Error('audit response invalid');
  const eventKey = value.event_key;
  if (!eventKey.startsWith(`kakao:${String(value.effect_type)}:`)) throw new Error('audit response invalid');
  return {
    eventKey,
    jobId: safeIdentifier(value.job_id, 160),
    roomRevision: value.room_revision,
    operationId: safeIdentifier(value.operation_id, 160, true),
    receiptId: safeIdentifier(value.receipt_id, 200, true),
    occurredAt: normalizeDatabaseTimestamp(value.occurred_at),
    recordedAt: normalizeDatabaseTimestamp(value.recorded_at),
    effectType: value.effect_type,
    actionType: value.action_type,
    outcome: value.outcome,
    customerLabel: safeText(value.customer_label, 120),
    targetType: value.target_type,
    targetId: safeIdentifier(value.target_id, 160, true),
    summary: safeText(value.summary, 500),
    changeItems: normalizeChangeItems(value.change_items),
    outboundText: safeText(value.outbound_text, 2000, true),
    evidence: normalizeEvidence(value.evidence),
    sourceMessageAt: normalizeDatabaseTimestamp(value.source_message_at, true),
    historicalImport: value.historical_import
  };
}

function decodeCursor(value: string | null) {
  if (value === null) return null;
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(value) || value.length > 1000) throw new Error();
    const bytes = Buffer.from(value, 'base64url');
    if (bytes.length > 750 || bytes.toString('base64url') !== value) throw new Error();
    const parsed = JSON.parse(bytes.toString('utf8'));
    if (!exactKeys(parsed, CURSOR_KEYS)
      || typeof parsed.eventKey !== 'string' || !EVENT_KEY_PATTERN.test(parsed.eventKey)) throw new Error();
    return { occurredAt: canonicalTimestamp(parsed.occurredAt), eventKey: parsed.eventKey };
  } catch {
    throw new QueryError('invalid cursor');
  }
}

function encodeCursor(value: { occurredAt: string; eventKey: string } | null) {
  if (value === null) return null;
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function seoulTodayRange(nowMs = Date.now()) {
  const localDate = new Date(nowMs + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const fromMs = Date.parse(`${localDate}T00:00:00+09:00`);
  return {
    from: new Date(fromMs).toISOString(),
    to: new Date(fromMs + 24 * 60 * 60 * 1000).toISOString()
  };
}

function parseQuery(url: URL) {
  for (const [key] of url.searchParams) {
    if (!QUERY_FIELDS.has(key) || url.searchParams.getAll(key).length !== 1) throw new QueryError('invalid query');
  }
  const range = url.searchParams.get('range') || 'today';
  if (!['today', '7d', 'custom'].includes(range)) throw new QueryError('invalid range');
  const rawFrom = url.searchParams.get('from');
  const rawTo = url.searchParams.get('to');
  let from: string;
  let to: string;
  if (range === 'custom') {
    try {
      from = canonicalTimestamp(rawFrom) as string;
      to = canonicalTimestamp(rawTo) as string;
    } catch {
      throw new QueryError('invalid custom range');
    }
    const span = Date.parse(to) - Date.parse(from);
    if (span <= 0 || span > 31 * 24 * 60 * 60 * 1000) throw new QueryError('invalid custom range');
  } else {
    if (rawFrom !== null || rawTo !== null) throw new QueryError('unexpected custom range');
    if (range === 'today') ({ from, to } = seoulTodayRange());
    else {
      const nowMs = Date.now();
      from = new Date(nowMs - 7 * 24 * 60 * 60 * 1000).toISOString();
      to = new Date(nowMs + 1).toISOString();
    }
  }
  const effect = url.searchParams.get('effect');
  const outcome = url.searchParams.get('outcome');
  if (effect !== null && !EFFECT_TYPES.has(effect)) throw new QueryError('invalid effect');
  if (outcome !== null && !OUTCOMES.has(outcome)) throw new QueryError('invalid outcome');
  const rawSearch = url.searchParams.get('search');
  const search = rawSearch === null ? null : rawSearch.trim();
  if (search !== null && (!search || search.length > 120 || containsPrivateText(search)
    || !/^[\p{L}\p{N} _.-]+$/u.test(search))) throw new QueryError('invalid search');
  const rawLimit = url.searchParams.get('limit');
  const limit = rawLimit === null ? 50 : Number(rawLimit);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || (rawLimit !== null && String(limit) !== rawLimit)) {
    throw new QueryError('invalid limit');
  }
  return { range, from, to, effect, outcome, search, limit, after: decodeCursor(url.searchParams.get('after')) };
}

async function supabaseFetch(baseUrl: string, serviceKey: string, pathAndQuery: string) {
  const response = await fetch(`${baseUrl.replace(/\/$/, '')}/rest/v1/${pathAndQuery}`, {
    method: 'GET',
    signal: AbortSignal.timeout(15_000),
    headers: {
      apikey: serviceKey,
      authorization: `Bearer ${serviceKey}`,
      'content-type': 'application/json'
    }
  });
  const text = await response.text();
  let data: unknown = null;
  if (text) {
    try { data = JSON.parse(text); } catch { throw new Error('audit response invalid'); }
  }
  if (!response.ok) throw new Error(`audit database rejected request with HTTP ${response.status}`);
  return data;
}

function validateProjectionStatus(value: unknown) {
  if (!Array.isArray(value) || value.length !== 1 || !exactKeys(value[0], STATUS_KEYS)) {
    throw new Error('audit status invalid');
  }
  const status = value[0];
  if (status.singleton !== true
    || !Number.isSafeInteger(status.pending_count) || Number(status.pending_count) < 0
    || !Number.isSafeInteger(status.conflict_count) || Number(status.conflict_count) < 0) {
    throw new Error('audit status invalid');
  }
  normalizeDatabaseTimestamp(status.oldest_pending_at, true);
  normalizeDatabaseTimestamp(status.last_success_at, true);
  normalizeDatabaseTimestamp(status.updated_at);
  return { delayed: Number(status.pending_count) > 0 || Number(status.conflict_count) > 0 };
}

export async function GET(req: NextRequest) {
  const user = await getAuthedUser(req);
  if (!user) return NextResponse.json({ error: '인증 필요' }, { status: 401 });

  let query;
  try {
    query = parseQuery(req.nextUrl);
  } catch (error) {
    if (error instanceof QueryError) return NextResponse.json({ error: '잘못된 조회 조건입니다' }, { status: 400 });
    return NextResponse.json({ error: '잘못된 조회 조건입니다' }, { status: 400 });
  }

  const baseUrl = String(process.env.NEXT_PUBLIC_SUPABASE_URL || '').trim();
  const serviceKey = String(process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
  if (!baseUrl || !serviceKey) {
    return NextResponse.json({ error: '자동처리 기록을 불러오지 못했습니다' }, { status: 503 });
  }

  try {
    const params = new URLSearchParams();
    params.set('select', EVENT_FIELDS.join(','));
    params.set('occurred_at', `gte.${query.from}`);
    params.append('occurred_at', `lt.${query.to}`);
    if (query.effect) params.set('effect_type', `eq.${query.effect}`);
    if (query.outcome) params.set('outcome', `eq.${query.outcome}`);
    if (query.search) params.set('or', `(customer_label.ilike.*${query.search}*,target_id.ilike.*${query.search}*)`);
    if (query.after) {
      params.append('or', `(occurred_at.lt.${query.after.occurredAt},and(occurred_at.eq.${query.after.occurredAt},event_key.lt.${query.after.eventKey}))`);
    }
    params.set('order', 'occurred_at.desc,event_key.desc');
    params.set('limit', String(query.limit + 1));
    const rawRows = await supabaseFetch(baseUrl, serviceKey, `kakao_automation_audit_events?${params.toString()}`);
    if (!Array.isArray(rawRows) || rawRows.length > query.limit + 1) throw new Error('audit response invalid');
    const rows = rawRows.map(normalizeRow);
    const items = rows.slice(0, query.limit);
    const last = items.at(-1);
    const nextCursor = rows.length > query.limit && last
      ? encodeCursor({ occurredAt: last.occurredAt as string, eventKey: last.eventKey })
      : null;

    const statusSelect = STATUS_KEYS.join(',');
    const rawStatus = await supabaseFetch(
      baseUrl,
      serviceKey,
      `kakao_automation_audit_projection_status?select=${encodeURIComponent(statusSelect)}&singleton=eq.true&limit=1`
    );
    const sync = validateProjectionStatus(rawStatus);
    return NextResponse.json({
      ok: true,
      source: 'kakao_automation_audit_events',
      items,
      nextCursor,
      sync
    });
  } catch {
    return NextResponse.json({ error: '자동처리 기록을 불러오지 못했습니다' }, { status: 503 });
  }
}
