import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildRegisteredTradeCorrectionInput,
  executeVillageRegisteredReservationChange,
  validateStaffConfirmedMutation
} from './staff-confirmed-mutation.mjs';

const MUTATION = {
  confirmed: true,
  kind: 'equipment_replace',
  target_scope: 'registered_trade',
  trade_id: '260824-008',
  source_evidence: {
    customer_request: '28-135 취소하고 sony 70-200 gm 2.8 로 부탁드립니당',
    staff_confirmation: '네',
    conversation_revision: 8
  },
  expected_period: {
    start_date: '2026-08-27', start_time: '06:00', end_date: '2026-08-27', end_time: '18:00'
  },
  expected_before: [{ schedule_id: '260824-008-07', name: '소니 FE 28-135mm', quantity: 1 }],
  desired_after: [{ name: '소니 GM 70-200mm II', quantity: 1 }],
  date_change: null
};

const PENDING_MUTATION = {
  confirmed: true,
  kind: 'equipment_replace',
  target_scope: 'pending_request',
  request_id: 'RQ-260824-008',
  source_evidence: { customer_request: '28-135 빼고 70-200으로 변경', staff_confirmation: '네', conversation_revision: 8 },
  expected_before: [{ name: '소니 FE 28-135mm', quantity: 1 }],
  desired_after: [{ name: '소니 GM 70-200mm II', quantity: 1 }],
  date_change: null
};

function clone(value) {
  return structuredClone(value);
}

function valid(mutation, options = { roomRevision: 8 }) {
  return validateStaffConfirmedMutation(mutation, options);
}

function request(overrides = {}) {
  return {
    config: { internalKey: 'test-key' },
    job: { job_id: 'job-260827-001', room_key: 'room-123', room_revision: 8 },
    roomRevision: 8,
    mutation: clone(MUTATION),
    dependencies: {
      operationFence: { operation_id: 'operation-260827-001' },
      assertCurrentClaim: async () => {},
      runRegisteredTradeCorrection: async () => ({
        ok: true,
        verified: true,
        tradeId: '260824-008',
        appliedStages: ['scheduleCorrectRegisteredTrade'],
        readback: { contract: { tradeId: '260824-008' }, schedule: [{ scheduleId: '260824-008-08' }], ledger: { tradeId: '260824-008' } },
        contractRegeneration: { success: true, url: 'https://example.test/contract', fileId: 'file-1' },
        send: { attempted: false, accepted: false }
      }),
      randomUUID: () => 'receipt-260827-001',
      now: () => new Date('2026-08-27T00:00:00.000Z')
    },
    ...overrides
  };
}

test('validates canonical registered and pending staff-confirmed mutation scopes', () => {
  assert.deepEqual(valid(MUTATION), { valid: true, errors: [] });
  assert.deepEqual(valid(PENDING_MUTATION), { valid: true, errors: [] });
});

test('rejects invalid staff-confirmed mutation identities, evidence, scope fields, and unsafe model fields', () => {
  const cases = [
    ['unconfirmed', { confirmed: false }],
    ['revision mismatch', { source_evidence: { ...MUTATION.source_evidence, conversation_revision: 7 } }],
    ['bad trade ID', { trade_id: 'trade-8' }],
    ['bad request ID', { target_scope: 'pending_request', trade_id: undefined, request_id: 'RQ-8', expected_period: undefined, expected_before: PENDING_MUTATION.expected_before }],
    ['bad schedule ID', { expected_before: [{ ...MUTATION.expected_before[0], schedule_id: '260824-008-x' }] }],
    ['blank evidence', { source_evidence: { ...MUTATION.source_evidence, staff_confirmation: ' ' } }],
    ['bad time', { expected_period: { ...MUTATION.expected_period, start_time: '24:00' } }],
    ['duplicate schedule', { expected_before: [MUTATION.expected_before[0], MUTATION.expected_before[0]] }],
    ['empty change', { expected_before: [], desired_after: [], date_change: null }],
    ['pending trade field', { ...PENDING_MUTATION, trade_id: '260824-008' }],
    ['pending schedule ID', { ...PENDING_MUTATION, expected_before: [{ ...PENDING_MUTATION.expected_before[0], schedule_id: '260824-008-07' }] }],
    ['unsupported key', { unsupported: true }],
    ['lease injection', { lease_id: 'lease-1' }],
    ['operation injection', { operation_id: 'operation-1' }],
    ['digest injection', { request_digest: 'digest-1' }],
    ['receipt injection', { receipt_id: 'receipt-1' }]
  ];
  for (const [label, overrides] of cases) {
    const mutation = { ...clone(MUTATION), ...overrides };
    assert.equal(valid(mutation).valid, false, label);
  }
});

