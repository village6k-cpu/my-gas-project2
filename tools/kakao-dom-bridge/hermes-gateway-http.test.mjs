import assert from 'node:assert/strict';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';

import { createHermesGatewayHttpHandler } from './hermes-gateway-http.mjs';

const token = 'test-token-not-a-secret';
const leaseId = 'lease-opaque-1';

function makeChannel() {
  const calls = { claim: [], complete: [], outcome: [], receipt: [] };
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
    async recordToolReceipt(body) { calls.receipt.push(body); return { state: 'claimed' }; },
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
