import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const routePath = path.join(appRoot, 'app/api/automation-audit/route.ts');
const EVENT_KEY = `kakao:confirmation_request:${'a'.repeat(64)}`;

function response(data, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() { return JSON.stringify(data); }
  };
}

function row(overrides = {}) {
  return {
    event_key: EVENT_KEY,
    job_id: 'job-audit-route',
    room_revision: 3,
    operation_id: 'operation-audit-route',
    receipt_id: 'receipt-audit-route',
    occurred_at: '2026-09-07T01:00:00.000Z',
    recorded_at: '2026-09-07T01:00:01.000Z',
    effect_type: 'confirmation_request',
    action_type: 'create',
    outcome: 'success',
    customer_label: '테스트 고객',
    target_type: 'request',
    target_id: 'RQ-260907-001',
    summary: '확인요청 RQ-260907-001을 생성했습니다.',
    change_items: [{ field: 'equipment', before: null, after: '소니 FX3 바디세트 1개' }],
    outbound_text: null,
    evidence: { schema: 'village-confirmation-receipt/v1', status: 'ok', readback: true },
    source_message_at: '2026-09-07T00:59:00.000Z',
    historical_import: false,
    ...overrides
  };
}

function loadRoute({ authed = true, serviceKey = 'service-role-key', anonKey = 'anon-key', fetchImpl = async () => response([]) } = {}) {
  const source = readFileSync(routePath, 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    fileName: routePath
  }).outputText;
  const module = { exports: {} };
  const responseJson = (body, init = {}) => ({
    status: init.status || 200,
    body,
    async json() { return body; }
  });
  const context = {
    module,
    exports: module.exports,
    process: {
      env: {
        NEXT_PUBLIC_SUPABASE_URL: 'https://unit.test',
        NEXT_PUBLIC_SUPABASE_ANON_KEY: anonKey,
        SUPABASE_SERVICE_ROLE_KEY: serviceKey
      }
    },
    require(specifier) {
      if (specifier === 'next/server') return { NextResponse: { json: responseJson } };
      if (specifier === '@/lib/server/authCache') {
        return { getAuthedUser: async () => authed ? { id: 'owner-user' } : null };
      }
      throw new Error(`unexpected import: ${specifier}`);
    },
    fetch: fetchImpl,
    AbortSignal: { timeout: (milliseconds) => ({ milliseconds }) },
    URL,
    URLSearchParams,
    encodeURIComponent,
    decodeURIComponent,
    Array,
    Object,
    Set,
    String,
    Number,
    Math,
    JSON,
    Date,
    RegExp,
    Error,
    Promise,
    Buffer
  };
  vm.runInNewContext(compiled, context, { filename: routePath });
  return { exports: module.exports, source };
}

function request(query = 'range=today') {
  return { nextUrl: new URL(`https://dashboard.test/api/automation-audit?${query}`) };
}

async function body(result) {
  return JSON.parse(JSON.stringify(await result.json()));
}

test('automation audit GET authenticates before config or database access', async () => {
  let fetchCalls = 0;
  const { exports: { GET } } = loadRoute({
    authed: false,
    serviceKey: '',
    fetchImpl: async () => { fetchCalls += 1; throw new Error('must not fetch'); }
  });
  const result = await GET(request());
  assert.equal(result.status, 401);
  assert.deepEqual(await body(result), { error: '인증 필요' });
  assert.equal(fetchCalls, 0);
});

test('automation audit GET requires service role and never falls back to anon', async () => {
  let fetchCalls = 0;
  const { exports: { GET } } = loadRoute({
    serviceKey: '',
    anonKey: 'must-never-be-used',
    fetchImpl: async () => { fetchCalls += 1; throw new Error('must not fetch'); }
  });
  const result = await GET(request());
  assert.equal(result.status, 503);
  assert.deepEqual(await body(result), { error: '자동처리 기록을 불러오지 못했습니다' });
  assert.equal(fetchCalls, 0);
});

