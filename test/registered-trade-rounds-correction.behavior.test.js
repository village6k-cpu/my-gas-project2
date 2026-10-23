'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');

const input = {
  tradeId: '261014-007',
  operationId: 'rounds-only-261014-007-001',
  roundsChange: { expectedRounds: 3, rounds: 1 },
};
const copy = value => JSON.parse(JSON.stringify(value));

function harness(options = {}) {
  const calls = { writes: [], regenerations: 0, lockHeld: false, flushes: 0 };
  const props = new Map([['개고생2_URL', 'https://docs.example/ledger']]);
  const properties = {
    getProperty: key => props.get(key) || '',
    setProperty(key, value) { props.set(key, value); return this; },
    deleteProperty: key => props.delete(key),
  };
  function sheet(name, data) {
    return {
      data,
      getLastRow: () => data.length,
      getLastColumn: () => Math.max(...data.map(row => row.length)),
      getRange(row, col, rows = 1, cols = 1) {
        if (typeof row === 'string') { assert.equal(row, 'H47'); row = 47; col = 8; }
        const values = () => Array.from({ length: rows }, (_, r) =>
          Array.from({ length: cols }, (_, c) => data[row + r - 1]?.[col + c - 1] ?? ''));
        return {
          getValues: () => copy(values()),
          getDisplayValues: () => values().map(record => record.map(String)),
          getValue: () => values()[0][0],
          setValue(value) {
            assert.equal(calls.lockHeld, true, 'the exact I-cell write must hold ScriptLock');
            calls.writes.push({ name, row, col, value });
            data[row - 1][col - 1] = value;
            if (options.afterWrite) options.afterWrite({ schedule, contract, ledger });
            return this;
          },
          setValues(values) {
            assert.equal(calls.lockHeld, true, 'rounds and approval note are written under one ScriptLock');
            calls.writes.push({ name, row, col, values: copy(values) });
            values.forEach((record, i) => record.forEach((value, j) => { data[row + i - 1][col + j - 1] = value; }));
            if (options.afterWrite) options.afterWrite({ schedule, contract, ledger });
            return this;
          },
        };
      },
    };
  }
  const schedule = sheet('스케줄상세', [
    Array(13).fill('header'),
    ['261014-007-01', '261014-007', '', 'FX3', 2, '2026-10-14', '18:00', '2026-10-17', '18:00', '반납완료', '보존 메모', 60000, '보존'],
    ['261014-008-01', '261014-008', '', '다른 거래', 1, '2026-10-14', '18:00', '2026-10-17', '18:00', '등록', '', 10000, ''],
  ]);
  const contract = sheet('계약마스터', [
    Array(13).fill('header'),
    ['261014-007', '노사무엘', 'synthetic-phone', '', '2026-10-14', '18:00', '2026-10-17', '18:00', 3, '반납완료', '일반', '', '보존'],
    ['261014-008', '다른 고객', '', '', '2026-10-14', '18:00', '2026-10-17', '18:00', 3, '예약', '', '', ''],
  ]);
  const ledger = sheet('거래내역', [
    Array(9).fill('header'),
    ['2026-10-14', '', 'https://docs.example/old', '', '261014-007', '', '', '', 360000],
  ]);
  let generated = null;
  const context = {
    Date, JSON, Object, Array, String, Number, Math, RegExp, Error,
    DASHBOARD_MUTATION_LEASE_MS_: 7 * 60 * 1000,
    DASHBOARD_SETUP_CLOSING_LEASE_MS_: 7 * 60 * 1000,
    PropertiesService: { getScriptProperties: () => properties },
    LockService: { getScriptLock: () => ({
      tryLock() {
        if (options.busy) return false;
        assert.equal(calls.lockHeld, false);
        calls.lockHeld = true;
        return true;
      },
      releaseLock() { calls.lockHeld = false; },
    }) },
    Utilities: {
      DigestAlgorithm: { SHA_256: 'sha256' }, Charset: { UTF_8: 'utf8' },
      formatDate: date => new Date(date).toISOString().slice(0, 10),
      computeDigest: (_algorithm, value) => [...crypto.createHash('sha256').update(value).digest()],
    },
    SpreadsheetApp: {
      getActiveSpreadsheet: () => ({ getSheetByName: name => ({ '스케줄상세': schedule, '계약마스터': contract })[name] }),
      openByUrl: () => ({ getSheetByName: name => name === '거래내역' ? ledger : null }),
      openById(id) { assert.equal(id, 'rounds-contract'); return { getSheets: () => [generated] }; },
      flush() { calls.flushes += 1; },
    },
    activeDashboardReturnProjectionLease_: () => null,
    invalidateContractSheetScan_() {},
    findTemplateRows: () => ({ itemStart: 10, itemRows: 2 }),
    findContractPaymentRefs_: () => ({ finalAmountCell: 'H47' }),
    readContractAmount_: (ws, ref) => ws.getRange(ref).getValue(),
    registeredTradeCorrectionDate_: raw => String(raw),
    registeredTradeCorrectionTime_: raw => String(raw),
    _normalizeDiscountTypeOrBlank_: value => String(value || '').trim(),
    regenerateContractById(tid, extra, opts) {
      calls.regenerations += 1;
      assert.equal(calls.lockHeld, false, 'regeneration must run after ScriptLock release');
      assert.ok(props.has('registeredTradeRoundsMutation_' + tid), 'shared lease must fence regeneration');
      assert.equal(tid, input.tradeId);
      assert.equal(extra, undefined);
      assert.equal(opts.strictLedgerLink, true);
      if (options.regenError) throw new Error('synthetic regeneration failure');
      const amount = schedule.data.slice(1)
        .filter(row => row[1] === tid)
        .reduce((sum, row) => sum + row[4] * row[11] * contract.data[1][8], 0);
      generated = sheet('generated', Array.from({ length: 47 }, () => Array(13).fill('')));
      generated.data[46][7] = amount;
      ledger.data[1][2] = 'https://docs.example/rounds-contract';
      ledger.data[1][8] = amount;
      if (options.afterRegeneration) options.afterRegeneration({ schedule, contract, ledger, generated });
      return { success: true, fileId: 'rounds-contract', url: 'https://docs.example/rounds-contract', finalAmount: amount, linkUpdate: { success: true } };
    },
  };
  const source = fs.readFileSync(path.resolve(__dirname, '../checkAvailability.js'), 'utf8').replace(/\r\n/g, '\n');
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../approvedBillingRounds.js'), 'utf8'), context);
  const pendingStart = source.indexOf('function hasPendingSchedulePrice_(');
  if (pendingStart >= 0) vm.runInContext(source.slice(pendingStart, source.indexOf('\nfunction ', pendingStart + 1)), context);
  vm.runInContext(source.slice(source.indexOf('function readDashboardMutationLease_'), source.indexOf('var DASHBOARD_STRUCTURE_QUEUE_PREFIX_')), context);
  vm.runInContext(source.slice(source.indexOf('function normalizeRegisteredTradeCorrection_'), source.indexOf('\nfunction changeRegisteredTradeDates')), context);
  context.registeredTradeCorrectionDate_ = raw => String(raw);
  context.registeredTradeCorrectionTime_ = raw => String(raw);
  return { run: value => copy(context.correctRegisteredTrade(value || copy(input))), context, calls, props, schedule, contract, ledger };
}

