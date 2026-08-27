import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { createHermesGatewayChannel } from './hermes-gateway-channel.mjs';
import {
  createHermesGatewayHttpHandler,
  registeredReservationChangeRequestDigest,
  validateRegisteredReservationChangeBody
} from './hermes-gateway-http.mjs';

function canonicalTestJson(value) {
  if (Array.isArray(value)) return value.map(canonicalTestJson);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalTestJson(value[key])]));
  }
  return value;
}

function expectedConfirmationRequestDigest(body) {
  const payload = {
    schema: body.schema || 'village-confirmation-request/v1',
    job_id: body.job_id,
    room_key: body.room_key,
    room_revision: body.room_revision,
    decision: body.decision
  };
  return createHash('sha256').update(JSON.stringify(canonicalTestJson(payload))).digest('hex');
}

function expectedDocumentRequestDigest(body) {
  const payload = {
    schema: body.schema || 'village-document-request/v1',
    job_id: body.job_id,
    room_key: body.room_key,
    room_revision: body.room_revision,
    document_type: body.document_type,
    trade_id: body.trade_id,
    tax_mode: body.tax_mode
  };
  return createHash('sha256').update(JSON.stringify(canonicalTestJson(payload))).digest('hex');
}

function expectedRegisteredReservationChangeDigest(body) {
  const payload = {
    schema: body.schema,
    job_id: body.job_id,
    room_key: body.room_key,
    room_revision: body.room_revision,
    lease_id: body.lease_id,
    mutation: body.mutation
  };
  return createHash('sha256').update(JSON.stringify(canonicalTestJson(payload))).digest('hex');
}

function registeredMutation(overrides = {}) {
  return {
    confirmed: true,
    kind: 'equipment_replace',
    target_scope: 'registered_trade',
    trade_id: '260824-008',
    source_evidence: {
      customer_request: '기존 렌즈 대신 다른 렌즈를 요청함',
      staff_confirmation: '직원이 교체 확정함',
      conversation_revision: 3
    },
    expected_period: {
      start_date: '2026-08-28', start_time: '09:00', end_date: '2026-08-29', end_time: '18:00'
    },
    expected_before: [{ schedule_id: '260824-008-07', name: '소니 FE 28-135mm', quantity: 1 }],
    desired_after: [{ name: '소니 GM 70-200mm II', quantity: 1 }],
    date_change: null,
    ...overrides
  };
}

function registeredChangeBody(overrides = {}) {
  return {
    schema: 'village-registered-reservation-change-request/v1',
    job_id: 'job-1', room_key: 'room-1', room_revision: 3, lease_id: leaseId,
    mutation: registeredMutation(),
    ...overrides
  };
}

function registeredChangeReceipt(request, overrides = {}) {
  return {
    schema: 'village-registered-reservation-change-receipt/v1',
    receipt_id: 'registered-change-receipt-1',
    job_id: request.job_id, room_key: request.room_key, room_revision: request.room_revision,
    status: 'ok', target_scope: 'registered_trade', trade_id: request.mutation.trade_id,
    mutation_kind: request.mutation.kind, authoritative_result: { verified: true },
    applied_stages: ['schedule_rows'], attempted_stage: null, customer_reply: 'no_reply',
    created_at: '2026-08-21T00:00:00.000Z', error: null,
    ...overrides
  };
}

const token = 'test-token-not-a-secret';
const leaseId = 'lease-opaque-1';

function makeChannel() {
  const calls = { claim: [], complete: [], outcome: [], reservation: [], receipt: [], get: [] };
  const job = {
    job_id: 'job-1', room_key: 'room-1', room_revision: 3, state: 'claimed', lease_id: leaseId,
    lease_expires_at_ms: 9_999_999_999_999, tool_operation: null, tool_receipts: []
  };
  return {
    calls,
    async claim(options) {
      calls.claim.push(options);
      return {
        job_id: 'job-1', room_key: 'room-1', room_revision: 3, lease_id: leaseId,
        event: {
          schema: 'village-kakao-gateway-event/v1', job_id: 'job-1', room_key: 'room-1',
          room_revision: 3, prompt: 'read only', detected_at: '2026-08-21T00:00:00.000Z', raw: { bounded: true }
        }
      };
    },
    async complete(body) { calls.complete.push(body); return { state: 'completed' }; },
    async recordOutcome(body) { calls.outcome.push(body); return { state: 'failed' }; },
    async reserveToolOperation(body) {
      calls.reservation.push(structuredClone(body));
      if (job.tool_operation) return { created: false, reservation: structuredClone(job.tool_operation) };
      job.tool_operation = {
        schema: 'village-tool-operation-reservation/v1', operation_id: 'operation-opaque-1',
        state: 'reserved', created_at: '2026-08-21T00:00:00.000Z', ...structuredClone(body)
      };
      return { created: true, reservation: structuredClone(job.tool_operation) };
    },
    async recordToolReceipt(body) {
      calls.receipt.push(body);
      job.tool_receipts.push(structuredClone(body));
      if (job.tool_operation) {
        job.tool_operation = { ...job.tool_operation, state: 'completed', receipt_id: body.receipt_id };
      }
      return structuredClone(job);
    },
    async get(jobId) {
      calls.get.push(jobId);
      return structuredClone({ ...job, job_id: jobId });
    },
    setJob(patch) { Object.assign(job, structuredClone(patch)); },
    async status() {
      return {
        counts: { ready: 2, claimed: 1, completed: 4, superseded: 0, retry_wait: 0, failed: 0 },
        application_counts: { pending: 1, claimed: 0, applying: 0, applied: 0, finalized: 2, failed: 1 },
        failure_notification_counts: { pending: 2, delivered: 3 },
        unnotified_application_failures: 1,
        oldest_lease_age_ms: 1234,
        last_completed_job_id: 'private-job',
        last_consumer_id: 'gateway-test-consumer',
        last_consumer_seen_at: '2026-08-21T00:00:00.000Z',
        registered_reservation_change: {
          reserved: 1, completed: 2, failed_human_review: 3, pending_failure_notifications: 4,
          oldest_reserved_age_ms: 5678, last_success_at: '2026-08-20T23:59:00.000Z'
        },
        token: 'must-not-leak', prompt: 'must-not-leak', local_context: { secret: true }
      };
    }
  };
}

async function start(handler) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (!(await handler(req, res, url))) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end('{}');
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  };
}

function gatewayFetch(base, pathname, init = {}) {
  return fetch(base + pathname, {
    ...init,
    headers: { authorization: `Bearer ${token}`, ...(init.headers || {}) }
  });
}

