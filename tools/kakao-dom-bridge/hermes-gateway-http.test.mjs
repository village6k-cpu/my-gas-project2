import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';

import { createHermesGatewayHttpHandler } from './hermes-gateway-http.mjs';

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

const token = 'test-token-not-a-secret';
const leaseId = 'lease-opaque-1';

function makeChannel() {
  const calls = { claim: [], complete: [], outcome: [], receipt: [], get: [] };
  const job = {
    job_id: 'job-1', room_key: 'room-1', room_revision: 3, state: 'claimed', lease_id: leaseId,
    lease_expires_at_ms: 9_999_999_999_999, tool_receipts: []
  };
  return {
    calls,
    async claim(options) {
      calls.claim.push(options);
      return {
        job_id: 'job-1', room_key: 'room-1', room_revision: 3, lease_id: leaseId,
        event: { schema: 'village-kakao-gateway-event/v1', job_id: 'job-1', room_key: 'room-1', room_revision: 3, prompt: 'read only' }
      };
    },
    async complete(body) { calls.complete.push(body); return { state: 'completed' }; },
    async recordOutcome(body) { calls.outcome.push(body); return { state: 'failed' }; },
    async recordToolReceipt(body) {
      calls.receipt.push(body);
      job.tool_receipts.push(structuredClone(body));
      return structuredClone(job);
    },
    async get(jobId) {
      calls.get.push(jobId);
      return structuredClone({ ...job, job_id: jobId });
    },
    setJob(patch) { Object.assign(job, structuredClone(patch)); },
    async status() {
      return { counts: { ready: 2, claimed: 1, completed: 4, superseded: 0, retry_wait: 0, failed: 0 }, oldest_lease_age_ms: 1234, last_completed_job_id: 'private-job' };
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
  } finally {
    await app.close();
  }
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
    request_digest: expectedConfirmationRequestDigest(body)
  };
  channel.get = async (jobId) => {
    channel.calls.get.push(jobId);
    return {
      job_id: jobId, room_key: 'room-1', room_revision: 3, state: 'claimed', lease_id: leaseId,
      lease_expires_at_ms: 9_999_999_999_999, tool_receipts: [persisted]
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
        request_digest: expectedConfirmationRequestDigest(JSON.parse(init.body))
      },
      {
        schema: 'village-confirmation-receipt/v1', receipt_id: 'receipt-concurrent', job_id: 'job-1', room_key: 'room-1', room_revision: 3,
        status: 'ok', availability_report: [], authoritative_sheet_result: null, created_at: '2026-08-21T00:00:00.000Z', error: null,
        lease_id: leaseId,
        request_digest: expectedConfirmationRequestDigest(JSON.parse(init.body))
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
    assert.equal(channel.calls.receipt.length, 0);
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
  const app = await start(createHermesGatewayHttpHandler({ token, channel: makeChannel(), transport: 'gateway' }));
  try {
    const response = await gatewayFetch(app.url, '/hermes/v1/status');
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      transport: 'gateway', gatewayConfigured: true,
      counts: { ready: 2, claimed: 1, completed: 4, superseded: 0, retry_wait: 0, failed: 0 },
      oldest_lease_age_ms: 1234
    });
  } finally {
    await app.close();
  }
});
