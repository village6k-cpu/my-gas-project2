'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  normalizeCorrectionInput,
  runRegisteredTradeCorrection,
} = require('../scripts/windows/village-registered-trade-correction.js');

const config = {
  VILLAGE2_API_URL: 'https://script.google.com/macros/s/example/exec',
  VILLAGE2_API_KEY: 'synthetic-key',
};
const operationId = '8f6c77d1-8828-4a85-bf74-13815d96bf51';

function response(payload, { ok = true, status = 200 } = {}) {
  return { ok, status, json: async () => payload };
}

function correctedPayload(overrides = {}) {
  const before = {
    contract: {
      startDate: '2026-08-11', startTime: '05:00',
      endDate: '2026-08-14', endTime: '05:00', rounds: 3,
    },
    schedule: {
      periods: ['2026-08-11|05:00|2026-08-14|05:00'],
      rows: [
        { scheduleId: '260810-003-04', setName: '', name: '소니 GM 줌렌즈 세트', qty: 1, isComponent: false },
        { scheduleId: '260810-003-99', setName: '', name: '소니 FX3', qty: 1, isComponent: false },
      ],
      topLevelQuantities: { '소니 GM 줌렌즈 세트': 1, '소니 FX3': 1 },
    },
    ledger: null,
  };
  const after = {
    contract: {
      startDate: '2026-08-12', startTime: '05:00',
      endDate: '2026-08-15', endTime: '05:00', rounds: 3,
    },
    schedule: {
      periods: ['2026-08-12|05:00|2026-08-15|05:00'],
      rows: [
        { scheduleId: '260810-003-12', setName: '', name: '소니 GM 24-70mm F2.8 GM II', qty: 1, isComponent: false },
        { scheduleId: '260810-003-13', setName: '', name: '소니 GM 70-200mm F2.8 GM II', qty: 1, isComponent: false },
        { scheduleId: '260810-003-99', setName: '', name: '소니 FX3', qty: 1, isComponent: false },
      ],
      topLevelQuantities: {
        '소니 GM 24-70mm F2.8 GM II': 1,
        '소니 GM 70-200mm F2.8 GM II': 1,
        '소니 FX3': 1,
      },
    },
    ledger: {
      rows: 1,
      startDate: '2026-08-12',
      contractLink: 'https://docs.google.com/spreadsheets/d/corrected-contract/edit',
      links: ['https://docs.google.com/spreadsheets/d/corrected-contract/edit'],
    },
  };
  return {
    success: true,
    status: 'CORRECTED',
    tradeId: '260810-003',
    operationId,
    stages: ['scheduleChangeDates', 'scheduleAddEquips', 'scheduleRemoveEquips', 'regenerateContract'],
    contractRegeneration: {
      success: true,
      url: 'https://docs.google.com/spreadsheets/d/corrected-contract/edit',
      fileId: 'corrected-contract',
      linkUpdate: { success: true },
    },
    readback: after,
    authoritativeReadback: { before, after },
    customerNotificationSent: false,
    ...overrides,
  };
}

function createFetchFixture({ responseByAction = {} } = {}) {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    const method = options.method || 'GET';
    if (method === 'GET') {
      calls.push({ method, url: String(url) });
      throw new Error('the one-call runner must not perform search GETs');
    }
    const body = JSON.parse(options.body);
    calls.push({ method, action: body.action, body });
    if (Object.prototype.hasOwnProperty.call(responseByAction, body.action)) {
      const custom = responseByAction[body.action];
      return response(typeof custom === 'function' ? custom(body) : custom);
    }
    if (body.action === 'scheduleCorrectRegisteredTrade') return response(correctedPayload());
    if (body.action === 'sendEstimate') {
      return response({
        status: 'OK',
        action: 'sendEstimate',
        tradeID: '260810-003',
        quoteUrl: 'https://example.invalid/quote/260810-003',
      });
    }
    return response({ success: false, error: `unexpected action: ${body.action}` });
  };
  return { calls, fetchImpl };
}

