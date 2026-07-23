'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  CAPABILITIES,
  catalog,
  executeOperation,
  operationRequestDigest,
  prepareOperation,
  runBroker
} = require('../scripts/windows/village-operation-broker.js');

const config = {
  VILLAGE2_API_URL: 'https://script.google.com/macros/s/example/exec',
  VILLAGE2_API_KEY: 'synthetic-key'
};

function response(payload, { ok = true, status = 200 } = {}) {
  return { ok, status, json: async () => payload };
}

test('the broker exposes a broad typed catalog without generic sheet-write or source-discovery routes', () => {
  const result = catalog();
  assert.equal(result.ok, true);
  assert.equal(result.aiRole, 'semantic_planner');
  assert.ok(result.capabilities.length >= 25, 'catalog must cover the normal Village operating surface');
  assert.ok(CAPABILITIES['schedule.change_dates']);
  assert.ok(CAPABILITIES['confirmation_request.create_batch']);
  assert.ok(CAPABILITIES['contract.regenerate']);
  assert.ok(CAPABILITIES['payment.update_method']);
  assert.ok(CAPABILITIES['operation.receipt']);
  assert.ok(CAPABILITIES['customer.send_estimate']);
  assert.equal(CAPABILITIES['sheet.write'], undefined);
  assert.equal(CAPABILITIES['api.run_function'], undefined);
  assert.doesNotMatch(JSON.stringify(result), /search_files|read_file|browser_navigate|raw curl/i);
});

test('prepare validates one AI-produced plan and never performs I/O', async () => {
  let fetchCalls = 0;
  const result = await prepareOperation({
    capability: 'schedule.change_dates',
    parameters: {
      tradeId: '260723-010',
      newStartDate: '2026-07-22',
      newEndDate: '2026-07-23'
    },
    authorization: { ownerApproved: true },
    fetchImpl: async () => { fetchCalls += 1; }
  });

  assert.equal(result.ok, true);
  assert.equal(result.ready, true);
  assert.equal(result.capability, 'schedule.change_dates');
  assert.equal(result.next, 'execute');
  assert.equal(fetchCalls, 0);
});

test('unsupported capabilities stop as a structured gap instead of inviting live source archaeology', async () => {
  const result = await prepareOperation({
    capability: 'made_up.live_mutation',
    parameters: {},
    authorization: { ownerApproved: true }
  });

  assert.deepEqual(result, {
    ok: false,
    ready: false,
    status: 'CAPABILITY_GAP',
    capability: 'made_up.live_mutation',
    liveSourceDiscoveryAllowed: false,
    developmentDiscoveryAllowed: true,
    mustResumeOriginalRequest: true,
    next: 'discover_validate_promote_confirm_resume',
    recordLearning: true
  });
});

test('a direct first-use execute also enters the learn-register-resume lifecycle', async () => {
  let calls = 0;
  const result = await executeOperation({
    config,
    capability: 'new.first_use_operation',
    parameters: {},
    authorization: { ownerApproved: true },
    fetchImpl: async () => { calls += 1; }
  });
  assert.equal(result.status, 'CAPABILITY_GAP');
  assert.equal(result.mustResumeOriginalRequest, true);
  assert.equal(result.next, 'discover_validate_promote_confirm_resume');
  assert.equal(calls, 0);
});

test('an internal write needs explicit owner authorization and accepts only the synchronous server acknowledgement', async () => {
  let calls = 0;
  const fetchImpl = async (url, options) => {
    calls += 1;
    assert.equal(options.method, 'POST');
    const body = JSON.parse(options.body);
    assert.equal(body.action, 'updatePayment');
    assert.equal(body.tid, '260723-010');
    assert.equal(body.method, 'card');
    assert.equal(body.key, 'synthetic-key');
    assert.ok(options.signal);
    return response({ success: true, tradeId: body.tid, method: body.method });
  };

  await assert.rejects(
    () => executeOperation({
      config,
      capability: 'payment.update_method',
      parameters: { tid: '260723-010', method: 'card' },
      authorization: {},
      fetchImpl
    }),
    /ownerApproved=true/
  );
  assert.equal(calls, 0);

  const result = await executeOperation({
    config,
    capability: 'payment.update_method',
    parameters: { tid: '260723-010', method: 'card' },
    authorization: { ownerApproved: true },
    fetchImpl
  });
  assert.equal(calls, 1);
  assert.equal(result.ok, true);
  assert.equal(result.capability, 'payment.update_method');
  assert.equal(result.executionCount, 1);
  assert.equal(result.verification, 'authoritative_server_ack');
  assert.equal(result.verified, true);
  assert.equal(result.readback, false);
  assert.doesNotMatch(JSON.stringify(result), /synthetic-key/);
});

