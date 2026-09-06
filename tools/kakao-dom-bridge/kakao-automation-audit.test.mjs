import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import {
  buildKakaoAutomationAuditEvents,
  createKakaoAutomationAuditStore,
  normalizeKakaoAutomationAuditEvent
} from './kakao-automation-audit.mjs';

const JOB_ID = 'job-audit-1';
const ROOM_KEY = 'room-audit-1';
const ROOM_REVISION = 7;
const LEASE_ID = '11111111-1111-4111-8111-111111111111';
const DIGEST = 'a'.repeat(64);
const CONFIRMATION_OPERATION = '11111111-2222-4333-8444-555555555555';
const REGISTERED_OPERATION = '22222222-3333-4444-8555-666666666666';
const DOCUMENT_OPERATION = '33333333-4444-4555-8666-777777777777';

function baseJob({ tool = 'confirmation_request', operationId = CONFIRMATION_OPERATION, receipt } = {}) {
  return {
    schema: 'village-hermes-gateway-job/v1',
    job_id: JOB_ID,
    room_key: ROOM_KEY,
    room_revision: ROOM_REVISION,
    event: {
      schema: 'village-kakao-gateway-event/v1',
      job_id: JOB_ID,
      room_key: ROOM_KEY,
      room_revision: ROOM_REVISION,
      detected_at: '2026-09-07T01:00:00.000Z'
    },
    local_context: { job: { customerName: '테스트 고객' } },
    tool_operation: receipt === undefined ? null : {
      schema: 'village-tool-operation-reservation/v1',
      tool,
      job_id: JOB_ID,
      room_key: ROOM_KEY,
      room_revision: ROOM_REVISION,
      lease_id: LEASE_ID,
      request_digest: DIGEST,
      operation_id: operationId,
      state: 'completed',
      receipt_id: receipt.receipt_id,
      created_at: '2026-09-07T01:00:01.000Z',
      completed_at: '2026-09-07T01:00:03.000Z'
    },
    tool_receipts: receipt === undefined ? [] : [{
      ...receipt,
      job_id: JOB_ID,
      room_key: ROOM_KEY,
      room_revision: ROOM_REVISION,
      lease_id: LEASE_ID,
      request_digest: DIGEST,
      operation_id: operationId,
      created_at: '2026-09-07T01:00:02.000Z'
    }],
    application: null
  };
}

function confirmationReceipt(overrides = {}) {
  return {
    schema: 'village-confirmation-receipt/v1',
    receipt_id: 'receipt-confirmation-1',
    status: 'ok',
    availability_report: [],
    authoritative_sheet_result: {
      success: true,
      reqID: 'RQ-260907-001',
      replacedReqIDs: ['RQ-260906-009'],
      staff_confirmed_pending_mutation: {
        target_scope: 'pending_request',
        target_request_id: 'RQ-260906-009',
        expected_before: [{ name: '소니 FX3 바디세트', quantity: 1 }],
        replacement_request_id: 'RQ-260907-001',
        final_plan: [{ name: '소니 FX3 바디세트', quantity: 1 }, { name: '강풍기', quantity: 1 }]
      }
    },
    error: null,
    ...overrides
  };
}

function registeredReceipt(overrides = {}) {
  return {
    schema: 'village-registered-reservation-change-receipt/v1',
    receipt_id: 'receipt-registered-1',
    status: 'ok',
    target_scope: 'registered_trade',
    trade_id: '260907-001',
    mutation_kind: 'equipment_add',
    authorized_mutation: {
      confirmed: true,
      kind: 'equipment_add',
      target_scope: 'registered_trade',
      request_id: 'RQ-260906-009',
      trade_id: '260907-001',
      source_evidence: { customer_request: 'ignored', staff_confirmation: 'ignored', conversation_revision: ROOM_REVISION },
      expected_period: { start_date: '2026-09-07', start_time: '07:30', end_date: '2026-09-07', end_time: '19:30' },
      expected_before: [],
      desired_after: [{ name: '강풍기', quantity: 1 }],
      date_change: null
    },
    authoritative_result: {
      before: { contract: { startDate: '2026-09-07', startTime: '07:30', endDate: '2026-09-07', endTime: '19:30' } },
      after: { contract: { startDate: '2026-09-07', startTime: '07:30', endDate: '2026-09-07', endTime: '19:30' } },
      requestFinalization: { requestId: 'RQ-260906-009', tradeId: '260907-001', status: '등록완료(기존거래 보강)' }
    },
    applied_stages: ['scheduleCorrectRegisteredTrade', 'contractRegeneration'],
    attempted_stage: null,
    customer_reply: 'no_reply',
    error: null,
    ...overrides
  };
}

