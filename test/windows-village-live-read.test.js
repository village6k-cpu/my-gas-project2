const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const {
  buildAutopilotRequest,
  parseEnv,
  summarizeAutopilotPayload
} = require(path.resolve(__dirname, '..', 'scripts', 'windows', 'village-live-read.js'));

test('parseEnv reads the two Village API settings without exposing unrelated values', () => {
  const parsed = parseEnv([
    'UNRELATED=do-not-return',
    'VILLAGE2_API_URL=https://script.google.com/macros/s/example/exec',
    'VILLAGE2_API_KEY="example-key"',
    ''
  ].join('\n'));

  assert.deepEqual(parsed, {
    VILLAGE2_API_URL: 'https://script.google.com/macros/s/example/exec',
    VILLAGE2_API_KEY: 'example-key'
  });
});

test('buildAutopilotRequest permits only the read-only Village autopilot action', () => {
  const request = buildAutopilotRequest({
    VILLAGE2_API_URL: 'https://script.google.com/macros/s/example/exec',
    VILLAGE2_API_KEY: 'example-key'
  });

  const url = new URL(request.url);
  assert.equal(request.method, 'GET');
  assert.equal(url.origin, 'https://script.google.com');
  assert.equal(url.searchParams.get('action'), 'autopilot');
  assert.equal(url.searchParams.get('key'), 'example-key');
  assert.equal(url.searchParams.has('sheet'), false);
  assert.equal(url.searchParams.has('range'), false);
});

test('summarizeAutopilotPayload returns only aggregate revenue fields', () => {
  const summary = summarizeAutopilotPayload({
    ok: true,
    generatedAt: '2026-07-21T04:00:00.000Z',
    kpi: {
      thisMonth: '2026-07',
      lastMonth: '2026-06',
      revenueThisMonth: 15608000,
      revenueLastMonth: 33824000,
      txThisMonth: 42,
      txLastMonth: 80
    },
    todos: [{ customerName: 'must not leak' }],
    reactivation: [{ phone: 'must not leak' }]
  });

  assert.deepEqual(summary, {
    ok: true,
    source: 'Village 2.0 GAS autopilot',
    generatedAt: '2026-07-21T04:00:00.000Z',
    thisMonth: '2026-07',
    lastMonth: '2026-06',
    revenueThisMonth: 15608000,
    revenueLastMonth: 33824000,
    transactionCountThisMonth: 42,
    transactionCountLastMonth: 80,
    revenueDelta: -18216000,
    revenueChangePercent: -53.85525070955535
  });
  assert.equal(JSON.stringify(summary).includes('must not leak'), false);
});

test('summarizeAutopilotPayload rejects incomplete responses instead of guessing', () => {
  assert.throws(
    () => summarizeAutopilotPayload({ ok: true, kpi: { revenueThisMonth: 1 } }),
    /missing required revenue KPI/i
  );
  assert.throws(
    () => summarizeAutopilotPayload({ ok: false, error: 'failed' }),
    /Village autopilot response was not successful/i
  );
});
