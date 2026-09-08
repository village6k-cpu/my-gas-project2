'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  createConfirmationRequest,
  createConfirmationRequests,
  updateConfirmationRequest,
  normalizeConfirmationRequest,
  normalizeConfirmedReservationCommit,
  commitConfirmedReservation,
  reconcileConfirmationRequest,
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
    시간원문: '5시~14시',
    예약자명: '테스트 고객',
    장비: [
      { 이름: '어퓨처 600C', 수량: 2 },
      { 이름: '고독스 라이트돔 90', 수량: 2 }
    ],
    ...overrides
  };
}

function confirmedRegistrationFixture(overrides = {}) {
  const period = {
    start_date: '2026-09-07',
    start_time: '07:00',
    end_date: '2026-09-07',
    end_time: '20:00'
  };
  const plan = [
    { name: '소니 FX3 바디세트', quantity: 1 },
    { name: '소니 GM 16-35mm', quantity: 1 },
    { name: '소니 GM 70-200mm II', quantity: 1 }
  ];
  return {
    confirmed: true,
    target_scope: 'pending_request',
    request_id: 'RQ-260906-001',
    source_evidence: {
      customer_request: 'bounded customer request evidence',
      staff_confirmation: 'bounded staff confirmation evidence',
      conversation_revision: 9,
      conversation_evidence_hash: 'a'.repeat(64),
      customer_message_ids: ['customer-message-1'],
      staff_message_ids: ['staff-message-2']
    },
    expected_before: plan,
    expected_set_components: [{
      set_item: '소니 FX3 바디세트',
      component_item: '소니 FX3 바디(케이지)',
      quantity: 1
    }],
    set_component_selections: [],
    expected_period: period,
    desired_after: plan,
    desired_period: period,
    ...overrides
  };
}

test('the CLI exposes one explicit staff-authorized pending registration command', () => {
  assert.equal(parseCliArgs(['commit-registration']).command, 'commit-registration');
});

test('confirmed registration normalization requires one exact full-state authorization without prose routing', () => {
  const normalized = normalizeConfirmedReservationCommit(confirmedRegistrationFixture());
  assert.equal(normalized.request_id, 'RQ-260906-001');
  assert.equal(normalized.source_evidence.conversation_revision, 9);
  assert.equal(normalized.source_evidence.conversation_evidence_hash, 'a'.repeat(64));
  assert.deepEqual(normalized.source_evidence.customer_message_ids, ['customer-message-1']);
  assert.deepEqual(normalized.source_evidence.staff_message_ids, ['staff-message-2']);
  assert.deepEqual(normalized.expected_before, normalized.desired_after);
  assert.deepEqual(normalized.expected_set_components, [{
    set_item: '소니 FX3 바디세트',
    component_item: '소니 FX3 바디(케이지)',
    quantity: 1
  }]);
  assert.deepEqual(normalized.set_component_selections, []);
  assert.deepEqual(normalized.expected_period, normalized.desired_period);

  for (const invalid of [
    { confirmed: false },
    { target_scope: 'registered_trade' },
    { request_id: 'RQ-wrong' },
    { source_evidence: {
      customer_request: 'x', staff_confirmation: 'y', conversation_revision: 0,
      conversation_evidence_hash: 'a'.repeat(64),
      customer_message_ids: ['customer-message-1'], staff_message_ids: ['staff-message-2']
    } },
    { source_evidence: {
      ...confirmedRegistrationFixture().source_evidence,
      conversation_evidence_hash: 'A'.repeat(64)
    } },
    { source_evidence: {
      ...confirmedRegistrationFixture().source_evidence,
      customer_message_ids: []
    } },
    { source_evidence: {
      ...confirmedRegistrationFixture().source_evidence,
      staff_message_ids: ['staff message with spaces']
    } },
    { expected_period: {
      ...confirmedRegistrationFixture().expected_period,
      start_time: '07:30'
    } },
    { expected_before: [] },
    { expected_period: { start_date: '2026-09-07', start_time: '', end_date: '2026-09-07', end_time: '20:00' } },
    { desired_after: [{ name: '', quantity: 1 }] },
    { desired_period: { start_date: '2026-09-07', start_time: '20:00', end_date: '2026-09-07', end_time: '07:00' } }
  ]) {
    assert.throws(
      () => normalizeConfirmedReservationCommit(confirmedRegistrationFixture(invalid)),
      /confirmed|target_scope|request_id|reqID|source_evidence|expected_before|expected_period|desired_after|desired_period|period/i
    );
  }
});

