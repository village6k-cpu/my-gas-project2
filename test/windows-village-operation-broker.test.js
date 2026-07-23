'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  CAPABILITIES,
  catalog,
  executeOperation,
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

test('an internal write needs explicit owner authorization and never claims a server response is readback', async () => {
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
  assert.equal(result.ok, false);
  assert.equal(result.status, 'UNVERIFIED_WRITE');
  assert.equal(result.capability, 'payment.update_method');
  assert.equal(result.executionCount, 1);
  assert.equal(result.verification, 'unverified_server_result');
  assert.equal(result.verified, false);
  assert.equal(result.mutationMayHaveOccurred, true);
  assert.equal(result.retryAllowed, false);
  assert.doesNotMatch(JSON.stringify(result), /synthetic-key/);
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
  assert.deepEqual(calls, [
    ['validate', 'new.operation'],
    ['promote', 'new.operation'],
    ['confirm', 'new.operation']
  ]);
});

test('uncertain writes reconcile only through a registered read-only capability', async () => {
  await assert.rejects(
    () => runBroker({
      phase: 'reconcile',
      capability: 'payment.update_method',
      parameters: { tid: '260723-010', method: 'card' }
    }, { config }),
    /read_only capability/
  );

  let calls = 0;
  const result = await runBroker({
    phase: 'reconcile',
    capability: 'schedule.timeline',
    parameters: { from: '2026-07-23', to: '2026-07-23' }
  }, {
    config,
    fetchImpl: async (_url, options) => {
      calls += 1;
      assert.equal(JSON.parse(options.body).action, 'timeline');
      return response({ success: true, items: [] });
    }
  });
  assert.equal(calls, 1);
  assert.equal(result.ok, true);
  assert.equal(result.reconciliation, true);
  assert.equal(result.verification, 'authoritative_read');
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