async function withRealGatewayChannel(run) {
  const directory = await mkdtemp(path.join(tmpdir(), 'hermes-gateway-http-'));
  const clock = { now: Date.parse('2026-08-21T00:00:00.000Z') };
  const channel = createHermesGatewayChannel({ directory, leaseMs: 1_000, maxAttempts: 2, now: () => clock.now });
  try {
    await run({ channel, clock, directory });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('Gateway HTTP claims a snake-case event with its opaque lease id', async () => {
  const channel = makeChannel();
  const app = await start(createHermesGatewayHttpHandler({ token, channel, transport: 'gateway' }));
  try {
    const response = await gatewayFetch(app.url, '/hermes/v1/events?consumer_id=gateway-1&wait_ms=25000');
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(channel.calls.claim, [{ consumerId: 'gateway-1', waitMs: 25000 }]);
    assert.equal(body.event.job_id, 'job-1');
    assert.equal(body.event.room_key, 'room-1');
    assert.equal(body.event.room_revision, 3);
    assert.equal(body.event.lease_id, leaseId);
    assert.equal(body.event.schema, 'village-kakao-gateway-event/v1');
    assert.deepEqual(Object.keys(body.event).sort(), [
      'detected_at', 'job_id', 'lease_id', 'prompt', 'raw', 'room_key', 'room_revision', 'schema'
    ]);
    assert.equal('local_context' in body.event, false);
  } finally {
    await app.close();
  }
});

test('Gateway HTTP executes and durably receipts one exact native supply-only quote send', async () => {
  const channel = makeChannel();
  let executions = 0;
  const body = {
    schema: 'village-document-request/v1', job_id: 'job-1', room_key: 'room-1', room_revision: 3,
    lease_id: leaseId, document_type: 'quote', trade_id: '260822-001', tax_mode: 'supply_only'
  };
  const app = await start(createHermesGatewayHttpHandler({
    token, channel, transport: 'gateway',
    executeDocument: async (request) => {
      executions += 1;
      assert.deepEqual(request, body);
      return {
        schema: 'village-document-receipt/v1', receipt_id: 'document-receipt-1',
        job_id: 'job-1', room_key: 'room-1', room_revision: 3, status: 'ok',
        document_type: 'quote', trade_id: '260822-001', tax_mode: 'supply_only',
        authoritative_document_result: { status: 'OK', tradeID: '260822-001', taxMode: 'supply_only' },
        created_at: '2026-08-24T01:00:00.000Z', error: null
      };
    }
  }));
  try {
    const init = { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
    const first = await gatewayFetch(app.url, '/hermes/v1/tools/document-send', init);
    const firstReceipt = await first.json();
    const second = await gatewayFetch(app.url, '/hermes/v1/tools/document-send', init);
    const secondReceipt = await second.json();

    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.equal(executions, 1);
    assert.deepEqual(secondReceipt, firstReceipt);
    assert.deepEqual(channel.calls.reservation, [{
      tool: 'document_send', job_id: 'job-1', room_key: 'room-1', room_revision: 3,
      lease_id: leaseId, request_digest: expectedDocumentRequestDigest(body)
    }]);
    assert.equal(channel.calls.receipt.length, 1);
    assert.equal(channel.calls.receipt[0].schema, 'village-document-receipt/v1');
    assert.equal(channel.calls.receipt[0].operation_id, 'operation-opaque-1');
  } finally {
    await app.close();
  }
});

test('registered change digest is lease-correlated, complete, and invariant to object key order', () => {
  const first = registeredChangeBody();
  const reordered = {
    mutation: {
      date_change: null,
      desired_after: [{ quantity: 1, name: '소니 GM 70-200mm II' }],
      expected_before: [{ quantity: 1, name: '소니 FE 28-135mm', schedule_id: '260824-008-07' }],
      expected_period: { end_time: '18:00', end_date: '2026-08-29', start_time: '09:00', start_date: '2026-08-28' },
      source_evidence: {
        conversation_revision: 3, staff_confirmation: '직원이 교체 확정함', customer_request: '기존 렌즈 대신 다른 렌즈를 요청함'
      },
      trade_id: '260824-008', target_scope: 'registered_trade', kind: 'equipment_replace', confirmed: true
    },
    lease_id: leaseId, room_revision: 3, room_key: 'room-1', job_id: 'job-1',
    schema: 'village-registered-reservation-change-request/v1'
  };
  const digest = expectedRegisteredReservationChangeDigest(first);
  assert.equal(registeredReservationChangeRequestDigest(first), digest);
  assert.equal(registeredReservationChangeRequestDigest(reordered), digest);
  for (const changed of [
    { ...first, schema: 'village-registered-reservation-change-request/v2' },
    { ...first, job_id: 'job-2' },
    { ...first, room_key: 'room-2' },
    { ...first, room_revision: 4 },
    { ...first, lease_id: 'lease-2' },
    { ...first, mutation: registeredMutation({ kind: 'equipment_add' }) }
  ]) {
    assert.notEqual(registeredReservationChangeRequestDigest(changed), digest);
  }
  assert.equal(validateRegisteredReservationChangeBody(first), true);
  assert.equal(validateRegisteredReservationChangeBody({ ...first, unexpected: true }), false);
  assert.equal(validateRegisteredReservationChangeBody({
    ...first, mutation: { ...first.mutation, target_scope: 'pending_request', request_id: 'RQ-260827-001' }
  }), false);
});

test('Gateway HTTP publishes one in-flight registered change and coalesces only its exact digest', async () => {
  const channel = makeChannel();
  const request = registeredChangeBody();
  let releaseExecution;
  const executionGate = new Promise((resolve) => { releaseExecution = resolve; });
  let markExecutionStarted;
  const executionStarted = new Promise((resolve) => { markExecutionStarted = resolve; });
  let executions = 0;
  const app = await start(createHermesGatewayHttpHandler({
    token, channel, transport: 'gateway',
    executeRegisteredReservationChange: async (body) => {
      executions += 1;
      markExecutionStarted();
      await executionGate;
      return registeredChangeReceipt(body, { receipt_id: 'registered-concurrent-receipt' });
    }
  }));
  try {
    const post = (body) => gatewayFetch(app.url, '/hermes/v1/tools/registered-reservation-change', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
    });
    const firstPromise = post(request);
    await executionStarted;
    const duplicatePromise = post(request);
    const conflicting = await post({
      ...request,
      mutation: registeredMutation({ desired_after: [{ name: '다른 렌즈', quantity: 1 }] })
    });
    assert.equal(conflicting.status, 409);
    assert.deepEqual(await conflicting.json(), { error: 'registered_reservation_change_conflict' });
    releaseExecution();
    const [first, duplicate] = await Promise.all([firstPromise, duplicatePromise]);
    assert.deepEqual([first.status, duplicate.status], [200, 200]);
    assert.deepEqual(await duplicate.json(), await first.json());
    assert.equal(executions, 1);
    assert.equal(channel.calls.reservation.length, 1);
    assert.equal(channel.calls.receipt.length, 1);
  } finally {
    releaseExecution?.();
    await app.close();
  }
});

test('Gateway HTTP executes and persists one exact fenced registered reservation change receipt', async () => {
  const channel = makeChannel();
  const request = registeredChangeBody();
  let executions = 0;
  let receivedFence = null;
  const app = await start(createHermesGatewayHttpHandler({
    token, channel, transport: 'gateway',
    executeRegisteredReservationChange: async (body, { assertCurrentClaim, operationFence }) => {
      executions += 1;
      receivedFence = operationFence;
      assert.deepEqual(body, request);
      await assertCurrentClaim();
      return registeredChangeReceipt(body);
    }
  }));
  try {
    const response = await gatewayFetch(app.url, '/hermes/v1/tools/registered-reservation-change', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request)
    });
    assert.equal(response.status, 200);
    const receipt = await response.json();
    const requestDigest = expectedRegisteredReservationChangeDigest(request);
    assert.equal(executions, 1);
    assert.deepEqual(channel.calls.reservation, [{
      tool: 'registered_reservation_change', job_id: 'job-1', room_key: 'room-1', room_revision: 3,
      lease_id: leaseId, request_digest: requestDigest
    }]);
    assert.equal(receivedFence.operation_id, 'operation-opaque-1');
    assert.deepEqual(receipt, {
      ...registeredChangeReceipt(request), lease_id: leaseId, request_digest: requestDigest,
      operation_id: 'operation-opaque-1'
    });
    assert.deepEqual(channel.calls.receipt, [receipt]);
  } finally {
    await app.close();
  }
});