const fullInput = {
  tradeId: '260810-003',
  operationId,
  expectedPeriod: {
    startDate: '2026-08-11',
    startTime: '05:00',
    endDate: '2026-08-14',
    endTime: '05:00',
  },
  dateChange: {
    newStartDate: '2026-08-12',
    newEndDate: '2026-08-15',
    startTime: '05:00',
    endTime: '05:00',
    allowConflicts: false,
  },
  remove: [{ scheduleId: '260810-003-04', expectedName: '소니 GM 줌렌즈 세트', expectedQty: 1 }],
  add: [
    { name: '소니 GM 24-70mm F2.8 GM II', qty: 1 },
    { name: '소니 GM 70-200mm F2.8 GM II', qty: 1 },
  ],
  sendEstimate: true,
};

test('normalizes an exact baseline period and removal quantity', () => {
  const normalized = normalizeCorrectionInput({
    tradeId: '260824-008',
    operationId: '11111111-2222-4333-8444-555555555555',
    expectedPeriod: {
      startDate: '2026-08-27',
      startTime: '06:00',
      endDate: '2026-08-27',
      endTime: '18:00',
    },
    remove: [{
      scheduleId: '260824-008-07',
      expectedName: '소니 FE 28-135mm',
      expectedQty: 1,
    }],
    add: [{ name: '소니 GM 70-200mm II', qty: 1 }],
  });

  assert.equal(normalized.remove[0].expectedQty, 1);
  assert.equal(normalized.expectedPeriod.startTime, '06:00');
});

test('rejects invalid supplied baseline expectations without narrowing legacy CLI inputs', () => {
  const base = {
    tradeId: '260824-008',
    operationId: '11111111-2222-4333-8444-555555555555',
    expectedPeriod: {
      startDate: '2026-08-27', startTime: '06:00',
      endDate: '2026-08-27', endTime: '18:00',
    },
    remove: [{ scheduleId: '260824-008-07', expectedName: '소니 FE 28-135mm', expectedQty: 1 }],
  };

  for (const expectedQty of [0, 1.5, 100]) {
    assert.throws(
      () => normalizeCorrectionInput({ ...base, remove: [{ ...base.remove[0], expectedQty }] }),
      /expectedQty/i,
    );
  }
  assert.throws(
    () => normalizeCorrectionInput({ ...base, remove: [{ ...base.remove[0], expectedQty: '1' }] }),
    /expectedQty/i,
  );
  assert.throws(
    () => normalizeCorrectionInput({ ...base, expectedPeriod: { ...base.expectedPeriod, startTime: '24:00' } }),
    /startTime/i,
  );
  assert.throws(
    () => normalizeCorrectionInput({ ...base, expectedPeriod: { ...base.expectedPeriod, unexpected: true } }),
    /expectedPeriod/i,
  );
  assert.throws(
    () => normalizeCorrectionInput({ ...base, expectedPeriod: { ...base.expectedPeriod, endTime: '06:00' } }),
    /after start/i,
  );

  const legacy = normalizeCorrectionInput({
    tradeId: base.tradeId,
    operationId: base.operationId,
    remove: [{ scheduleId: base.remove[0].scheduleId, expectedName: base.remove[0].expectedName }],
  });
  assert.equal(legacy.expectedPeriod, null);
  assert.equal(Object.hasOwn(legacy.remove[0], 'expectedQty'), false);
});

test('strict input requires exact identity and rejects a generic write surface', () => {
  assert.throws(
    () => normalizeCorrectionInput({ tradeId: '260810-003', sendEstimate: true }),
    /operationId/i,
  );
  assert.throws(
    () => normalizeCorrectionInput({
      tradeId: '260810-003', operationId, sendEstimate: true, sheet: '계약마스터',
    }),
    /unsupported or forbidden/i,
  );
  assert.throws(
    () => normalizeCorrectionInput({ tradeId: '260810-003', operationId, sendEstimate: false }),
    /at least one correction or send/i,
  );
  assert.throws(
    () => normalizeCorrectionInput({
      tradeId: '260810-003', operationId,
      remove: [{ scheduleId: '260810-003-04' }],
    }),
    /expectedName/i,
  );
});

