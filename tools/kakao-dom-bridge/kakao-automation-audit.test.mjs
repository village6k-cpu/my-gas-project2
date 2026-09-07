import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { executeConfirmationBatch } from '../ai-browser-worker/confirmation-batch.mjs';
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
const REGISTRATION_OPERATION = '44444444-5555-4666-8777-888888888888';

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

function batchChild(index, overrides = {}) {
  return confirmationReceipt({
    receipt_id: `receipt-batch-child-${index}`,
    job_id: JOB_ID, room_key: ROOM_KEY, room_revision: ROOM_REVISION,
    created_at: '2026-09-07T01:00:02.000Z',
    authoritative_sheet_result: { success: true, reqID: `RQ-260907-00${index + 1}` },
    ...overrides
  });
}

function batchReceipt(children = [batchChild(0), batchChild(1)], { status = 'ok', unattemptedIndices = [] } = {}) {
  const requestResults = children.map((receipt, index) => ({
    index, status: receipt?.status ?? 'uncertain', receipt,
    ...(receipt ? { authoritative_sheet_result: receipt.authoritative_sheet_result } : { error: { code: 'confirmation_batch_execution_uncertain' } }),
    request_ids: receipt?.authoritative_sheet_result?.reqID ? [receipt.authoritative_sheet_result.reqID] : []
  }));
  const requestIds = requestResults.flatMap(result => result.request_ids);
  return confirmationReceipt({
    status,
    receipt_id: 'receipt-batch-parent',
    child_receipts: children.filter(Boolean), request_results: requestResults,
    request_ids: requestIds, unattempted_indices: unattemptedIndices,
    authoritative_sheet_result: {
      success: status === 'ok', batch: true,
      request_results: requestResults, request_ids: requestIds, unattempted_indices: unattemptedIndices,
      ...(requestIds.length ? { reqID: requestIds[0] } : {})
    }
  });
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

function confirmedRegistrationReceipt(overrides = {}) {
  const plan = [
    { name: '소니 FX3 바디세트', quantity: 1 },
    { name: '소니 GM 70-200mm II', quantity: 1 }
  ];
  const period = {
    start_date: '2026-09-07', start_time: '07:30',
    end_date: '2026-09-07', end_time: '19:30'
  };
  const components = [{
    set_item: '소니 FX3 바디세트',
    component_item: '소니 FX3 바디(케이지)',
    quantity: 1
  }];
  return {
    schema: 'village-confirmed-reservation-commit-receipt/v1',
    receipt_id: 'receipt-confirmed-registration-1',
    status: 'ok',
    target_scope: 'pending_request',
    request_id: 'RQ-260906-001',
    effective_request_id: 'RQ-260906-001',
    trade_id: '260906-001',
    authorized_registration: {
      confirmed: true,
      target_scope: 'pending_request',
      request_id: 'RQ-260906-001',
      source_evidence: {
        customer_request: 'not stored in audit',
        staff_confirmation: 'not stored in audit',
        conversation_revision: ROOM_REVISION
      },
      expected_before: plan,
      expected_set_components: components,
      set_component_selections: [],
      expected_period: period,
      desired_after: plan,
      desired_period: period
    },
    authoritative_result: {
      success: true,
      status: 'ok',
      request_id: 'RQ-260906-001',
      effective_request_id: 'RQ-260906-001',
      trade_id: '260906-001',
      final_plan: plan,
      final_set_components: components,
      final_period: period,
      authoritative: {
        registered: true,
        request: {
          reqID: 'RQ-260906-001',
          name: '테스트 고객', phone: '01011112222', discount: '일반', memo: '', extraRequest: '',
          startDate: period.start_date, startTime: period.start_time,
          endDate: period.end_date, endTime: period.end_time,
          topLevelEquipItems: plan.map(({ name, quantity }) => ({ name, qty: quantity })),
          setComponentItems: components,
          tradeIds: ['260906-001']
        },
        registered_trade: {
          schedule: {
            rows: components.map((entry, index) => ({
              scheduleId: `260906-001-${String(index + 2).padStart(2, '0')}`,
              setName: entry.set_item,
              name: entry.component_item,
              qty: entry.quantity,
              isComponent: true
            }))
          }
        }
      },
      customerNotificationAttempted: false,
      customerNotificationSent: false
    },
    applied_stages: ['registration', 'authoritative_readback'],
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

test('two period batch projects distinct stable events under the one durable operation and parent receipt', () => {
  const durableJob = baseJob({ receipt: batchReceipt() });
  const events = buildKakaoAutomationAuditEvents({ durableJob });
  assert.equal(events.length, 2);
  assert.deepEqual(events.map(event => event.target_id), ['RQ-260907-001', 'RQ-260907-002']);
  assert.deepEqual(events.map(event => event.outcome), ['success', 'success']);
  assert.deepEqual(events.map(event => event.operation_id), [CONFIRMATION_OPERATION, CONFIRMATION_OPERATION]);
  assert.deepEqual(events.map(event => event.receipt_id), ['receipt-batch-parent', 'receipt-batch-parent']);
  assert.notEqual(events[0].event_key, events[1].event_key);
  assert.deepEqual(events.map(event => event.evidence.attempted_stage), ['batch_child_0', 'batch_child_1']);
  assert.deepEqual(buildKakaoAutomationAuditEvents({ durableJob, historicalImport: true }).map(event => event.event_key), events.map(event => event.event_key));
  const single = buildKakaoAutomationAuditEvents({ durableJob: baseJob({ receipt: confirmationReceipt() }) });
  assert.notEqual(events[0].event_key, single[0].event_key);
});

test('batch failure retains successful first period and audits failed second without inventing unattempted effects', () => {
  const receipt = batchReceipt([
    batchChild(0), batchChild(1, { status: 'failed', authoritative_sheet_result: null, error: { code: 'gas_rejected', message: 'private customer detail' } })
  ], { status: 'partial_success', unattemptedIndices: [2] });
  const events = buildKakaoAutomationAuditEvents({ durableJob: baseJob({ receipt }) });
  assert.equal(events.length, 2);
  assert.deepEqual(events.map(event => event.outcome), ['success', 'failed']);
  assert.deepEqual(events.map(event => event.target_id), ['RQ-260907-001', null]);
  assert.equal(events[1].evidence.error_type, 'gas_rejected');
  assert.equal(JSON.stringify(events).includes('private customer detail'), false);
});

test('uncertain attempted batch child receives partial outcome and no fabricated target', () => {
  const receipt = batchReceipt([batchChild(0), null], { status: 'partial_success', unattemptedIndices: [2] });
  const events = buildKakaoAutomationAuditEvents({ durableJob: baseJob({ receipt }) });
  assert.equal(events.length, 2);
  assert.equal(events[1].outcome, 'partial_success');
  assert.equal(events[1].target_id, null);
  assert.equal(events[1].evidence.readback, false);
  assert.equal(events[1].evidence.error_type, 'confirmation_batch_execution_uncertain');
});

test('batch children must correlate to the authenticated parent job room and revision', () => {
  for (const override of [{ job_id: 'other-job' }, { room_key: 'other-room' }, { room_revision: 8 }, { schema: 'other-schema' }]) {
    const receipt = batchReceipt([batchChild(0), batchChild(1, override)]);
    assert.throws(() => buildKakaoAutomationAuditEvents({ durableJob: baseJob({ receipt }) }), /trusted tool receipt set is invalid/);
  }
});

test('batch projection rejects duplicate indices and contradictory copied child evidence', () => {
  const duplicateIndex = batchReceipt();
  duplicateIndex.request_results[1].index = 0;
  assert.throws(() => buildKakaoAutomationAuditEvents({ durableJob: baseJob({ receipt: duplicateIndex }) }), /trusted tool receipt set is invalid/);
  const contradictory = batchReceipt();
  contradictory.authoritative_sheet_result.request_results = structuredClone(contradictory.request_results);
  contradictory.authoritative_sheet_result.request_results[1].receipt.authoritative_sheet_result.reqID = 'RQ-260907-999';
  assert.throws(() => buildKakaoAutomationAuditEvents({ durableJob: baseJob({ receipt: contradictory }) }), /trusted tool receipt set is invalid/);
});

test('already registered trade reconciliation produces no-action trade audit without an RQ', () => {
  const reconciled = batchChild(0, { authoritative_sheet_result: { success: true, alreadyRegistered: true, duplicate: true, matchedRegisteredTradeId: '260907-001' } });
  const single = buildKakaoAutomationAuditEvents({ durableJob: baseJob({ receipt: reconciled }) });
  assert.equal(single[0].target_type, 'trade');
  assert.equal(single[0].target_id, '260907-001');
  assert.equal(single[0].outcome, 'no_action');
  assert.match(single[0].summary, /기존 등록 거래/);
  assert.equal(single[0].summary.includes('생성'), false);
  const events = buildKakaoAutomationAuditEvents({ durableJob: baseJob({ receipt: batchReceipt([reconciled, batchChild(1)]) }) });
  assert.deepEqual(events.map(event => event.target_type), ['trade', 'request']);
  assert.deepEqual(events.map(event => event.target_id), ['260907-001', 'RQ-260907-002']);
  assert.deepEqual(events.map(event => event.outcome), ['no_action', 'success']);
});

test('trade-only reconciliation requires successful evidence and one real consistent trade id', () => {
  for (const sheet of [
    { success: true, alreadyRegistered: true },
    { success: true, alreadyRegistered: true, matchedRegisteredTradeId: 'not-a-trade' },
    { success: true, alreadyRegistered: true, matchedRegisteredTradeId: '260907-001', tradeID: '260907-002' }
  ]) {
    assert.throws(() => buildKakaoAutomationAuditEvents({ durableJob: baseJob({ receipt: confirmationReceipt({ authoritative_sheet_result: sheet }) }) }), /trusted tool receipt set is invalid/);
  }
});

test('ordinary child no-action is represented without a failure or success claim', () => {
  const receipt = batchReceipt([batchChild(0), batchChild(1, { status: 'no_action', authoritative_sheet_result: null })], { status: 'partial_success', unattemptedIndices: [2] });
  const events = buildKakaoAutomationAuditEvents({ durableJob: baseJob({ receipt }) });
  assert.equal(events[1].outcome, 'no_action');
  assert.equal(events[1].summary.includes('실패'), false);
  assert.equal(events[1].target_id, null);
});

test('real batch executor receipts project successful and uncertain periods without replay or shape adaptation', async () => {
  const decision = { confirmation_requests: [1, 2, 3].map(day => ({
    should_write_to_sheet: true,
    sheet_row_candidate: { customer_name: 'Synthetic renter', phone: '', start_date: `2026-10-0${day}`, pickup_time: '09:00', end_date: `2026-10-0${day}`, return_time: '18:00' }
  })) };
  let executions = 0;
  const receipt = await executeConfirmationBatch({
    decision,
    validateDecision: () => ({ valid: true }),
    preflightDecision: async child => ({ ok: true, decision: child }),
    executeDecision: async (_child, index) => {
      executions += 1;
      if (index === 1) throw new Error('Synthetic lost response');
      return batchChild(index);
    },
    buildReceipt: ({ status, authoritativeSheetResult, availabilityReport, error }) => confirmationReceipt({
      job_id: JOB_ID, room_key: ROOM_KEY, room_revision: ROOM_REVISION,
      receipt_id: 'receipt-real-batch', created_at: '2026-09-07T01:00:02.000Z',
      status, authoritative_sheet_result: authoritativeSheetResult, availability_report: availabilityReport, error
    })
  });
  const events = buildKakaoAutomationAuditEvents({ durableJob: baseJob({ receipt }) });
  assert.equal(executions, 2);
  assert.deepEqual(receipt.unattempted_indices, [2]);
  assert.deepEqual(events.map(event => event.outcome), ['success', 'partial_success']);
  assert.deepEqual(events.map(event => event.target_id), ['RQ-260907-001', null]);
  assert.deepEqual(events.map(event => event.receipt_id), ['receipt-real-batch', 'receipt-real-batch']);
});

test('explicit uncertain evidence never becomes a successful audit from an ok child label', () => {
  const uncertain = batchChild(1, { authoritative_sheet_result: { success: true, reqID: 'RQ-260907-002', uncertainWrite: true } });
  const receipt = batchReceipt([batchChild(0), uncertain], { status: 'partial_success', unattemptedIndices: [2] });
  const events = buildKakaoAutomationAuditEvents({ durableJob: baseJob({ receipt }) });
  assert.equal(events[1].outcome, 'partial_success');
  assert.equal(events[1].evidence.readback, false);
  assert.equal(events[1].target_id, 'RQ-260907-002');
});

test('batch preflight failure with zero attempted children creates no fictional effect event', () => {
  const receipt = batchReceipt([], { status: 'failed', unattemptedIndices: [0, 1] });
  assert.deepEqual(buildKakaoAutomationAuditEvents({ durableJob: baseJob({ receipt }) }), []);
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

test('staff-authorized pending registration becomes one no-send owner-readable audit event', () => {
  const events = buildKakaoAutomationAuditEvents({
    durableJob: baseJob({
      tool: 'confirmed_reservation_commit',
      operationId: REGISTRATION_OPERATION,
      receipt: confirmedRegistrationReceipt()
    })
  });

  assert.equal(events.length, 1);
  assert.match(events[0].event_key, /^kakao:reservation_registration:[0-9a-f]{64}$/);
  assert.deepEqual(events[0], {
    ...events[0],
    job_id: JOB_ID,
    room_revision: ROOM_REVISION,
    operation_id: REGISTRATION_OPERATION,
    receipt_id: 'receipt-confirmed-registration-1',
    occurred_at: '2026-09-07T01:00:03.000Z',
    effect_type: 'reservation_registration',
    action_type: 'create',
    outcome: 'success',
    customer_label: '테스트 고객',
    target_type: 'trade',
    target_id: '260906-001',
    summary: '예약 260906-001을 등록했습니다.',
    change_items: [{
      field: 'equipment',
      before: '소니 FX3 바디세트 1개, 소니 GM 70-200mm II 1개',
      after: '소니 FX3 바디세트 1개, 소니 GM 70-200mm II 1개'
    }],
    outbound_text: null,
    evidence: {
      schema: 'village-confirmed-reservation-commit-receipt/v1',
      status: 'ok',
      readback: true,
      applied_stages: ['registration', 'authoritative_readback']
    },
    source_message_at: '2026-09-07T01:00:00.000Z',
    historical_import: false
  });
  assert.equal(JSON.stringify(events).includes('not stored in audit'), false);
});

test('a restarted registration with no persisted receipt remains visible once as an unresolved no-send audit event', () => {
  const durableJob = {
    ...baseJob(),
    state: 'failed',
    updated_at: '2026-09-07T01:00:05.000Z',
    human_review_required: true,
    error: {
      type: 'confirmation_operation_unresolved',
      operation_id: REGISTRATION_OPERATION,
      operation_state: 'reserved',
      reason: 'receipt_not_persisted'
    },
    tool_operation: {
      schema: 'village-tool-operation-reservation/v1',
      tool: 'confirmed_reservation_commit',
      job_id: JOB_ID,
      room_key: ROOM_KEY,
      room_revision: ROOM_REVISION,
      lease_id: LEASE_ID,
      request_digest: DIGEST,
      operation_id: REGISTRATION_OPERATION,
      state: 'reserved',
      receipt_id: null,
      created_at: '2026-09-07T01:00:01.000Z',
      completed_at: null,
      audit_target: {
        schema: 'village-kakao-tool-audit-target/v1',
        effect_type: 'reservation_registration',
        action_type: 'create',
        target_type: 'request',
        target_id: 'RQ-260907-001'
      }
    },
    tool_receipts: []
  };

  const events = buildKakaoAutomationAuditEvents({ durableJob });

  assert.equal(events.length, 1);
  assert.deepEqual(events[0], {
    event_key: `kakao:reservation_registration:${createHash('sha256')
      .update(`village-kakao-automation-audit/v1\nreservation_registration\n${REGISTRATION_OPERATION}`)
      .digest('hex')}`,
    job_id: JOB_ID,
    room_revision: ROOM_REVISION,
    operation_id: REGISTRATION_OPERATION,
    receipt_id: null,
    occurred_at: '2026-09-07T01:00:01.000Z',
    effect_type: 'reservation_registration',
    action_type: 'create',
    outcome: 'partial_success',
    customer_label: '테스트 고객',
    target_type: 'request',
    target_id: 'RQ-260907-001',
    summary: '예약 RQ-260907-001 자동처리 결과를 확인해야 합니다.',
    change_items: [],
    outbound_text: null,
    evidence: {
      schema: 'village-confirmed-reservation-commit-receipt/v1',
      status: 'unresolved',
      readback: false,
      attempted_stage: 'receipt_persistence',
      error_type: 'confirmation_operation_unresolved'
    },
    source_message_at: '2026-09-07T01:00:00.000Z',
    historical_import: false
  });
  assert.equal(JSON.stringify(events).includes('staff_confirmation'), false);

  const completedEvidence = baseJob({
    tool: 'confirmed_reservation_commit',
    operationId: REGISTRATION_OPERATION,
    receipt: confirmedRegistrationReceipt()
  });
  const lateReceiptJob = {
    ...durableJob,
    updated_at: '2026-09-07T01:30:00.000Z',
    tool_operation: {
      ...completedEvidence.tool_operation,
      audit_target: durableJob.tool_operation.audit_target
    },
    tool_receipts: completedEvidence.tool_receipts
  };
  assert.deepEqual(
    buildKakaoAutomationAuditEvents({ durableJob: lateReceiptJob }),
    events,
    'late exact evidence may enrich durable state but cannot rewrite an unresolved operation as success'
  );
});

test('coalesced fast authorization audits the generated effective RQ without inventing a requested RQ', () => {
  const receipt = confirmedRegistrationReceipt({
    request_id: null,
    effective_request_id: 'RQ-260907-009',
    applied_stages: ['pending_request_bootstrap', 'registration', 'authoritative_readback']
  });
  receipt.authorized_registration = {
    ...receipt.authorized_registration,
    request_id: null,
    expected_set_components: [],
    set_component_selections: [],
    pending_request_candidate: {
      customer_name: '테스트 고객', phone: '010-1111-2222', discount_type: '일반', memo: '', extra_request: ''
    }
  };
  receipt.authoritative_result = {
    ...receipt.authoritative_result,
    request_id: null,
    effective_request_id: 'RQ-260907-009',
    final_set_components: [],
    authoritative: {
      ...receipt.authoritative_result.authoritative,
      request: {
        reqID: 'RQ-260907-009',
        name: '테스트 고객', phone: '01011112222', discount: '일반', memo: '', extraRequest: '',
        startDate: receipt.authorized_registration.desired_period.start_date,
        startTime: receipt.authorized_registration.desired_period.start_time,
        endDate: receipt.authorized_registration.desired_period.end_date,
        endTime: receipt.authorized_registration.desired_period.end_time,
        topLevelEquipItems: receipt.authorized_registration.desired_after
          .map(({ name, quantity }) => ({ name, qty: quantity })),
        setComponentItems: [], tradeIds: ['260906-001']
      },
      registered_trade: { schedule: { rows: [] } }
    }
  };

  const events = buildKakaoAutomationAuditEvents({
    durableJob: baseJob({
      tool: 'confirmed_reservation_commit',
      operationId: REGISTRATION_OPERATION,
      receipt
    })
  });

  assert.equal(events.length, 1);
  assert.equal(events[0].effect_type, 'reservation_registration');
  assert.equal(events[0].outcome, 'success');
  assert.equal(events[0].target_type, 'trade');
  assert.equal(events[0].target_id, '260906-001');
  assert.equal(events[0].outbound_text, null);
});

test('registration audit compares private request terms exactly before redacting its public event', () => {
  const exactReceipt = confirmedRegistrationReceipt({
    request_id: null,
    effective_request_id: 'RQ-260907-009',
    applied_stages: ['pending_request_bootstrap', 'registration', 'authoritative_readback']
  });
  exactReceipt.authorized_registration = {
    ...exactReceipt.authorized_registration,
    request_id: null,
    expected_set_components: [],
    set_component_selections: [],
    pending_request_candidate: {
      customer_name: '테스트 고객', phone: '010-1111-2222', discount_type: '일반',
      memo: '', extra_request: ''
    }
  };
  exactReceipt.authoritative_result = {
    ...exactReceipt.authoritative_result,
    request_id: null,
    effective_request_id: 'RQ-260907-009',
    final_set_components: [],
    authoritative: {
      ...exactReceipt.authoritative_result.authoritative,
      request: {
        reqID: 'RQ-260907-009', tradeIds: ['260906-001'],
        topLevelEquipItems: exactReceipt.authorized_registration.desired_after
          .map(({ name, quantity }) => ({ name, qty: quantity })),
        setComponentItems: [],
        startDate: exactReceipt.authorized_registration.desired_period.start_date,
        startTime: exactReceipt.authorized_registration.desired_period.start_time,
        endDate: exactReceipt.authorized_registration.desired_period.end_date,
        endTime: exactReceipt.authorized_registration.desired_period.end_time,
        name: '테스트 고객', phone: '01011112222', discount: '일반', memo: '', extraRequest: ''
      },
      registered_trade: { schedule: { rows: [] } }
    }
  };

  for (const [label, mutate] of [
    ['blank versus private phone-shaped memo', (receipt) => {
      receipt.authoritative_result.authoritative.request.memo = '010-9999-8888';
    }],
    ['different private memo values', (receipt) => {
      receipt.authorized_registration.pending_request_candidate.memo = '010-1111-2222';
      receipt.authoritative_result.authoritative.request.memo = '010-3333-4444';
    }],
    ['different secret-shaped extra requests', (receipt) => {
      receipt.authorized_registration.pending_request_candidate.extra_request = 'token=first-private-value';
      receipt.authoritative_result.authoritative.request.extraRequest = 'token=second-private-value';
    }]
  ]) {
    const receipt = structuredClone(exactReceipt);
    mutate(receipt);
    assert.throws(() => buildKakaoAutomationAuditEvents({
      durableJob: baseJob({
        tool: 'confirmed_reservation_commit', operationId: REGISTRATION_OPERATION, receipt
      })
    }), /trusted tool receipt set is invalid/, label);
  }
});

test('registration audit readback comparison is canonical and ignores harmless object key order', () => {
  const receipt = confirmedRegistrationReceipt();
  receipt.authoritative_result.final_plan = receipt.authoritative_result.final_plan.map((item) => ({
    quantity: item.quantity,
    name: item.name
  }));
  receipt.authoritative_result.final_period = {
    end_time: receipt.authoritative_result.final_period.end_time,
    start_date: receipt.authoritative_result.final_period.start_date,
    end_date: receipt.authoritative_result.final_period.end_date,
    start_time: receipt.authoritative_result.final_period.start_time
  };
  const events = buildKakaoAutomationAuditEvents({
    durableJob: baseJob({
      tool: 'confirmed_reservation_commit',
      operationId: REGISTRATION_OPERATION,
      receipt
    })
  });
  assert.equal(events.length, 1);
  assert.equal(events[0].outcome, 'success');
});

test('registration audit rejects an ok receipt whose component readback contradicts the authorized set baseline', () => {
  const receipt = confirmedRegistrationReceipt();
  receipt.authoritative_result.final_set_components = [{
    set_item: '소니 FX3 바디세트',
    component_item: '인증되지 않은 대체 구성품',
    quantity: 1
  }];
  receipt.authoritative_result.authoritative.registered_trade.schedule.rows = [{
    scheduleId: '260906-001-02',
    setName: '소니 FX3 바디세트',
    name: '인증되지 않은 대체 구성품',
    qty: 1,
    isComponent: true
  }];
  assert.throws(() => buildKakaoAutomationAuditEvents({
    durableJob: baseJob({
      tool: 'confirmed_reservation_commit',
      operationId: REGISTRATION_OPERATION,
      receipt
    })
  }), /trusted tool receipt set is invalid/);
});

test('registration audit rejects an ok receipt whose authoritative request differs from the authorized operation', () => {
  const receipt = confirmedRegistrationReceipt();
  receipt.authoritative_result.authoritative.request.topLevelEquipItems[0].qty = 2;
  assert.throws(() => buildKakaoAutomationAuditEvents({
    durableJob: baseJob({
      tool: 'confirmed_reservation_commit',
      operationId: REGISTRATION_OPERATION,
      receipt
    })
  }), /trusted tool receipt set is invalid/);
});

test('blocked and partial registration receipts remain visible without raw conversation evidence', () => {
  for (const [status, expectedOutcome] of [['blocked', 'blocked'], ['partial_success', 'partial_success']]) {
    const receipt = confirmedRegistrationReceipt({
      status,
      effective_request_id: status === 'partial_success' ? 'RQ-260907-002' : null,
      trade_id: null,
      authoritative_result: status === 'partial_success'
        ? { success: false, status, effective_request_id: 'RQ-260907-002' }
        : null,
      applied_stages: status === 'partial_success' ? ['pending_request_replacement'] : [],
      attempted_stage: status === 'partial_success' ? 'registration' : 'preflight',
      error: { type: status === 'partial_success' ? 'commit_uncertain' : 'invalid_or_stale', message: 'private detail' }
    });
    const events = buildKakaoAutomationAuditEvents({
      durableJob: baseJob({
        tool: 'confirmed_reservation_commit',
        operationId: REGISTRATION_OPERATION,
        receipt
      })
    });
    assert.equal(events.length, 1);
    assert.equal(events[0].outcome, expectedOutcome);
    assert.equal(events[0].target_type, 'request');
    assert.equal(events[0].target_id, 'RQ-260906-001');
    assert.equal(JSON.stringify(events).includes('not stored in audit'), false);
    assert.equal(JSON.stringify(events).includes('private detail'), false);
  }
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