test('Gateway HTTP reuses a registered change receipt for a semantic key-order retry', async () => {
  const channel = makeChannel();
  const request = registeredChangeBody();
  const reordered = {
    ...request,
    mutation: {
      ...request.mutation,
      source_evidence: {
        conversation_revision: 3,
        staff_confirmation: request.mutation.source_evidence.staff_confirmation,
        customer_request: request.mutation.source_evidence.customer_request
      },
      expected_before: [{ quantity: 1, name: '소니 FE 28-135mm', schedule_id: '260824-008-07' }]
    }
  };
  let executions = 0;
  const app = await start(createHermesGatewayHttpHandler({
    token, channel, transport: 'gateway',
    executeRegisteredReservationChange: async (body) => {
      executions += 1;
      return registeredChangeReceipt(body);
    }
  }));
  try {
    const post = (body) => gatewayFetch(app.url, '/hermes/v1/tools/registered-reservation-change', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
    });
    const first = await post(request);
    const second = await post(reordered);
    assert.deepEqual([first.status, second.status], [200, 200]);
    assert.deepEqual(await second.json(), await first.json());
    assert.equal(executions, 1);
    assert.equal(channel.calls.reservation.length, 1);
    assert.equal(channel.calls.receipt.length, 1);
  } finally {
    await app.close();
  }
});

test('Gateway HTTP conflicts a different typed mutation under the same registered change claim', async () => {
  const channel = makeChannel();
  const request = registeredChangeBody();
  let executions = 0;
  const app = await start(createHermesGatewayHttpHandler({
    token, channel, transport: 'gateway',
    executeRegisteredReservationChange: async (body) => {
      executions += 1;
      return registeredChangeReceipt(body);
    }
  }));
  try {
    const post = (body) => gatewayFetch(app.url, '/hermes/v1/tools/registered-reservation-change', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
    });
    assert.equal((await post(request)).status, 200);
    const conflict = await post({
      ...request,
      mutation: registeredMutation({
        desired_after: [{ name: '소니 GM 24-70mm II', quantity: 1 }]
      })
    });
    assert.equal(conflict.status, 409);
    assert.deepEqual(await conflict.json(), { error: 'registered_reservation_change_conflict' });
    assert.equal(executions, 1);
    assert.equal(channel.calls.reservation.length, 1);
  } finally {
    await app.close();
  }
});

test('Gateway HTTP rejects an expired registered change lease before reservation or execution', async () => {
  const channel = makeChannel();
  channel.setJob({ lease_expires_at_ms: 999 });
  let executions = 0;
  const app = await start(createHermesGatewayHttpHandler({
    token, channel, transport: 'gateway', now: () => 1000,
    executeRegisteredReservationChange: async () => { executions += 1; }
  }));
  try {
    const response = await gatewayFetch(app.url, '/hermes/v1/tools/registered-reservation-change', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(registeredChangeBody())
    });
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), { error: 'stale_lease' });
    assert.equal(executions, 0);
    assert.equal(channel.calls.reservation.length, 0);
  } finally {
    await app.close();
  }
});

test('Gateway HTTP persists exact late registered change evidence after expiry or same-room supersession', async () => {
  await withRealGatewayChannel(async ({ channel, clock }) => {
    const claims = {};
    for (const scenario of ['expiry', 'supersession']) {
      await channel.enqueue({ job_id: `registered-${scenario}`, room_key: `registered-${scenario}-room`, room_revision: 1 });
      claims[scenario] = await channel.claim({ consumerId: 'gateway-registered-change', waitMs: 0 });
    }
    let executions = 0;
    const app = await start(createHermesGatewayHttpHandler({
      token, channel, transport: 'gateway', now: () => clock.now,
      executeRegisteredReservationChange: async (request, { operationFence }) => {
        executions += 1;
        if (request.job_id === claims.expiry.job_id) {
          clock.now += 1_000;
        } else {
          await channel.enqueue({
            job_id: 'registered-superseding-turn', room_key: request.room_key, room_revision: request.room_revision + 1
          });
        }
        return registeredChangeReceipt(request, {
          receipt_id: `${request.job_id}-receipt`, operation_id: operationFence.operation_id
        });
      }
    }));
    try {
      for (const claim of [claims.supersession, claims.expiry]) {
        const response = await gatewayFetch(app.url, '/hermes/v1/tools/registered-reservation-change', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify(registeredChangeBody({
            job_id: claim.job_id, room_key: claim.room_key, room_revision: claim.room_revision,
            lease_id: claim.lease_id,
            mutation: registeredMutation({
              source_evidence: {
                ...registeredMutation().source_evidence,
                conversation_revision: claim.room_revision
              }
            })
          }))
        });
        assert.equal(response.status, 200);
        const receipt = await response.json();
        const persisted = await channel.get(claim.job_id);
        assert.equal(persisted.tool_operation.operation_id, receipt.operation_id);
        assert.equal(persisted.tool_operation.state, 'completed');
        assert.equal(persisted.tool_receipts.length, 1);
      }
      assert.equal(executions, 2);
    } finally {
      await app.close();
    }
  });
});

test('Gateway HTTP returns registered change unresolved after restart without replay', async () => {
  await withRealGatewayChannel(async ({ channel, clock, directory }) => {
    await channel.enqueue({ job_id: 'registered-unresolved', room_key: 'registered-unresolved-room', room_revision: 1 });
    const claim = await channel.claim({ consumerId: 'gateway-registered-change', waitMs: 0 });
    const request = registeredChangeBody({
      job_id: claim.job_id, room_key: claim.room_key, room_revision: claim.room_revision, lease_id: claim.lease_id,
      mutation: registeredMutation({
        source_evidence: { ...registeredMutation().source_evidence, conversation_revision: claim.room_revision }
      })
    });
    await channel.reserveToolOperation({
      tool: 'registered_reservation_change', job_id: claim.job_id, room_key: claim.room_key,
      room_revision: claim.room_revision, lease_id: claim.lease_id,
      request_digest: expectedRegisteredReservationChangeDigest(request)
    });
    const restarted = createHermesGatewayChannel({ directory, leaseMs: 1_000, maxAttempts: 2, now: () => clock.now });
    const review = await restarted.get(claim.job_id);
    assert.equal(review.state, 'failed');
    assert.equal(review.human_review_required, true);
    assert.equal(review.error.type, 'confirmation_operation_unresolved');
    assert.equal(review.error.operation_state, 'reserved');
    assert.equal(review.failure_notification.state, 'pending');
    assert.equal(await restarted.claim({ consumerId: 'gateway-after-restart', waitMs: 0 }), null);
    let executions = 0;
    const app = await start(createHermesGatewayHttpHandler({
      token, channel: restarted, transport: 'gateway', now: () => clock.now,
      executeRegisteredReservationChange: async () => { executions += 1; }
    }));
    try {
      const response = await gatewayFetch(app.url, '/hermes/v1/tools/registered-reservation-change', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request)
      });
      assert.equal(response.status, 409);
      assert.deepEqual(await response.json(), { error: 'registered_reservation_change_unresolved' });
      assert.equal(executions, 0);
    } finally {
      await app.close();
    }
  });
});

test('Gateway HTTP gateway_no_send rejects registered changes before reservation or execution', async () => {
  const channel = makeChannel();
  let executions = 0;
  const app = await start(createHermesGatewayHttpHandler({
    token, channel, transport: 'gateway_no_send',
    executeRegisteredReservationChange: async () => { executions += 1; }
  }));
  try {
    const response = await gatewayFetch(app.url, '/hermes/v1/tools/registered-reservation-change', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(registeredChangeBody())
    });
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { error: 'writes_disabled' });
    assert.equal(channel.calls.reservation.length, 0);
    assert.equal(executions, 0);
  } finally {
    await app.close();
  }
});