test('fast registration preserves exact set choices and rejects scalar metadata coercion', () => {
  const candidate = {
    customer_name: '테스트 고객', phone: '010-1111-2222', discount_type: '일반', memo: '', extra_request: ''
  };
  const selections = [{
    set_item: '소니 FX3 바디세트', component_item: '메모리', selected_item: 'CFexpress Type A 160GB'
  }];
  const fast = confirmedRegistrationFixture({
    request_id: null,
    expected_set_components: [],
    set_component_selections: selections,
    pending_request_candidate: candidate
  });
  assert.deepEqual(normalizeConfirmedReservationCommit(fast).pending_request_candidate, candidate);
  assert.deepEqual(normalizeConfirmedReservationCommit(fast).set_component_selections, selections);

  for (const [field, value] of [['phone', 1010], ['memo', 123], ['extra_request', false]]) {
    assert.throws(
      () => normalizeConfirmedReservationCommit(confirmedRegistrationFixture({
        request_id: null,
        expected_set_components: [],
        set_component_selections: selections,
        pending_request_candidate: { ...candidate, [field]: value }
      })),
      new RegExp(`pending_request_candidate\\.${field}`, 'i')
    );
  }
});

test('confirmed registration rejects missing or duplicate set-component fencing fields', () => {
  const fixture = confirmedRegistrationFixture();
  const missingBaseline = structuredClone(fixture);
  delete missingBaseline.expected_set_components;
  assert.throws(() => normalizeConfirmedReservationCommit(missingBaseline), /expected_set_components/i);

  const missingSelections = structuredClone(fixture);
  delete missingSelections.set_component_selections;
  assert.throws(() => normalizeConfirmedReservationCommit(missingSelections), /set_component_selections/i);

  assert.throws(() => normalizeConfirmedReservationCommit({
    ...fixture,
    expected_set_components: [fixture.expected_set_components[0], fixture.expected_set_components[0]]
  }), /duplicate|duplicated/i);
});

test('confirmed registration makes one bounded GAS operation call and returns authoritative receipt evidence', async () => {
  const calls = [];
  const timeoutRequests = [];
  const registration = confirmedRegistrationFixture();
  const operationId = '11111111-2222-4333-8444-555555555555';
  const authoritative = {
    success: true,
    status: 'REGISTERED',
    request_id: 'RQ-260906-001',
    trade_id: '260906-001',
    final_plan: registration.desired_after,
    final_period: registration.desired_period,
    customer_notification: { attempted: false }
  };
  const fetchImpl = async (url, options) => {
    const parsed = new URL(url);
    calls.push({ parsed, options });
    assert.equal(options.method, 'POST');
    assert.equal(options.headers['content-type'], 'application/json; charset=utf-8');
    assert.equal(parsed.searchParams.has('args'), false, 'typed evidence must not be constrained by URL length');
    assert.equal(parsed.searchParams.has('key'), false, 'write credential must not be placed in the URL');
    const posted = JSON.parse(options.body);
    assert.equal(posted.key, config.VILLAGE2_API_KEY);
    delete posted.key;
    assert.deepEqual(posted, {
      action: 'run',
      func: 'commitConfirmedReservation',
      args: { registration, operation_id: operationId }
    });
    return response({ success: true, function: 'commitConfirmedReservation', result: authoritative });
  };

  const originalTimeout = AbortSignal.timeout;
  AbortSignal.timeout = (milliseconds) => {
    timeoutRequests.push(milliseconds);
    return new AbortController().signal;
  };
  let result;
  try {
    result = await commitConfirmedReservation({ config, registration, operationId, fetchImpl });
  } finally {
    AbortSignal.timeout = originalTimeout;
  }

  assert.equal(calls.length, 1);
  assert.deepEqual(timeoutRequests, [240_000], 'GAS must finish before the plugin 250s transport deadline');
  assert.ok(calls[0].options.signal);
  assert.deepEqual(result, authoritative);
});

