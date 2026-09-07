import test from 'node:test';
import assert from 'node:assert/strict';
import { executeConfirmationBatch, validateConfirmationBatchDecision } from './confirmation-batch.mjs';

const context = { job_id: 'test-job', room_key: 'test-room', room_revision: 7 };
function child(day) {
  return {
    should_write_to_sheet: true,
    reservation_inquiry: { is_reservation_inquiry: true, already_registered: false },
    sheet_row_candidate: {
      customer_name: 'Synthetic renter', phone: '010-0000-0000',
      start_date: `2026-10-${day}`, pickup_time: '09:00', end_date: `2026-10-${day}`, return_time: '18:00',
      equipment: [{ item: 'Synthetic camera', quantity: 1 }]
    }
  };
}
function buildReceipt({ status, authoritativeSheetResult = null, availabilityReport = [], error = null }) {
  return {
    schema: 'village-confirmation-receipt/v1', receipt_id: 'batch-receipt', ...context,
    status, authoritative_sheet_result: authoritativeSheetResult,
    availability_report: availabilityReport, error, created_at: '2026-09-07T00:00:00.000Z'
  };
}
function successfulReceipt(index) {
  return { ...buildReceipt({ status: 'ok', authoritativeSheetResult: { success: true, reqID: `RQ-261001-00${index + 1}` }, availabilityReport: [{ period: index }] }), receipt_id: `child-${index}` };
}
function harness(children = [child('01'), child('02')], overrides = {}) {
  const events = [];
  const states = [];
  return {
    events, states,
    options: {
      decision: { confirmation_requests: children },
      validateDecision: (_decision, index) => { events.push(`validate:${index}`); return { valid: true, errors: [] }; },
      preflightDecision: async (decision, index) => { events.push(`preflight:${index}`); return { ok: true, decision }; },
      executeDecision: async (decision, index) => {
        events.push(`execute:${index}`);
        return { receipt: successfulReceipt(index), executionState: { decision, sheetResult: { success: true, reqID: `RQ-261001-00${index + 1}` } } };
      },
      buildReceipt,
      onExecutionState: state => states.push(state),
      ...overrides
    }
  };
}

test('two rental periods complete once after every validation and catalog preflight', async () => {
  const h = harness();
  const receipt = await executeConfirmationBatch(h.options);
  assert.equal(receipt.status, 'ok');
  assert.deepEqual(h.events, ['validate:0', 'validate:1', 'preflight:0', 'preflight:1', 'execute:0', 'execute:1']);
  assert.deepEqual(receipt.request_ids, ['RQ-261001-001', 'RQ-261001-002']);
  assert.deepEqual(receipt.authoritative_sheet_result.request_ids, receipt.request_ids);
  assert.equal(receipt.authoritative_sheet_result.reqID, 'RQ-261001-001');
  assert.equal(receipt.child_receipts.length, 2);
  assert.equal(receipt.request_results[1].index, 1);
  assert.deepEqual(receipt.request_results[1].receipt, successfulReceipt(1));
  assert.deepEqual(receipt.unattempted_indices, []);
  assert.equal(receipt.room_revision, 7);
  assert.equal(receipt.authorized_confirmation_requests.length, 2);
  assert.equal(receipt.authorized_confirmation_requests[1].sheet_row_candidate.start_date, '2026-10-02');
  h.options.decision.confirmation_requests[1].sheet_row_candidate.start_date = '2026-12-01';
  assert.equal(receipt.authorized_confirmation_requests[1].sheet_row_candidate.start_date, '2026-10-02');
  assert.deepEqual(receipt.availability_report, [{ period: 0 }, { period: 1 }]);
  assert.equal(h.states.length, 1);
  assert.equal(h.states[0].childExecutionStates.length, 2);
  assert.deepEqual(h.states[0].requestIds, receipt.request_ids);
});

test('invalid second child contract prevents every write and catalog lookup', async () => {
  const h = harness(undefined, { validateDecision: (_child, index) => ({ valid: index !== 1, errors: ['invalid period'] }) });
  const receipt = await executeConfirmationBatch(h.options);
  assert.equal(receipt.status, 'failed');
  assert.equal(receipt.error.code, 'invalid_decision');
  assert.deepEqual(h.events, []);
  assert.deepEqual(receipt.unattempted_indices, [0, 1]);
});