test('automation audit GET returns a fixed newest-first DTO and content-free sync delay', async () => {
  const calls = [];
  const rows = [
    row(),
    row({
      event_key: `kakao:auto_reply:${'b'.repeat(64)}`,
      job_id: 'job-audit-route-2', operation_id: null,
      receipt_id: `reply-readback-${'c'.repeat(64)}`,
      occurred_at: '2026-09-07T00:30:00.000Z',
      effect_type: 'auto_reply', action_type: 'send', target_type: 'room', target_id: null,
      summary: '카카오 답변을 전송했습니다.', change_items: [], outbound_text: '네, 가능합니다.',
      evidence: { schema: 'kakao-auto-reply-readback/v1', status: 'sent', readback: true }
    }),
    row({
      event_key: `kakao:document_send:${'d'.repeat(64)}`,
      job_id: 'job-audit-route-3', occurred_at: '2026-09-06T23:00:00.000Z',
      effect_type: 'document_send', action_type: 'send', target_type: 'document', target_id: '260907-001'
    })
  ];
  const { exports: { GET } } = loadRoute({ fetchImpl: async (url, init) => {
    calls.push({ url, init });
    return calls.length === 1
      ? response(rows)
      : response([{
        singleton: true, pending_count: 2, conflict_count: 0,
        oldest_pending_at: '2026-09-07T00:00:00.000Z',
        last_success_at: '2026-09-07T01:00:00.000Z', updated_at: '2026-09-07T01:01:00.000Z'
      }]);
  } });

  const result = await GET(request('range=today&effect=reservation_registration&outcome=success&search=RQ-260907-001&limit=2'));
  const value = await body(result);
  assert.equal(result.status, 200);
  assert.deepEqual(Object.keys(value).sort(), ['items', 'nextCursor', 'ok', 'source', 'sync'].sort());
  assert.equal(value.ok, true);
  assert.equal(value.source, 'kakao_automation_audit_events');
  assert.equal(value.items.length, 2);
  assert.deepEqual(Object.keys(value.items[0]).sort(), [
    'actionType', 'changeItems', 'customerLabel', 'effectType', 'eventKey', 'evidence',
    'historicalImport', 'jobId', 'occurredAt', 'operationId', 'outboundText', 'outcome',
    'receiptId', 'recordedAt', 'roomRevision', 'sourceMessageAt', 'summary', 'targetId', 'targetType'
  ].sort());
  assert.deepEqual(value.sync, { delayed: true });
  assert.equal(typeof value.nextCursor, 'string');
  const cursor = JSON.parse(Buffer.from(value.nextCursor, 'base64url').toString('utf8'));
  assert.deepEqual(cursor, { occurredAt: rows[1].occurred_at, eventKey: rows[1].event_key });

  assert.equal(calls.length, 2);
  assert.match(calls[0].url, /kakao_automation_audit_events\?/);
  assert.match(calls[0].url, /order=occurred_at\.desc%2Cevent_key\.desc|order=occurred_at.desc%2Cevent_key.desc/);
  assert.match(calls[0].url, /limit=3/);
  assert.match(decodeURIComponent(calls[0].url), /effect_type=eq\.reservation_registration/);
  assert.match(decodeURIComponent(calls[0].url), /outcome=eq\.success/);
  assert.doesNotMatch(calls[0].url, /work_items_v2|ai_follow_up_items/);
  assert.equal(calls[0].init.headers.apikey, 'service-role-key');
  assert.equal(calls[0].init.headers.authorization, 'Bearer service-role-key');
  assert.equal(calls[0].init.signal.milliseconds, 15_000);
  assert.match(calls[1].url, /kakao_automation_audit_projection_status/);
});

test('automation audit GET validates every query and canonical cursor before fetching', async () => {
  const invalidQueries = [
    'range=month',
    'range=today&from=2026-09-01T00%3A00%3A00.000Z',
    'range=custom',
    'range=custom&from=bad&to=2026-09-02T00%3A00%3A00.000Z',
    'range=custom&from=2026-09-03T00%3A00%3A00.000Z&to=2026-09-02T00%3A00%3A00.000Z',
    'range=today&effect=unknown',
    'range=today&outcome=unknown',
    'range=today&search=010-1234-5678',
    'range=today&search=*',
    'range=today&limit=0',
    'range=today&limit=101',
    'range=today&after=not-base64url!',
    'range=today&extra=1',
    'range=today&range=7d'
  ];
  for (const query of invalidQueries) {
    let fetchCalls = 0;
    const { exports: { GET } } = loadRoute({ fetchImpl: async () => { fetchCalls += 1; return response([]); } });
    const result = await GET(request(query));
    assert.equal(result.status, 400, query);
    assert.deepEqual(await body(result), { error: '잘못된 조회 조건입니다' }, query);
    assert.equal(fetchCalls, 0, query);
  }
});

