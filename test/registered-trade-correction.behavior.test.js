'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');

function section(source, start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, `${start} section not found`);
  return source.slice(from, to);
}

function successState() {
  return {
    contract: {
      startDate: '2026-08-18', startTime: '04:30',
      endDate: '2026-08-21', endTime: '04:30', rounds: 3,
    },
    schedule: {
      periods: ['2026-08-18|04:30|2026-08-21|04:30'],
      rows: [
        { scheduleId: '260813-005-12', setName: '', name: 'BURANO 8K', qty: 1, isComponent: false },
      ],
      topLevelQuantities: { 'BURANO 8K': 1 },
    },
    ledger: {
      rows: 1,
      startDate: '2026-08-18',
      contractLink: 'https://docs.example/contract',
      links: ['https://docs.example/contract'],
    },
  };
}

function harness({
  lockAvailable = true,
  addPreflightError = '',
  addMutationError = '',
  checkoutStarted = false,
  leaseError = '',
  structureQueuePending = false,
  useRealRemovalPreflight = false,
} = {}) {
  const gas = fs.readFileSync(path.join(root, 'checkAvailability.js'), 'utf8');
  const body = section(
    gas,
    'function normalizeRegisteredTradeCorrection_',
    '\nfunction changeRegisteredTradeDates',
  );

  const calls = {
    preflight: [], mutate: [], lockTries: 0, lockReleases: 0,
    regenerations: 0, lockHeldDuringRegeneration: null, triggerLockStates: [], reads: 0,
  };
  let lockHeld = false;
  const baseline = {
    contract: {
      startDate: '2026-08-17', startTime: '04:30',
      endDate: '2026-08-20', endTime: '04:30', rounds: 3,
    },
    schedule: {
      periods: ['2026-08-17|04:30|2026-08-20|04:30'],
      rows: [
        { scheduleId: '260813-005-01', setName: '', name: 'FX9', qty: 1, isComponent: false },
      ],
      topLevelQuantities: { FX9: 1 },
    },
    ledger: { rows: 1, startDate: '2026-08-17', contractLink: 'https://docs.example/old' },
  };

  const context = {
    Date, JSON, Math, Object, Array, String, Number, RegExp, Error,
    Utilities: {
      formatDate(date) {
        return new Date(date).toISOString().slice(0, 10);
      },
    },
    SpreadsheetApp: {
      flush() {},
      getActiveSpreadsheet() { return {}; },
    },
    PropertiesService: {
      getScriptProperties() {
        return {
          getProperty(key) {
            return structureQueuePending && key === `dashboardStructureQueue_${input.tradeId}` ? '{}' : '';
          },
        };
      },
    },
    DASHBOARD_STRUCTURE_QUEUE_PREFIX_: 'dashboardStructureQueue_',
    dashboardTradeMutationLeaseError_() {
      return leaseError ? { error: leaseError, code: 'BUSY', retryable: true } : null;
    },
    resolveDashboardRemovalRows_(removalData, _tradeId, scheduleId) {
      return removalData
        .map((row, index) => String(row[0]) === String(scheduleId) ? index + 2 : 0)
        .filter(Boolean);
    },
    isDashboardTradeCheckoutStarted_() { return checkoutStarted; },
    normalizeDashboardAddEntries_(entries) {
      return (entries || []).map((entry) => ({
        name: String(entry.name || '').trim(),
        qty: Number(entry.qty) || 1,
      }));
    },
    calcRentalDays(startDate, startTime, endDate, endTime) {
      const start = Date.parse(`${startDate}T${startTime}:00+09:00`);
      const end = Date.parse(`${endDate}T${endTime}:00+09:00`);
      return Math.max(1, Math.ceil(((end - start) / 3_600_000 - 3) / 24));
    },
    LockService: {
      getScriptLock: () => ({
        tryLock() {
          calls.lockTries += 1;
          if (!lockAvailable) return false;
          lockHeld = true;
          return true;
        },
        releaseLock() {
          calls.lockReleases += 1;
          lockHeld = false;
        },
      }),
    },
    changeRegisteredTradeDates(args, options) {
      assert.equal(lockHeld, true, 'date mutation must run under the outer lock');
      assert.equal(options.lockAlreadyHeld, true);
      assert.equal(options.deferContractRegeneration, true);
      calls.mutate.push('date');
      return { success: true, status: 'CHANGED', requested: args };
    },
    dashboardAddEquipments(_tid, _entries, options) {
      assert.deepEqual(
        Array.from(options.excludeScheduleIds || []),
        ['260813-005-01'],
        'combined availability must exclude the exact removal plan',
      );
      assert.equal(options.requireExactCatalog, true);
      if (options.dryRun) {
        calls.preflight.push('add');
        return addPreflightError ? { error: addPreflightError } : {
          success: true,
          dryRun: true,
          plannedItems: [
            { scheduleId: '260813-005-12', setName: '', name: 'BURANO 8K', qty: 1, isComponent: false },
          ],
        };
      }
      assert.equal(lockHeld, true, 'add mutation must run under the outer lock');
      assert.equal(options.lockAlreadyHeld, true);
      assert.equal(options.deferContractRegeneration, true);
      calls.mutate.push('add');
      return addMutationError ? { error: addMutationError } : { success: true, addedRows: 1 };
    },
    dashboardRemoveEquipmentBatch(_tid, _entries, options) {
      assert.equal(lockHeld, true, 'remove mutation must run under the outer lock');
      assert.equal(options.lockAlreadyHeld, true);
      assert.equal(options.deferContractRegeneration, true);
      calls.mutate.push('remove');
      return { success: true, removedRows: 1, removedScheduleIds: ['260813-005-01'] };
    },
    regenerateContractById() {
      calls.regenerations += 1;
      calls.lockHeldDuringRegeneration = lockHeld;
      return {
        success: true,
        url: 'https://docs.example/contract',
        fileId: 'contract-file',
        linkUpdate: { success: true },
      };
    },
    ensureDashboardStructureProjectionTrigger_() {
      calls.triggerLockStates.push(lockHeld);
    },
  };
  vm.runInNewContext(`${body}\nthis.correct = correctRegisteredTrade; this.normalize = normalizeRegisteredTradeCorrection_;`, context);
  const verifyActual = context.verifyRegisteredTradeCorrectionState_;

  context.readRegisteredTradeCorrectionState_ = () => {
    calls.reads += 1;
    return calls.reads === 1 ? baseline : successState();
  };
  if (!useRealRemovalPreflight) {
    context.preflightRegisteredTradeRemoval_ = () => {
      calls.preflight.push('remove');
      return { success: true, scheduleIds: ['260813-005-01'] };
    };
  }
  context.verifyRegisteredTradeCorrectionState_ = (_baseline, finalState) => finalState;

  return { context, calls, verifyActual, baseline };
}