test('one explicit run performs one correction POST, one send POST, and zero search GETs', async () => {
  const fixture = createFetchFixture();
  const result = await runRegisteredTradeCorrection({
    config, input: fullInput, fetchImpl: fixture.fetchImpl, timeoutMs: 1_000,
  });

  assert.deepEqual(fixture.calls.map((call) => call.action), [
    'scheduleCorrectRegisteredTrade',
    'sendEstimate',
  ]);
  assert.equal(fixture.calls.filter((call) => call.method === 'GET').length, 0);
  assert.deepEqual(fixture.calls[0].body.args, {
    tradeId: fullInput.tradeId,
    operationId,
    expectedPeriod: fullInput.expectedPeriod,
    dateChange: fullInput.dateChange,
    remove: fullInput.remove,
    add: fullInput.add,
  });
  assert.equal(result.ok, true);
  assert.equal(result.verified, true);
  assert.equal(result.send.accepted, true);
  assert.equal(result.readback.contract.rounds, 3);
  assert.equal(result.authoritativeReadback.before.schedule.topLevelQuantities['소니 FX3'], 1);
  assert.equal(result.authoritativeReadback.after.schedule.topLevelQuantities['소니 FX3'], 1);
  assert.doesNotMatch(JSON.stringify(result), /synthetic-key/);
});

test('a correction response without the locked authoritative before envelope is rejected', async () => {
  const fixture = createFetchFixture({
    responseByAction: {
      scheduleCorrectRegisteredTrade: correctedPayload({ authoritativeReadback: null }),
    },
  });

  await assert.rejects(
    runRegisteredTradeCorrection({ config, input: { ...fullInput, sendEstimate: false }, fetchImpl: fixture.fetchImpl }),
    (error) => {
      assert.equal(error.name, 'CorrectionStageError');
      assert.equal(error.stage, 'scheduleCorrectRegisteredTrade');
      assert.equal(error.outcomeUnknown, true);
      assert.match(error.message, /authoritative.*before|before.*readback/i);
      return true;
    },
  );
  assert.equal(fixture.calls.length, 1);
});

test('a correction without explicit send makes only the single correction request', async () => {
  const fixture = createFetchFixture();
  const result = await runRegisteredTradeCorrection({
    config,
    input: {
      tradeId: '260810-003', operationId,
      add: [{ name: '소니 GM 70-200mm F2.8 GM II', qty: 1 }],
      sendEstimate: false,
    },
    fetchImpl: fixture.fetchImpl,
    timeoutMs: 1_000,
  });

  assert.deepEqual(fixture.calls.map((call) => call.action), ['scheduleCorrectRegisteredTrade']);
  assert.equal(result.send.attempted, false);
  assert.equal(result.verified, true);
});

test('BUSY is attempted once, sends nothing, and is never automatically retried', async () => {
  const fixture = createFetchFixture({
    responseByAction: {
      scheduleCorrectRegisteredTrade: {
        success: false,
        code: 'BUSY',
        retryable: false,
        error: '다른 변경 작업이 진행 중입니다',
      },
    },
  });

  await assert.rejects(
    () => runRegisteredTradeCorrection({
      config, input: fullInput, fetchImpl: fixture.fetchImpl, timeoutMs: 1_000,
    }),
    (error) => {
      assert.equal(error.stage, 'scheduleCorrectRegisteredTrade');
      assert.equal(error.outcomeUnknown, false);
      return true;
    },
  );
  assert.equal(fixture.calls.filter((call) => call.action === 'scheduleCorrectRegisteredTrade').length, 1);
  assert.equal(fixture.calls.filter((call) => call.action === 'sendEstimate').length, 0);
});

test('unsafe component re-add stays typed, customer no-send, and is never replayed', async () => {
  const fixture = createFetchFixture({
    responseByAction: {
      scheduleCorrectRegisteredTrade: {
        success: false,
        status: 'ERROR',
        code: 'UNSAFE_COMPONENT_READD',
        retryable: false,
        tradeId: '260810-003',
        operationId,
        attemptedStage: 'preflight',
        stages: [],
        appliedStages: [],
        error: '세트 구성품의 소속을 정확히 보존할 수 없어 자동 재추가를 차단했습니다: 260810-003-05',
        customerNotificationSent: false,
      },
    },
  });

  await assert.rejects(
    () => runRegisteredTradeCorrection({
      config, input: { ...fullInput, sendEstimate: false }, fetchImpl: fixture.fetchImpl, timeoutMs: 1_000,
    }),
    (error) => {
      assert.equal(error.stage, 'scheduleCorrectRegisteredTrade');
      assert.equal(error.outcomeUnknown, false);
      assert.deepEqual(error.appliedStages, []);
      assert.equal(error.details.code, 'UNSAFE_COMPONENT_READD');
      assert.equal(error.details.tradeId, '260810-003');
      assert.equal(error.details.operationId, operationId);
      assert.equal(error.details.attemptedStage, 'preflight');
      assert.equal(error.details.customerNotificationSent, false);
      return true;
    },
  );
  assert.equal(fixture.calls.filter((call) => call.action === 'scheduleCorrectRegisteredTrade').length, 1);
  assert.equal(fixture.calls.filter((call) => call.action === 'sendEstimate').length, 0);
});