test('Gateway HTTP emits exact durable seven-field event plus lease and never local context', async () => {
  await withRealGatewayChannel(async ({ channel }) => {
    const event = {
      schema: 'village-kakao-gateway-event/v1', job_id: 'job-contract', room_key: 'room-contract',
      room_revision: 4, prompt: '정확한 이벤트', detected_at: '2026-08-21T00:00:00.000Z', raw: { safe: '근거' }
    };
    await channel.enqueue(event, { localContext: { secret: 'local-only' } });
    const app = await start(createHermesGatewayHttpHandler({ token, channel, transport: 'gateway' }));
    try {
      const response = await gatewayFetch(app.url, '/hermes/v1/events?consumer_id=gateway-contract&wait_ms=0');
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.deepEqual(
        Object.fromEntries(Object.entries(body.event).filter(([key]) => key !== 'lease_id')),
        event
      );
      assert.match(body.event.lease_id, /\S/);
      assert.deepEqual(Object.keys(body.event).sort(), [
        'detected_at', 'job_id', 'lease_id', 'prompt', 'raw', 'room_key', 'room_revision', 'schema'
      ]);
      assert.equal(JSON.stringify(body).includes('local-only'), false);
    } finally {
      await app.close();
    }
  });
});

test('Gateway HTTP reclaims one no_final event once and exposes no third lease', async () => {
  await withRealGatewayChannel(async ({ channel }) => {
    const event = {
      schema: 'village-kakao-gateway-event/v1', job_id: 'job-no-final-retry', room_key: 'room-no-final-retry',
      room_revision: 1, prompt: 'retry the exact turn', detected_at: '2026-08-21T00:00:00.000Z', raw: { bounded: true }
    };
    await channel.enqueue(event, { localContext: { local: 'preserved' } });
    const app = await start(createHermesGatewayHttpHandler({ token, channel, transport: 'gateway' }));
    try {
      const firstResponse = await gatewayFetch(app.url, '/hermes/v1/events?consumer_id=gateway-retry-1&wait_ms=0');
      const first = (await firstResponse.json()).event;
      const firstOutcome = await gatewayFetch(app.url, '/hermes/v1/outcomes', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...first, outcome: 'no_final' })
      });
      assert.equal(firstOutcome.status, 200);

      const secondResponse = await gatewayFetch(app.url, '/hermes/v1/events?consumer_id=gateway-retry-2&wait_ms=0');
      const second = (await secondResponse.json()).event;
      assert.equal(second.job_id, first.job_id);
      assert.notEqual(second.lease_id, first.lease_id);
      assert.equal(JSON.stringify(second).includes('preserved'), false);
      const secondOutcome = await gatewayFetch(app.url, '/hermes/v1/outcomes', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...second, outcome: 'no_final' })
      });
      assert.equal(secondOutcome.status, 200);

      const exhaustedResponse = await gatewayFetch(app.url, '/hermes/v1/events?consumer_id=gateway-retry-3&wait_ms=0');
      assert.deepEqual(await exhaustedResponse.json(), { event: null });
      const exhausted = await channel.get(first.job_id);
      assert.equal(exhausted.state, 'failed');
      assert.equal(exhausted.failure_notification.state, 'pending');
    } finally {
      await app.close();
    }
  });
});

test('Gateway HTTP requires its bearer token and does not echo it', async () => {
  const app = await start(createHermesGatewayHttpHandler({ token, channel: makeChannel(), transport: 'gateway' }));
  try {
    for (const authorization of ['', 'Bearer wrong-token']) {
      const response = await fetch(app.url + '/hermes/v1/status', { headers: authorization ? { authorization } : {} });
      assert.equal(response.status, 401);
      assert.equal((await response.text()).includes(token), false);
    }
  } finally {
    await app.close();
  }
});

test('Gateway HTTP rejects a non-loopback peer before reading its request', async () => {
  const handler = createHermesGatewayHttpHandler({ token, channel: makeChannel(), transport: 'gateway' });
  const req = Object.assign(new EventEmitter(), {
    method: 'GET', headers: { authorization: `Bearer ${token}` }, socket: { remoteAddress: '10.0.0.8' }
  });
  const response = { status: null, body: '', writeHead(status) { this.status = status; }, end(body = '') { this.body = body; } };
  const handled = await handler(req, response, new URL('http://bridge.local/hermes/v1/status'));
  assert.equal(handled, true);
  assert.equal(response.status, 403);
  assert.equal(response.body.includes(token), false);
});

test('Gateway HTTP forwards the exact lease id for results and outcomes', async () => {
  const channel = makeChannel();
  const app = await start(createHermesGatewayHttpHandler({ token, channel, transport: 'gateway' }));
  const base = { job_id: 'job-1', room_key: 'room-1', room_revision: 3, lease_id: leaseId };
  try {
    for (const [pathname, body] of [
      ['/hermes/v1/results', { ...base, final: { reply_mode: 'draft_only' } }],
      ['/hermes/v1/outcomes', { ...base, outcome: 'no_final' }]
    ]) {
      const response = await gatewayFetch(app.url, pathname, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      assert.equal(response.status, 200);
    }
    assert.equal(channel.calls.complete[0].lease_id, leaseId);
    assert.equal(channel.calls.outcome[0].lease_id, leaseId);
    const missing = await gatewayFetch(app.url, '/hermes/v1/results', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...base, lease_id: '' }) });
    assert.equal(missing.status, 400);
  } finally {
    await app.close();
  }
});

test('Gateway HTTP hands the durably completed result to the local application enqueue seam', async () => {
  const channel = makeChannel();
  const enqueued = [];
  channel.complete = async (body) => {
    channel.calls.complete.push(body);
    return {
      state: 'completed', job_id: body.job_id, room_key: body.room_key,
      room_revision: body.room_revision, result: body, application: { state: 'pending' }
    };
  };
  const app = await start(createHermesGatewayHttpHandler({
    token, channel, transport: 'gateway',
    enqueueResultApplication: async (job) => { enqueued.push(structuredClone(job)); }
  }));
  try {
    const body = {
      job_id: 'job-1', room_key: 'room-1', room_revision: 3,
      lease_id: leaseId, content: 'FINAL_JSON {}'
    };
    const response = await gatewayFetch(app.url, '/hermes/v1/results', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
    });
    assert.equal(response.status, 200);
    assert.equal(enqueued.length, 1);
    assert.equal(enqueued[0].application.state, 'pending');
    assert.deepEqual(enqueued[0].result, body);
  } finally {
    await app.close();
  }
});

test('Gateway HTTP rejects a result submitted before its reserved confirmation receipt and persists human review', async () => {
  await withRealGatewayChannel(async ({ channel, clock }) => {
    await channel.enqueue({ job_id: 'job-result-http', room_key: 'room-result-http', room_revision: 1 });
    const claim = await channel.claim({ consumerId: 'gateway-1', waitMs: 0 });
    await channel.reserveToolOperation({
      tool: 'confirmation_request', job_id: claim.job_id, room_key: claim.room_key,
      room_revision: claim.room_revision, lease_id: claim.lease_id, request_digest: 'digest-http-result'
    });
    const app = await start(createHermesGatewayHttpHandler({
      token, channel, transport: 'gateway', now: () => clock.now
    }));
    try {
      const response = await gatewayFetch(app.url, '/hermes/v1/results', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          job_id: claim.job_id, room_key: claim.room_key, room_revision: claim.room_revision,
          lease_id: claim.lease_id, final: { reply_mode: 'draft_only' }
        })
      });
      assert.equal(response.status, 409);
      assert.deepEqual(await response.json(), { error: 'confirmation_operation_unresolved' });
      const failed = await channel.get(claim.job_id);
      assert.equal(failed.state, 'failed');
      assert.equal(failed.human_review_required, true);
      assert.equal(failed.error.type, 'confirmation_operation_unresolved');
    } finally {
      await app.close();
    }
  });
});