test('unresolved second catalog group prevents every write', async () => {
  const h = harness(undefined, { preflightDecision: async (_child, index) => ({ ok: index === 0, error: { code: 'equipment_catalog_verification_failed', message: 'Catalog unresolved' } }) });
  const receipt = await executeConfirmationBatch(h.options);
  assert.equal(receipt.status, 'failed');
  assert.equal(receipt.error.code, 'equipment_catalog_verification_failed');
  assert.deepEqual(h.events, ['validate:0', 'validate:1']);
  assert.deepEqual(receipt.request_ids, []);
});

test('second failure preserves first RQ and stops third without retries', async () => {
  const h = harness([child('01'), child('02'), child('03')]);
  h.options.executeDecision = async (_child, index) => {
    h.events.push(`execute:${index}`);
    return index === 0 ? successfulReceipt(0) : buildReceipt({ status: 'failed', error: { code: 'gas_rejected', message: 'Rejected' } });
  };
  const receipt = await executeConfirmationBatch(h.options);
  assert.equal(receipt.status, 'partial_success');
  assert.deepEqual(receipt.request_ids, ['RQ-261001-001']);
  assert.deepEqual(receipt.unattempted_indices, [2]);
  assert.equal(receipt.child_receipts[1].status, 'failed');
  assert.deepEqual(h.events.filter(event => event.startsWith('execute:')), ['execute:0', 'execute:1']);
});

for (const status of ['partial_success', 'no_action']) {
  test(`second ${status} stops later periods and retains all child evidence`, async () => {
    const h = harness([child('01'), child('02'), child('03')], {
      executeDecision: async (_child, index) => index === 0 ? successfulReceipt(0) : buildReceipt({ status, authoritativeSheetResult: status === 'partial_success' ? { success: false, reqID: 'RQ-261001-002', uncertainWrite: true } : null })
    });
    const receipt = await executeConfirmationBatch(h.options);
    assert.equal(receipt.status, 'partial_success');
    assert.equal(receipt.request_results[1].receipt.status, status);
    assert.deepEqual(receipt.unattempted_indices, [2]);
  });
}

test('first thrown execution is uncertain and terminal without any retry', async () => {
  const h = harness();
  h.options.executeDecision = async (_child, index) => { h.events.push(`execute:${index}`); throw new Error('Lost response'); };
  const receipt = await executeConfirmationBatch(h.options);
  assert.equal(receipt.status, 'partial_success');
  assert.equal(receipt.error.code, 'confirmation_batch_execution_uncertain');
  assert.deepEqual(receipt.unattempted_indices, [1]);
  assert.deepEqual(h.events.filter(event => event.startsWith('execute:')), ['execute:0']);
});

test('abort between writes retains completed evidence and leaves next period unattempted', async () => {
  const controller = new AbortController();
  const h = harness(undefined, { signal: controller.signal, executeDecision: async () => { controller.abort(); return successfulReceipt(0); } });
  const receipt = await executeConfirmationBatch(h.options);
  assert.equal(receipt.status, 'partial_success');
  assert.equal(receipt.error.code, 'confirmation_batch_aborted');
  assert.deepEqual(receipt.request_ids, ['RQ-261001-001']);
  assert.deepEqual(receipt.unattempted_indices, [1]);
});

test('freshness loss after first write stops before second execution without replay', async () => {
  let written = false;
  const h = harness(undefined, {
    assertCurrent: async () => { if (written) throw Object.assign(new Error('Stale'), { code: 'stale_room_revision' }); },
    executeDecision: async () => { written = true; return successfulReceipt(0); }
  });
  const receipt = await executeConfirmationBatch(h.options);
  assert.equal(receipt.status, 'partial_success');
  assert.equal(receipt.error.code, 'stale_room_revision');
  assert.deepEqual(receipt.request_ids, ['RQ-261001-001']);
  assert.deepEqual(receipt.unattempted_indices, [1]);
});

test('initial abort prevents all callbacks and writes', async () => {
  const controller = new AbortController();
  controller.abort();
  const h = harness(undefined, { signal: controller.signal });
  const receipt = await executeConfirmationBatch(h.options);
  assert.equal(receipt.status, 'failed');
  assert.deepEqual(h.events, []);
  assert.deepEqual(receipt.unattempted_indices, [0, 1]);
});

