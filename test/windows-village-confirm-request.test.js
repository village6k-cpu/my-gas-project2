'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  createConfirmationRequest,
  createConfirmationRequests,
  updateConfirmationRequest,
  parseCliArgs,
  parseJsonInput,
  resolveEquipment
} = require('../scripts/windows/village-confirm-request.js');

const config = {
  VILLAGE2_API_URL: 'https://script.google.com/macros/s/example/exec',
  VILLAGE2_API_KEY: 'synthetic-key'
};

function response(payload, { ok = true, status = 200 } = {}) {
  return { ok, status, json: async () => payload };
}

function requestFixture(overrides = {}) {
  return {
    반출일: '2026-07-23',
    반출시간: '05:00',
    반납일: '2026-07-23',
    반납시간: '14:00',
    예약자명: '테스트 고객',
    장비: [
      { 이름: '어퓨처 600C', 수량: 2 },
      { 이름: '고독스 라이트돔 90', 수량: 2 }
    ],
    ...overrides
  };
}

test('Windows UTF-8 BOM input is accepted at the CLI boundary', () => {
  assert.deepEqual(parseJsonInput('\uFEFF{"queries":["600C"]}'), { queries: ['600C'] });
});

test('the CLI exposes an explicit batch command for AI-planned schedule splits', () => {
  assert.equal(parseCliArgs(['create-batch']).command, 'create-batch');
});

test('the CLI exposes help and a bounded update command for an existing partial request', () => {
  assert.equal(parseCliArgs(['--help']).command, 'help');
  assert.equal(parseCliArgs(['update']).command, 'update');
});

test('update replaces one existing partial request and verifies the complete readback', async () => {
  const calls = [];
  const request = requestFixture();
  const fetchImpl = async (url, options) => {
    const parsed = new URL(url);
    const action = parsed.searchParams.get('action');
    const func = parsed.searchParams.get('func');
    const sheet = parsed.searchParams.get('sheet');
    calls.push({ action, func, sheet, options });

    if (action === 'search' && sheet === '목록') {
      const query = parsed.searchParams.get('query');
      return response({ count: 1, results: [{ row: 2, data: [query] }] });
    }
    if (action === 'run' && func === 'updateRequest') {
      const payload = JSON.parse(parsed.searchParams.get('args'));
      assert.equal(payload.reqID, 'RQ-260723-003');
      assert.deepEqual(payload.장비, request.장비);
      return response({ success: true, function: 'updateRequest', result: { reqID: payload.reqID } });
    }
    if (action === 'search' && sheet === '확인요청') {
      return response({
        count: 2,
        results: request.장비.map((item, index) => ({
          row: 10 + index,
          data: index === 0
            ? ['RQ-260723-003', request.반출일, request.반출시간, request.반납일, request.반납시간,
              item.이름, item.수량, '', '가능', '', request.예약자명]
            : ['RQ-260723-003', '', '', '', '', item.이름, item.수량, '', '가능', '']
        }))
      });
    }
    throw new Error(`unexpected request: ${url}`);
  };

  const result = await updateConfirmationRequest({
    config,
    reqID: 'RQ-260723-003',
    request,
    fetchImpl,
    readTimeoutMs: 1_000,
    writeTimeoutMs: 2_000
  });

  assert.equal(result.reqID, 'RQ-260723-003');
  assert.equal(result.updated, true);
  assert.equal(result.verified, true);
  assert.deepEqual(calls.map(({ action, func, sheet }) => ({ action, func, sheet })), [
    { action: 'search', func: null, sheet: '목록' },
    { action: 'search', func: null, sheet: '목록' },
    { action: 'run', func: 'updateRequest', sheet: null },
    { action: 'search', func: null, sheet: '확인요청' }
  ]);
  assert.ok(calls.every((call) => call.options.signal));
});

test('equipment aliases are resolved concurrently in one process without exposing credentials', async () => {
  const calls = [];
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    await gate;
    const query = new URL(url).searchParams.get('query');
    return response({
      count: 1,
      results: [{ row: 2, data: [`${query} 정식명`, 'ignored'] }]
    });
  };

  const pending = resolveEquipment({
    config,
    queries: ['600C', '라이트돔'],
    fetchImpl,
    timeoutMs: 1_000
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(calls.length, 2, 'all catalog searches must start concurrently');
  for (const call of calls) {
    const url = new URL(call.url);
    assert.equal(url.searchParams.get('action'), 'search');
    assert.equal(url.searchParams.get('sheet'), '목록');
    assert.equal(url.searchParams.get('col'), 'A');
    assert.ok(call.options.signal, 'every request must have a timeout signal');
  }

  release();
  const result = await pending;
  assert.deepEqual(result.items.map((item) => item.query), ['600C', '라이트돔']);
  assert.doesNotMatch(JSON.stringify(result), /synthetic-key/);
});

test('an unresolved catalog name fails closed before any mutation', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    return response({ count: 1, results: [{ row: 2, data: ['다른 장비', 'ignored'] }] });
  };

  await assert.rejects(
    () => createConfirmationRequest({ config, request: requestFixture(), fetchImpl }),
    /catalog exact match/i
  );

  assert.equal(calls.length, 2, 'only parallel catalog validation is allowed');
  assert.equal(calls.some((url) => new URL(url).searchParams.get('action') === 'run'), false);
});

