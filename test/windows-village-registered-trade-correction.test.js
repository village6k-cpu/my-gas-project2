'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  normalizeCorrectionInput,
  runRegisteredTradeCorrection
} = require('../scripts/windows/village-registered-trade-correction.js');

const config = {
  VILLAGE2_API_URL: 'https://script.google.com/macros/s/example/exec',
  VILLAGE2_API_KEY: 'synthetic-key'
};
const operationId = '8f6c77d1-8828-4a85-bf74-13815d96bf51';
const scheduleHeaders = [
  '스케줄ID', '거래ID', '세트명', '장비명', '수량',
  '반출일', '반출시간', '반납일', '반납시간', '상태', '예비', '단가', '예약자명'
];
const contractHeaders = [
  '거래ID', '예약자명', '연락처', '업체명', '반출일', '반출시간',
  '반납일', '반납시간', '회차', '계약상태', '할인유형', '비고'
];

function response(payload, { ok = true, status = 200 } = {}) {
  return { ok, status, json: async () => payload };
}

function searchPayload(sheet, rows) {
  return {
    sheet,
    headers: sheet === '스케줄상세' ? scheduleHeaders : contractHeaders,
    count: rows.length,
    results: rows.map((data, index) => ({ row: index + 2, data }))
  };
}

const oldSetRow = [
  '260810-003-04', '260810-003', '소니 GM 줌렌즈 세트', '소니 GM 줌렌즈 세트', 1,
  '2026-08-10', '05:00', '2026-08-19', '05:00', '대기', '', 300000, '조용준'
];
const oldComponentRow = [
  '260810-003-05', '260810-003', '소니 GM 줌렌즈 세트', '소니 GM 24-70mm F2.8 GM II', 1,
  '2026-08-10', '05:00', '2026-08-19', '05:00', '대기', '', 0, '조용준'
];
const oldContractRow = [
  '260810-003', '조용준', '010-0000-0000', '',
  '2026-08-10 16:00:00', '1899-12-30 21:27:52',
  '2026-08-19 16:00:00', '1899-12-30 21:27:52', 9, '예약', '학생 30%', ''
];
const finalScheduleRows = [
  [
    '260810-003-12', '260810-003', '', '소니 GM 24-70mm F2.8 GM II', 1,
    '2026-08-12', '05:00', '2026-08-15', '05:00', '대기', '', 100000, '조용준'
  ],
  [
    '260810-003-13', '260810-003', '', '소니 GM 70-200mm F2.8 GM II', 1,
    '2026-08-12', '05:00', '2026-08-15', '05:00', '대기', '', 120000, '조용준'
  ]
];
const finalContractRow = [
  '260810-003', '조용준', '010-0000-0000', '',
  '2026-08-12 16:00:00', '1899-12-30 21:27:52',
  '2026-08-15 16:00:00', '1899-12-30 21:27:52', 3, '예약', '학생 30%', ''
];

function createFetchFixture({
  baselineSchedule = [oldSetRow, oldComponentRow],
  baselineContract = [oldContractRow],
  finalSchedule = finalScheduleRows,
  finalContract = [finalContractRow],
  responseByAction = {}
} = {}) {
  const calls = [];
  let getCount = 0;
  const fetchImpl = async (url, options = {}) => {
    const method = options.method || 'GET';
    if (method === 'GET') {
      const parsed = new URL(url);
      const sheet = parsed.searchParams.get('sheet');
      const finalRead = getCount >= 2;
      getCount += 1;
      calls.push({ method, action: parsed.searchParams.get('action'), sheet, url: String(url) });
      const rows = sheet === '스케줄상세'
        ? (finalRead ? finalSchedule : baselineSchedule)
        : (finalRead ? finalContract : baselineContract);
      return response(searchPayload(sheet, rows));
    }

    const body = JSON.parse(options.body);
    calls.push({ method, action: body.action, body });
    if (Object.prototype.hasOwnProperty.call(responseByAction, body.action)) {
      const custom = responseByAction[body.action];
      return response(typeof custom === 'function' ? custom(body) : custom);
    }
    const defaults = {
      scheduleChangeDates: { success: true, status: 'CHANGED', customerNotificationSent: false },
      scheduleRemoveEquip: { success: true, removedScheduleIds: ['260810-003-04', '260810-003-05'] },
      scheduleAddEquips: { success: true, addedRows: 2, contractRegenPending: true },
      regenerateContract: {
        success: true,
        tradeId: '260810-003',
        url: 'https://docs.google.com/spreadsheets/d/corrected-contract/edit',
        fileId: 'corrected-contract'
      },
      sendEstimate: {
        status: 'OK',
        action: 'sendEstimate',
        tradeID: '260810-003',
        quoteUrl: 'https://example.invalid/quote/260810-003'
      }
    };
    return response(defaults[body.action] || { error: `unexpected action: ${body.action}` });
  };
  return { calls, fetchImpl };
}