function documentReceipt(overrides = {}) {
  return {
    schema: 'village-document-receipt/v1',
    receipt_id: 'receipt-document-1',
    status: 'ok',
    document_type: 'quote',
    trade_id: '260907-001',
    tax_mode: 'supply_only',
    authoritative_document_result: { status: 'OK', tradeID: '260907-001', taxMode: 'supply_only' },
    error: null,
    ...overrides
  };
}

function replyProof(overrides = {}) {
  const text = '네, 가능합니다.';
  return {
    schema: 'kakao-auto-reply-readback/v1',
    receipt_id: `reply-readback-${'d'.repeat(64)}`,
    confirmed_at: '2026-09-07T01:00:04.000Z',
    text,
    text_sha256: createHash('sha256').update(text).digest('hex'),
    readback_confirmed: true,
    customer_label: '테스트 고객',
    source_message_at: '2026-09-07T01:00:00.000Z',
    ...overrides
  };
}

test('trusted confirmation replacement maps to one immutable owner-readable audit event', () => {
  const events = buildKakaoAutomationAuditEvents({
    durableJob: baseJob({ receipt: confirmationReceipt() })
  });
  assert.equal(events.length, 1);
  assert.deepEqual(events[0], {
    event_key: 'kakao:confirmation_request:5fd4827c69cbe65df515cebd7da4ee3d26d999b2f5bfed753238ae9895187111',
    job_id: JOB_ID,
    room_revision: ROOM_REVISION,
    operation_id: CONFIRMATION_OPERATION,
    receipt_id: 'receipt-confirmation-1',
    occurred_at: '2026-09-07T01:00:03.000Z',
    effect_type: 'confirmation_request',
    action_type: 'update',
    outcome: 'success',
    customer_label: '테스트 고객',
    target_type: 'request',
    target_id: 'RQ-260907-001',
    summary: '확인요청 RQ-260907-001을 수정했습니다.',
    change_items: [{ field: 'equipment', before: '소니 FX3 바디세트 1개', after: '소니 FX3 바디세트 1개, 강풍기 1개' }],
    outbound_text: null,
    evidence: { schema: 'village-confirmation-receipt/v1', status: 'ok', readback: true },
    source_message_at: '2026-09-07T01:00:00.000Z',
    historical_import: false
  });
});

test('trusted registered mutation and document send preserve typed action and authoritative target', () => {
  const registered = buildKakaoAutomationAuditEvents({
    durableJob: baseJob({ tool: 'registered_reservation_change', operationId: REGISTERED_OPERATION, receipt: registeredReceipt() })
  });
  assert.deepEqual(registered[0], {
    event_key: 'kakao:registered_reservation_change:279afaa7f6f36828c5df4741c49553d5157f1477a3ff0853320ff99dc2360412',
    job_id: JOB_ID,
    room_revision: ROOM_REVISION,
    operation_id: REGISTERED_OPERATION,
    receipt_id: 'receipt-registered-1',
    occurred_at: '2026-09-07T01:00:03.000Z',
    effect_type: 'registered_reservation_change',
    action_type: 'add',
    outcome: 'success',
    customer_label: '테스트 고객',
    target_type: 'trade',
    target_id: '260907-001',
    summary: '등록예약 260907-001에 장비를 추가했습니다.',
    change_items: [{ field: 'equipment', before: null, after: '강풍기 1개' }],
    outbound_text: null,
    evidence: { schema: 'village-registered-reservation-change-receipt/v1', status: 'ok', readback: true, applied_stages: ['scheduleCorrectRegisteredTrade', 'contractRegeneration'] },
    source_message_at: '2026-09-07T01:00:00.000Z',
    historical_import: false
  });

  const document = buildKakaoAutomationAuditEvents({
    durableJob: baseJob({ tool: 'document_send', operationId: DOCUMENT_OPERATION, receipt: documentReceipt() })
  });
  assert.equal(document[0].event_key, 'kakao:document_send:9a91a28c6554fb313e49d5ef741cd7d5582f0b9b88a0ed6b73d3779507f48c33');
  assert.equal(document[0].summary, '견적서 260907-001을 전송했습니다.');
  assert.deepEqual(document[0].change_items, [{ field: 'tax_mode', before: null, after: 'supply_only' }]);
  assert.deepEqual(document[0].evidence, { schema: 'village-document-receipt/v1', status: 'ok', readback: true });
});

