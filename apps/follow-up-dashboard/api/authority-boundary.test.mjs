import test from 'node:test';
import assert from 'node:assert/strict';

import gasProxyHandler from './gas-proxy.js';
import operationsHandler from './operations.js';
import followUpsHandler from './follow-ups.js';

function responseRecorder() {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    setHeader(name, value) { this.headers[String(name).toLowerCase()] = value; },
    end(value = '') { this.body = String(value); },
  };
}

async function withoutDashboardToken(run) {
  const previous = process.env.DASHBOARD_TOKEN;
  delete process.env.DASHBOARD_TOKEN;
  try {
    return await run();
  } finally {
    if (previous === undefined) delete process.env.DASHBOARD_TOKEN;
    else process.env.DASHBOARD_TOKEN = previous;
  }
}

test('legacy operations and follow-up APIs fail closed when dashboard auth is unconfigured', async () => {
  await withoutDashboardToken(async () => {
    for (const handler of [operationsHandler, followUpsHandler]) {
      const req = { method: 'GET', headers: {}, query: {} };
      const res = responseRecorder();
      await handler(req, res);
      assert.equal(res.statusCode, 503);
      assert.match(res.body, /authentication unavailable/i);
    }
  });
});

test('retired generic GAS proxy never forwards reads or writes', async () => {
  const req = { method: 'GET', headers: {}, query: { action: 'operations' } };
  const res = responseRecorder();
  await gasProxyHandler(req, res);
  assert.equal(res.statusCode, 410);
  assert.match(res.body, /retired/i);
});