test('strict input requires exact identity and rejects a generic write surface', () => {
  assert.throws(
    () => normalizeCorrectionInput({ tradeId: '260810-003', sendEstimate: true }),
    /operationId/i
  );
  assert.throws(
    () => normalizeCorrectionInput({
      tradeId: '260810-003', operationId, sendEstimate: true, sheet: '계약마스터'
    }),
    /unsupported or forbidden/i
  );
  assert.throws(
    () => normalizeCorrectionInput({ tradeId: '260810-003', operationId, sendEstimate: false }),
    /at least one correction or send/i
  );
});

test('baseline reads run before writes and stale removal identity fails closed', async () => {
  const fixture = createFetchFixture();
  await assert.rejects(
    () => runRegisteredTradeCorrection({
      config,
      input: {
        tradeId: '260810-003',
        operationId,
        remove: [{ scheduleId: '260810-003-04', expectedName: '다른 장비' }]
      },
      fetchImpl: fixture.fetchImpl,
      timeoutMs: 1_000
    }),
    /removal preflight/i
  );
  assert.equal(fixture.calls.filter((call) => call.method === 'GET').length, 2);
  assert.equal(fixture.calls.filter((call) => call.method === 'POST').length, 0);
});

test('one explicit run applies ordered corrections, regenerates once, sends once, and verifies final rows', async () => {
  const fixture = createFetchFixture();
  const result = await runRegisteredTradeCorrection({
    config,
    input: {
      tradeId: '260810-003',
      operationId,
      dateChange: {
        newStartDate: '2026-08-12',
        newEndDate: '2026-08-15',
        startTime: '05:00',
        endTime: '05:00',
        allowConflicts: false
      },
      remove: [{ scheduleId: '260810-003-04', expectedName: '소니 GM 줌렌즈 세트' }],
      add: [
        { name: '소니 GM 24-70mm F2.8 GM II', qty: 1 },
        { name: '소니 GM 70-200mm F2.8 GM II', qty: 1 }
      ],
      sendEstimate: true
    },
    fetchImpl: fixture.fetchImpl,
    timeoutMs: 1_000
  });

  const posts = fixture.calls.filter((call) => call.method === 'POST');
  assert.deepEqual(posts.map((call) => call.action), [
    'scheduleChangeDates',
    'scheduleRemoveEquip',
    'scheduleAddEquips',
    'regenerateContract',
    'sendEstimate'
  ]);
  assert.equal(posts.filter((call) => call.action === 'regenerateContract').length, 1);
  assert.equal(posts.filter((call) => call.action === 'sendEstimate').length, 1);
  assert.equal(posts[1].body.scheduleId, '260810-003-04');
  assert.match(posts[1].body.mutationId, /-remove-1$/);
  assert.deepEqual(posts[2].body.entries, [
    { name: '소니 GM 24-70mm F2.8 GM II', qty: 1 },
    { name: '소니 GM 70-200mm F2.8 GM II', qty: 1 }
  ]);
  assert.equal(posts[2].body.directRegenerate, false);
  assert.equal(result.ok, true);
  assert.equal(result.verified, true);
  assert.equal(result.send.accepted, true);
  assert.equal(result.readback.contract.rounds, 3);
  assert.equal(fixture.calls.filter((call) => call.method === 'GET').length, 4);
  assert.doesNotMatch(JSON.stringify(result), /synthetic-key/);
});

