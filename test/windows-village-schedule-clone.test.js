'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  cloneRegisteredSchedule,
  normalizeCloneInput,
  parseCliArgs
} = require('../scripts/windows/village-schedule-clone.js');

const config = {
  VILLAGE2_API_URL: 'https://script.google.com/macros/s/example/exec',
  VILLAGE2_API_KEY: 'synthetic-key'
};

function response(payload, { ok = true, status = 200 } = {}) {
  return { ok, status, json: async () => payload };
}

test('preview sends one bounded exact-clone dry run and exposes the source fingerprint without credentials', async () => {
  const calls = [];
  const result = await cloneRegisteredSchedule({
    config,
    mode: 'preview',
    input: {
      sourceTradeId: '260809-007',
      targetStart: '2026-08-13 11:00',
      targetEnd: '2026-08-14 23:00'
    },
    fetchImpl: async (url, options) => {
      calls.push({ url, options, body: JSON.parse(options.body) });
      return response({
        success: true,
        status: 'DRY_RUN',
        sourceTradeId: '260809-007',
        sourceFingerprint: 'fixture-fingerprint',
        sourceRowCount: 6,
        customerSendSuppressed: true
      });
    }
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.method, 'POST');
  assert.deepEqual(calls[0].body, {
    action: 'cloneScheduleNoSend',
    sourceTradeId: '260809-007',
    targetStart: '2026-08-13 11:00',
    targetEnd: '2026-08-14 23:00',
    dryRun: true
  });
  assert.ok(calls[0].options.signal);
  assert.equal(result.sourceRowCount, 6);
  assert.equal(result.sourceFingerprint, 'fixture-fingerprint');
  assert.doesNotMatch(JSON.stringify(result), /synthetic-key/);
});

test('execute requires the reviewed dry-run fingerprint before any write call', async () => {
  let calls = 0;
  await assert.rejects(
    () => cloneRegisteredSchedule({
      config,
      mode: 'execute',
      input: {
        sourceTradeId: '260809-007',
        targetStart: '2026-08-13 11:00',
        targetEnd: '2026-08-14 23:00'
      },
      fetchImpl: async () => { calls += 1; }
    }),
    /expectedSourceFingerprint/
  );
  assert.equal(calls, 0);
});

test('execute verifies exact row parity and the no-send readback from one API call', async () => {
  const result = await cloneRegisteredSchedule({
    config,
    mode: 'execute',
    input: {
      sourceTradeId: '260809-007',
      targetStart: '2026-08-13 11:00',
      targetEnd: '2026-08-14 23:00',
      expectedSourceFingerprint: 'fixture-fingerprint'
    },
    fetchImpl: async (_url, options) => {
      assert.equal(JSON.parse(options.body).dryRun, false);
      return response({
        success: true,
        tradeId: '260813-001',
        sourceTradeId: '260809-007',
        sourceFingerprint: 'fixture-fingerprint',
        sourceRowCount: 6,
        targetRowCount: 6,
        customerSendSuppressed: true,
        customerSendFlagPresent: true,
        readback: { contract: true, schedule: true, ledger: true }
      });
    }
  });

  assert.equal(result.tradeId, '260813-001');
  assert.equal(result.verifiedExactClone, true);
  assert.equal(result.customerSendSuppressed, true);
});

test('clone CLI has explicit preview and execute modes', () => {
  assert.deepEqual(parseCliArgs(['preview']), {
    mode: 'preview',
    envFile: 'C:\\Village\\village-ai\\.env.finance',
    inputFile: null
  });
  assert.equal(normalizeCloneInput({
    customerName: '이진수',
    targetStart: '2026-08-13 11:00',
    targetEnd: '2026-08-14 23:00'
  }, 'preview').customerName, '이진수');
});