test('Gateway HTTP wrong-lease results and no_final outcomes leave reserved operations untouched', async () => {
  await withRealGatewayChannel(async ({ channel, clock }) => {
    const cases = [
      { pathname: '/hermes/v1/results', suffix: 'result', payload: { final: { reply_mode: 'draft_only' } } },
      { pathname: '/hermes/v1/outcomes', suffix: 'outcome', payload: { outcome: 'no_final' } }
    ];
    const app = await start(createHermesGatewayHttpHandler({
      token, channel, transport: 'gateway', now: () => clock.now
    }));
    try {
      for (const entry of cases) {
        await channel.enqueue({
          job_id: `job-http-wrong-${entry.suffix}`,
          room_key: `room-http-wrong-${entry.suffix}`,
          room_revision: 1
        });
        const claim = await channel.claim({ consumerId: 'gateway-1', waitMs: 0 });
        const requestDigest = `digest-http-wrong-${entry.suffix}`;
        const reserved = await channel.reserveToolOperation({
          tool: 'confirmation_request', job_id: claim.job_id, room_key: claim.room_key,
          room_revision: claim.room_revision, lease_id: claim.lease_id, request_digest: requestDigest
        });
        const original = await channel.get(claim.job_id);
        const wrong = await gatewayFetch(app.url, entry.pathname, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            job_id: claim.job_id, room_key: claim.room_key, room_revision: claim.room_revision,
            lease_id: 'different-lease', ...entry.payload
          })
        });
        assert.equal(wrong.status, 409);
        assert.deepEqual(await wrong.json(), { error: 'stale_lease' });
        assert.deepEqual(await channel.get(claim.job_id), original);

        await channel.recordToolReceipt({
          schema: 'village-confirmation-receipt/v1', receipt_id: `receipt-http-${entry.suffix}`,
          job_id: claim.job_id, room_key: claim.room_key, room_revision: claim.room_revision,
          lease_id: claim.lease_id, request_digest: requestDigest, operation_id: reserved.reservation.operation_id,
          status: 'ok', availability_report: [], authoritative_sheet_result: null,
          created_at: '2026-08-21T00:00:00.000Z', error: null
        });
        const correct = await gatewayFetch(app.url, '/hermes/v1/results', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            job_id: claim.job_id, room_key: claim.room_key, room_revision: claim.room_revision,
            lease_id: claim.lease_id, final: { reply_mode: 'draft_only' }
          })
        });
        assert.equal(correct.status, 200);
        assert.equal((await channel.get(claim.job_id)).state, 'completed');
      }
    } finally {
      await app.close();
    }
  });
});

test('Gateway HTTP forwards the claim lease id into confirmation execution and receipt persistence', async () => {
  const channel = makeChannel();
  const confirmationCalls = [];
  const app = await start(createHermesGatewayHttpHandler({
    token, channel, transport: 'gateway',
    executeConfirmation: async (request) => {
      confirmationCalls.push(request);
      return {
        schema: 'village-confirmation-receipt/v1', receipt_id: 'receipt-1', job_id: 'job-1', room_key: 'room-1', room_revision: 3,
        status: 'ok', availability_report: [], authoritative_sheet_result: null, created_at: '2026-08-21T00:00:00.000Z', error: null
      };
    }
  }));
  try {
    const body = { job_id: 'job-1', room_key: 'room-1', room_revision: 3, lease_id: leaseId, decision: { reply_mode: 'draft_only' } };
    const response = await gatewayFetch(app.url, '/hermes/v1/tools/confirmation-request', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal(response.status, 200);
    assert.equal(confirmationCalls[0].lease_id, leaseId);
    assert.equal(channel.calls.receipt[0].lease_id, leaseId);
    const receipt = await response.json();
    assert.equal(receipt.schema, 'village-confirmation-receipt/v1');
    assert.equal(receipt.receipt_id, 'receipt-1');
    assert.equal(receipt.lease_id, leaseId);
  } finally {
    await app.close();
  }
});

test('Gateway HTTP returns an exactly fenced trusted receipt without repeating confirmation execution', async () => {
  const channel = makeChannel();
  const body = { job_id: 'job-1', room_key: 'room-1', room_revision: 3, lease_id: leaseId, decision: { should_write_to_sheet: true, sheet_row_candidate: {} } };
  const persisted = {
    schema: 'village-confirmation-receipt/v1', receipt_id: 'receipt-existing', job_id: 'job-1', room_key: 'room-1', room_revision: 3,
    status: 'ok', availability_report: [], authoritative_sheet_result: { success: true, reqID: 'RQ-260821-001' },
    created_at: '2026-08-21T00:00:00.000Z', error: null, lease_id: leaseId,
    request_digest: expectedConfirmationRequestDigest(body), operation_id: 'operation-existing'
  };
  channel.get = async (jobId) => {
    channel.calls.get.push(jobId);
    return {
      job_id: jobId, room_key: 'room-1', room_revision: 3, state: 'claimed', lease_id: leaseId,
      lease_expires_at_ms: 9_999_999_999_999,
      tool_operation: {
        schema: 'village-tool-operation-reservation/v1', operation_id: 'operation-existing', tool: 'confirmation_request',
        job_id: jobId, room_key: 'room-1', room_revision: 3, lease_id: leaseId,
        request_digest: expectedConfirmationRequestDigest(body), state: 'completed',
        created_at: '2026-08-21T00:00:00.000Z', receipt_id: 'receipt-existing', completed_at: '2026-08-21T00:00:00.000Z'
      },
      tool_receipts: [persisted]
    };
  };
  let executionCalls = 0;
  const app = await start(createHermesGatewayHttpHandler({
    token, channel, transport: 'gateway', executeConfirmation: async () => { executionCalls += 1; throw new Error('must not replay GAS'); }
  }));
  try {
    const response = await gatewayFetch(app.url, '/hermes/v1/tools/confirmation-request', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), persisted);
    assert.equal(executionCalls, 0);
    assert.equal(channel.calls.receipt.length, 0);
  } finally {
    await app.close();
  }
});

test('Gateway HTTP coalesces concurrent duplicate confirmation requests before receipt persistence', async () => {
  const channel = makeChannel();
  let releaseBothGets;
  const bothGets = new Promise((resolve) => { releaseBothGets = resolve; });
  let getCalls = 0;
  channel.get = async (jobId) => {
    getCalls += 1;
    if (getCalls === 2) releaseBothGets();
    await bothGets;
    return {
      job_id: jobId, room_key: 'room-1', room_revision: 3, state: 'claimed', lease_id: leaseId,
      lease_expires_at_ms: 9_999_999_999_999, tool_receipts: []
    };
  };
  let releaseExecution;
  const executionGate = new Promise((resolve) => { releaseExecution = resolve; });
  let executionCalls = 0;
  const app = await start(createHermesGatewayHttpHandler({
    token, channel, transport: 'gateway', executeConfirmation: async () => {
      executionCalls += 1;
      await executionGate;
      return {
        schema: 'village-confirmation-receipt/v1', receipt_id: 'receipt-concurrent', job_id: 'job-1', room_key: 'room-1', room_revision: 3,
        status: 'ok', availability_report: [], authoritative_sheet_result: null, created_at: '2026-08-21T00:00:00.000Z', error: null
      };
    }
  }));
  try {
    const init = {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ job_id: 'job-1', room_key: 'room-1', room_revision: 3, lease_id: leaseId, decision: { should_write_to_sheet: true, sheet_row_candidate: {} } })
    };
    const first = gatewayFetch(app.url, '/hermes/v1/tools/confirmation-request', init);
    const second = gatewayFetch(app.url, '/hermes/v1/tools/confirmation-request', init);
    await bothGets;
    releaseExecution();
    const responses = await Promise.all([first, second]);
    assert.deepEqual(responses.map((response) => response.status), [200, 200]);
    assert.deepEqual(await Promise.all(responses.map((response) => response.json())), [
      {
        schema: 'village-confirmation-receipt/v1', receipt_id: 'receipt-concurrent', job_id: 'job-1', room_key: 'room-1', room_revision: 3,
        status: 'ok', availability_report: [], authoritative_sheet_result: null, created_at: '2026-08-21T00:00:00.000Z', error: null,
         lease_id: leaseId,
         request_digest: expectedConfirmationRequestDigest(JSON.parse(init.body)),
         operation_id: 'operation-opaque-1'
      },
      {
        schema: 'village-confirmation-receipt/v1', receipt_id: 'receipt-concurrent', job_id: 'job-1', room_key: 'room-1', room_revision: 3,
        status: 'ok', availability_report: [], authoritative_sheet_result: null, created_at: '2026-08-21T00:00:00.000Z', error: null,
         lease_id: leaseId,
         request_digest: expectedConfirmationRequestDigest(JSON.parse(init.body)),
         operation_id: 'operation-opaque-1'
      }
    ]);
    assert.equal(executionCalls, 1);
    assert.equal(channel.calls.receipt.length, 1);
  } finally {
    await app.close();
  }
});