test('rounds-only correction CAS-writes I and approval L, preserves J/K, and verifies one regenerated contract', () => {
  const h = harness();
  const beforeSchedule = copy(h.schedule.data);
  const beforeContract = copy(h.contract.data);
  const result = h.run();
  assert.equal(result.success, true, result.error);
  assert.equal(result.customerNotificationSent, false);
  const note = '[승인회차:v1 회차=1 기간=2026-10-14T18:00/2026-10-17T18:00]';
  assert.deepEqual(h.calls.writes, [{ name: '계약마스터', row: 2, col: 9, values: [[1, '반납완료', '일반', note]] }]);
  beforeContract[1][8] = 1;
  beforeContract[1][11] = note;
  assert.deepEqual(h.contract.data, beforeContract);
  assert.deepEqual(h.schedule.data, beforeSchedule);
  assert.equal(h.calls.regenerations, 1);
  assert.equal(result.readback.contract.rounds, 1);
  assert.equal(result.roundsReadback.expectedRounds, 3);
  assert.equal(result.roundsReadback.rounds, 1);
  assert.equal(result.roundsReadback.contractAmount, 120000);
  assert.equal(result.roundsReadback.ledgerAmount, 120000);
  assert.equal(result.authoritativeReadback.before.contract.rounds, 3);
  assert.equal(result.authoritativeReadback.after.contract.rounds, 1);
  assert.equal(h.props.has('registeredTradeRoundsMutation_' + input.tradeId), false);
});

