'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  changeTradeDates,
  getCliHelpText,
  normalizeInput,
  parseCliArgs
} = require('../scripts/windows/village-trade-date-change.js');

const config = {
  VILLAGE2_API_URL: 'https://script.google.com/macros/s/example/exec',
  VILLAGE2_API_KEY: 'synthetic-key'
};

function response(payload, { ok = true, status = 200 } = {}) {
  return { ok, status, json: async () => payload };
}

function verifiedMutation(overrides = {}) {
  const contractUrl = 'https://docs.google.com/spreadsheets/d/generated-contract/edit';
  return {
    success: true,
    status: 'CHANGED',
    tradeId: '260723-010',
    updatedScheduleRows: 2,
    conflicts: [],
    customerNotificationSent: false,
    contractRegeneration: {
      success: true,
      url: contractUrl,
      fileId: 'generated-contract',
      linkUpdate: { success: true, rows: 1, url: contractUrl }
    },
    readback: {
      contract: {
        startDate: '2026-07-22', startTime: '20:00', endDate: '2026-07-23', endTime: '23:00'
      },
      schedule: {
        rows: 2,
        periods: ['2026-07-22|20:00|2026-07-23|23:00']
      },
      ledger: {
        startDate: '2026-07-22',
        rows: 1,
        contractLink: contractUrl,
        links: [contractUrl]
      }
    },
    ...overrides
  };
}

test('CLI documents one exact bounded envelope and accepts the change command', () => {
  assert.equal(parseCliArgs(['change']).command, 'change');
  assert.equal(parseCliArgs(['--help']).command, 'help');
  assert.match(
    getCliHelpText(),
    /change\s+\{"name":"customer","currentDate":"YYYY-MM-DD","newStartDate":"YYYY-MM-DD","newEndDate":"YYYY-MM-DD","allowConflicts":false\}/
  );
  assert.match(getCliHelpText(), /explicitly accepts.*conflict/i);
});

test('input validation preserves omitted times and rejects send or arbitrary write fields', () => {
  const normalized = normalizeInput({
    name: '박재인',
    currentDate: '2026-07-24',
    newStartDate: '2026-07-22',
    newEndDate: '2026-07-23'
  });
  assert.equal(normalized.startTime, undefined);
  assert.equal(normalized.endTime, undefined);
  assert.equal(normalized.allowConflicts, false);
  assert.equal(normalizeInput({
    tradeId: '260723-010',
    newStartDate: '2026-07-22',
    newEndDate: '2026-07-23',
    allowConflicts: true
  }).allowConflicts, true);

  assert.throws(
    () => normalizeInput({
      tradeId: '260723-010',
      newStartDate: '2026-07-22',
      newEndDate: '2026-07-23',
      sendCustomerMessage: true
    }),
    /unsupported or forbidden field/i
  );
  assert.throws(
    () => normalizeInput({
      tradeId: '260723-010',
      newStartDate: '2026-07-22',
      newEndDate: '2026-07-23',
      sheet: '계약마스터'
    }),
    /unsupported or forbidden field/i
  );
  assert.throws(
    () => normalizeInput({
      tradeId: '260723-010',
      newStartDate: '2026-02-31',
      newEndDate: '2026-03-02'
    }),
    /valid date/i
  );
});

test('name and old date resolve one trade, then exactly one first-class mutation runs', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    const parsed = new URL(url);
    calls.push({ parsed, options });
    if (options.method === 'GET') {
      assert.equal(parsed.searchParams.get('action'), 'search');
      assert.equal(parsed.searchParams.get('sheet'), '스케줄상세');
      assert.equal(parsed.searchParams.get('col'), '예약자명');
      return response({
        count: 2,
        results: [
          { row: 7461, data: ['260723-010-01', '260723-010', '', '소니 A7S3 바디세트', 1, '2026-07-24', '20:00', '2026-07-26', '23:00', '대기', '', '', '박재인'] },
          { row: 7462, data: ['260723-010-02', '260723-010', '', '소니 FX6 바디세트', 1, '2026-07-24', '20:00', '2026-07-26', '23:00', '대기', '', '', '박재인'] }
        ]
      });
    }

    assert.equal(options.method, 'POST');
    const body = JSON.parse(options.body);
    assert.equal(body.action, 'scheduleChangeDates');
    assert.deepEqual(body.args, {
      tradeId: '260723-010',
      newStartDate: '2026-07-22',
      newEndDate: '2026-07-23',
      allowConflicts: false,
      dryRun: false
    });
    assert.equal('sheet' in body, false);
    assert.equal('range' in body, false);
    assert.equal('send' in body, false);
    return response(verifiedMutation());
  };

  const result = await changeTradeDates({
    config,
    input: {
      name: '박재인',
      currentDate: '2026-07-24',
      newStartDate: '2026-07-22',
      newEndDate: '2026-07-23'
    },
    fetchImpl,
    timeoutMs: 1_000
  });

  assert.equal(result.ok, true);
  assert.equal(result.tradeId, '260723-010');
  assert.equal(result.verified, true);
  assert.equal(result.readback.ledger.startDate, '2026-07-22');
  assert.equal(calls.length, 2);
  assert.doesNotMatch(JSON.stringify(result), /synthetic-key/);
});

