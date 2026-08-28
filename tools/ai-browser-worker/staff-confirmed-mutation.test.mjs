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

const REAL_RUNNER_CONFIG = {
  VILLAGE2_API_URL: 'https://script.google.com/macros/s/example/exec',
  VILLAGE2_API_KEY: 'synthetic-internal-key'
};
const REAL_RUNNER_OPERATION_ID = '11111111-2222-4333-8444-555555555555';

function clone(value) {
  return structuredClone(value);
}

function valid(mutation, options = { roomRevision: 8 }) {
  return validateStaffConfirmedMutation(mutation, options);
}

function registeredMutation(kind) {
  const mutation = clone(MUTATION);
  mutation.kind = kind;
  if (kind === 'equipment_add') {
    mutation.expected_before = [];
    mutation.desired_after = [{ name: '배터리', quantity: 1 }];
  } else if (kind === 'equipment_remove') {
    mutation.desired_after = [];
  } else if (kind === 'equipment_quantity_change') {
    mutation.desired_after = [{ name: mutation.expected_before[0].name, quantity: 2 }];
  } else if (kind === 'date_time_change') {
    mutation.expected_before = [];
    mutation.desired_after = [];
    mutation.date_change = {
      new_start_date: '2026-08-28', new_start_time: '07:00',
      new_end_date: '2026-08-28', new_end_time: '19:00'
    };
  }
  return mutation;
}

function authoritativeState({
  startDate = '2026-08-27', startTime = '06:00', endDate = '2026-08-27', endTime = '18:00',
  rows = []
} = {}) {
  const topLevelQuantities = {};
  for (const row of rows) {
    if (!row.isComponent) topLevelQuantities[row.name] = (topLevelQuantities[row.name] || 0) + row.qty;
  }
  return {
    contract: { startDate, startTime, endDate, endTime },
    schedule: {
      periods: [`${startDate}|${startTime}|${endDate}|${endTime}`],
      rows,
      topLevelQuantities
    },
    ledger: { rows: 1, startDate, contractLink: 'https://example.test/contracts/260824-008', links: ['https://example.test/contracts/260824-008'] }
  };
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
        authoritativeReadback: {
          before: authoritativeState({ rows: [
            { scheduleId: '260824-008-07', setName: '', name: '소니 FE 28-135mm', qty: 1, isComponent: false },
            { scheduleId: '260824-008-99', setName: '', name: '소니 FX3', qty: 1, isComponent: false }
          ] }),
          after: authoritativeState({ rows: [
            { scheduleId: '260824-008-08', setName: '', name: '소니 GM 70-200mm II', qty: 1, isComponent: false },
            { scheduleId: '260824-008-99', setName: '', name: '소니 FX3', qty: 1, isComponent: false }
          ] })
        },
        readback: authoritativeState({ rows: [
          { scheduleId: '260824-008-08', setName: '', name: '소니 GM 70-200mm II', qty: 1, isComponent: false },
          { scheduleId: '260824-008-99', setName: '', name: '소니 FX3', qty: 1, isComponent: false }
        ] }),
        contractRegeneration: { success: true, url: 'https://example.test/contract', fileId: 'file-1' },
        send: { attempted: false, accepted: false }
      }),
      randomUUID: () => 'receipt-260827-001',
      now: () => new Date('2026-08-27T00:00:00.000Z')
    },
    ...overrides
  };
}