test('confirmed registration never retries a rejected or uncertain GAS mutation', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return response({ error: 'upstream failed' }, { ok: false, status: 504 });
  };
  await assert.rejects(
    () => commitConfirmedReservation({
      config,
      registration: confirmedRegistrationFixture(),
      operationId: '11111111-2222-4333-8444-555555555555',
      fetchImpl,
      timeoutMs: 250_000
    }),
    (error) => error.uncertainWrite === true && error.stage === 'confirmed_registration'
  );
  assert.equal(calls, 1);
});

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
  const reductions = [{ name: '시네로이드 CFL-800', beforeQty: 2, afterQty: 0, reason: '고객 취소 요청' }];
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
      assert.deepEqual(payload.equipmentReductions, reductions);
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
    equipmentReductions: reductions,
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

test('unregistered customer wording is preserved as an equipment row instead of being dropped or demoted', async () => {
  const calls = [];
  const request = {
    pickupDate: '2026-08-13',
    pickupTime: '10:00',
    returnDate: '2026-08-13',
    returnTime: '18:00',
    timeSource: '10시~18시',
    customerName: '장민혁',
    items: [{ name: '20-70', quantity: 1 }]
  };
  const fetchImpl = async (url) => {
    const parsed = new URL(url);
    calls.push({ action: parsed.searchParams.get('action'), sheet: parsed.searchParams.get('sheet') });
    if (parsed.searchParams.get('action') === 'run') {
      const payload = JSON.parse(parsed.searchParams.get('args'));
      assert.match(JSON.stringify(payload), /20-70/);
      assert.doesNotMatch(JSON.stringify(payload), /추가요청/);
      assert.equal(payload.장비명원문보존, true);
      return response({ success: true, reqID: 'RQ-260813-003' });
    }
    if (parsed.searchParams.get('sheet') === '확인요청') {
      return response({
        count: 1,
        results: [{
          row: 20,
          data: ['RQ-260813-003', '2026-08-13', '10:00', '2026-08-13', '18:00', '20-70', 1, '', '미등록 장비', '', '장민혁']
        }]
      });
    }
    throw new Error(`unexpected request: ${url}`);
  };

  const result = await createConfirmationRequest({
    config,
    request,
    unregisteredOriginals: ['20-70'],
    fetchImpl
  });

  assert.equal(result.verified, true);
  assert.equal(result.rows[0].equipment, '20-70');
  assert.deepEqual(calls, [
    { action: 'run', sheet: null },
    { action: 'search', sheet: '확인요청' }
  ]);
});

test('the unregistered-original allowlist rejects names that are not exact equipment rows', async () => {
  let calls = 0;
  await assert.rejects(
    () => createConfirmationRequest({
      config,
      request: requestFixture(),
      unregisteredOriginals: ['20-70'],
      fetchImpl: async () => { calls += 1; }
    }),
    /must exactly match an equipment item/i
  );
  assert.equal(calls, 0);
});