test('one tool effect plus one persisted DOM reply readback produces two distinct events', () => {
  const durableJob = baseJob({ receipt: confirmationReceipt({ authoritative_sheet_result: { success: true, reqID: 'RQ-260907-002' } }) });
  durableJob.application = { state: 'applied', applied_audit: { auto_reply_readback: replyProof() } };
  const events = buildKakaoAutomationAuditEvents({ durableJob });
  assert.equal(events.length, 2);
  assert.equal(events[1].event_key, 'kakao:auto_reply:6985dacff8dba40745bcb6dceeb7947a2770785376c507667134dc6b0a1a3c70');
  assert.deepEqual(events[1], {
    event_key: 'kakao:auto_reply:6985dacff8dba40745bcb6dceeb7947a2770785376c507667134dc6b0a1a3c70',
    job_id: JOB_ID,
    room_revision: ROOM_REVISION,
    operation_id: null,
    receipt_id: `reply-readback-${'d'.repeat(64)}`,
    occurred_at: '2026-09-07T01:00:04.000Z',
    effect_type: 'auto_reply',
    action_type: 'send',
    outcome: 'success',
    customer_label: '테스트 고객',
    target_type: 'room',
    target_id: null,
    summary: '카카오 답변을 전송했습니다.',
    change_items: [],
    outbound_text: '네, 가능합니다.',
    evidence: { schema: 'kakao-auto-reply-readback/v1', status: 'sent', readback: true },
    source_message_at: '2026-09-07T01:00:00.000Z',
    historical_import: false
  });
});

test('partial and failed trusted receipts stay non-successful and retain only bounded failure evidence', () => {
  const partial = registeredReceipt({
    status: 'partial_success',
    attempted_stage: 'contractRegeneration',
    error: { type: 'contract_regeneration_failed', message: 'private detail must not be copied' }
  });
  const events = buildKakaoAutomationAuditEvents({
    durableJob: baseJob({ tool: 'registered_reservation_change', operationId: REGISTERED_OPERATION, receipt: partial })
  });
  assert.equal(events[0].outcome, 'partial_success');
  assert.match(events[0].summary, /부분 반영/);
  assert.deepEqual(events[0].evidence, {
    schema: 'village-registered-reservation-change-receipt/v1',
    status: 'partial_success',
    readback: true,
    applied_stages: ['scheduleCorrectRegisteredTrade', 'contractRegeneration'],
    attempted_stage: 'contractRegeneration',
    error_type: 'contract_regeneration_failed'
  });
  assert.equal(JSON.stringify(events).includes('private detail'), false);

  const failed = buildKakaoAutomationAuditEvents({
    durableJob: baseJob({ receipt: confirmationReceipt({ status: 'failed', authoritative_sheet_result: null, error: { type: 'invalid_decision', stack: 'private stack' } }) })
  });
  assert.equal(failed[0].outcome, 'failed');
  assert.equal(failed[0].target_id, null);
  assert.equal(JSON.stringify(failed).includes('private stack'), false);
});

test('untrusted, mismatched, unsafe, and oversized evidence never becomes an audit event', () => {
  const wrongRevision = baseJob({ receipt: confirmationReceipt() });
  wrongRevision.tool_receipts[0].room_revision = ROOM_REVISION - 1;
  assert.throws(() => buildKakaoAutomationAuditEvents({ durableJob: wrongRevision }), /trusted tool receipt set is invalid/);

  const extraReceipt = baseJob({ receipt: confirmationReceipt() });
  extraReceipt.tool_receipts.push({ ...extraReceipt.tool_receipts[0], receipt_id: 'fabricated' });
  assert.throws(() => buildKakaoAutomationAuditEvents({ durableJob: extraReceipt }), /trusted tool receipt set is invalid/);

  const unsafeCustomer = baseJob({ receipt: confirmationReceipt() });
  unsafeCustomer.local_context.job.customerName = '010-1234-5678';
  assert.deepEqual(buildKakaoAutomationAuditEvents({ durableJob: unsafeCustomer }), []);

  const badReply = baseJob();
  badReply.application = { state: 'applied', applied_audit: { auto_reply_readback: replyProof({ text_sha256: '0'.repeat(64) }) } };
  assert.deepEqual(buildKakaoAutomationAuditEvents({ durableJob: badReply }), []);

  assert.throws(() => normalizeKakaoAutomationAuditEvent({
    unexpected: true,
    event_key: `kakao:auto_reply:${'a'.repeat(64)}`
  }), /invalid audit event/);

  const safe = buildKakaoAutomationAuditEvents({ durableJob: baseJob({ receipt: confirmationReceipt() }) })[0];
  assert.throws(() => normalizeKakaoAutomationAuditEvent({
    ...safe,
    target_id: '010-1234-5678'
  }), /invalid audit event/);
  assert.throws(() => normalizeKakaoAutomationAuditEvent({
    ...safe,
    summary: 'token=private-value'
  }), /invalid audit event/);
  assert.throws(() => normalizeKakaoAutomationAuditEvent({
    ...safe,
    outbound_text: '우리은행 1005-404-109661로 보내주세요'
  }), /invalid audit event/);
});