test('Gateway HTTP rejects an expired claim before confirmation execution', async () => {
  const channel = makeChannel();
  channel.setJob({ lease_expires_at_ms: 999 });
  let executionCalls = 0;
  const app = await start(createHermesGatewayHttpHandler({
    token,
    channel,
    transport: 'gateway',
    now: () => 1000,
    executeConfirmation: async () => { executionCalls += 1; throw new Error('expired lease reached GAS'); }
  }));
  try {
    const response = await gatewayFetch(app.url, '/hermes/v1/tools/confirmation-request', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ job_id: 'job-1', room_key: 'room-1', room_revision: 3, lease_id: leaseId, decision: { should_write_to_sheet: true, sheet_row_candidate: {} } })
    });
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), { error: 'stale_lease' });
    assert.equal(executionCalls, 0);
  } finally {
    await app.close();
  }
});

test('Gateway HTTP durably reserves before a write and persists its exact receipt after the lease expires', async () => {
  await withRealGatewayChannel(async ({ channel, clock }) => {
    await channel.enqueue({ job_id: 'job-expiring-write', room_key: 'room-expiring-write', room_revision: 1 });
    const claim = await channel.claim({ consumerId: 'gateway-1', waitMs: 0 });
    let writes = 0;
    const app = await start(createHermesGatewayHttpHandler({
      token, channel, transport: 'gateway', now: () => clock.now,
      executeConfirmation: async (request, { assertCurrentClaim, operationFence }) => {
        await assertCurrentClaim();
        assert.equal(operationFence.request_digest, expectedConfirmationRequestDigest(request));
        writes += 1;
        clock.now += 1_000;
        return {
          schema: 'village-confirmation-receipt/v1', receipt_id: 'receipt-expiring-write',
          job_id: request.job_id, room_key: request.room_key, room_revision: request.room_revision,
          status: 'ok', availability_report: [], authoritative_sheet_result: { success: true, reqID: 'RQ-260821-001' },
          created_at: '2026-08-21T00:00:01.000Z', error: null
        };
      }
    }));
    try {
      const request = {
        job_id: claim.job_id, room_key: claim.room_key, room_revision: claim.room_revision,
        lease_id: claim.lease_id, decision: { should_write_to_sheet: true, sheet_row_candidate: { customer_name: '홍길동' } }
      };
      const response = await gatewayFetch(app.url, '/hermes/v1/tools/confirmation-request', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request)
      });
      assert.equal(response.status, 200);
      const receipt = await response.json();
      assert.equal(receipt.receipt_id, 'receipt-expiring-write');
      assert.match(receipt.operation_id, /^[0-9a-f-]{36}$/);
      const persisted = await channel.get(claim.job_id);
      assert.equal(writes, 1);
      assert.equal(persisted.tool_receipts.length, 1);
      assert.equal(persisted.tool_operation.state, 'completed');
      assert.equal(persisted.tool_operation.operation_id, receipt.operation_id);
    } finally {
      await app.close();
    }
  });
});

test('Gateway HTTP persists an exact reserved receipt when a newer room revision supersedes the write', async () => {
  await withRealGatewayChannel(async ({ channel, clock }) => {
    await channel.enqueue({ job_id: 'job-write-old', room_key: 'room-write', room_revision: 1 });
    const claim = await channel.claim({ consumerId: 'gateway-1', waitMs: 0 });
    let writes = 0;
    const app = await start(createHermesGatewayHttpHandler({
      token, channel, transport: 'gateway', now: () => clock.now,
      executeConfirmation: async (request, { assertCurrentClaim }) => {
        await assertCurrentClaim();
        writes += 1;
        await channel.enqueue({ job_id: 'job-write-new', room_key: request.room_key, room_revision: 2 });
        return {
          schema: 'village-confirmation-receipt/v1', receipt_id: 'receipt-superseded-write',
          job_id: request.job_id, room_key: request.room_key, room_revision: request.room_revision,
          status: 'ok', availability_report: [], authoritative_sheet_result: { success: true, reqID: 'RQ-260821-002' },
          created_at: '2026-08-21T00:00:00.000Z', error: null
        };
      }
    }));
    try {
      const response = await gatewayFetch(app.url, '/hermes/v1/tools/confirmation-request', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          job_id: claim.job_id, room_key: claim.room_key, room_revision: claim.room_revision,
          lease_id: claim.lease_id, decision: { should_write_to_sheet: true, sheet_row_candidate: {} }
        })
      });
      assert.equal(response.status, 200);
      const persisted = await channel.get(claim.job_id);
      assert.equal(writes, 1);
      assert.equal(persisted.state, 'superseded');
      assert.equal(persisted.tool_receipts.length, 1);
      assert.equal(persisted.tool_operation.state, 'completed');
    } finally {
      await app.close();
    }
  });
});

test('Gateway HTTP rejects a restarted unresolved reservation without executing confirmation again', async () => {
  await withRealGatewayChannel(async ({ channel, clock, directory }) => {
    await channel.enqueue({ job_id: 'job-unresolved-http', room_key: 'room-unresolved-http', room_revision: 1 });
    const claim = await channel.claim({ consumerId: 'gateway-1', waitMs: 0 });
    const request = {
      job_id: claim.job_id, room_key: claim.room_key, room_revision: claim.room_revision,
      lease_id: claim.lease_id, decision: { should_write_to_sheet: true, sheet_row_candidate: {} }
    };
    await channel.reserveToolOperation({
      tool: 'confirmation_request', job_id: request.job_id, room_key: request.room_key,
      room_revision: request.room_revision, lease_id: request.lease_id,
      request_digest: expectedConfirmationRequestDigest(request)
    });
    const restarted = createHermesGatewayChannel({ directory, leaseMs: 1_000, maxAttempts: 2, now: () => clock.now });
    let executions = 0;
    const app = await start(createHermesGatewayHttpHandler({
      token, channel: restarted, transport: 'gateway', now: () => clock.now,
      executeConfirmation: async () => { executions += 1; throw new Error('must not replay reserved write'); }
    }));
    try {
      const response = await gatewayFetch(app.url, '/hermes/v1/tools/confirmation-request', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request)
      });
      assert.equal(response.status, 409);
      assert.deepEqual(await response.json(), { error: 'confirmation_operation_unresolved' });
      assert.equal(executions, 0);
    } finally {
      await app.close();
    }
  });
});