test('an unresolved name without an explicit original-wording allowlist still fails before mutation', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    return response({ count: 1, results: [{ row: 2, data: ['다른 장비', 'ignored'] }] });
  };

  await assert.rejects(
    () => createConfirmationRequest({ config, request: requestFixture(), fetchImpl }),
    /catalog exact match/i
  );
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
      시간원문: '5시~6시',
      장비: [
        { 이름: '소니 FX3 풀세트', 수량: 2 },
        { 이름: '소니 GM 24-70mm II', 수량: 1 }
      ]
    }),
    requestFixture({
      반납일: '2026-08-01',
      반납시간: '06:00',
      시간원문: '5시~6시',
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

test('English alias fields (customerName, pickupDate, items, ...) are mapped to the canonical Korean schema', () => {
  const normalized = normalizeConfirmationRequest({
    pickupDate: '2026-07-23',
    pickupTime: '5:00',
    returnDate: '2026.07.23',
    returnTime: '14:00:00',
    timeSource: '5시~14시',
    customerName: '테스트 고객',
    phone: '010-1234-5678',
    items: [
      { name: '어퓨처 600C', quantity: '2' },
      { 이름: '고독스 라이트돔 90', qty: 1 }
    ]
  });

  assert.deepEqual(normalized, {
    반출일: '2026-07-23',
    반출시간: '05:00',
    반납일: '2026-07-23',
    반납시간: '14:00',
    예약자명: '테스트 고객',
    연락처: '010-1234-5678',
    장비: [
      { 이름: '어퓨처 600C', 수량: 2 },
      { 이름: '고독스 라이트돔 90', 수량: 1 }
    ]
  });
});

test('Village bare Korean hours stay literal 24-hour values and cannot be reinterpreted as PM', () => {
  assert.throws(
    () => normalizeConfirmationRequest(requestFixture({
      반출일: '2026-08-25',
      반출시간: '17:00',
      반납일: '2026-08-27',
      반납시간: '00:00',
      시간원문: '8월 25일 5시~8월 26일 24시'
    })),
    /5시.*05:00.*17:00|17:00.*5시.*05:00/i
  );

  const literal = normalizeConfirmationRequest(requestFixture({
    반출일: '2026-08-25',
    반출시간: '05:00',
    반납일: '2026-08-27',
    반납시간: '00:00',
    시간원문: '8월 25일 5시~8월 26일 24시'
  }));
  assert.equal(literal.반출시간, '05:00');
  assert.equal(literal.반납시간, '00:00');
  assert.equal(Object.hasOwn(literal, '시간원문'), false, 'source evidence must not leak into the sheet payload');

  assert.equal(normalizeConfirmationRequest(requestFixture({
    반출시간: '17:00',
    반납시간: '20:00',
    시간원문: '오후 5시~오후 8시'
  })).반출시간, '17:00');
  assert.equal(normalizeConfirmationRequest(requestFixture({
    반출시간: '17:00',
    반납시간: '20:00',
    시간원문: '17시~20시'
  })).반출시간, '17:00');
});

test('conflicting alias and canonical values fail loudly instead of silently picking one', () => {
  assert.throws(
    () => normalizeConfirmationRequest(requestFixture({ customerName: '다른 사람' })),
    /conflicting values for 예약자명/i
  );
});

test('an unknown field error teaches the full allowed schema in one round trip', () => {
  assert.throws(
    () => normalizeConfirmationRequest(requestFixture({ customerSend: true })),
    (error) => {
      assert.match(error.message, /unsupported or forbidden field/i);
      assert.match(error.message, /반출일, 반출시간, 반납일, 반납시간, 예약자명, 연락처, 할인유형, 업체명, 장비, 비고, 추가요청/);
      return true;
    }
  );
});

test('ambiguous dates and times are still rejected', () => {
  assert.throws(() => normalizeConfirmationRequest(requestFixture({ 반출일: '26-07-23' })), /반출일 must use YYYY-MM-DD/);
  assert.throws(() => normalizeConfirmationRequest(requestFixture({ 반출시간: '25:00' })), /반출시간 must use HH:MM/);
});

test('a failure after a successful insert is marked as an uncertain write with the created reqID', async () => {
  const fetchImpl = async (url) => {
    const parsed = new URL(url);
    if (parsed.searchParams.get('sheet') === '목록') {
      const query = parsed.searchParams.get('query');
      return response({ count: 1, results: [{ row: 2, data: [query] }] });
    }
    if (parsed.searchParams.get('action') === 'run') {
      return response({ success: true, reqID: 'RQ-260722-999', results: [] });
    }
    return response({}, { ok: false, status: 500 });
  };

  await assert.rejects(
    () => createConfirmationRequest({ config, request: requestFixture(), fetchImpl }),
    (error) => {
      assert.equal(error.uncertainWrite, true);
      assert.equal(error.reqID, 'RQ-260722-999');
      assert.equal(error.stage, 'insert_readback');
      return true;
    }
  );
});

test('a pre-insert failure is not marked as an uncertain write', async () => {
  const fetchImpl = async (url) => {
    const parsed = new URL(url);
    if (parsed.searchParams.get('sheet') === '목록') {
      return response({ count: 0, results: [] });
    }
    throw new Error('mutation must not run');
  };

  await assert.rejects(
    () => createConfirmationRequest({ config, request: requestFixture(), fetchImpl }),
    (error) => {
      assert.notEqual(error.uncertainWrite, true);
      return true;
    }
  );
});

test('reconcile by reqID reads the sheet without writing and reports found rows', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    const parsed = new URL(url);
    calls.push({ action: parsed.searchParams.get('action'), col: parsed.searchParams.get('col') });
    assert.equal(parsed.searchParams.get('action'), 'search');
    assert.equal(parsed.searchParams.get('sheet'), '확인요청');
    return response({
      count: 1,
      results: [{
        row: 10,
        data: ['RQ-260722-999', '2026-07-23', '05:00', '2026-07-23', '14:00', '어퓨처 600C', 2, '', '가용', '', '테스트 고객']
      }]
    });
  };

  const result = await reconcileConfirmationRequest({ config, query: { reqID: 'RQ-260722-999' }, fetchImpl });
  assert.equal(result.found, true);
  assert.equal(result.readOnly, true);
  assert.equal(result.rows.length, 1);
  assert.equal(calls.every((call) => call.action === 'search'), true, 'reconcile must never mutate');
});