test('create performs parallel validation, one insert, and one authoritative readback', async () => {
  const calls = [];
  let catalogInFlight = 0;
  let maxCatalogInFlight = 0;
  const fetchImpl = async (url, options) => {
    const parsed = new URL(url);
    const action = parsed.searchParams.get('action');
    calls.push({ action, func: parsed.searchParams.get('func'), sheet: parsed.searchParams.get('sheet'), options });

    if (action === 'search' && parsed.searchParams.get('sheet') === '목록') {
      catalogInFlight += 1;
      maxCatalogInFlight = Math.max(maxCatalogInFlight, catalogInFlight);
      await new Promise((resolve) => setImmediate(resolve));
      catalogInFlight -= 1;
      const query = parsed.searchParams.get('query');
      return response({ count: 1, results: [{ row: 2, data: [query, 'ignored'] }] });
    }
    if (action === 'run') {
      assert.equal(parsed.searchParams.get('func'), 'insertAndCheckRequest');
      return response({
        success: true,
        function: 'insertAndCheckRequest',
        reqID: 'RQ-260722-999',
        results: []
      });
    }
    if (action === 'search' && parsed.searchParams.get('sheet') === '확인요청') {
      return response({
        count: 2,
        results: [
          { row: 10, data: ['RQ-260722-999', '2026-07-23', '05:00', '2026-07-23', '14:00', '어퓨처 600C', 2, '', '가용', '', '테스트 고객', '', '일반'] },
          { row: 11, data: ['RQ-260722-999', '', '', '', '', '고독스 라이트돔 90', 2, '', '가용', ''] }
        ]
      });
    }
    throw new Error(`unexpected request: ${url}`);
  };

  const result = await createConfirmationRequest({
    config,
    request: requestFixture(),
    fetchImpl,
    readTimeoutMs: 1_000,
    writeTimeoutMs: 2_000
  });

  assert.equal(maxCatalogInFlight, 2, 'catalog checks should run concurrently');
  assert.deepEqual(calls.map(({ action, func, sheet }) => ({ action, func, sheet })), [
    { action: 'search', func: null, sheet: '목록' },
    { action: 'search', func: null, sheet: '목록' },
    { action: 'run', func: 'insertAndCheckRequest', sheet: null },
    { action: 'search', func: null, sheet: '확인요청' }
  ]);
  assert.equal(calls.filter((call) => call.action === 'run').length, 1);
  assert.ok(calls.every((call) => call.options.signal), 'every remote call must be bounded');
  assert.equal(result.reqID, 'RQ-260722-999');
  assert.equal(result.verified, true);
  assert.equal(result.rows.length, 2);
  assert.equal(result.rows[0].hasContact, false);
  assert.doesNotMatch(JSON.stringify(result), /synthetic-key/);
});