test('rejects null fields belonging to the other mutation scope and a baseline from another trade', () => {
  const registeredWithRequest = { ...clone(MUTATION), request_id: null };
  const pendingWithTrade = { ...clone(PENDING_MUTATION), trade_id: null };
  const pendingWithPeriod = { ...clone(PENDING_MUTATION), expected_period: null };
  const crossTradeBaseline = {
    ...clone(MUTATION),
    expected_before: [{ ...MUTATION.expected_before[0], schedule_id: '260824-009-07' }]
  };
  for (const [label, mutation] of [
    ['registered request_id null', registeredWithRequest],
    ['pending trade_id null', pendingWithTrade],
    ['pending expected_period null', pendingWithPeriod],
    ['cross-trade schedule ID', crossTradeBaseline]
  ]) {
    assert.equal(valid(mutation).valid, false, label);
  }
  assert.throws(() => buildRegisteredTradeCorrectionInput(crossTradeBaseline, 'operation-260827-001'));
});

test('projects a registered mutation with exact expected period and quantities', () => {
  assert.deepEqual(buildRegisteredTradeCorrectionInput(MUTATION, 'operation-260827-001'), {
    tradeId: '260824-008', operationId: 'operation-260827-001',
    expectedPeriod: { startDate: '2026-08-27', startTime: '06:00', endDate: '2026-08-27', endTime: '18:00' },
    dateChange: null,
    remove: [{ scheduleId: '260824-008-07', expectedName: '소니 FE 28-135mm', expectedQty: 1 }],
    add: [{ name: '소니 GM 70-200mm II', qty: 1 }],
    sendEstimate: false
  });
  assert.throws(() => buildRegisteredTradeCorrectionInput(PENDING_MUTATION, 'operation-260827-001'));
});

test('projects a registered date change with the exact new date-time field names', () => {
  const mutation = clone(MUTATION);
  mutation.kind = 'date_time_change';
  mutation.expected_before = [];
  mutation.desired_after = [];
  mutation.date_change = {
    new_start_date: '2026-08-28', new_start_time: '07:00', new_end_date: '2026-08-28', new_end_time: '19:00'
  };
  assert.deepEqual(buildRegisteredTradeCorrectionInput(mutation, 'operation-date-change').dateChange, {
    newStartDate: '2026-08-28', startTime: '07:00', newEndDate: '2026-08-28', endTime: '19:00', allowConflicts: false
  });
});

test('executes exactly once with the operation fence and claim immediately before the correction', async () => {
  const events = [];
  const result = await executeVillageRegisteredReservationChange(request({
    dependencies: {
      ...request().dependencies,
      assertCurrentClaim: async () => { events.push('claim'); },
      runRegisteredTradeCorrection: async (args) => {
        events.push('runner');
        assert.equal(args.input.operationId, 'operation-260827-001');
        assert.deepEqual(args.input.expectedPeriod, { startDate: '2026-08-27', startTime: '06:00', endDate: '2026-08-27', endTime: '18:00' });
        return request().dependencies.runRegisteredTradeCorrection(args);
      }
    }
  }));
  assert.deepEqual(events, ['claim', 'runner']);
  assert.deepEqual(result, {
    schema: 'village-registered-reservation-change-receipt/v1', receipt_id: 'receipt-260827-001',
    job_id: 'job-260827-001', room_key: 'room-123', room_revision: 8, status: 'ok',
    target_scope: 'registered_trade', trade_id: '260824-008', mutation_kind: 'equipment_replace',
    authoritative_result: {
      contract: { tradeId: '260824-008' }, schedule: [{ scheduleId: '260824-008-08' }], ledger: { tradeId: '260824-008' }
    },
    applied_stages: ['scheduleCorrectRegisteredTrade'], attempted_stage: null,
    customer_reply: 'no_reply', created_at: '2026-08-27T00:00:00.000Z', error: null
  });
});