test('server-reported partial state is surfaced as unknown and never followed by send', async () => {
  const partialReadback = {
    contract: { startDate: '2026-08-12' },
    schedule: { rows: [{ scheduleId: '260810-003-12', name: 'BURANO 8K' }] },
    ledger: { rows: 1 },
  };
  const fixture = createFetchFixture({
    responseByAction: {
      scheduleCorrectRegisteredTrade: {
        success: false,
        code: 'PARTIAL_STATE',
        outcomeUnknown: true,
        appliedStages: ['scheduleChangeDates'],
        tradeId: '260810-003',
        operationId,
        attemptedStage: 'scheduleAddEquips',
        error: 'add write failed after date change',
        readback: partialReadback,
        readbackError: '',
        customerNotificationSent: false,
      },
    },
  });

  await assert.rejects(
    () => runRegisteredTradeCorrection({
      config, input: fullInput, fetchImpl: fixture.fetchImpl, timeoutMs: 1_000,
    }),
    (error) => {
      assert.equal(error.stage, 'scheduleCorrectRegisteredTrade');
      assert.equal(error.outcomeUnknown, true);
      assert.deepEqual(error.appliedStages, ['scheduleChangeDates']);
      assert.equal(error.details.code, 'PARTIAL_STATE');
      assert.equal(error.details.tradeId, '260810-003');
      assert.equal(error.details.operationId, operationId);
      assert.equal(error.details.attemptedStage, 'scheduleAddEquips');
      assert.deepEqual(error.details.readback, partialReadback);
      assert.equal(error.details.readbackError, '');
      return true;
    },
  );
  assert.equal(fixture.calls.filter((call) => call.action === 'scheduleCorrectRegisteredTrade').length, 1);
  assert.equal(fixture.calls.filter((call) => call.action === 'sendEstimate').length, 0);
});

test('an ambiguous send response is never retried and exposes the failed stage', async () => {
  const fixture = createFetchFixture({
    responseByAction: { sendEstimate: { message: 'request may have been accepted' } },
  });
  await assert.rejects(
    () => runRegisteredTradeCorrection({
      config, input: fullInput, fetchImpl: fixture.fetchImpl, timeoutMs: 1_000,
    }),
    (error) => {
      assert.equal(error.stage, 'sendEstimate');
      assert.equal(error.outcomeUnknown, true);
      return true;
    },
  );
  assert.equal(fixture.calls.filter((call) => call.action === 'sendEstimate').length, 1);
});

test('a correction response without authoritative readback is rejected before send', async () => {
  const fixture = createFetchFixture({
    responseByAction: {
      scheduleCorrectRegisteredTrade: correctedPayload({ readback: null }),
    },
  });
  await assert.rejects(
    () => runRegisteredTradeCorrection({
      config, input: fullInput, fetchImpl: fixture.fetchImpl, timeoutMs: 1_000,
    }),
    (error) => {
      assert.equal(error.stage, 'scheduleCorrectRegisteredTrade');
      assert.equal(error.outcomeUnknown, true);
      assert.deepEqual(error.appliedStages, ['scheduleCorrectRegisteredTrade']);
      assert.match(error.message, /readback/i);
      return true;
    },
  );
  assert.equal(fixture.calls.filter((call) => call.action === 'sendEstimate').length, 0);
});

test('a send-only request skips the correction action entirely', async () => {
  const fixture = createFetchFixture();
  const result = await runRegisteredTradeCorrection({
    config,
    input: { tradeId: '260810-003', operationId, sendEstimate: true },
    fetchImpl: fixture.fetchImpl,
    timeoutMs: 1_000,
  });
  assert.deepEqual(fixture.calls.map((call) => call.action), ['sendEstimate']);
  assert.equal(result.verified, true);
  assert.equal(result.readback, null);
});