test('Gateway HTTP rejects a sequential different decision under the same claim without another execution', async () => {
  const channel = makeChannel();
  let executionCalls = 0;
  const app = await start(createHermesGatewayHttpHandler({
    token, channel, transport: 'gateway', executeConfirmation: async (request) => {
      executionCalls += 1;
      return {
        schema: 'village-confirmation-receipt/v1', receipt_id: `receipt-${executionCalls}`,
        job_id: request.job_id, room_key: request.room_key, room_revision: request.room_revision,
        status: 'ok', availability_report: [], authoritative_sheet_result: null, created_at: '2026-08-21T00:00:00.000Z', error: null
      };
    }
  }));
  try {
    const common = { job_id: 'job-1', room_key: 'room-1', room_revision: 3, lease_id: leaseId };
    const first = await gatewayFetch(app.url, '/hermes/v1/tools/confirmation-request', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...common, decision: { should_write_to_sheet: true, sheet_row_candidate: { customer_name: '첫 요청' } } })
    });
    assert.equal(first.status, 200);
    const second = await gatewayFetch(app.url, '/hermes/v1/tools/confirmation-request', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...common, decision: { should_write_to_sheet: true, sheet_row_candidate: { customer_name: '다른 요청' } } })
    });
    assert.equal(second.status, 409);
    assert.deepEqual(await second.json(), { error: 'confirmation_request_conflict' });
    assert.equal(executionCalls, 1);
    assert.equal(channel.calls.receipt.length, 1);
  } finally {
    await app.close();
  }
});

test('Gateway HTTP rejects a concurrent different decision instead of sharing or starting another mutation', async () => {
  const channel = makeChannel();
  let executionStarted;
  const started = new Promise((resolve) => { executionStarted = resolve; });
  let releaseExecution;
  const executionGate = new Promise((resolve) => { releaseExecution = resolve; });
  let executionCalls = 0;
  const app = await start(createHermesGatewayHttpHandler({
    token, channel, transport: 'gateway', executeConfirmation: async (request) => {
      executionCalls += 1;
      executionStarted();
      if (executionCalls === 1) await executionGate;
      return {
        schema: 'village-confirmation-receipt/v1', receipt_id: 'receipt-first-decision',
        job_id: request.job_id, room_key: request.room_key, room_revision: request.room_revision,
        status: 'ok', availability_report: [], authoritative_sheet_result: null, created_at: '2026-08-21T00:00:00.000Z', error: null
      };
    }
  }));
  try {
    const common = { job_id: 'job-1', room_key: 'room-1', room_revision: 3, lease_id: leaseId };
    const firstPromise = gatewayFetch(app.url, '/hermes/v1/tools/confirmation-request', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...common, decision: { should_write_to_sheet: true, sheet_row_candidate: { customer_name: '첫 요청' } } })
    });
    await started;
    const conflictingPromise = gatewayFetch(app.url, '/hermes/v1/tools/confirmation-request', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...common, decision: { should_write_to_sheet: true, sheet_row_candidate: { customer_name: '다른 요청' } } })
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    releaseExecution();
    const conflicting = await conflictingPromise;
    assert.equal(conflicting.status, 409);
    assert.deepEqual(await conflicting.json(), { error: 'confirmation_request_conflict' });
    assert.equal((await firstPromise).status, 200);
    assert.equal(executionCalls, 1);
  } finally {
    releaseExecution?.();
    await app.close();
  }
});

test('Gateway HTTP treats reordered decision keys as the same semantic request', async () => {
  const channel = makeChannel();
  let executionCalls = 0;
  const app = await start(createHermesGatewayHttpHandler({
    token, channel, transport: 'gateway', executeConfirmation: async (request) => {
      executionCalls += 1;
      return {
        schema: 'village-confirmation-receipt/v1', receipt_id: 'receipt-reordered',
        job_id: request.job_id, room_key: request.room_key, room_revision: request.room_revision,
        status: 'ok', availability_report: [], authoritative_sheet_result: null, created_at: '2026-08-21T00:00:00.000Z', error: null
      };
    }
  }));
  try {
    const common = { job_id: 'job-1', room_key: 'room-1', room_revision: 3, lease_id: leaseId };
    const firstBody = { ...common, decision: { should_write_to_sheet: true, sheet_row_candidate: { customer_name: '동일', phone: '010-0000-0000' } } };
    const reorderedBody = { ...common, decision: { sheet_row_candidate: { phone: '010-0000-0000', customer_name: '동일' }, should_write_to_sheet: true } };
    assert.equal(expectedConfirmationRequestDigest(firstBody), expectedConfirmationRequestDigest(reorderedBody));
    const first = await gatewayFetch(app.url, '/hermes/v1/tools/confirmation-request', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(firstBody)
    });
    const second = await gatewayFetch(app.url, '/hermes/v1/tools/confirmation-request', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(reorderedBody)
    });
    assert.deepEqual([first.status, second.status], [200, 200]);
    const firstReceipt = await first.json();
    const secondReceipt = await second.json();
    assert.equal(firstReceipt.receipt_id, 'receipt-reordered');
    assert.equal(secondReceipt.receipt_id, 'receipt-reordered');
    assert.equal(firstReceipt.request_digest, expectedConfirmationRequestDigest(firstBody));
    assert.equal(secondReceipt.request_digest, expectedConfirmationRequestDigest(reorderedBody));
    assert.equal(executionCalls, 1);
    assert.equal(channel.calls.receipt.length, 1);
  } finally {
    await app.close();
  }
});

test('Gateway HTTP does not reuse a receipt from another lease', async () => {
  const channel = makeChannel();
  channel.get = async (jobId) => ({
    job_id: jobId, room_key: 'room-1', room_revision: 3, state: 'claimed', lease_id: leaseId,
    lease_expires_at_ms: 9_999_999_999_999,
    tool_receipts: [{
      schema: 'village-confirmation-receipt/v1', receipt_id: 'receipt-old', job_id: 'job-1', room_key: 'room-1', room_revision: 3,
      status: 'ok', availability_report: [], authoritative_sheet_result: null, created_at: '2026-08-21T00:00:00.000Z', error: null,
      lease_id: 'expired-lease'
    }]
  });
  let executionCalls = 0;
  const app = await start(createHermesGatewayHttpHandler({
    token, channel, transport: 'gateway',
    executeConfirmation: async () => {
      executionCalls += 1;
      return {
        schema: 'village-confirmation-receipt/v1', receipt_id: 'receipt-new', job_id: 'job-1', room_key: 'room-1', room_revision: 3,
        status: 'ok', availability_report: [], authoritative_sheet_result: null, created_at: '2026-08-21T01:00:00.000Z', error: null
      };
    }
  }));
  try {
    const body = { job_id: 'job-1', room_key: 'room-1', room_revision: 3, lease_id: leaseId, decision: { should_write_to_sheet: true, sheet_row_candidate: {} } };
    const response = await gatewayFetch(app.url, '/hermes/v1/tools/confirmation-request', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).receipt_id, 'receipt-new');
    assert.equal(executionCalls, 1);
    assert.equal(channel.calls.receipt.length, 1);
  } finally {
    await app.close();
  }
});