function installAuthenticatedCorrectionFetch(t, { before, after, events = [] }) {
  const previousFetch = globalThis.fetch;
  const calls = [];
  t.after(() => { globalThis.fetch = previousFetch; });
  globalThis.fetch = async (url, options = {}) => {
    events.push('fetch');
    assert.equal(String(url), REAL_RUNNER_CONFIG.VILLAGE2_API_URL);
    assert.equal(options.method, 'POST');
    const body = JSON.parse(options.body);
    assert.equal(body.key, REAL_RUNNER_CONFIG.VILLAGE2_API_KEY);
    calls.push(body);
    return {
      ok: true,
      status: 200,
      json: async () => ({
        success: true,
        status: 'CORRECTED',
        tradeId: '260824-008',
        operationId: REAL_RUNNER_OPERATION_ID,
        stages: ['scheduleCorrectRegisteredTrade'],
        contractRegeneration: {
          success: true,
          url: 'https://example.test/contracts/260824-008',
          fileId: 'contract-260824-008'
        },
        readback: after,
        authoritativeReadback: { before, after },
        customerNotificationSent: false
      })
    };
  };
  return calls;
}

function realRunnerRequest(mutation, assertCurrentClaim) {
  const value = request({ config: REAL_RUNNER_CONFIG, mutation });
  value.dependencies = {
    operationFence: { operation_id: REAL_RUNNER_OPERATION_ID },
    assertCurrentClaim,
    randomUUID: value.dependencies.randomUUID,
    now: value.dependencies.now
  };
  return value;
}

test('validates canonical registered and pending staff-confirmed mutation scopes', () => {
  assert.deepEqual(valid(MUTATION), { valid: true, errors: [] });
  assert.deepEqual(valid(PENDING_MUTATION), { valid: true, errors: [] });
});

test('enforces the strict affected-row delta union for all five registered mutation kinds', () => {
  for (const kind of [
    'equipment_add', 'equipment_remove', 'equipment_replace',
    'equipment_quantity_change', 'date_time_change'
  ]) {
    assert.deepEqual(valid(registeredMutation(kind)), { valid: true, errors: [] }, kind);
  }

  const invalid = [
    ['add with removal delta', { ...registeredMutation('equipment_add'), expected_before: clone(MUTATION.expected_before) }],
    ['add without addition delta', { ...registeredMutation('equipment_add'), desired_after: [] }],
    ['remove with addition delta', { ...registeredMutation('equipment_remove'), desired_after: clone(MUTATION.desired_after) }],
    ['replace without removal delta', { ...registeredMutation('equipment_replace'), expected_before: [] }],
    ['quantity with different identity', { ...registeredMutation('equipment_quantity_change'), desired_after: [{ name: '다른 장비', quantity: 2 }] }],
    ['quantity without a quantity change', { ...registeredMutation('equipment_quantity_change'), desired_after: [{ name: MUTATION.expected_before[0].name, quantity: 1 }] }],
    ['equipment kind with date delta', { ...registeredMutation('equipment_replace'), date_change: registeredMutation('date_time_change').date_change }],
    ['date change with equipment removal delta', { ...registeredMutation('date_time_change'), expected_before: clone(MUTATION.expected_before) }],
    ['date change with unchanged period', {
      ...registeredMutation('date_time_change'),
      date_change: { new_start_date: '2026-08-27', new_start_time: '06:00', new_end_date: '2026-08-27', new_end_time: '18:00' }
    }]
  ];
  for (const [label, mutation] of invalid) assert.equal(valid(mutation).valid, false, label);
});