test('reconcile by reqID reports found:false instead of throwing when nothing landed', async () => {
  const fetchImpl = async () => response({ count: 0, results: [] });
  const result = await reconcileConfirmationRequest({ config, query: { reqID: 'RQ-260722-999' }, fetchImpl });
  assert.equal(result.found, false);
  assert.deepEqual(result.rows, []);
});

test('reconcile by requester and pickup date groups matching confirmation requests', async () => {
  const fetchImpl = async (url) => {
    const parsed = new URL(url);
    assert.equal(parsed.searchParams.get('action'), 'search');
    if (parsed.searchParams.get('col') === 'K') {
      return response({
        count: 2,
        results: [
          { row: 10, data: ['RQ-260722-998', '2026-07-22', '05:00', '', '', '어퓨처 600C', 1, '', '', '', '테스트 고객'] },
          { row: 12, data: ['RQ-260722-999', '2026-07-23', '05:00', '', '', '어퓨처 600C', 2, '', '', '', '테스트 고객'] }
        ]
      });
    }
    const reqID = parsed.searchParams.get('query');
    return response({
      count: 1,
      results: [{
        row: 12,
        data: [reqID, '2026-07-23', '05:00', '2026-07-23', '14:00', '어퓨처 600C', 2, '', '가용', '', '테스트 고객']
      }]
    });
  };

  const result = await reconcileConfirmationRequest({
    config,
    query: { customerName: '테스트 고객', pickupDate: '2026-07-23' },
    fetchImpl
  });
  assert.equal(result.found, true);
  assert.deepEqual(result.groups.map((group) => group.reqID), ['RQ-260722-999']);
  assert.equal(result.groups[0].requester, '테스트 고객');
});

test('the CLI exposes the read-only reconcile command', () => {
  assert.equal(parseCliArgs(['reconcile']).command, 'reconcile');
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