const input = {
  tradeId: '260813-005',
  operationId: '8f6c77d1-8828-4a85-bf74-13815d96bf51',
  expectedPeriod: {
    startDate: '2026-08-17', startTime: '04:30',
    endDate: '2026-08-20', endTime: '04:30',
  },
  dateChange: {
    newStartDate: '2026-08-18', newEndDate: '2026-08-21',
    startTime: '04:30', endTime: '04:30', allowConflicts: false,
  },
  remove: [{ scheduleId: '260813-005-01', expectedName: 'FX9', expectedQty: 1 }],
  add: [{ name: 'BURANO 8K', qty: 1 }],
};

function assertNoWriteSideEffects(calls) {
  assert.deepEqual(calls.mutate, []);
  assert.equal(calls.regenerations, 0);
  assert.deepEqual(calls.triggerLockStates, []);
}

test('a removal quantity baseline mismatch fails before every write', () => {
  const { context, calls } = harness({ useRealRemovalPreflight: true });

  assert.throws(
    () => context.correct({
      ...input,
      expectedPeriod: undefined,
      remove: [{ ...input.remove[0], expectedQty: 2 }],
    }),
    /수량이 일치하지 않습니다/,
  );

  assertNoWriteSideEffects(calls);
});

test('a contract period baseline mismatch fails before removal or add preflight', () => {
  const { context, calls } = harness();

  assert.throws(
    () => context.correct({
      ...input,
      expectedPeriod: { ...input.expectedPeriod, endTime: '05:00' },
    }),
    /baseline period mismatch/i,
  );

  assert.deepEqual(calls.preflight, []);
  assertNoWriteSideEffects(calls);
});