test('accepts schedule suffixes of two or more digits and rejects malformed or cross-trade IDs', () => {
  assert.equal(valid({
    ...clone(MUTATION),
    expected_before: [{ ...MUTATION.expected_before[0], schedule_id: '260824-008-100' }]
  }).valid, true);
  for (const schedule_id of ['260824-008-1', '260824-008-x100', '260824-009-100']) {
    assert.equal(valid({
      ...clone(MUTATION),
      expected_before: [{ ...MUTATION.expected_before[0], schedule_id }]
    }).valid, false, schedule_id);
  }
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

test('equipment mutation crosses the real correction runner seam once without an empty date change', async (t) => {
  const before = authoritativeState({ rows: [
    { scheduleId: '260824-008-07', setName: '', name: '소니 FE 28-135mm', qty: 1, isComponent: false },
    { scheduleId: '260824-008-99', setName: '', name: '소니 FX3', qty: 1, isComponent: false }
  ] });
  const after = authoritativeState({ rows: [
    { scheduleId: '260824-008-08', setName: '', name: '소니 GM 70-200mm II', qty: 1, isComponent: false },
    { scheduleId: '260824-008-99', setName: '', name: '소니 FX3', qty: 1, isComponent: false }
  ] });
  const events = [];
  const calls = installAuthenticatedCorrectionFetch(t, { before, after, events });

  const receipt = await executeVillageRegisteredReservationChange(
    realRunnerRequest(clone(MUTATION), async () => { events.push('claim'); })
  );

  assert.deepEqual(events, ['claim', 'fetch']);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].action, 'scheduleCorrectRegisteredTrade');
  assert.deepEqual(calls[0].args, {
    tradeId: '260824-008',
    operationId: REAL_RUNNER_OPERATION_ID,
    expectedPeriod: { startDate: '2026-08-27', startTime: '06:00', endDate: '2026-08-27', endTime: '18:00' },
    remove: [{ scheduleId: '260824-008-07', expectedName: '소니 FE 28-135mm', expectedQty: 1 }],
    add: [{ name: '소니 GM 70-200mm II', qty: 1 }]
  });
  assert.equal(Object.hasOwn(calls[0].args, 'dateChange'), false);
  assert.equal(receipt.status, 'ok');
  assert.equal(receipt.trade_id, '260824-008');
  assert.equal(receipt.customer_reply, 'no_reply');
  assert.deepEqual(receipt.authoritative_result, { before, after });
});

test('date-time mutation crosses the real correction runner seam once with the exact date change', async (t) => {
  const before = authoritativeState();
  const after = authoritativeState({
    startDate: '2026-08-28', startTime: '07:00', endDate: '2026-08-28', endTime: '19:00'
  });
  const events = [];
  const calls = installAuthenticatedCorrectionFetch(t, { before, after, events });
  const mutation = registeredMutation('date_time_change');

  const receipt = await executeVillageRegisteredReservationChange(
    realRunnerRequest(mutation, async () => { events.push('claim'); })
  );

  assert.deepEqual(events, ['claim', 'fetch']);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args, {
    tradeId: '260824-008',
    operationId: REAL_RUNNER_OPERATION_ID,
    expectedPeriod: { startDate: '2026-08-27', startTime: '06:00', endDate: '2026-08-27', endTime: '18:00' },
    dateChange: {
      newStartDate: '2026-08-28',
      newEndDate: '2026-08-28',
      startTime: '07:00',
      endTime: '19:00',
      allowConflicts: false
    }
  });
  assert.equal(receipt.status, 'ok');
  assert.deepEqual(receipt.authoritative_result, { before, after });
});

test('executes exactly once with the operation fence and claim immediately before the correction', async () => {
  const events = [];
  const authoritativeReadback = (await request().dependencies.runRegisteredTradeCorrection()).authoritativeReadback;
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
    authoritative_result: authoritativeReadback,
    applied_stages: ['scheduleCorrectRegisteredTrade'], attempted_stage: null,
    customer_reply: 'no_reply', created_at: '2026-08-27T00:00:00.000Z', error: null
  });
});

test('refuses success when the correction omits the authoritative before and after envelope', async () => {
  let calls = 0;
  const receipt = await executeVillageRegisteredReservationChange(request({
    dependencies: {
      ...request().dependencies,
      runRegisteredTradeCorrection: async () => {
        calls += 1;
        const result = await request().dependencies.runRegisteredTradeCorrection();
        delete result.authoritativeReadback;
        return result;
      }
    }
  }));

  assert.equal(calls, 1);
  assert.equal(receipt.status, 'partial_success');
  assert.equal(receipt.authoritative_result, null);
  assert.equal(receipt.error.code, 'invalid_authoritative_result');
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