test('a failed read is explicitly retry-safe and never becomes an uncertain write', async () => {
  const result = await runBroker({
    phase: 'execute',
    capability: 'inventory.lookup',
    parameters: { query: 'camera' }
  }, {
    config,
    handlers: {
      lookupVillage: async () => { throw new Error('synthetic read timeout'); }
    }
  });
  assert.equal(result.ok, false);
  assert.equal(result.status, 'READ_FAILED');
  assert.equal(result.policy, 'read_only');
  assert.equal(result.mutationMayHaveOccurred, false);
  assert.equal(result.retrySafe, true);
});

test('a write rejected before network access is retry-safe and never becomes uncertain', async () => {
  let calls = 0;
  const result = await runBroker({
    phase: 'execute',
    capability: 'equipment.add',
    parameters: { tid: '260723-010', equipName: 'FX3' },
    authorization: {},
    operationId: '11111111-1111-4111-8111-111111111111'
  }, {
    config,
    fetchImpl: async () => { calls += 1; return response({ success: true }); }
  });
  assert.equal(calls, 0);
  assert.equal(result.ok, false);
  assert.equal(result.status, 'REQUEST_REJECTED');
  assert.equal(result.mutationMayHaveOccurred, false);
  assert.equal(result.retrySafe, true);
});

test('a new capability has explicit validate promote confirm phases before resume', async () => {
  const calls = [];
  const promotionHandlers = {
    validateCandidate: async (request) => {
      calls.push(['validate', request.capability]);
      return { ok: true, validated: true, validationId: 'validation-1' };
    },
    promoteCandidate: async (request) => {
      calls.push(['promote', request.capability]);
      return { ok: true, promoted: true, promotionId: 'promotion-1' };
    },
    confirmRegistration: async (request) => {
      calls.push(['confirm', request.capability]);
      return { ok: true, confirmed: true, runtimeConfirmed: true, liveCatalogConfirmed: true };
    },
    rollbackPromotion: async (request) => {
      calls.push(['rollback', request.capability]);
      return { ok: true, rolledBack: true, promotionId: request.promotionId };
    }
  };

  const validated = await runBroker({
    phase: 'validate_candidate',
    capability: 'new.operation',
    candidateRoot: 'C:/Village/my-gas-project2'
  }, { promotionHandlers });
  assert.equal(validated.validationId, 'validation-1');

  await assert.rejects(
    () => runBroker({
      phase: 'promote',
      capability: 'new.operation',
      validationId: 'validation-1',
      authorization: { ownerApproved: true }
    }, { promotionHandlers }),
    /systemAdminApproved=true/
  );

  const promoted = await runBroker({
    phase: 'promote',
    capability: 'new.operation',
    validationId: 'validation-1',
    authorization: { ownerApproved: true, systemAdminApproved: true }
  }, { promotionHandlers });
  assert.equal(promoted.promotionId, 'promotion-1');

  const confirmed = await runBroker({
    phase: 'confirm_registration',
    capability: 'new.operation',
    promotionId: 'promotion-1'
  }, { promotionHandlers });
  assert.equal(confirmed.confirmed, true);

  await assert.rejects(
    () => runBroker({
      phase: 'rollback_promotion',
      capability: 'new.operation',
      promotionId: 'promotion-1',
      authorization: { ownerApproved: true }
    }, { promotionHandlers }),
    /systemAdminApproved=true/
  );
  const rolledBack = await runBroker({
    phase: 'rollback_promotion',
    capability: 'new.operation',
    promotionId: 'promotion-1',
    authorization: { ownerApproved: true, systemAdminApproved: true }
  }, { promotionHandlers });
  assert.equal(rolledBack.rolledBack, true);
  assert.deepEqual(calls, [
    ['validate', 'new.operation'],
    ['promote', 'new.operation'],
    ['confirm', 'new.operation'],
    ['rollback', 'new.operation']
  ]);
});