test('Gateway HTTP rejects a boolean room revision before confirmation execution', async () => {
  const channel = makeChannel();
  channel.get = async (jobId) => ({
    job_id: jobId, room_key: 'room-1', room_revision: 1, state: 'claimed', lease_id: leaseId,
    lease_expires_at_ms: 9_999_999_999_999, tool_receipts: []
  });
  let executionCalls = 0;
  const app = await start(createHermesGatewayHttpHandler({
    token, channel, transport: 'gateway', executeConfirmation: async () => {
      executionCalls += 1;
      return {
        schema: 'village-confirmation-receipt/v1', receipt_id: 'receipt-boolean', job_id: 'job-1', room_key: 'room-1', room_revision: 1,
        status: 'ok', availability_report: [], authoritative_sheet_result: null, created_at: '2026-08-21T00:00:00.000Z', error: null
      };
    }
  }));
  try {
    const response = await gatewayFetch(app.url, '/hermes/v1/tools/confirmation-request', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ job_id: 'job-1', room_key: 'room-1', room_revision: true, lease_id: leaseId, decision: {} })
    });
    assert.equal(response.status, 409);
    assert.equal(executionCalls, 0);
  } finally {
    await app.close();
  }
});

test('Gateway HTTP gateway_no_send rejects confirmation writes before execution', async () => {
  const channel = makeChannel();
  let executionCalls = 0;
  const app = await start(createHermesGatewayHttpHandler({
    token, channel, transport: 'gateway_no_send', executeConfirmation: async () => { executionCalls += 1; }
  }));
  try {
    const response = await gatewayFetch(app.url, '/hermes/v1/tools/confirmation-request', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ job_id: 'job-1', room_key: 'room-1', room_revision: 3, lease_id: leaseId, decision: {} })
    });
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { error: 'writes_disabled' });
    assert.equal(executionCalls, 0);
    assert.equal(channel.calls.reservation.length, 0);
    assert.equal(channel.calls.receipt.length, 0);
  } finally {
    await app.close();
  }
});

test('Gateway HTTP preflight rejection does not reserve the lease and a corrected request can execute', async () => {
  const channel = makeChannel();
  let executionCalls = 0;
  const app = await start(createHermesGatewayHttpHandler({
    token,
    channel,
    transport: 'gateway',
    validateConfirmation: async (request) => request.decision?.sheet_row_candidate?.discount_type
      ? { valid: true, errors: [] }
      : { valid: false, errors: ['sheet_row_candidate.discount_type must be an explicit allowed value'] },
    executeConfirmation: async (request) => {
      executionCalls += 1;
      return {
        schema: 'village-confirmation-receipt/v1',
        receipt_id: 'receipt-corrected-preflight',
        job_id: request.job_id,
        room_key: request.room_key,
        room_revision: request.room_revision,
        status: 'ok',
        availability_report: [],
        authoritative_sheet_result: null,
        created_at: '2026-08-23T00:00:00.000Z',
        error: null
      };
    }
  }));
  try {
    const common = { job_id: 'job-1', room_key: 'room-1', room_revision: 3, lease_id: leaseId };
    const invalid = await gatewayFetch(app.url, '/hermes/v1/tools/confirmation-request', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ...common,
        decision: { should_write_to_sheet: true, sheet_row_candidate: { customer_name: '안중섭', discount_type: '' } }
      })
    });
    assert.equal(invalid.status, 422);
    assert.deepEqual(await invalid.json(), {
      error: 'invalid_confirmation_request',
      validation_errors: ['sheet_row_candidate.discount_type must be an explicit allowed value']
    });
    assert.equal(channel.calls.reservation.length, 0, 'invalid input must not consume the durable operation fence');
    assert.equal(executionCalls, 0);

    const corrected = await gatewayFetch(app.url, '/hermes/v1/tools/confirmation-request', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ...common,
        decision: { should_write_to_sheet: true, sheet_row_candidate: { customer_name: '안중섭', discount_type: '일반' } }
      })
    });
    assert.equal(corrected.status, 200);
    assert.equal((await corrected.json()).receipt_id, 'receipt-corrected-preflight');
    assert.equal(channel.calls.reservation.length, 1);
    assert.equal(executionCalls, 1);
  } finally {
    await app.close();
  }
});

test('Gateway HTTP fails closed when durable receipt persistence fails', async () => {
  const channel = makeChannel();
  channel.recordToolReceipt = async () => { throw Object.assign(new Error('disk unavailable'), { code: 'receipt_persist_failed' }); };
  const app = await start(createHermesGatewayHttpHandler({
    token, channel, transport: 'gateway', executeConfirmation: async () => ({
      schema: 'village-confirmation-receipt/v1', receipt_id: 'receipt-unpersisted', job_id: 'job-1', room_key: 'room-1', room_revision: 3,
      status: 'ok', availability_report: [], authoritative_sheet_result: null, created_at: '2026-08-21T00:00:00.000Z', error: null
    })
  }));
  try {
    const response = await gatewayFetch(app.url, '/hermes/v1/tools/confirmation-request', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ job_id: 'job-1', room_key: 'room-1', room_revision: 3, lease_id: leaseId, decision: {} })
    });
    assert.notEqual(response.status, 200);
    const body = await response.json();
    assert.notEqual(body.receipt_id, 'receipt-unpersisted');
  } finally {
    await app.close();
  }
});

test('Gateway HTTP caps request bodies at 1,048,576 bytes', async () => {
  const app = await start(createHermesGatewayHttpHandler({ token, channel: makeChannel(), transport: 'gateway' }));
  try {
    const oversized = JSON.stringify({ payload: 'x'.repeat(1_048_576) });
    const response = await gatewayFetch(app.url, '/hermes/v1/results', { method: 'POST', headers: { 'content-type': 'application/json' }, body: oversized });
    assert.equal(response.status, 413);
  } finally {
    await app.close();
  }
});

test('Gateway HTTP status exposes only gateway-safe queue health', async () => {
  const app = await start(createHermesGatewayHttpHandler({
    token, channel: makeChannel(), transport: 'gateway',
    now: () => Date.parse('2026-08-21T00:01:00.000Z'), consumerFreshnessMs: 180_000
  }));
  try {
    const response = await gatewayFetch(app.url, '/hermes/v1/status');
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      transport: 'gateway', gatewayConfigured: true, gatewayReady: true,
      consumer: {
        id: 'gateway-test-consumer', last_seen_at: '2026-08-21T00:00:00.000Z', age_ms: 60_000, fresh: true
      },
      queue: {
        ready: 2, claimed: 1, retry: 0, failed: 0,
        oldest_claim_age_ms: 1234, last_completed_job_id: 'private-job'
      },
      application_counts: { pending: 1, claimed: 0, applying: 0, applied: 0, finalized: 2, failed: 1 },
      failure_notification_counts: { pending: 2, delivered: 3 },
      unnotified_application_failures: 1,
      registered_reservation_change: {
        reserved: 1, completed: 2, failed_human_review: 3, pending_failure_notifications: 4,
        oldest_reserved_age_ms: 5678, last_success_at: '2026-08-20T23:59:00.000Z'
      }
    });
  } finally {
    await app.close();
  }
});

test('Gateway HTTP runs durable failure-notification recovery after terminal outcomes and lease reaping', async () => {
  const channel = makeChannel();
  let recoveries = 0;
  const app = await start(createHermesGatewayHttpHandler({
    token, channel, transport: 'gateway',
    recoverFailureNotifications: async () => { recoveries += 1; }
  }));
  try {
    const outcome = await gatewayFetch(app.url, '/hermes/v1/outcomes', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ job_id: 'job-1', room_key: 'room-1', room_revision: 3, lease_id: leaseId, outcome: 'no_final' })
    });
    assert.equal(outcome.status, 200);
    const events = await gatewayFetch(app.url, '/hermes/v1/events?consumer_id=gateway-1&wait_ms=0');
    assert.equal(events.status, 200);
    assert.equal(recoveries, 2);
  } finally {
    await app.close();
  }
});