test('approved half-round correction retains note text and binds the new billed rounds to the exact current period', () => {
  const h = harness();
  h.contract.data[1][11] = '인수 메모 유지';
  const result = h.run({ ...input, roundsChange: { expectedRounds: 3, rounds: 2.5 } });
  assert.equal(result.success, true, result.error);
  assert.equal(h.contract.data[1][8], 2.5);
  assert.equal(h.contract.data[1][11], '인수 메모 유지\n[승인회차:v1 회차=2.5 기간=2026-10-14T18:00/2026-10-17T18:00]');
  assert.equal(result.readback.contract.billingRounds, 2.5);
  assert.equal(h.calls.regenerations, 1);
  const replay = h.run({ ...input, roundsChange: { expectedRounds: 3, rounds: 2.5 } });
  assert.equal(replay.success, true);
  assert.equal(h.calls.regenerations, 1);
});

test('rounds-only correction rejects stale CAS, invalid bounds, no-op, and mixed changes before writes', () => {
  const h = harness();
  const stale = h.run({ ...input, roundsChange: { expectedRounds: 2, rounds: 1 } });
  assert.equal(stale.success, false);
  assert.equal(stale.noMutationPerformed, true);
  assert.equal(h.calls.writes.length, 0);
  assert.equal(h.calls.regenerations, 0);
  for (const roundsChange of [
    { expectedRounds: 0, rounds: 1 }, { expectedRounds: 3, rounds: 0 },
    { expectedRounds: 3, rounds: 100 }, { expectedRounds: 3, rounds: 1.25 },
    { expectedRounds: '3', rounds: 1 }, { expectedRounds: 3, rounds: 3 },
  ]) assert.throws(() => h.context.normalizeRegisteredTradeCorrection_({ ...input, roundsChange }));
  for (const mixed of [
    { add: [{ name: 'FX6', qty: 1 }] }, { remove: [{ scheduleId: '261014-007-01', expectedName: 'FX3' }] },
    { dateChange: { newStartDate: '2026-10-15', newEndDate: '2026-10-17' } },
    { priceChanges: [{ scheduleId: '261014-007-01', expectedName: 'FX3', expectedQty: 2, expectedUnitPrice: 60000, unitPrice: 50000 }] },
    { expectedPeriod: { startDate: '2026-10-14', startTime: '18:00', endDate: '2026-10-17', endTime: '18:00' } },
  ]) assert.throws(() => h.context.normalizeRegisteredTradeCorrection_({ ...input, ...mixed }));
});

test('post-write unrelated drift is partial state and the operation is never replayed', () => {
  const h = harness({ afterRegeneration: ({ schedule }) => { schedule.data[1][10] = 'concurrent edit'; } });
  const result = h.run();
  assert.equal(result.success, false);
  assert.equal(result.status, 'PARTIAL_STATE');
  assert.equal(result.outcomeUnknown, true);
  assert.equal(h.calls.writes.length, 1);
  assert.equal(h.calls.regenerations, 1);
  const retry = h.run();
  assert.equal(retry.success, false);
  assert.equal(retry.outcomeUnknown, true);
  assert.equal(h.calls.writes.length, 1);
  assert.equal(h.calls.regenerations, 1);
});