test('uncertain writes reconcile only through the original write capability authoritative reader', async () => {
  await assert.rejects(
    () => runBroker({
      phase: 'reconcile',
      originalCapability: 'payment.update_method',
      originalParameters: { tid: '260723-010', method: 'card' },
      capability: 'inventory.lookup',
      parameters: { query: 'camera' }
    }, { config }),
    /not an authoritative reconciliation path/
  );

  let calls = 0;
  let observedMethod = 'card';
  const reconcileRequest = {
    phase: 'reconcile',
    originalCapability: 'payment.update_method',
    originalParameters: { tid: '260723-010', method: 'card' },
    capability: 'finance.lookup',
    parameters: { query: '260723-010' }
  };
  const reconciliationDependencies = {
    config,
    handlers: {
      lookupVillage: async ({ domain, query }) => {
        assert.equal(domain, 'finance');
        assert.equal(query, '260723-010');
        calls += 1;
        return {
          ok: true,
          sheets: [{
            sheet: '거래내역',
            headers: ['거래ID', '결제수단'],
            results: [[query, observedMethod]]
          }]
        };
      }
    },
    fetchImpl: async () => {
      calls += 1;
      throw new Error('reconciliation must use the declared specialized reader');
    }
  };
  const result = await runBroker({
    ...reconcileRequest
  }, reconciliationDependencies);
  assert.equal(calls, 1);
  assert.equal(result.ok, true);
  assert.equal(result.reconciliation, true);
  assert.equal(result.verification, 'authoritative_read');
  assert.equal(result.originalCapability, 'payment.update_method');
  assert.equal(result.reconciliationOutcome, 'already_applied');

  observedMethod = 'cash';
  const notApplied = await runBroker(reconcileRequest, reconciliationDependencies);
  assert.equal(calls, 2);
  assert.equal(notApplied.ok, true);
  assert.equal(notApplied.reconciliationOutcome, 'not_applied');

  reconciliationDependencies.handlers.lookupVillage = async ({ query }) => ({
    ok: true,
    sheets: [{
      sheet: '발행처DB',
      headers: ['거래ID', '결제수단'],
      results: [[query, 'card']]
    }]
  });
  const wrongSheet = await runBroker(reconcileRequest, reconciliationDependencies);
  assert.equal(wrongSheet.ok, false);
  assert.equal(wrongSheet.status, 'RECONCILIATION_INDETERMINATE');
});

test('generic acknowledged writes reconcile through their durable operation receipt', async () => {
  const operationId = `${Math.floor(Date.now() / 1000)}-22222222-2222-4222-8222-222222222222`;
  let receiptStatus = 'applied';
  let receiptDigest = operationRequestDigest(
    'equipment.add',
    CAPABILITIES['equipment.add'],
    { tid: '260723-010', equipName: 'FX3' }
  );
  const request = {
    phase: 'reconcile',
    originalCapability: 'equipment.add',
    originalParameters: { tid: '260723-010', equipName: 'FX3' },
    originalOperationId: operationId,
    capability: 'operation.receipt',
    parameters: { operationId }
  };
  const fetchImpl = async (_url, options) => {
    const body = JSON.parse(options.body);
    assert.equal(body.action, 'operationReceipt');
    assert.equal(body.operationId, operationId);
    return response({
      success: true,
      found: !['not_found', 'expired'].includes(receiptStatus),
      status: receiptStatus,
      operationId,
      capability: 'equipment.add',
      requestDigest: receiptDigest,
      retrySafe: receiptStatus === 'not_found'
    });
  };

  const applied = await runBroker(request, { config, fetchImpl });
  assert.equal(applied.ok, true);
  assert.equal(applied.reconciliationOutcome, 'already_applied');

  receiptStatus = 'not_found';
  const absent = await runBroker(request, { config, fetchImpl });
  assert.equal(absent.ok, true);
  assert.equal(absent.reconciliationOutcome, 'not_applied');

  receiptStatus = 'in_progress';
  const pending = await runBroker(request, { config, fetchImpl });
  assert.equal(pending.ok, false);
  assert.equal(pending.status, 'RECONCILIATION_INDETERMINATE');

  receiptStatus = 'expired';
  const expired = await runBroker(request, { config, fetchImpl });
  assert.equal(expired.ok, false);
  assert.equal(expired.reconciliationOutcome, 'indeterminate');

  receiptStatus = 'applied';
  receiptDigest = 'wrong-request-digest';
  const mismatched = await runBroker(request, { config, fetchImpl });
  assert.equal(mismatched.ok, false);
  assert.equal(mismatched.reconciliationReason, 'receipt_identity_mismatch');
});

test('customer-facing sends require a separate current-request approval', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return response({ success: true });
  };
  await assert.rejects(
    () => executeOperation({
      config,
      capability: 'customer.send_estimate',
      parameters: { tid: '260723-010' },
      authorization: { ownerApproved: true },
      fetchImpl
    }),
    /customerSendApproved=true/
  );
  assert.equal(calls, 0);
});

test('specialized capabilities retain their authoritative readback runners', async () => {
  let called = 0;
  const result = await executeOperation({
    config,
    capability: 'schedule.change_dates',
    parameters: {
      tradeId: '260723-010',
      newStartDate: '2026-07-22',
      newEndDate: '2026-07-23'
    },
    authorization: { ownerApproved: true },
    handlers: {
      changeTradeDates: async ({ input }) => {
        called += 1;
        assert.equal(input.tradeId, '260723-010');
        return { ok: true, verified: true, tradeId: input.tradeId };
      }
    }
  });

  assert.equal(called, 1);
  assert.equal(result.ok, true);
  assert.equal(result.verification, 'authoritative_readback');
  assert.equal(result.executionCount, 1);
});