test('a replacement stock conflict after target allocation exclusion fails before every write', () => {
  const { context, calls } = harness({ addPreflightError: 'BURANO unavailable' });

  assert.throws(() => context.correct(input), /BURANO unavailable/);

  assert.deepEqual(calls.preflight, ['remove', 'add']);
  assertNoWriteSideEffects(calls);
});

test('a replacement available only after exact target allocation exclusion preflights and succeeds', () => {
  const { context, calls } = harness();
  const result = context.correct(input);

  assert.deepEqual(calls.preflight, ['remove', 'add']);
  assert.deepEqual(calls.mutate, ['date', 'add', 'remove']);
  assert.equal(result.success, true);
});

test('one correction preflights all item deltas, locks once, adds before remove, and regenerates after unlock', () => {
  const { context, calls } = harness();
  const result = context.correct(input);

  assert.deepEqual(calls.preflight, ['remove', 'add']);
  assert.deepEqual(calls.mutate, ['date', 'add', 'remove']);
  assert.equal(calls.lockTries, 1);
  assert.equal(calls.lockReleases, 1);
  assert.equal(calls.regenerations, 1);
  assert.equal(calls.lockHeldDuringRegeneration, false);
  assert.deepEqual(calls.triggerLockStates, [false]);
  assert.equal(result.success, true);
  assert.equal(result.customerNotificationSent, false);
  assert.equal(result.readback.ledger.contractLink, 'https://docs.example/contract');
});

test('BUSY is terminal for this invocation and never spins or mutates', () => {
  const { context, calls } = harness({ lockAvailable: false });
  const result = context.correct(input);

  assert.equal(result.success, false);
  assert.equal(result.code, 'BUSY');
  assert.equal(result.retryable, false);
  assert.equal(calls.lockTries, 1);
  assert.deepEqual(calls.mutate, []);
  assert.equal(calls.regenerations, 0);
});

test('an add preflight failure prevents every mutation', () => {
  const { context, calls } = harness({ addPreflightError: 'BURANO unavailable' });
  assert.throws(() => context.correct(input), /BURANO unavailable/);
  assert.deepEqual(calls.mutate, []);
  assert.equal(calls.lockTries, 1);
});

test('removing every schedule row without a replacement fails before the first mutation', () => {
  const { context, calls } = harness();
  assert.throws(
    () => context.correct({
      tradeId: input.tradeId,
      operationId: input.operationId,
      remove: input.remove,
    }),
    /모든 스케줄|remaining schedule/i,
  );
  assert.deepEqual(calls.mutate, []);
  assert.equal(calls.regenerations, 0);
});

test('a checkout-started removal is rejected before date or add mutation', () => {
  const { context, calls } = harness({ checkoutStarted: true });
  assert.throws(() => context.correct(input), /반출/);
  assert.deepEqual(calls.mutate, []);
  assert.equal(calls.regenerations, 0);
});

test('an active cross-operation lease blocks even a date-only correction before mutation', () => {
  const { context, calls } = harness({ leaseError: '같은 거래의 반납 상태를 처리 중입니다.' });
  assert.throws(
    () => context.correct({
      tradeId: input.tradeId,
      operationId: input.operationId,
      dateChange: input.dateChange,
    }),
    /반납 상태를 처리 중/,
  );
  assert.deepEqual(calls.mutate, []);
  assert.equal(calls.regenerations, 0);
});

