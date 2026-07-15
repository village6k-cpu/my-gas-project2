const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const appSource = fs.readFileSync(
  path.join(__dirname, '..', 'toss-front-plugin/village-front/app.js'),
  'utf8'
);

function paymentRecord(overrides = {}) {
  return Object.assign({
    tradeId: '260715-001',
    sourceType: 'reservation',
    paymentKey: 'payment-key-1',
    paymentMethod: 'CARD',
    amount: 11000,
    tax: 1000,
    supplyValue: 10000,
    tip: 0,
    timestamp: '2026-07-15T12:00:00.000Z',
    approvalNumber: 'PAYMENT-APPROVAL-1',
    installment: 0,
    extraData: null,
    isSelfIssuance: false,
    paidAt: '2026-07-15T12:00:00.000Z',
    customerName: '테스트 예약자'
  }, overrides);
}

function paymentNotFound(field = 'code') {
  const error = new Error('결제 취소 내역 없음');
  error[field] = 'PAYMENT_NOT_FOUND';
  return error;
}

function createHarness(options = {}) {
  let records = (options.records || [paymentRecord()]).map((record) => Object.assign({}, record));
  let failedWritesRemaining = options.failReceiptWrites || 0;
  const lookupCalls = [];
  const requestCalls = [];
  const fetchCalls = [];
  const events = [];
  const logs = [];
  const pages = [];
  const toasts = [];

  const sdk = {
    app: {
      openSetting() {}
    },
    payment: {
      async getPayment() {
        throw new Error('getPayment must not run for a complete record');
      },
      async getPaymentCancel(payload) {
        lookupCalls.push(payload);
        events.push({ type: 'tossLookup', payload });
        return options.getPaymentCancel(payload, lookupCalls.length);
      },
      async requestPaymentCancel(payload) {
        requestCalls.push(payload);
        events.push({ type: 'tossCancel', payload });
        return options.requestPaymentCancel(payload, requestCalls.length);
      }
    },
    storage: {
      async get({ key }) {
        return { value: key === 'receiptRecords' ? JSON.stringify(records) : '' };
      },
      async set({ key, value }) {
        if (key !== 'receiptRecords') return;
        if (failedWritesRemaining > 0) {
          failedWritesRemaining -= 1;
          throw new Error('storage write failed');
        }
        if (options.beforeReceiptWrite) await options.beforeReceiptWrite();
        records = JSON.parse(value);
        events.push({
          type: 'receiptWrite',
          records: records.map((record) => Object.assign({}, record))
        });
      }
    },
    template: {
      renderSelectPage(page) {
        pages.push({ type: 'select', page });
      },
      renderResultPage(page) {
        pages.push({ type: 'result', page });
      },
      renderInputPage(page) {
        pages.push({ type: 'input', page });
      },
      renderOrderPage(page) {
        pages.push({ type: 'order', page });
      },
      openToast(toast) {
        toasts.push(toast);
      }
    }
  };

  const sandbox = {
    console: {
      log(...args) { logs.push({ level: 'log', args }); },
      warn(...args) { logs.push({ level: 'warn', args }); },
      error(...args) { logs.push({ level: 'error', args }); }
    },
    setTimeout,
    clearTimeout,
    crypto: { randomUUID: () => 'test-payment-key' },
    CONFIG: { LOOKUP_BASE: 'https://dashboard.test', LOOKUP_TOKEN: 'lookup-token' },
    VILLAGE_PAGE_MODE: options.pageMode === undefined ? 'settings' : options.pageMode,
    TossFrontSDK: sdk,
    document: { getElementById: () => null },
    fetch: async (url, init) => {
      const call = { url, init };
      fetchCalls.push(call);
      events.push({ type: 'ledgerSync', call });
      if (options.fetch) return options.fetch(url, init, fetchCalls.length);
      return {
        ok: true,
        status: 200,
        async json() { return { ok: true }; }
      };
    }
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  const initPromise = vm.runInContext(appSource, sandbox, {
    filename: 'toss-front-plugin/village-front/app.js'
  });

  return {
    context: sandbox,
    lookupCalls,
    requestCalls,
    fetchCalls,
    events,
    logs,
    pages,
    toasts,
    initPromise,
    records: () => records,
    lastResult: () => pages.filter((entry) => entry.type === 'result').at(-1).page
  };
}

async function testConfirmedReservationCancelSyncsLedgerAfterLocalPersistence() {
  const harness = createHarness({
    getPaymentCancel: async () => { throw paymentNotFound('code'); },
    requestPaymentCancel: async () => ({
      type: 'SUCCESS',
      response: {
        paymentMethod: 'CARD',
        card: { approvalNumber: 'CANCEL-SYNC-1', timestamp: '2026-07-15T13:00:00.000Z' }
      }
    })
  });

  await harness.context.executeFullPaymentCancel(paymentRecord());

  assert.strictEqual(harness.fetchCalls.length, 1);
  const call = harness.fetchCalls[0];
  assert.strictEqual(call.url, 'https://dashboard.test/api/lookup/cancel');
  assert.strictEqual(call.init.method, 'POST');
  assert.strictEqual(call.init.headers['x-lookup-token'], 'lookup-token');
  assert.deepStrictEqual(JSON.parse(call.init.body), {
    tradeId: '260715-001',
    paymentKey: 'payment-key-1',
    amount: 11000,
    cancelApprovalNumber: 'CANCEL-SYNC-1'
  });
  assert.ok(harness.records()[0].cancelledAt);
  assert.strictEqual(harness.records()[0].cancelSyncPending, false);

  const cancelIndex = harness.events.findIndex((event) => event.type === 'tossCancel');
  const persistedIndex = harness.events.findIndex((event) => (
    event.type === 'receiptWrite' &&
    event.records[0].cancelledAt &&
    event.records[0].cancelSyncPending === true
  ));
  const ledgerIndex = harness.events.findIndex((event) => event.type === 'ledgerSync');
  assert.ok(cancelIndex !== -1 && cancelIndex < persistedIndex);
  assert.ok(persistedIndex < ledgerIndex, 'ledger sync must start only after local cancellation persistence');
}

async function testManualCancelNeverSyncsLedger() {
  const manual = paymentRecord({
    tradeId: 'manual-payment-key-1',
    sourceType: 'manual'
  });
  const harness = createHarness({
    records: [manual],
    getPaymentCancel: async () => ({
      type: 'SUCCESS',
      response: {
        paymentMethod: 'CARD',
        card: { approvalNumber: 'MANUAL-CANCEL-1', timestamp: '2026-07-15T13:00:00.000Z' }
      }
    }),
    requestPaymentCancel: async () => {
      throw new Error('cached SUCCESS must not request another cancel');
    }
  });

  await harness.context.executeFullPaymentCancel(manual);

  assert.strictEqual(harness.fetchCalls.length, 0);
  assert.ok(harness.records()[0].cancelledAt);
  assert.strictEqual(harness.records()[0].cancelSyncPending, false);
}

async function testLedgerFailureLeavesPendingAndShowsAccurateWarning() {
  const harness = createHarness({
    getPaymentCancel: async () => { throw paymentNotFound('code'); },
    requestPaymentCancel: async () => ({
      type: 'SUCCESS',
      response: {
        paymentMethod: 'CARD',
        card: { approvalNumber: 'PENDING-CANCEL-1', timestamp: '2026-07-15T13:00:00.000Z' }
      }
    }),
    fetch: async () => ({
      ok: false,
      status: 502,
      async json() { return { error: '예약 장부 쓰기 실패' }; }
    })
  });

  await harness.context.executeFullPaymentCancel(paymentRecord());

  assert.strictEqual(harness.fetchCalls.length, 1);
  assert.ok(harness.records()[0].cancelledAt);
  assert.strictEqual(harness.records()[0].cancelSyncPending, true);
  assert.strictEqual(harness.lastResult().title, '전액 취소는 완료됐어요');
  assert.match(harness.lastResult().description, /장부.*아직|장부.*대기/);
}

async function testSettingsInitRetriesOnlyPendingCancelledReservationsWithoutTossCalls() {
  const records = [
    paymentRecord({
      tradeId: 'retry-me',
      paymentKey: 'retry-payment',
      cancelledAt: '2026-07-15T13:00:00.000Z',
      cancelSyncPending: true
    }),
    paymentRecord({
      tradeId: 'already-synced',
      paymentKey: 'synced-payment',
      cancelledAt: '2026-07-15T13:00:00.000Z',
      cancelSyncPending: false
    }),
    paymentRecord({
      tradeId: 'not-cancelled',
      paymentKey: 'not-cancelled-payment',
      cancelledAt: null,
      cancelSyncPending: true
    }),
    paymentRecord({
      tradeId: 'manual-payment',
      paymentKey: 'manual-payment',
      sourceType: 'manual',
      cancelledAt: '2026-07-15T13:00:00.000Z',
      cancelSyncPending: true
    }),
    paymentRecord({
      tradeId: '',
      paymentKey: 'missing-trade-payment',
      cancelledAt: '2026-07-15T13:00:00.000Z',
      cancelSyncPending: true
    })
  ];
  const harness = createHarness({
    records,
    getPaymentCancel: async () => { throw new Error('retry must not query Toss cancellation'); },
    requestPaymentCancel: async () => { throw new Error('retry must not request Toss cancellation'); }
  });

  await harness.initPromise;

  assert.strictEqual(harness.fetchCalls.length, 1);
  assert.strictEqual(JSON.parse(harness.fetchCalls[0].init.body).tradeId, 'retry-me');
  assert.strictEqual(harness.lookupCalls.length, 0);
  assert.strictEqual(harness.requestCalls.length, 0);
  const byPaymentKey = Object.fromEntries(
    harness.records().map((record) => [record.paymentKey, record])
  );
  assert.strictEqual(byPaymentKey['retry-payment'].cancelSyncPending, false);
  assert.strictEqual(byPaymentKey['synced-payment'].cancelSyncPending, false);
  assert.strictEqual(byPaymentKey['not-cancelled-payment'].cancelSyncPending, true);
  assert.strictEqual(byPaymentKey['manual-payment'].cancelSyncPending, true);
  assert.strictEqual(byPaymentKey['missing-trade-payment'].cancelSyncPending, true);
}

async function testSettingsInitBlocksInteractiveMenuUntilRetrySettlesWithoutLosingState() {
  let releaseLedgerRetry;
  let notifyRetryStarted;
  const retryStarted = new Promise((resolve) => { notifyRetryStarted = resolve; });
  const ledgerRetry = new Promise((resolve) => { releaseLedgerRetry = resolve; });
  const pending = paymentRecord({
    tradeId: 'blocking-retry',
    paymentKey: 'blocking-retry-payment',
    cancelledAt: '2026-07-15T13:00:00.000Z',
    cancelSyncPending: true
  });
  const untouched = paymentRecord({
    tradeId: 'untouched-trade',
    paymentKey: 'untouched-payment',
    customerName: '보존 대상',
    cancelSyncPending: false
  });
  const harness = createHarness({
    records: [pending, untouched],
    getPaymentCancel: async () => { throw new Error('retry must not query Toss cancellation'); },
    requestPaymentCancel: async () => { throw new Error('retry must not request Toss cancellation'); },
    fetch: async () => {
      notifyRetryStarted();
      return ledgerRetry;
    }
  });

  await retryStarted;

  const staffMenusBeforeRetry = harness.pages.filter((entry) => (
    entry.type === 'select' && entry.page.title === 'VILLAGE 직원 설정'
  ));
  assert.strictEqual(
    staffMenusBeforeRetry.length,
    0,
    'interactive staff menu must stay hidden while pending ledger retry is unresolved'
  );
  const loadingPage = harness.pages.at(-1);
  assert.strictEqual(loadingPage.type, 'result');
  assert.match(loadingPage.page.title, /장부.*확인|환불.*확인/);
  assert.strictEqual((loadingPage.page.buttons || []).length, 0);

  releaseLedgerRetry({
    ok: true,
    status: 200,
    async json() { return { ok: true, tradeId: 'blocking-retry' }; }
  });
  await harness.initPromise;

  const staffMenusAfterRetry = harness.pages.filter((entry) => (
    entry.type === 'select' && entry.page.title === 'VILLAGE 직원 설정'
  ));
  assert.strictEqual(staffMenusAfterRetry.length, 1);
  assert.strictEqual(harness.records().length, 2);
  const byPaymentKey = Object.fromEntries(
    harness.records().map((record) => [record.paymentKey, record])
  );
  assert.strictEqual(byPaymentKey['blocking-retry-payment'].cancelSyncPending, false);
  assert.strictEqual(byPaymentKey['untouched-payment'].tradeId, 'untouched-trade');
  assert.strictEqual(byPaymentKey['untouched-payment'].customerName, '보존 대상');
}

async function testRetryPendingCancelSyncsReturnsUsefulSummary() {
  const records = [
    paymentRecord({
      tradeId: 'summary-success',
      paymentKey: 'summary-success-payment',
      cancelledAt: '2026-07-15T13:00:00.000Z',
      cancelSyncPending: true
    }),
    paymentRecord({
      tradeId: 'summary-failure',
      paymentKey: 'summary-failure-payment',
      cancelledAt: '2026-07-15T13:00:00.000Z',
      cancelSyncPending: true
    })
  ];
  const harness = createHarness({
    pageMode: 'customer',
    records,
    getPaymentCancel: async () => { throw new Error('retry must not query Toss cancellation'); },
    requestPaymentCancel: async () => { throw new Error('retry must not request Toss cancellation'); },
    fetch: async (_url, init) => {
      const body = JSON.parse(init.body);
      if (body.tradeId === 'summary-failure') {
        return {
          ok: false,
          status: 502,
          async json() { return { error: '장부 일시 오류' }; }
        };
      }
      return {
        ok: true,
        status: 200,
        async json() { return { ok: true, tradeId: body.tradeId }; }
      };
    }
  });
  await harness.initPromise;

  const summary = await harness.context.retryPendingCancelSyncs();

  assert.ok(summary, 'retryPendingCancelSyncs must return a summary');
  assert.strictEqual(summary.attempted, 2);
  assert.strictEqual(summary.synced, 1);
  assert.strictEqual(summary.failed, 1);
  assert.strictEqual(summary.failedRecords.length, 1);
  assert.strictEqual(summary.failedRecords[0].tradeId, 'summary-failure');
  assert.match(summary.failedRecords[0].error, /장부 일시 오류/);
  assert.strictEqual(harness.lookupCalls.length, 0);
  assert.strictEqual(harness.requestCalls.length, 0);
}

async function testSettingsRetryFailureKeepsPendingWithoutTossCalls() {
  const pending = paymentRecord({
    tradeId: 'retry-fails',
    paymentKey: 'retry-fails-payment',
    cancelledAt: '2026-07-15T13:00:00.000Z',
    cancelSyncPending: true
  });
  const harness = createHarness({
    records: [pending],
    getPaymentCancel: async () => { throw new Error('retry must not query Toss cancellation'); },
    requestPaymentCancel: async () => { throw new Error('retry must not request Toss cancellation'); },
    fetch: async (_url, _init, callNumber) => callNumber === 1
      ? {
          ok: false,
          status: 502,
          async json() { return { error: '장부 일시 오류' }; }
        }
      : {
          ok: true,
          status: 200,
          async json() { return { ok: true, tradeId: 'retry-fails' }; }
        }
  });

  await harness.initPromise;

  assert.strictEqual(harness.fetchCalls.length, 1);
  assert.strictEqual(harness.lookupCalls.length, 0);
  assert.strictEqual(harness.requestCalls.length, 0);
  assert.strictEqual(harness.records()[0].cancelSyncPending, true);
  const warningEntries = harness.pages.filter((entry) => entry.type === 'result');
  assert.ok(warningEntries.length > 0, 'failed settings retry must render a visible warning');
  const warning = warningEntries.at(-1).page;
  assert.strictEqual(warning.status, 'error');
  assert.match(warning.title, /토스 취소.*완료/);
  assert.match(warning.description, /예약 장부.*환불.*대기/);
  const labels = (warning.buttons || []).map((button) => button.label);
  assert.ok(labels.includes('다시 시도'));
  assert.ok(labels.includes('직원 설정 열기'));
  const retryButton = warning.buttons.find((button) => button.label === '다시 시도');
  const retryResult = retryButton.onClick();
  assert.ok(retryResult && typeof retryResult.then === 'function', 'retry button must return initialization promise');
  await retryResult;
  assert.strictEqual(harness.fetchCalls.length, 2);
  assert.strictEqual(harness.records()[0].cancelSyncPending, false);
  const finalPage = harness.pages.at(-1);
  assert.strictEqual(finalPage.type, 'select');
  assert.strictEqual(finalPage.page.title, 'VILLAGE 직원 설정');
  assert.strictEqual(harness.lookupCalls.length, 0);
  assert.strictEqual(harness.requestCalls.length, 0);
}

async function testPaymentNotFoundStartsOneCancellation() {
  const harness = createHarness({
    getPaymentCancel: async () => { throw paymentNotFound('code'); },
    requestPaymentCancel: async () => ({
      type: 'SUCCESS',
      response: {
        paymentMethod: 'CARD',
        card: { approvalNumber: 'CANCEL-CARD-1', timestamp: '2026-07-15T13:00:00.000Z' }
      }
    })
  });

  await harness.context.executeFullPaymentCancel(paymentRecord());

  assert.strictEqual(harness.lookupCalls.length, 1);
  assert.strictEqual(
    harness.requestCalls.length,
    1,
    'PAYMENT_NOT_FOUND must continue to exactly one requestPaymentCancel call'
  );
  assert.ok(harness.records()[0].cancelledAt);
  assert.strictEqual(harness.records()[0].cancelApprovalNumber, 'CANCEL-CARD-1');
}

async function testPaymentNotFoundErrorShapes() {
  const harness = createHarness({
    getPaymentCancel: async () => { throw paymentNotFound(); },
    requestPaymentCancel: async () => ({ type: 'CANCELED' })
  });
  const detects = harness.context.isPaymentCancelNotFoundError;

  assert.strictEqual(detects({ code: 'PAYMENT_NOT_FOUND' }), true);
  assert.strictEqual(detects({ errorCode: 'PAYMENT_NOT_FOUND' }), true);
  assert.strictEqual(detects({ message: 'Toss SDK: PAYMENT_NOT_FOUND' }), true);
  assert.strictEqual(detects({ response: { data: { errorCode: 'PAYMENT_NOT_FOUND' } } }), true);
  assert.strictEqual(detects({ code: 'NETWORK_ERROR', message: 'PAYMENT lookup failed' }), false);
}

async function testCachedSuccessNeverRecancels() {
  const harness = createHarness({
    getPaymentCancel: async () => ({
      type: 'SUCCESS',
      response: {
        paymentMethod: 'CARD',
        card: { approvalNumber: 'CACHED-CANCEL-1', timestamp: '2026-07-15T13:00:00.000Z' }
      }
    }),
    requestPaymentCancel: async () => {
      throw new Error('requestPaymentCancel must not run for cached SUCCESS');
    }
  });

  await harness.context.executeFullPaymentCancel(paymentRecord());

  assert.strictEqual(harness.requestCalls.length, 0);
  assert.strictEqual(harness.records()[0].cancelApprovalNumber, 'CACHED-CANCEL-1');
  assert.ok(harness.records()[0].cancelledAt);
}

async function testOtherLookupErrorFailsClosed() {
  const harness = createHarness({
    getPaymentCancel: async () => {
      const error = new Error('단말 네트워크 오류');
      error.code = 'NETWORK_ERROR';
      throw error;
    },
    requestPaymentCancel: async () => {
      throw new Error('requestPaymentCancel must not run after lookup errors');
    }
  });

  await harness.context.executeFullPaymentCancel(paymentRecord());

  assert.strictEqual(harness.requestCalls.length, 0);
  assert.strictEqual(harness.records()[0].cancelledAt, undefined);
  assert.strictEqual(harness.lastResult().title, '취소 상태를 확인하지 못했어요');
}

async function testConfirmedCancelWarnsThenReconcilesAfterLocalFailure() {
  const harness = createHarness({
    failReceiptWrites: 1,
    getPaymentCancel: async (_payload, callNumber) => {
      if (callNumber === 1) throw paymentNotFound('errorCode');
      return {
        type: 'SUCCESS',
        response: {
          paymentMethod: 'CARD',
          card: { approvalNumber: 'RECONCILED-CANCEL-1', timestamp: '2026-07-15T13:00:00.000Z' }
        }
      };
    },
    requestPaymentCancel: async () => ({
      type: 'SUCCESS',
      response: {
        paymentMethod: 'CARD',
        card: { approvalNumber: 'FIRST-CANCEL-1', timestamp: '2026-07-15T13:00:00.000Z' }
      }
    })
  });

  await harness.context.executeFullPaymentCancel(paymentRecord());

  assert.strictEqual(harness.requestCalls.length, 1);
  assert.strictEqual(harness.records()[0].cancelledAt, undefined);
  assert.strictEqual(harness.lastResult().title, '전액 취소는 완료됐어요');
  assert.match(harness.lastResult().description, /로컬 기록/);

  await harness.context.executeFullPaymentCancel(paymentRecord());

  assert.strictEqual(harness.requestCalls.length, 1, 'reconciliation must not cancel twice');
  assert.strictEqual(harness.records()[0].cancelApprovalNumber, 'RECONCILED-CANCEL-1');
  assert.ok(harness.records()[0].cancelledAt);
}

async function testInFlightRequestRejectsSecondExecution() {
  let finishCancel;
  const pendingCancel = new Promise((resolve) => { finishCancel = resolve; });
  const harness = createHarness({
    getPaymentCancel: async () => { throw paymentNotFound('message'); },
    requestPaymentCancel: async () => pendingCancel
  });

  const first = harness.context.executeFullPaymentCancel(paymentRecord());
  await new Promise((resolve) => setImmediate(resolve));
  assert.strictEqual(harness.requestCalls.length, 1);

  await harness.context.executeFullPaymentCancel(paymentRecord());
  assert.strictEqual(harness.requestCalls.length, 1);
  assert.strictEqual(harness.toasts.at(-1).message, '취소 요청을 처리하고 있어요.');

  finishCancel({
    type: 'SUCCESS',
    response: {
      paymentMethod: 'CARD',
      card: { approvalNumber: 'LOCKED-CANCEL-1', timestamp: '2026-07-15T13:00:00.000Z' }
    }
  });
  await first;
}

async function testInFlightStaysLockedUntilLocalPersistenceFinishes() {
  let releaseWrite;
  let notifyWriteStarted;
  const writeStarted = new Promise((resolve) => { notifyWriteStarted = resolve; });
  const writeGate = new Promise((resolve) => { releaseWrite = resolve; });
  const harness = createHarness({
    getPaymentCancel: async () => { throw paymentNotFound('code'); },
    requestPaymentCancel: async () => ({
      type: 'SUCCESS',
      response: {
        paymentMethod: 'CARD',
        card: { approvalNumber: 'PERSISTING-CANCEL-1', timestamp: '2026-07-15T13:00:00.000Z' }
      }
    }),
    beforeReceiptWrite: async () => {
      notifyWriteStarted();
      await writeGate;
    }
  });

  const first = harness.context.executeFullPaymentCancel(paymentRecord());
  await writeStarted;

  assert.strictEqual(
    harness.context.cancelInFlight,
    true,
    'cancel must remain locked until confirmed external success is persisted locally'
  );
  await harness.context.executeFullPaymentCancel(paymentRecord());
  assert.strictEqual(harness.requestCalls.length, 1);
  assert.strictEqual(harness.toasts.at(-1).message, '취소 요청을 처리하고 있어요.');

  releaseWrite();
  await first;
}

(async function run() {
  await testConfirmedReservationCancelSyncsLedgerAfterLocalPersistence();
  await testManualCancelNeverSyncsLedger();
  await testLedgerFailureLeavesPendingAndShowsAccurateWarning();
  await testSettingsInitRetriesOnlyPendingCancelledReservationsWithoutTossCalls();
  await testRetryPendingCancelSyncsReturnsUsefulSummary();
  await testSettingsRetryFailureKeepsPendingWithoutTossCalls();
  await testSettingsInitBlocksInteractiveMenuUntilRetrySettlesWithoutLosingState();
  await testPaymentNotFoundStartsOneCancellation();
  await testPaymentNotFoundErrorShapes();
  await testCachedSuccessNeverRecancels();
  await testOtherLookupErrorFailsClosed();
  await testConfirmedCancelWarnsThenReconcilesAfterLocalFailure();
  await testInFlightRequestRejectsSecondExecution();
  await testInFlightStaysLockedUntilLocalPersistenceFinishes();
  console.log('toss-front payment cancel behavioral checks passed');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