test('an ambiguous name/date fails closed before any mutation', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return response({
      count: 2,
      results: [
        { row: 10, data: ['A-01', '260723-010', '', 'A', 1, '2026-07-24', '20:00', '2026-07-26', '23:00', '', '', '', '박재인'] },
        { row: 20, data: ['B-01', '260723-011', '', 'B', 1, '2026-07-24', '20:00', '2026-07-25', '23:00', '', '', '', '박재인'] }
      ]
    });
  };

  await assert.rejects(
    () => changeTradeDates({
      config,
      input: {
        name: '박재인', currentDate: '2026-07-24',
        newStartDate: '2026-07-22', newEndDate: '2026-07-23'
      },
      fetchImpl,
      timeoutMs: 1_000
    }),
    /ambiguous/i
  );
  assert.equal(calls.length, 1);
});

test('a mismatched or incomplete server readback fails without retrying the mutation', async () => {
  let calls = 0;
  const fetchImpl = async (_url, options) => {
    calls += 1;
    assert.equal(options.method, 'POST');
    return response(verifiedMutation({
      readback: {
        contract: { startDate: '2026-07-24', startTime: '20:00', endDate: '2026-07-26', endTime: '23:00' },
        schedule: { rows: 2, periods: ['2026-07-22|20:00|2026-07-23|23:00'] },
        ledger: {
          startDate: '2026-07-22',
          rows: 1,
          contractLink: 'https://docs.google.com/spreadsheets/d/generated-contract/edit',
          links: ['https://docs.google.com/spreadsheets/d/generated-contract/edit']
        }
      }
    }));
  };

  await assert.rejects(
    () => changeTradeDates({
      config,
      input: {
        tradeId: '260723-010',
        newStartDate: '2026-07-22', newEndDate: '2026-07-23',
        startTime: '20:00', endTime: '23:00'
      },
      fetchImpl,
      timeoutMs: 1_000
    }),
    /readback verification failed/i
  );
  assert.equal(calls, 1, 'an uncertain write result must never be retried automatically');
});

test('an availability conflict returns full structured evidence without retry or mutation success', async () => {
  let calls = 0;
  const conflict = {
    장비명: '소니 FX6 바디세트',
    요청수량: 1,
    가용수량: 0,
    보유수량: 1,
    최대동시사용: 1
  };
  const fetchImpl = async (_url, options) => {
    calls += 1;
    assert.equal(options.method, 'POST');
    assert.equal(JSON.parse(options.body).args.allowConflicts, false);
    return response({
      success: false,
      status: 'CONFLICT',
      tradeId: '260723-010',
      conflicts: [conflict],
      availabilityWarnings: ['충돌 상세를 확인하세요'],
      matchedScheduleRows: 27,
      updatedScheduleRows: 27,
      customerNotificationSent: false
    });
  };

  const result = await changeTradeDates({
    config,
    input: {
      tradeId: '260723-010',
      newStartDate: '2026-07-22',
      newEndDate: '2026-07-23'
    },
    fetchImpl,
    timeoutMs: 1_000
  });

  assert.deepEqual(result, {
    ok: false,
    mode: 'blocked',
    tradeId: '260723-010',
    verified: false,
    status: 'CONFLICT',
    conflicts: [conflict],
    availabilityWarnings: ['충돌 상세를 확인하세요'],
    matchedScheduleRows: 27,
    updatedScheduleRows: 0,
    customerNotificationSent: false
  });
  assert.equal(calls, 1);
});

test('a regeneration without a concrete file and matching ledger link is rejected', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return response(verifiedMutation({
      contractRegeneration: { success: true, url: '', fileId: '' }
    }));
  };

  await assert.rejects(
    () => changeTradeDates({
      config,
      input: {
        tradeId: '260723-010',
        newStartDate: '2026-07-22',
        newEndDate: '2026-07-23'
      },
      fetchImpl,
      timeoutMs: 1_000
    }),
    /contract was not regenerated/i
  );
  assert.equal(calls, 1);
});