test('a failure after a committed stage is explicitly partial and never sends', () => {
  const { context, calls } = harness({ addMutationError: 'write failed' });
  const result = context.correct(input);
  assert.equal(result.success, false);
  assert.equal(result.code, 'PARTIAL_STATE');
  assert.equal(result.outcomeUnknown, true);
  assert.deepEqual(Array.from(result.appliedStages), ['scheduleChangeDates']);
  assert.equal(result.customerNotificationSent, false);
  assert.deepEqual(calls.mutate, ['date', 'add']);
  assert.equal(calls.regenerations, 0);
  assert.equal(calls.lockReleases, 1);
});

test('a nested add failure after queueing structure work still wakes the worker after unlock', () => {
  const { context, calls } = harness({
    addMutationError: 'write failed after structure queue',
    structureQueuePending: true,
  });
  const result = context.correct(input);
  assert.equal(result.code, 'PARTIAL_STATE');
  assert.deepEqual(calls.triggerLockStates, [false]);
  assert.equal(calls.lockReleases, 1);
});

test('GAS correction boundary rejects nested extras and lossy quantity coercion', () => {
  const { context } = harness();
  assert.throws(
    () => context.normalize({
      tradeId: input.tradeId,
      operationId: input.operationId,
      add: [{ name: 'BURANO 8K', qty: '1', alias: 'burano' }],
    }),
    /add/i,
  );
  assert.throws(
    () => context.normalize({
      tradeId: input.tradeId,
      operationId: input.operationId,
      remove: [{ scheduleId: '260813-005-01', expectedName: 'FX9', row: 2 }],
    }),
    /remove/i,
  );
  assert.throws(
    () => context.normalize({
      tradeId: input.tradeId,
      operationId: 'a'.repeat(114),
      add: [{ name: 'BURANO 8K', qty: 1 }],
    }),
    /operationId/i,
    'the base id must leave room for the longest internal :remove suffix',
  );
});