test('AI-planned mixed return times are preflighted together and created as two verified requests', async () => {
  const requests = [
    requestFixture({
      반납일: '2026-08-02',
      반납시간: '06:00',
      장비: [
        { 이름: '소니 FX3 풀세트', 수량: 2 },
        { 이름: '소니 GM 24-70mm II', 수량: 1 }
      ]
    }),
    requestFixture({
      반납일: '2026-08-01',
      반납시간: '06:00',
      장비: [
        { 이름: '파보튜브 II 30X', 수량: 2 },
        { 이름: '아마란 F21C', 수량: 1 }
      ]
    })
  ];
  const calls = [];
  const inserted = new Map();
  let insertCount = 0;
  const fetchImpl = async (url) => {
    const parsed = new URL(url);
    const action = parsed.searchParams.get('action');
    const sheet = parsed.searchParams.get('sheet');
    calls.push({ action, sheet });

    if (action === 'search' && sheet === '목록') {
      const query = parsed.searchParams.get('query');
      return response({ count: 1, results: [{ row: 2, data: [query] }] });
    }
    if (action === 'run') {
      insertCount += 1;
      const reqID = `RQ-260723-${900 + insertCount}`;
      inserted.set(reqID, JSON.parse(parsed.searchParams.get('args')));
      return response({ success: true, reqID });
    }
    if (action === 'search' && sheet === '확인요청') {
      const reqID = parsed.searchParams.get('query');
      const request = inserted.get(reqID);
      return response({
        count: request.장비.length,
        results: request.장비.map((item, index) => ({
          row: 20 + index,
          data: index === 0
            ? [reqID, request.반출일, request.반출시간, request.반납일, request.반납시간,
              item.이름, item.수량, '', '가용', '', request.예약자명]
            : [reqID, '', '', '', '', item.이름, item.수량, '', '가용', '']
        }))
      });
    }
    throw new Error(`unexpected request: ${url}`);
  };

  const result = await createConfirmationRequests({ config, requests, fetchImpl });

  const firstMutation = calls.findIndex((call) => call.action === 'run');
  assert.equal(firstMutation, 4, 'every split group must pass catalog preflight before the first write');
  assert.equal(insertCount, 2, 'each AI-planned schedule group is inserted exactly once');
  assert.equal(result.mode, 'batch');
  assert.equal(result.verified, true);
  assert.deepEqual(result.requests.map((item) => item.reqID), ['RQ-260723-901', 'RQ-260723-902']);
});

test('a catalog failure in any AI-planned split prevents every batch mutation', async () => {
  const requests = [
    requestFixture({ 장비: [{ 이름: '소니 FX3 풀세트', 수량: 1 }] }),
    requestFixture({
      반납일: '2026-08-01',
      장비: [{ 이름: '확인되지 않은 조명', 수량: 1 }]
    })
  ];
  let insertCalls = 0;
  const fetchImpl = async (url) => {
    const parsed = new URL(url);
    if (parsed.searchParams.get('action') === 'run') {
      insertCalls += 1;
      throw new Error('mutation must not run');
    }
    const query = parsed.searchParams.get('query');
    return response({
      count: query === '확인되지 않은 조명' ? 0 : 1,
      results: query === '확인되지 않은 조명' ? [] : [{ row: 2, data: [query] }]
    });
  };

  await assert.rejects(
    () => createConfirmationRequests({ config, requests, fetchImpl }),
    /catalog exact match/i
  );
  assert.equal(insertCalls, 0);
});

test('the dedicated runner rejects sends, registration, and unknown side effects before network access', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls += 1; };

  for (const forbidden of [
    { 발송승인: true },
    { 등록: true },
    { action: '등록' },
    { customerSend: true }
  ]) {
    await assert.rejects(
      () => createConfirmationRequest({
        config,
        request: requestFixture(forbidden),
        fetchImpl
      }),
      /unsupported or forbidden field/i
    );
  }
  assert.equal(calls, 0);
});

test('missing readback is an error and is never followed by a second insert', async () => {
  let insertCalls = 0;
  const fetchImpl = async (url) => {
    const parsed = new URL(url);
    if (parsed.searchParams.get('sheet') === '목록') {
      const query = parsed.searchParams.get('query');
      return response({ count: 1, results: [{ row: 2, data: [query] }] });
    }
    if (parsed.searchParams.get('action') === 'run') {
      insertCalls += 1;
      return response({ success: true, reqID: 'RQ-260722-999', results: [] });
    }
    return response({ count: 0, results: [] });
  };

  await assert.rejects(
    () => createConfirmationRequest({ config, request: requestFixture(), fetchImpl }),
    /readback verification failed/i
  );
  assert.equal(insertCalls, 1);
});

test('a nonempty but mismatched readback fails closed without retrying the insert', async () => {
  let insertCalls = 0;
  const fetchImpl = async (url) => {
    const parsed = new URL(url);
    if (parsed.searchParams.get('sheet') === '목록') {
      const query = parsed.searchParams.get('query');
      return response({ count: 1, results: [{ row: 2, data: [query] }] });
    }
    if (parsed.searchParams.get('action') === 'run') {
      insertCalls += 1;
      return response({ success: true, reqID: 'RQ-260722-999', results: [] });
    }
    return response({
      count: 1,
      results: [{
        row: 10,
        data: ['RQ-260722-999', '2026-07-23', '05:00', '2026-07-23', '14:00', '전혀 다른 장비', 1, '', '가용', '', '테스트 고객']
      }]
    });
  };

  await assert.rejects(
    () => createConfirmationRequest({ config, request: requestFixture(), fetchImpl }),
    /intended equipment readback verification failed/i
  );
  assert.equal(insertCalls, 1);
});