test('historical imports preserve identity while marking only the import fact', () => {
  const current = buildKakaoAutomationAuditEvents({ durableJob: baseJob({ receipt: confirmationReceipt() }) });
  const historical = buildKakaoAutomationAuditEvents({ durableJob: baseJob({ receipt: confirmationReceipt() }), historicalImport: true });
  assert.equal(historical[0].event_key, current[0].event_key);
  assert.equal(historical[0].historical_import, true);
});

test('fixed audit contract accepts bounded quantity and document changes', () => {
  const base = buildKakaoAutomationAuditEvents({ durableJob: baseJob({ receipt: confirmationReceipt() }) })[0];
  for (const field of ['quantity', 'document']) {
    const normalized = normalizeKakaoAutomationAuditEvent({
      ...base,
      change_items: [{ field, before: '이전', after: '이후' }]
    });
    assert.deepEqual(normalized.change_items, [{ field, before: '이전', after: '이후' }]);
  }
});

function response(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() { return body === null ? '' : JSON.stringify(body); }
  };
}

test('audit store inserts idempotently then requires exact database readback', async () => {
  const event = buildKakaoAutomationAuditEvents({ durableJob: baseJob({ receipt: confirmationReceipt() }) })[0];
  const calls = [];
  const store = createKakaoAutomationAuditStore({
    supabaseUrl: 'https://supabase.test',
    serviceRoleKey: 'service-role-secret',
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      if (calls.length === 1) return response([event], 201);
      return response([{ ...event, recorded_at: '2026-09-07T01:00:05.000Z' }]);
    },
    timeoutMs: 7000
  });
  const result = await store.insertAndReadback([event]);
  assert.deepEqual(result, { inserted: 1, existing: 0, events: [event] });
  assert.equal(calls.length, 2);
  assert.match(calls[0].url, /kakao_automation_audit_events\?on_conflict=event_key$/);
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers.apikey, 'service-role-secret');
  assert.match(calls[0].init.headers.Prefer, /resolution=ignore-duplicates/);
  assert.match(calls[1].url, /event_key=in\./);

  const conflictingStore = createKakaoAutomationAuditStore({
    supabaseUrl: 'https://supabase.test', serviceRoleKey: 'service-role-secret',
    fetchImpl: async (_url, init) => init.method === 'POST'
      ? response([], 201)
      : response([{ ...event, summary: 'different immutable fact', recorded_at: '2026-09-07T01:00:05.000Z' }])
  });
  await assert.rejects(conflictingStore.insertAndReadback([event]), { code: 'automation_audit_projection_conflict' });
});

test('audit store records only content-free projection status and never falls back to anon credentials', async () => {
  assert.throws(() => createKakaoAutomationAuditStore({
    supabaseUrl: 'https://supabase.test', serviceRoleKey: ''
  }), /service role/i);
  const calls = [];
  const store = createKakaoAutomationAuditStore({
    supabaseUrl: 'https://supabase.test', serviceRoleKey: 'service-role-secret',
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return response([{
        singleton: true, pending_count: 2, conflict_count: 1,
        oldest_pending_at: '2026-09-07T00:00:00.000Z',
        last_success_at: '2026-09-07T01:00:00.000Z', updated_at: '2026-09-07T02:00:00.000Z'
      }]);
    }
  });
  const status = await store.recordProjectionStatus({
    pendingCount: 2, conflictCount: 1,
    oldestPendingAt: '2026-09-07T00:00:00.000Z',
    lastSuccessAt: '2026-09-07T01:00:00.000Z',
    updatedAt: '2026-09-07T02:00:00.000Z'
  });
  assert.equal(status.pending_count, 2);
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /kakao_automation_audit_projection_status\?singleton=eq.true$/);
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    pending_count: 2,
    conflict_count: 1,
    oldest_pending_at: '2026-09-07T00:00:00.000Z',
    last_success_at: '2026-09-07T01:00:00.000Z',
    updated_at: '2026-09-07T02:00:00.000Z'
  });
});