test('combined availability projection removes every expanded schedule id before checking stock', () => {
  const gas = fs.readFileSync(path.join(root, 'checkAvailability.js'), 'utf8');
  const addBody = section(gas, 'function dashboardAddEquipments', '\nvar DASHBOARD_ONSITE_IDEM_PROP_');
  assert.match(addBody, /excludeScheduleIds/);
  assert.match(addBody, /projectedRows\s*=\s*projectedRows\.filter/);
  assert.match(addBody, /availabilityPreflighted/);
  assert.match(
    addBody,
    /if\s*\(periodOverride\s*\|\|\s*excludeScheduleIds\.length\)[\s\S]*?findDashboardScheduleRowsForEquipments_[\s\S]*?else\s*\{[\s\S]*?getDashboardAvailabilityScheduleData_/,
    'projected preflight must branch before the ordinary full availability-map call',
  );
});

test('sheetAPI exposes the bounded correction action and capability', () => {
  const api = fs.readFileSync(path.join(root, 'sheetAPI.js'), 'utf8');
  assert.match(api, /case\s+["']scheduleCorrectRegisteredTrade["']/);
  assert.match(api, /correctRegisteredTrade\s*\(/);
  assert.match(api, /schedule\.correct_registered_trade/);
});

test('authoritative verification rejects a missing added set component', () => {
  const { verifyActual, baseline } = harness();
  const finalState = successState();
  const correction = {
    tradeId: input.tradeId,
    operationId: input.operationId,
    dateChange: input.dateChange,
    remove: input.remove,
    add: input.add,
  };
  const regeneration = {
    success: true,
    url: 'https://docs.example/contract',
    fileId: 'contract-file',
    linkUpdate: { success: true },
  };
  const operationResults = {
    removalPlan: { scheduleIds: ['260813-005-01'] },
    addPlan: {
      plannedItems: [
        { scheduleId: '260813-005-12', setName: '', name: 'BURANO 8K', qty: 1, isComponent: false },
        { scheduleId: '260813-005-13', setName: 'BURANO 8K', name: 'battery', qty: 1, isComponent: true },
      ],
    },
    remove: {
      removedScheduleIds: ['260813-005-01'],
      removedEquipments: [
        { scheduleId: '260813-005-01', setName: '', name: 'FX9' },
      ],
    },
    add: {
      addedItems: [
        { scheduleId: '260813-005-12', setName: '', name: 'BURANO 8K', qty: 1, isComponent: false },
        { scheduleId: '260813-005-13', setName: 'BURANO 8K', name: 'battery', qty: 1, isComponent: true },
      ],
    },
  };

  assert.throws(
    () => verifyActual(baseline, finalState, correction, regeneration, operationResults),
    /row multiset/i,
  );

  const complete = structuredClone(finalState);
  complete.schedule.rows.push({
    scheduleId: '260813-005-13', setName: 'BURANO 8K', name: 'battery', qty: 1, isComponent: true,
  });
  assert.equal(
    verifyActual(baseline, complete, correction, regeneration, operationResults),
    complete,
  );
});

test('authoritative verification uses the preflight component plan, not a matching bad mutation result', () => {
  const { verifyActual, baseline } = harness();
  const finalState = successState();
  const correction = {
    tradeId: input.tradeId,
    operationId: input.operationId,
    dateChange: input.dateChange,
    remove: input.remove,
    add: input.add,
  };
  const regeneration = {
    success: true,
    url: 'https://docs.example/contract',
    fileId: 'contract-file',
    linkUpdate: { success: true },
  };
  const topLevelOnly = {
    scheduleId: '260813-005-12', setName: '', name: 'BURANO 8K', qty: 1, isComponent: false,
  };

  assert.throws(
    () => verifyActual(baseline, finalState, correction, regeneration, {
      removalPlan: { scheduleIds: ['260813-005-01'] },
      addPlan: {
        plannedItems: [
          topLevelOnly,
          { scheduleId: '260813-005-13', setName: 'BURANO 8K', name: 'battery', qty: 1, isComponent: true },
        ],
      },
      remove: { removedScheduleIds: ['260813-005-01'] },
      add: { addedItems: [topLevelOnly] },
    }),
    /add result.*preflight plan|row multiset/i,
  );
});

test('authoritative verification rejects component over-removal even when mutation result agrees with bad final state', () => {
  const { verifyActual, baseline } = harness();
  baseline.schedule.rows.push({
    scheduleId: '260813-005-02', setName: 'retained set', name: 'battery', qty: 1, isComponent: true,
  });
  const finalState = successState();
  const correction = {
    tradeId: input.tradeId,
    operationId: input.operationId,
    dateChange: input.dateChange,
    remove: input.remove,
    add: input.add,
  };
  const regeneration = {
    success: true,
    url: 'https://docs.example/contract',
    fileId: 'contract-file',
    linkUpdate: { success: true },
  };
  const added = {
    scheduleId: '260813-005-12', setName: '', name: 'BURANO 8K', qty: 1, isComponent: false,
  };

  assert.throws(
    () => verifyActual(baseline, finalState, correction, regeneration, {
      removalPlan: { scheduleIds: ['260813-005-01'] },
      addPlan: { plannedItems: [added] },
      remove: { removedScheduleIds: ['260813-005-01', '260813-005-02'] },
      add: { addedItems: [added] },
    }),
    /remove result.*preflight plan|row multiset/i,
  );
});

test('authoritative verification counts only top-level items and rejects an unexpected item', () => {
  const { verifyActual, baseline } = harness();
  const finalState = successState();
  const correction = {
    tradeId: input.tradeId,
    operationId: input.operationId,
    dateChange: input.dateChange,
    remove: input.remove,
    add: input.add,
  };
  const regeneration = {
    success: true,
    url: 'https://docs.example/contract',
    fileId: 'contract-file',
    linkUpdate: { success: true },
  };

  assert.equal(verifyActual(baseline, finalState, correction, regeneration), finalState);
  const polluted = structuredClone(finalState);
  polluted.schedule.rows.push({
    scheduleId: '260813-005-99', setName: '', name: '요청하지 않은 장비', qty: 1, isComponent: false,
  });
  polluted.schedule.topLevelQuantities['요청하지 않은 장비'] = 1;
  assert.throws(
    () => verifyActual(baseline, polluted, correction, regeneration),
    /최상위 품목 목록 불일치/,
  );
});
