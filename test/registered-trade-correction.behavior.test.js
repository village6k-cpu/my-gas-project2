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

function successState(contractStatus = '') {
  return {
    contract: {
      startDate: '2026-08-18', startTime: '04:30',
      endDate: '2026-08-21', endTime: '04:30', rounds: 3, status: contractStatus,
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
  baselineRows = null,
  expectedExcludeScheduleIds = ['260813-005-01'],
  baselineContractStatus = '',
  finalContractStatus = '',
  durableCheckoutState = {
    ok: true,
    tradeFound: true,
    setupDone: false,
    returnDone: false,
    contractStatus: '',
    started: false,
    items: [],
  },
  historicalProjectionError = '',
  finalState = null,
  useRealVerification = false,
} = {}) {
  const gas = fs.readFileSync(path.join(root, 'checkAvailability.js'), 'utf8');
  const body = section(
    gas,
    'function normalizeRegisteredTradeCorrection_',
    '\nfunction changeRegisteredTradeDates',
  );

  const calls = {
    preflight: [], mutate: [], lockTries: 0, lockReleases: 0,
    regenerations: 0, notifications: 0, lockHeldDuringRegeneration: null, triggerLockStates: [], reads: 0,
    removeEntries: [],
    durableCheckoutReads: 0, historicalProjectionCalls: [],
    addHistoricalToken: null, removeHistoricalToken: null,
  };
  let lockHeld = false;
  const effectiveBaselineRows = baselineRows || [
    { scheduleId: '260813-005-01', setName: '', name: 'FX9', qty: 1, isComponent: false },
  ];
  const baselineTopLevelQuantities = {};
  effectiveBaselineRows.forEach((row) => {
    if (!row.isComponent) baselineTopLevelQuantities[row.name] = (baselineTopLevelQuantities[row.name] || 0) + row.qty;
  });
  const baseline = {
    contract: {
      startDate: '2026-08-17', startTime: '04:30',
      endDate: '2026-08-20', endTime: '04:30', rounds: 3, status: baselineContractStatus,
    },
    schedule: {
      periods: ['2026-08-17|04:30|2026-08-20|04:30'],
      rows: effectiveBaselineRows,
      topLevelQuantities: baselineTopLevelQuantities,
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
    supaGetCheckoutBaselineState_() {
      calls.durableCheckoutReads += 1;
      return durableCheckoutState;
    },
    supaApplyReturnedTradeHistoricalCorrection_(_tid, _removedIds, _addedItems) {
      calls.historicalProjectionCalls.push({
        tid: _tid,
        removedIds: Array.from(_removedIds || []),
        addedItems: Array.from(_addedItems || [], (item) => ({ ...item })),
      });
      return historicalProjectionError
        ? { ok: false, error: historicalProjectionError }
        : { ok: true, removedScheduleIds: Array.from(_removedIds || []), addedScheduleIds: Array.from(_addedItems || [], (item) => item.scheduleId) };
    },
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
        expectedExcludeScheduleIds,
        'combined availability must exclude the exact removal plan',
      );
      assert.equal(options.requireExactCatalog, true);
      if (options.dryRun) {
        calls.preflight.push('add');
        return addPreflightError ? { error: addPreflightError } : {
          success: true,
          dryRun: true,
          plannedItems: _entries.map((entry, index) => ({
            scheduleId: `260813-005-${12 + index}`,
            setName: '',
            name: entry.name,
            qty: entry.qty,
            isComponent: false,
          })),
        };
      }
      assert.equal(lockHeld, true, 'add mutation must run under the outer lock');
      assert.equal(options.lockAlreadyHeld, true);
      assert.equal(options.deferContractRegeneration, true);
      calls.addHistoricalToken = options.historicalCorrectionToken || null;
      calls.mutate.push('add');
      return addMutationError ? { error: addMutationError } : {
        success: true,
        addedRows: _entries.length,
        addedItems: _entries.map((entry, index) => ({
          scheduleId: `260813-005-${12 + index}`,
          setName: '',
          name: entry.name,
          qty: entry.qty,
          isComponent: false,
        })),
      };
    },
    dashboardRemoveEquipmentBatch(_tid, _entries, options) {
      assert.equal(lockHeld, true, 'remove mutation must run under the outer lock');
      assert.equal(options.lockAlreadyHeld, true);
      assert.equal(options.deferContractRegeneration, true);
      calls.removeHistoricalToken = options.historicalCorrectionToken || null;
      calls.mutate.push('remove');
      calls.removeEntries = _entries.map((entry) => ({ ...entry }));
      return {
        success: true,
        removedRows: _entries.length,
        removedScheduleIds: _entries.map((entry) => entry.scheduleId),
      };
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
    sendRegisteredTradeCorrectionNotification_() {
      calls.notifications += 1;
      return { sent: true };
    },
    ensureDashboardStructureProjectionTrigger_() {
      calls.triggerLockStates.push(lockHeld);
    },
  };
  vm.runInNewContext(`${body}\nthis.correct = correctRegisteredTrade; this.normalize = normalizeRegisteredTradeCorrection_;`, context);
  const verifyActual = context.verifyRegisteredTradeCorrectionState_;

  context.readRegisteredTradeCorrectionState_ = () => {
    calls.reads += 1;
    return calls.reads === 1 ? baseline : (finalState || successState(finalContractStatus));
  };
  if (!useRealRemovalPreflight) {
    context.preflightRegisteredTradeRemoval_ = (_state, removals) => {
      calls.preflight.push('remove');
      return { success: true, scheduleIds: (removals || []).length ? ['260813-005-01'] : [] };
    };
  }
  if (!useRealVerification) {
    context.verifyRegisteredTradeCorrectionState_ = (_baseline, finalState) => finalState;
  }

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
  assert.equal(calls.notifications, 0);
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

test('component quantity change is typed blocked in locked preflight with zero writes', () => {
  const componentRows = [
    { scheduleId: '260813-005-01', setName: 'Cinema Set', name: 'Cinema Set', qty: 1, isComponent: false },
    { scheduleId: '260813-005-02', setName: 'Cinema Set', name: 'Battery', qty: 1, isComponent: true },
  ];
  const { context, calls } = harness({
    baselineRows: componentRows,
    useRealRemovalPreflight: true,
    expectedExcludeScheduleIds: ['260813-005-02'],
  });

  const result = context.correct({
    tradeId: input.tradeId,
    operationId: input.operationId,
    remove: [{ scheduleId: '260813-005-02', expectedName: 'Battery', expectedQty: 1 }],
    add: [{ name: 'Battery', qty: 2 }],
  });

  assert.equal(result.success, false);
  assert.equal(result.status, 'ERROR');
  assert.equal(result.code, 'UNSAFE_COMPONENT_READD');
  assert.equal(result.attemptedStage, 'preflight');
  assert.deepEqual(Array.from(result.appliedStages), []);
  assert.equal(result.customerNotificationSent, false);
  assert.deepEqual(calls.preflight, []);
  assertNoWriteSideEffects(calls);
});

test('component replacement is typed blocked before add preflight or any write', () => {
  const componentRows = [
    { scheduleId: '260813-005-01', setName: 'Cinema Set', name: 'Cinema Set', qty: 1, isComponent: false },
    { scheduleId: '260813-005-02', setName: 'Cinema Set', name: 'Battery', qty: 1, isComponent: true },
  ];
  const { context, calls } = harness({
    baselineRows: componentRows,
    useRealRemovalPreflight: true,
    expectedExcludeScheduleIds: ['260813-005-02'],
  });

  const result = context.correct({
    tradeId: input.tradeId,
    operationId: input.operationId,
    remove: [{ scheduleId: '260813-005-02', expectedName: 'Battery', expectedQty: 1 }],
    add: [{ name: 'High Capacity Battery', qty: 1 }],
  });

  assert.equal(result.code, 'UNSAFE_COMPONENT_READD');
  assert.deepEqual(calls.preflight, []);
  assertNoWriteSideEffects(calls);
});

test('component removal-only keeps the surrounding set and removes only the exact component row', () => {
  const componentRows = [
    { scheduleId: '260813-005-01', setName: 'Cinema Set', name: 'Cinema Set', qty: 1, isComponent: false },
    { scheduleId: '260813-005-02', setName: 'Cinema Set', name: 'Battery', qty: 1, isComponent: true },
    { scheduleId: '260813-005-03', setName: 'Cinema Set', name: 'Charger', qty: 1, isComponent: true },
  ];
  const { context, calls } = harness({ baselineRows: componentRows, useRealRemovalPreflight: true });

  const result = context.correct({
    tradeId: input.tradeId,
    operationId: input.operationId,
    remove: [{ scheduleId: '260813-005-02', expectedName: 'Battery', expectedQty: 1 }],
  });

  assert.equal(result.success, true);
  assert.deepEqual(calls.mutate, ['remove']);
  assert.deepEqual(calls.removeEntries, [{ scheduleId: '260813-005-02' }]);
});

test('ordinary top-level quantity change remains supported', () => {
  const { context, calls } = harness();
  const result = context.correct({
    tradeId: input.tradeId,
    operationId: input.operationId,
    remove: [{ scheduleId: '260813-005-01', expectedName: 'FX9', expectedQty: 1 }],
    add: [{ name: 'FX9', qty: 2 }],
  });

  assert.equal(result.success, true);
  assert.deepEqual(calls.mutate, ['add', 'remove']);
});

test('one correction preflights all item deltas, locks once, adds before remove, and regenerates after unlock', () => {
  const { context, calls, baseline } = harness();
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
  assert.deepEqual(result.authoritativeReadback.before, baseline);
  assert.deepEqual(result.authoritativeReadback.after, result.readback);
  assert.equal(result.authoritativeReadback.before.schedule.topLevelQuantities.FX9, 1);
  assert.equal(result.authoritativeReadback.after.schedule.topLevelQuantities['BURANO 8K'], 1);
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

test('a returned trade replacement may correct only an untaken historical row without reopening return state', () => {
  const returnedFinal = {
    contract: {
      startDate: '2026-08-17', startTime: '04:30',
      endDate: '2026-08-20', endTime: '04:30', rounds: 3, status: '반납완료',
    },
    schedule: {
      periods: ['2026-08-17|04:30|2026-08-20|04:30'],
      rows: [
        { scheduleId: '260813-005-12', setName: '', name: 'BURANO 8K', qty: 1, isComponent: false },
      ],
      topLevelQuantities: { 'BURANO 8K': 1 },
    },
    ledger: {
      rows: 1,
      startDate: '2026-08-17',
      contractLink: 'https://docs.example/contract',
      links: ['https://docs.example/contract'],
    },
  };
  const { context, calls } = harness({
    checkoutStarted: true,
    baselineContractStatus: '반납완료',
    finalContractStatus: '반납완료',
    finalState: returnedFinal,
    useRealVerification: true,
    durableCheckoutState: {
      ok: true,
      tradeFound: true,
      setupDone: true,
      returnDone: true,
      contractStatus: '반납완료',
      started: true,
      items: [{ schedule_id: '260813-005-99', taken_qty: 1 }],
    },
  });

  const result = context.correct({
    tradeId: input.tradeId,
    operationId: input.operationId,
    expectedPeriod: input.expectedPeriod,
    remove: input.remove,
    add: input.add,
  });

  assert.equal(result.success, true);
  assert.deepEqual(calls.mutate, ['add', 'remove']);
  assert.equal(calls.durableCheckoutReads, 1);
  assert.ok(calls.addHistoricalToken, 'the add must receive the private historical-correction capability');
  assert.equal(calls.removeHistoricalToken, calls.addHistoricalToken);
  assert.deepEqual(calls.historicalProjectionCalls, [{
    tid: input.tradeId,
    removedIds: ['260813-005-01'],
    addedItems: [{ scheduleId: '260813-005-12', setName: '', name: 'BURANO 8K', qty: 1, isComponent: false }],
  }]);
  assert.equal(result.readback.contract.status, '반납완료');
});

test('a returned trade addition is recorded as historical documentation without reopening return state', () => {
  const returnedFinal = {
    contract: {
      startDate: '2026-08-17', startTime: '04:30',
      endDate: '2026-08-20', endTime: '04:30', rounds: 3, status: '반납완료',
    },
    schedule: {
      periods: ['2026-08-17|04:30|2026-08-20|04:30'],
      rows: [
        { scheduleId: '260813-005-01', setName: '', name: 'FX9', qty: 1, isComponent: false },
        { scheduleId: '260813-005-12', setName: '', name: 'BURANO 8K', qty: 1, isComponent: false },
      ],
      topLevelQuantities: { FX9: 1, 'BURANO 8K': 1 },
    },
    ledger: {
      rows: 1,
      startDate: '2026-08-17',
      contractLink: 'https://docs.example/contract',
      links: ['https://docs.example/contract'],
    },
  };
  const { context, calls } = harness({
    checkoutStarted: true,
    expectedExcludeScheduleIds: [],
    baselineContractStatus: '반납완료',
    finalState: returnedFinal,
    useRealVerification: true,
    durableCheckoutState: {
      ok: true,
      tradeFound: true,
      setupDone: true,
      returnDone: true,
      contractStatus: '반납완료',
      started: true,
      items: [{ schedule_id: '260813-005-01', taken_qty: 1 }],
    },
  });

  const result = context.correct({
    tradeId: input.tradeId,
    operationId: input.operationId,
    expectedPeriod: input.expectedPeriod,
    add: input.add,
  });

  assert.equal(result.success, true);
  assert.deepEqual(calls.mutate, ['add']);
  assert.ok(calls.addHistoricalToken);
  assert.deepEqual(calls.historicalProjectionCalls[0].removedIds, []);
  assert.equal(result.readback.contract.status, '반납완료');
});

test('a returned trade correction fails closed before writes when the target belongs to the immutable checkout baseline', () => {
  const { context, calls } = harness({
    checkoutStarted: true,
    baselineContractStatus: '반납완료',
    durableCheckoutState: {
      ok: true,
      tradeFound: true,
      setupDone: true,
      returnDone: true,
      contractStatus: '반납완료',
      started: true,
      items: [{ schedule_id: '260813-005-01', taken_qty: 1 }],
    },
  });

  assert.throws(() => context.correct({
    tradeId: input.tradeId,
    operationId: input.operationId,
    expectedPeriod: input.expectedPeriod,
    remove: input.remove,
    add: input.add,
  }), /불변 반출 기준선|taken_qty/);
  assertNoWriteSideEffects(calls);
  assert.equal(calls.historicalProjectionCalls.length, 0);
});

test('a returned trade correction fails closed before writes when durable checkout authority cannot be read', () => {
  const { context, calls } = harness({
    checkoutStarted: true,
    baselineContractStatus: '반납완료',
    durableCheckoutState: { ok: false, error: 'authority unavailable', started: false, items: [] },
  });

  assert.throws(() => context.correct({
    tradeId: input.tradeId,
    operationId: input.operationId,
    expectedPeriod: input.expectedPeriod,
    remove: input.remove,
    add: input.add,
  }), /authority unavailable|권한 상태/);
  assertNoWriteSideEffects(calls);
});

test('a returned historical correction reports partial state if its exact Supabase projection fails after sheet writes', () => {
  const { context, calls } = harness({
    checkoutStarted: true,
    baselineContractStatus: '반납완료',
    historicalProjectionError: 'projection unavailable',
    durableCheckoutState: {
      ok: true,
      tradeFound: true,
      setupDone: true,
      returnDone: true,
      contractStatus: '반납완료',
      started: true,
      items: [],
    },
  });

  const result = context.correct({
    tradeId: input.tradeId,
    operationId: input.operationId,
    expectedPeriod: input.expectedPeriod,
    remove: input.remove,
    add: input.add,
  });

  assert.equal(result.success, false);
  assert.equal(result.code, 'PARTIAL_STATE');
  assert.deepEqual(Array.from(result.appliedStages), ['scheduleAddEquips', 'scheduleRemoveEquips']);
  assert.equal(result.attemptedStage, 'syncHistoricalProjection');
  assert.equal(calls.regenerations, 0);
  assert.equal(result.customerNotificationSent, false);
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

test('actual single-equipment GAS add preserves schedule suffix 100 without changing row width', () => {
  const gas = fs.readFileSync(path.join(root, 'checkAvailability.js'), 'utf8');
  const body = section(gas, 'function dashboardAddEquipment(', '\n/**\n * Dashboard에서 장비 삭제.');
  const tradeId = '260813-005';
  const existing = [
    `${tradeId}-99`, tradeId, '', 'FX9', 1,
    '2026-08-17', '04:30', '2026-08-20', '04:30', '대기', '', 0, '테스트 고객',
  ];
  let writtenRows = null;
  const sched = {
    getLastRow() { return 2; },
    getRange(row, column, rowCount, columnCount) {
      return {
        getValues() { return [existing.slice()]; },
        getDisplayValues() { return [existing.slice()]; },
        setValues(rows) { writtenRows = rows.map((entry) => Array.from(entry)); return this; },
        setNumberFormat() { return this; },
      };
    },
    insertRowsAfter() {},
  };
  const ss = {
    getSheetByName(name) {
      if (name === '스케줄상세') return sched;
      if (name === '장비마스터' || name === '세트마스터') return {};
      return null;
    },
  };
  const context = {
    Date, JSON, Math, Object, Array, String, Number, RegExp, Error,
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) },
    PropertiesService: { getScriptProperties: () => ({ getProperty: () => '' }) },
    SpreadsheetApp: { getActiveSpreadsheet: () => ss },
    dashboardTradeMutationLeaseError_: () => null,
    resolveEquipmentName_: (name) => name,
    parseDT: () => new Date('2026-08-17T00:00:00Z'),
    getSetComponents: () => [],
    buildAvailabilityItems_: (name, qty) => [{ name, qty }],
    checkAvailabilityForAdd_: () => ({ ok: true, conflicts: [], warnings: [] }),
    findSetPrice: () => 0,
    invalidateDashboardReturnInspectionForTrade_: () => ({ success: true }),
    isDashboardTradeCheckoutStarted_: () => false,
    formatScheduleSheet() {},
    scheduleContractRegenUnderLock_() {},
    ensureDashboardStructureProjectionTrigger_() {},
    ensureContractRegenTrigger_() {},
    dashboardAddedItemsFromRows_: (rows) => rows.map((row) => ({
      scheduleId: row[0], setName: row[2], name: row[3], qty: row[4], isComponent: !!row[2] && row[2] !== row[3],
    })),
  };
  vm.runInNewContext(`${body}\nthis.addOne = dashboardAddEquipment;`, context);

  const result = context.addOne(tradeId, 'BURANO 8K', 1);

  assert.equal(result.success, true);
  assert.deepEqual(Array.from(writtenRows, (row) => row[0]), [`${tradeId}-100`]);
  assert.equal(writtenRows[0].length, 13);
  assert.equal(writtenRows.some((row) => /-00$/.test(row[0])), false);
});

test('actual batch/set GAS add allocates unique monotonic suffixes 100 and 101', () => {
  const gas = fs.readFileSync(path.join(root, 'checkAvailability.js'), 'utf8');
  const body = section(gas, 'function dashboardAddEquipments(', '\nvar DASHBOARD_ONSITE_IDEM_PROP_');
  const tradeId = '260813-005';
  let plannedRowWidths = [];
  const sched = {
    getLastRow: () => 2,
    getRange: () => ({
      getDisplayValues: () => [[
        '2026-08-17', '04:30', '2026-08-20', '04:30', '', '', '', '테스트 고객',
      ]],
    }),
  };
  const ss = {
    getSheetByName(name) {
      if (name === '스케줄상세') return sched;
      if (name === '장비마스터' || name === '세트마스터') return {};
      return null;
    },
  };
  const context = {
    Date, JSON, Math, Object, Array, String, Number, RegExp, Error,
    normalizeDashboardAddEntries_: (entries) => entries.map((entry) => ({ name: entry.name, qty: entry.qty })),
    SpreadsheetApp: { getActiveSpreadsheet: () => ss },
    findDashboardRowsByValue_: () => [2],
    readDashboardScheduleRows_: () => [[`${tradeId}-99`]],
    parseDT: () => new Date('2026-08-17T00:00:00Z'),
    buildDashboardSetLookup_: () => ({
      items: { 'Cinema Set': true },
      prices: { 'Cinema Set': 1000 },
      components: { 'Cinema Set': [{ name: 'Battery', qty: 1 }] },
    }),
    buildAvailabilityItems_: (name, qty, components) => [
      { name, qty },
      ...components.map((component) => ({ name: component.name, qty: component.qty * qty })),
    ],
    buildDashboardEquipmentMeta_: () => ({ equipment: {} }),
    mergeAvailabilityItems_: (items) => items,
    dashboardAddedItemsFromRows_: (rows) => {
      plannedRowWidths = rows.map((row) => row.length);
      return rows.map((row) => ({
        scheduleId: row[0], setName: row[2], name: row[3], qty: row[4], isComponent: !!row[2] && row[2] !== row[3],
      }));
    },
  };
  vm.runInNewContext(`${body}\nthis.addMany = dashboardAddEquipments;`, context);

  const result = context.addMany(tradeId, [{ name: 'Cinema Set', qty: 1 }], {
    dryRun: true,
    rawNames: true,
    lockAlreadyHeld: true,
    availabilityPreflighted: true,
  });

  assert.equal(result.success, true);
  assert.deepEqual(Array.from(result.plannedItems, (row) => row.scheduleId), [
    `${tradeId}-100`, `${tradeId}-101`,
  ]);
  assert.equal(new Set(Array.from(result.plannedItems, (row) => row.scheduleId)).size, 2);
  assert.equal(Array.from(result.plannedItems).every((row) => !/-00$/.test(row.scheduleId)), true);
  assert.deepEqual(Array.from(plannedRowWidths), [13, 13]);
});

test('actual historical GAS add preserves returned state and delegates no checkout baseline projection', () => {
  const gas = fs.readFileSync(path.join(root, 'checkAvailability.js'), 'utf8');
  const body = section(gas, 'function dashboardAddEquipments(', '\nvar DASHBOARD_ONSITE_IDEM_PROP_');
  const tradeId = '260813-005';
  const privateToken = {};
  const calls = { invalidations: 0, projections: [], written: [] };
  const props = { getProperty: () => '', setProperty() {}, deleteProperty() {} };
  const sched = {
    getLastRow: () => 2,
    getRange(row, column) {
      if (column === 6) {
        return { getDisplayValues: () => [[
          '2026-08-17', '04:30', '2026-08-20', '04:30', '', '', '', '테스트 고객',
        ]] };
      }
      return { setValues: (rows) => { calls.written = rows.map((entry) => Array.from(entry)); } };
    },
    insertRowsAfter() {},
  };
  const ss = {
    getSheetByName(name) {
      if (name === '스케줄상세') return sched;
      if (name === '장비마스터' || name === '세트마스터') return {};
      return null;
    },
  };
  const context = {
    Date, JSON, Math, Object, Array, String, Number, RegExp, Error,
    REGISTERED_HISTORICAL_CORRECTION_TOKEN_: privateToken,
    normalizeDashboardAddEntries_: (entries) => entries.map((entry) => ({ name: entry.name, qty: entry.qty })),
    normalizeDashboardMutationId_: (value) => String(value || ''),
    PropertiesService: { getScriptProperties: () => props },
    CacheService: { getScriptCache: () => ({ get: () => '', put() {} }) },
    SpreadsheetApp: { getActiveSpreadsheet: () => ss },
    dashboardTradeMutationLeaseError_: () => null,
    dashboardOnsiteRequestFingerprint_: () => 'fingerprint',
    beginDashboardMutation_: () => ({ ok: true }),
    commitDashboardMutation_() {},
    findDashboardRowsByValue_: () => [2],
    readDashboardScheduleRows_: () => [[`${tradeId}-11`]],
    parseDT: () => new Date('2026-08-17T00:00:00Z'),
    buildDashboardSetLookup_: () => ({ items: {}, prices: {}, components: {} }),
    buildAvailabilityItems_: (name, qty) => [{ name, qty }],
    buildDashboardEquipmentMeta_: () => ({ equipment: { 'BURANO 8K': true } }),
    mergeAvailabilityItems_: (items) => items,
    dashboardAddedItemsFromRows_: (rows) => rows.map((row) => ({
      scheduleId: row[0], setName: row[2], name: row[3], qty: row[4], isComponent: false,
    })),
    invalidateDashboardReturnInspectionForTrade_: () => { calls.invalidations += 1; return {}; },
    applyDashboardAddRowFormats_() {},
    isDashboardTradeCheckoutStarted_: () => true,
    getDashboardReturnCheckableItems_: () => { throw new Error('must not extend immutable checkout baseline'); },
    scheduleDashboardStructureProjectionUnderLock_: (_tid, patch) => calls.projections.push({ tid: _tid, patch }),
    invalidateDashboardCache() {},
    invalidateTimelineCache() {},
  };
  vm.runInNewContext(`${body}\nthis.addMany = dashboardAddEquipments;`, context);

  const result = context.addMany(tradeId, [{ name: 'BURANO 8K', qty: 1 }], {
    lockAlreadyHeld: true,
    deferContractRegeneration: true,
    rawNames: true,
    requireExactCatalog: true,
    availabilityPreflighted: true,
    mutationId: `${input.operationId}:add`,
    historicalCorrectionToken: privateToken,
  });

  assert.equal(result.success, true);
  assert.equal(calls.invalidations, 0);
  assert.deepEqual(calls.projections, []);
  assert.deepEqual(Array.from(calls.written, (row) => row[0]), [`${tradeId}-12`]);
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