test('automation audit GET accepts a bounded custom UTC range and exact cursor', async () => {
  const cursor = Buffer.from(JSON.stringify({
    occurredAt: '2026-09-02T01:00:00.000Z',
    eventKey: `kakao:auto_reply:${'f'.repeat(64)}`
  }), 'utf8').toString('base64url');
  const calls = [];
  const { exports: { GET } } = loadRoute({ fetchImpl: async (url, init) => {
    calls.push({ url, init });
    return calls.length === 1
      ? response([])
      : response([{
        singleton: true, pending_count: 0, conflict_count: 0,
        oldest_pending_at: null, last_success_at: null, updated_at: '2026-09-07T01:01:00.000Z'
      }]);
  } });
  const result = await GET(request(`range=custom&from=2026-09-01T00%3A00%3A00.000Z&to=2026-09-03T00%3A00%3A00.000Z&after=${cursor}`));
  assert.equal(result.status, 200);
  assert.deepEqual(await body(result), {
    ok: true, source: 'kakao_automation_audit_events', items: [], nextCursor: null,
    sync: { delayed: false }
  });
  const decoded = decodeURIComponent(calls[0].url);
  assert.match(decoded, /occurred_at=gte\.2026-09-01T00:00:00.000Z/);
  assert.match(decoded, /occurred_at=lt\.2026-09-03T00:00:00.000Z/);
  assert.match(decoded, /event_key\.lt\.kakao:auto_reply:/);
});

test('automation audit GET rejects malformed or private upstream rows', async () => {
  for (const malformed of [
    { ...row(), private_payload: 'must-not-leak' },
    { ...row(), customer_label: '010-1234-5678' },
    { ...row(), target_id: '010-1234-5678' },
    { ...row(), summary: 'token=private-value' },
    { ...row(), outbound_text: '우리은행 1005-404-109661로 보내주세요' },
    { ...row(), evidence: { schema: 'x', status: 'ok', readback: true, raw: 'private' } },
    { ...row(), change_items: [{ field: 'unsupported', before: null, after: 'x' }] }
  ]) {
    let calls = 0;
    const { exports: { GET } } = loadRoute({ fetchImpl: async () => {
      calls += 1;
      return response(calls === 1 ? [malformed] : [{
        singleton: true,
        pending_count: 0,
        conflict_count: 0,
        oldest_pending_at: null,
        last_success_at: null,
        updated_at: '2026-09-07T01:01:00.000Z'
      }]);
    } });
    const result = await GET(request());
    assert.equal(result.status, 503);
    assert.deepEqual(await body(result), { error: '자동처리 기록을 불러오지 못했습니다' });
    assert.equal(JSON.stringify(await body(result)).includes('must-not-leak'), false);
  }
});

test('automation audit route is GET-only and contains no task or business mutation endpoint', () => {
  const { exports, source } = loadRoute();
  assert.equal(typeof exports.GET, 'function');
  for (const method of ['POST', 'PATCH', 'PUT', 'DELETE']) assert.equal(exports[method], undefined);
  assert.doesNotMatch(source, /work_items_v2|ai_follow_up_items|complete|snooze|reopen|acknowledge/i);
});

test('automation audit route preserves bounded quantity and document change fields', async () => {
  let calls = 0;
  const quantity = row({ change_items: [
    { field: 'quantity', before: '1', after: '2' },
    { field: 'document', before: '견적서', after: '계약서' },
  ] });
  const { exports: { GET } } = loadRoute({ fetchImpl: async () => {
    calls += 1;
    return calls === 1 ? response([quantity]) : response([{
      singleton: true, pending_count: 0, conflict_count: 0, oldest_pending_at: null,
      last_success_at: null, updated_at: '2026-09-07T01:01:00.000Z'
    }]);
  } });
  const result = await GET(request());
  assert.equal(result.status, 200);
  assert.deepEqual((await body(result)).items[0].changeItems, quantity.change_items);
});