test('a correction without explicit send never calls a customer action', async () => {
  const addedRow = [
    '260810-003-12', '260810-003', '', '소니 GM 70-200mm F2.8 GM II', 1,
    '2026-08-10', '05:00', '2026-08-19', '05:00', '대기', '', 120000, '조용준'
  ];
  const fixture = createFetchFixture({
    finalSchedule: [oldSetRow, oldComponentRow, addedRow],
    finalContract: [oldContractRow]
  });
  const result = await runRegisteredTradeCorrection({
    config,
    input: {
      tradeId: '260810-003',
      operationId,
      add: [{ name: '소니 GM 70-200mm F2.8 GM II', qty: 1 }],
      sendEstimate: false
    },
    fetchImpl: fixture.fetchImpl,
    timeoutMs: 1_000
  });

  const actions = fixture.calls.filter((call) => call.method === 'POST').map((call) => call.action);
  assert.deepEqual(actions, ['scheduleAddEquips', 'regenerateContract']);
  assert.equal(result.send.attempted, false);
  assert.equal(result.verified, true);
});

test('an ambiguous send response is never retried and exposes the failed stage', async () => {
  const fixture = createFetchFixture({
    finalSchedule: [oldSetRow, oldComponentRow],
    finalContract: [oldContractRow],
    responseByAction: { sendEstimate: { message: 'request may have been accepted' } }
  });
  await assert.rejects(
    () => runRegisteredTradeCorrection({
      config,
      input: { tradeId: '260810-003', operationId, sendEstimate: true },
      fetchImpl: fixture.fetchImpl,
      timeoutMs: 1_000
    }),
    (error) => {
      assert.equal(error.stage, 'sendEstimate');
      assert.equal(error.outcomeUnknown, true);
      return true;
    }
  );
  assert.equal(
    fixture.calls.filter((call) => call.action === 'sendEstimate').length,
    1,
    'an uncertain customer send must never be retried automatically'
  );
});

test('stale final item readback rejects an apparently successful correction', async () => {
  const fixture = createFetchFixture({
    finalSchedule: [oldSetRow, oldComponentRow],
    finalContract: [oldContractRow]
  });
  await assert.rejects(
    () => runRegisteredTradeCorrection({
      config,
      input: {
        tradeId: '260810-003',
        operationId,
        add: [{ name: '소니 GM 70-200mm F2.8 GM II', qty: 1 }]
      },
      fetchImpl: fixture.fetchImpl,
      timeoutMs: 1_000
    }),
    (error) => {
      assert.match(error.message, /final readback/i);
      assert.deepEqual(error.appliedStages, ['scheduleAddEquips', 'regenerateContract']);
      return true;
    }
  );
  assert.equal(fixture.calls.filter((call) => call.action === 'scheduleAddEquips').length, 1);
  assert.equal(fixture.calls.filter((call) => call.action === 'regenerateContract').length, 1);
});

test('an unexpected final top-level item is rejected instead of being hidden by partial verification', async () => {
  const expectedAddedRow = [
    '260810-003-12', '260810-003', '', '소니 GM 70-200mm F2.8 GM II', 1,
    '2026-08-10', '05:00', '2026-08-19', '05:00', '대기', '', 120000, '조용준'
  ];
  const unexpectedRow = [
    '260810-003-13', '260810-003', '', '요청하지 않은 장비', 1,
    '2026-08-10', '05:00', '2026-08-19', '05:00', '대기', '', 50000, '조용준'
  ];
  const fixture = createFetchFixture({
    finalSchedule: [oldSetRow, oldComponentRow, expectedAddedRow, unexpectedRow],
    finalContract: [oldContractRow]
  });

  await assert.rejects(
    () => runRegisteredTradeCorrection({
      config,
      input: {
        tradeId: '260810-003',
        operationId,
        add: [{ name: '소니 GM 70-200mm F2.8 GM II', qty: 1 }]
      },
      fetchImpl: fixture.fetchImpl,
      timeoutMs: 1_000
    }),
    /unexpected item/i
  );
});