test('returns blocked receipt for explicit pre-write GAS rejection without retry', async () => {
  let calls = 0;
  const receipt = await executeVillageRegisteredReservationChange(request({
    dependencies: {
      ...request().dependencies,
      runRegisteredTradeCorrection: async () => {
        calls += 1;
        const error = new Error('expected baseline quantity mismatched');
        error.name = 'CorrectionStageError';
        error.stage = 'scheduleCorrectRegisteredTrade';
        error.outcomeUnknown = false;
        error.appliedStages = [];
        error.details = { error: 'expected baseline quantity mismatched' };
        throw error;
      }
    }
  }));
  assert.equal(calls, 1);
  assert.equal(receipt.status, 'blocked');
  assert.deepEqual(receipt.applied_stages, []);
  assert.equal(receipt.attempted_stage, 'scheduleCorrectRegisteredTrade');
  assert.deepEqual(receipt.error, { code: 'gas_rejected', message: 'expected baseline quantity mismatched', details: { error: 'expected baseline quantity mismatched' } });
});

test('preserves unknown partial correction stage evidence without retry', async () => {
  let calls = 0;
  const receipt = await executeVillageRegisteredReservationChange(request({
    dependencies: {
      ...request().dependencies,
      runRegisteredTradeCorrection: async () => {
        calls += 1;
        const error = new Error('correction outcome is unknown');
        error.name = 'CorrectionStageError';
        error.stage = 'scheduleCorrectRegisteredTrade';
        error.outcomeUnknown = true;
        error.appliedStages = ['scheduleCorrectRegisteredTrade'];
        throw error;
      }
    }
  }));
  assert.equal(calls, 1);
  assert.equal(receipt.status, 'partial_success');
  assert.deepEqual(receipt.applied_stages, ['scheduleCorrectRegisteredTrade']);
  assert.equal(receipt.attempted_stage, 'scheduleCorrectRegisteredTrade');
  assert.equal(receipt.error.code, 'outcome_unknown');
});

test('preserves known applied correction stages as partial success without retry', async () => {
  let calls = 0;
  const receipt = await executeVillageRegisteredReservationChange(request({
    dependencies: {
      ...request().dependencies,
      runRegisteredTradeCorrection: async () => {
        calls += 1;
        const error = new Error('contract regeneration rejected after schedule correction');
        error.name = 'CorrectionStageError';
        error.stage = 'contractRegeneration';
        error.outcomeUnknown = false;
        error.appliedStages = ['scheduleCorrectRegisteredTrade'];
        throw error;
      }
    }
  }));
  assert.equal(calls, 1);
  assert.equal(receipt.status, 'partial_success');
  assert.deepEqual(receipt.applied_stages, ['scheduleCorrectRegisteredTrade']);
  assert.equal(receipt.attempted_stage, 'contractRegeneration');
  assert.equal(receipt.error.code, 'gas_rejected');
});

test('preserves applied result stages as partial success when authoritative readback is incomplete', async () => {
  let calls = 0;
  const receipt = await executeVillageRegisteredReservationChange(request({
    dependencies: {
      ...request().dependencies,
      runRegisteredTradeCorrection: async () => {
        calls += 1;
        return { ok: true, verified: false, tradeId: '260824-008', appliedStages: ['scheduleCorrectRegisteredTrade'] };
      }
    }
  }));
  assert.equal(calls, 1);
  assert.equal(receipt.status, 'partial_success');
  assert.deepEqual(receipt.applied_stages, ['scheduleCorrectRegisteredTrade']);
  assert.equal(receipt.error.code, 'invalid_authoritative_result');
});

test('returns failed receipt for an unstructured failure before any write and rejects stale job correlation', async () => {
  let calls = 0;
  const receipt = await executeVillageRegisteredReservationChange(request({
    dependencies: { ...request().dependencies, runRegisteredTradeCorrection: async () => { calls += 1; throw new Error('runner unavailable'); } }
  }));
  assert.equal(calls, 1);
  assert.equal(receipt.status, 'failed');
  assert.equal(receipt.error.code, 'execution_failed');
  await assert.rejects(
    executeVillageRegisteredReservationChange(request({ roomRevision: 9 })),
    /room revision/i
  );
});