test('batch shape and identity gates reject mixed, nested, duplicate, and oversized plans', () => {
  const cases = [
    [child('01')],
    Array.from({ length: 9 }, (_, index) => child(String(index + 1).padStart(2, '0'))),
    [child('01'), { ...child('02'), confirmation_requests: [child('03'), child('04')] }],
    [child('01'), { ...child('02'), staff_confirmed_registration: { target_scope: 'pending_request' } }],
    [child('01'), { ...child('02'), staff_confirmed_mutation: { target_scope: 'registered_trade' } }],
    [child('01'), { ...child('02'), reservation_inquiry: { already_registered: true } }],
    [child('01'), { ...child('02'), sheet_row_candidate: { ...child('02').sheet_row_candidate, customer_name: 'Another renter' } }],
    [child('01'), { ...child('02'), sheet_row_candidate: { ...child('02').sheet_row_candidate, phone: '010-9999-9999' } }],
    [child('01'), child('01')]
  ];
  for (const confirmation_requests of cases) {
    assert.equal(validateConfirmationBatchDecision({ confirmation_requests }, { validateDecision: () => ({ valid: true }) }).valid, false);
  }
});

test('typed pending revision and distinct new period can share a batch', () => {
  const revised = { ...child('01'), customer_requested_pending_revision: { request_id: 'RQ-260907-001' } };
  assert.equal(validateConfirmationBatchDecision({ confirmation_requests: [revised, child('02')] }, { validateDecision: () => ({ valid: true }) }).valid, true);
});

test('explicit uncertain write evidence stops even when a child labels its receipt ok', async () => {
  const h = harness();
  h.options.executeDecision = async (_child, index) => {
    h.events.push(`execute:${index}`);
    return buildReceipt({ status: 'ok', authoritativeSheetResult: { success: true, reqID: 'RQ-261001-001', uncertainWrite: true } });
  };
  const receipt = await executeConfirmationBatch(h.options);
  assert.equal(receipt.status, 'partial_success');
  assert.deepEqual(receipt.request_ids, ['RQ-261001-001']);
  assert.deepEqual(receipt.unattempted_indices, [1]);
  assert.deepEqual(h.events.filter(event => event.startsWith('execute:')), ['execute:0']);
});

test('resolved catalog child must still pass the complete decision schema before any write', async () => {
  const h = harness(undefined, {
    validateDecision: decision => ({ valid: Array.isArray(decision.sheet_row_candidate.equipment), errors: ['equipment required'] }),
    preflightDecision: async (decision, index) => ({ ok: true, decision: index === 1 ? { ...decision, sheet_row_candidate: { ...decision.sheet_row_candidate, equipment: null } } : decision })
  });
  const receipt = await executeConfirmationBatch(h.options);
  assert.equal(receipt.status, 'failed');
  assert.deepEqual(h.events, []);
});

test('preflight cannot mutate the authorized customer or period in place', async () => {
  const h = harness(undefined, {
    preflightDecision: async (decision, index) => {
      if (index === 1) decision.sheet_row_candidate.start_date = '2026-11-02';
      return { ok: true, decision };
    }
  });
  const receipt = await executeConfirmationBatch(h.options);
  assert.equal(receipt.status, 'failed');
  assert.deepEqual(h.events.filter(event => event.startsWith('execute:')), []);
});

test('already-applied trade evidence stays in its child receipt without inventing an RQ', async () => {
  const h = harness(undefined, {
    executeDecision: async (_child, index) => index === 0
      ? buildReceipt({ status: 'ok', authoritativeSheetResult: { success: true, alreadyRegistered: true, tradeID: '261001-001' } })
      : successfulReceipt(1)
  });
  const receipt = await executeConfirmationBatch(h.options);
  assert.equal(receipt.status, 'ok');
  assert.equal(receipt.request_results[0].authoritative_sheet_result.tradeID, '261001-001');
  assert.deepEqual(receipt.request_results[0].request_ids, []);
  assert.deepEqual(receipt.request_ids, ['RQ-261001-002']);
  assert.equal(receipt.authoritative_sheet_result.reqID, 'RQ-261001-002');
});

test('distinct periods cannot revise the same pending request twice', async () => {
  const first = { ...child('01'), existing_confirm_request_ids: ['RQ-260907-001'] };
  const second = { ...child('02'), existing_confirm_request_ids: [' rq-260907-001 '] };
  const h = harness([first, second]);
  const receipt = await executeConfirmationBatch(h.options);
  assert.equal(receipt.status, 'failed');
  assert.equal(receipt.error.code, 'invalid_decision');
  assert.deepEqual(h.events.filter(event => event.startsWith('execute:')), []);
  assert.deepEqual(h.events.filter(event => event.startsWith('preflight:')), []);
});
