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
  let receiptValue = Object.prototype.hasOwnProperty.call(options, 'receiptRawValue')
    ? options.receiptRawValue
    : JSON.stringify(records);
  let failedWritesRemaining = options.failReceiptWrites || 0;
  const lookupCalls = [];
  const requestCalls = [];
  const paymentCalls = [];
  const printCalls = [];
  const getPaymentCalls = [];
  const fetchCalls = [];
  const events = [];
  const logs = [];
  const pages = [];
  const toasts = [];
  const storageValues = Object.assign({}, options.storageValues);

  const sdk = {
    app: {
      openSetting() {}
    },
    payment: {
      async requestPayment(payload) {
        paymentCalls.push(payload);
        events.push({ type: 'payment', payload });
        if (options.requestPayment) return options.requestPayment(payload, paymentCalls.length);
        return {
          type: 'SUCCESS',
          response: {
            paymentMethod: 'CARD',
            card: {
              approvalNumber: 'PAYMENT-APPROVAL-TEST',
              timestamp: '2026-07-15T12:00:00.000Z',
              installment: 0
            },
            extraData: null
          }
        };
      },
      async getPayment(payload) {
        getPaymentCalls.push(payload);
        events.push({ type: 'getPayment', payload });
        if (options.getPayment) return options.getPayment(payload, getPaymentCalls.length);
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
    printer: {
      async printReceipt(payload) {
        printCalls.push(payload);
        if (options.printReceipt) return options.printReceipt(payload, printCalls.length);
      }
    }
  };

  if (!options.missingStorage) {
    sdk.storage = {
      async get({ key }) {
        if (key === 'receiptRecords') {
          if (options.receiptReadError) {
            throw options.receiptReadError instanceof Error
              ? options.receiptReadError
              : new Error(String(options.receiptReadError));
          }
          return { value: receiptValue };
        }
        return { value: storageValues[key] || '' };
      },
      async set({ key, value }) {
        if (key !== 'receiptRecords') {
          storageValues[key] = value;
          events.push({ type: 'storageWrite', key, value });
          return;
        }
        if (failedWritesRemaining > 0) {
          failedWritesRemaining -= 1;
          throw new Error('storage write failed');
        }
        if (options.beforeReceiptWrite) await options.beforeReceiptWrite();
        const attemptedRecords = JSON.parse(value);
        if (!options.receiptWriteMismatch) {
          records = attemptedRecords;
          receiptValue = value;
        }
        events.push({
          type: 'receiptWrite',
          records: records.map((record) => Object.assign({}, record))
        });
      }
    };
  }

  Object.assign(sdk, {
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
  });

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
    paymentCalls,
    printCalls,
    getPaymentCalls,
    fetchCalls,
    events,
    logs,
    pages,
    toasts,
    initPromise,
    records: () => records,
    pending: () => {
      const raw = storageValues.pending;
      return raw ? JSON.parse(raw) : null;
    },
    lastResult: () => pages.filter((entry) => entry.type === 'result').at(-1).page
  };
}

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return body; }
  };
}

function reservationTrade(overrides = {}) {
  return Object.assign({
    tradeId: '260715-APPROVED',
    amount: 22000,
    customerName: '승인 테스트 예약자',
    itemSummary: '카메라 세트',
    checkoutAt: '2026-07-16T01:00:00.000Z',
    returnAt: '2026-07-17T01:00:00.000Z'
  }, overrides);
}

function approvedCardResult(overrides = {}) {
  const card = Object.assign({
    approvalNumber: 'APPROVED-CARD-1',
    timestamp: '2026-07-15T12:30:00.000Z',
    installment: 0
  }, overrides.card);
  return {
    type: 'SUCCESS',
    response: Object.assign({
      paymentMethod: 'CARD',
      card,
      extraData: null
    }, overrides.response)
  };
}

function approvedReservationFetch(trade, confirmStatus = 200) {
  return async (url) => {
    if (url.includes('/api/lookup?')) return jsonResponse({ matches: [trade] });
    if (url.endsWith('/api/lookup/confirm')) {
      return confirmStatus === 200
        ? jsonResponse({ ok: true, tradeId: trade.tradeId })
        : jsonResponse({ error: '예약 장부 반영 실패' }, confirmStatus);
    }
    throw new Error('unexpected payment-flow request: ' + url);
  };
}

async function testStrictReceiptReadAllowsActuallyAbsentKey() {
  const harness = createHarness({ pageMode: 'customer', receiptRawValue: '' });
  await harness.initPromise;

  const records = await harness.context.loadReceiptRecords();

  assert.deepStrictEqual(Array.from(records), []);
}

async function testStrictReceiptReadRejectsMissingStorageApi() {
  const harness = createHarness({ pageMode: 'customer', missingStorage: true });
  await harness.initPromise;

  await assert.rejects(
    () => harness.context.loadReceiptRecords(),
    /receiptRecords|결제 기록|저장소|storage/i
  );
}

async function testStrictReceiptReadRejectsInvalidStoreShape() {
  const harness = createHarness({ pageMode: 'customer', receiptRawValue: '{"not":"an array"}' });
  await harness.initPromise;

  await assert.rejects(
    () => harness.context.loadReceiptRecords(),
    /receiptRecords|결제 기록|배열|형식/i
  );
}

async function testStrictReceiptWriteRejectsSdkFailure() {
  const harness = createHarness({ pageMode: 'customer', failReceiptWrites: 1 });
  await harness.initPromise;

  await assert.rejects(
    () => harness.context.saveReceiptRecords([paymentRecord({ paymentKey: 'write-failure' })]),
    /storage write failed|저장/i
  );
}

async function testStrictReceiptWriteDetectsReadBackMismatch() {
  const harness = createHarness({ pageMode: 'customer', receiptWriteMismatch: true });
  await harness.initPromise;

  await assert.rejects(
    () => harness.context.saveReceiptRecords([paymentRecord({ paymentKey: 'mismatch-write' })]),
    /확인|불일치|mismatch|저장/i
  );
}

async function testReservationApprovalHistoryFailureStillConfirmsAndKeepsPending() {
  const trade = reservationTrade();
  const harness = createHarness({
    pageMode: 'customer',
    records: [],
    failReceiptWrites: 1,
    requestPayment: async () => approvedCardResult(),
    fetch: approvedReservationFetch(trade)
  });
  await harness.initPromise;

  await harness.context.doCharge(trade);

  const confirmCalls = harness.fetchCalls.filter((call) => call.url.endsWith('/api/lookup/confirm'));
  assert.strictEqual(confirmCalls.length, 1, 'approved reservation must still run confirmPaid');
  assert.deepStrictEqual(harness.pending(), {
    paymentKey: 'test-payment-key',
    tradeId: trade.tradeId,
    amount: trade.amount
  });
  const result = harness.lastResult();
  assert.strictEqual(result.status, 'success');
  assert.match(result.title, /결제 승인.*완료/);
  assert.match(result.description, /로컬 결제기록.*저장하지 못/);
  assert.match(result.description, /직원/);
  assert.ok(!harness.pages.some((entry) => entry.type === 'result' && entry.page.title === '결제 실패'));
}

async function testReservationApprovalCombinesHistoryAndLedgerWarnings() {
  const trade = reservationTrade({ tradeId: '260715-BOTH-WARNINGS' });
  const harness = createHarness({
    pageMode: 'customer',
    records: [],
    failReceiptWrites: 1,
    requestPayment: async () => approvedCardResult(),
    fetch: approvedReservationFetch(trade, 503)
  });
  await harness.initPromise;

  await harness.context.doCharge(trade);

  const result = harness.lastResult();
  assert.match(result.description, /로컬 결제기록.*저장하지 못/);
  assert.match(result.description, /예약 장부.*재시도|장부 반영.*대기/);
  assert.ok(harness.pending(), 'combined warning must retain pending recovery');
}

async function testManualApprovalHistoryFailureShowsApprovedWarning() {
  const harness = createHarness({
    pageMode: 'customer',
    records: [],
    failReceiptWrites: 1,
    requestPayment: async () => approvedCardResult()
  });
  await harness.initPromise;

  await harness.context.doManualCharge(33000);

  const result = harness.lastResult();
  assert.strictEqual(result.status, 'success');
  assert.match(result.title, /결제 승인.*완료/);
  assert.match(result.description, /로컬 결제기록.*저장하지 못/);
  assert.ok(!harness.pages.some((entry) => entry.type === 'result' && entry.page.title === '결제 실패'));
  assert.strictEqual(
    harness.fetchCalls.filter((call) => call.url.endsWith('/api/lookup/confirm')).length,
    0,
    'manual approval must not call reservation confirmation'
  );
}

async function testNormalReservationSuccessRemainsUnchanged() {
  const trade = reservationTrade({ tradeId: '260715-NORMAL' });
  const harness = createHarness({
    pageMode: 'customer',
    records: [],
    requestPayment: async () => approvedCardResult(),
    fetch: approvedReservationFetch(trade)
  });
  await harness.initPromise;

  await harness.context.doCharge(trade);

  assert.strictEqual(harness.pending(), null);
  assert.strictEqual(harness.lastResult().title, '결제가 완료되었어요');
  assert.strictEqual(harness.lastResult().description, '22,000원');
}

async function testReservationApprovalReplacesOrderWhileReceiptHistoryPersists() {
  const trade = reservationTrade({ tradeId: '260715-RECEIPT-PERSISTING' });
  let releaseWrite;
  let notifyWriteStarted;
  const writeStarted = new Promise((resolve) => { notifyWriteStarted = resolve; });
  const writeGate = new Promise((resolve) => { releaseWrite = resolve; });
  const harness = createHarness({
    pageMode: 'customer',
    records: [],
    requestPayment: async () => approvedCardResult(),
    fetch: approvedReservationFetch(trade),
    beforeReceiptWrite: async () => {
      notifyWriteStarted();
      await writeGate;
    }
  });
  await harness.initPromise;
  harness.context.showOrder(trade);

  const charge = harness.context.doCharge(trade);
  await writeStarted;

  try {
    const visible = harness.pages.at(-1);
    assert.strictEqual(visible.type, 'result', 'approved card must immediately replace the order page');
    assert.match(visible.page.title, /승인.*완료/);
    assert.deepStrictEqual(
      Array.from(visible.page.buttons || []),
      [],
      'receipt-history persistence screen must not allow another payment action'
    );
  } finally {
    releaseWrite();
    await charge;
  }
}

async function testManualApprovalReplacesOrderWhileReceiptHistoryPersists() {
  let releaseWrite;
  let notifyWriteStarted;
  const writeStarted = new Promise((resolve) => { notifyWriteStarted = resolve; });
  const writeGate = new Promise((resolve) => { releaseWrite = resolve; });
  const harness = createHarness({
    pageMode: 'customer',
    records: [],
    requestPayment: async () => approvedCardResult(),
    beforeReceiptWrite: async () => {
      notifyWriteStarted();
      await writeGate;
    }
  });
  await harness.initPromise;
  harness.context.showManualOrder(33000);

  const charge = harness.context.doManualCharge(33000);
  await writeStarted;

  try {
    const visible = harness.pages.at(-1);
    assert.strictEqual(visible.type, 'result', 'manual approval must immediately replace the order page');
    assert.match(visible.page.title, /승인.*완료/);
    assert.deepStrictEqual(Array.from(visible.page.buttons || []), []);
  } finally {
    releaseWrite();
    await charge;
  }
}

async function testReservationApprovalShowsReceiptBeforeLedgerSyncFinishes() {
  const trade = reservationTrade({ tradeId: '260715-IMMEDIATE-RECEIPT' });
  let releaseConfirm;
  let notifyConfirmStarted;
  const confirmStarted = new Promise((resolve) => { notifyConfirmStarted = resolve; });
  const confirmGate = new Promise((resolve) => { releaseConfirm = resolve; });
  const harness = createHarness({
    pageMode: 'customer',
    records: [],
    requestPayment: async () => approvedCardResult(),
    fetch: async (url) => {
      if (url.includes('/api/lookup?')) return jsonResponse({ matches: [trade] });
      if (url.endsWith('/api/lookup/confirm')) {
        notifyConfirmStarted();
        await confirmGate;
        return jsonResponse({ ok: true, tradeId: trade.tradeId });
      }
      throw new Error('unexpected immediate-receipt request: ' + url);
    }
  });
  await harness.initPromise;
  harness.context.showOrder(trade);

  const charge = harness.context.doCharge(trade);
  await confirmStarted;

  try {
    const visible = harness.pages.at(-1);
    assert.strictEqual(
      visible.type,
      'result',
      'approved card must replace the order page before ledger synchronization finishes'
    );
    assert.ok(
      visible.page.buttons.some((button) => button.label === '영수증 출력'),
      'the immediate result page must expose receipt printing'
    );
    assert.ok(
      !visible.page.buttons.some((button) => button.label === '확인'),
      'the payment flow must not return to idle while ledger synchronization is pending'
    );
    assert.strictEqual(visible.page.timerMs, 0, 'the pending-sync receipt page must not time out');
    assert.strictEqual(harness.paymentCalls.length, 1, 'approval must request payment exactly once');
  } finally {
    releaseConfirm();
    await charge;
  }

  const settled = harness.lastResult();
  assert.ok(settled.buttons.some((button) => button.label === '확인'));
  assert.strictEqual(settled.timerMs, 5000);
}

async function testReceiptPrintedDuringLedgerSyncKeepsPaymentFlowLocked() {
  const trade = reservationTrade({ tradeId: '260715-PRINT-DURING-SYNC' });
  let releaseConfirm;
  let notifyConfirmStarted;
  const confirmStarted = new Promise((resolve) => { notifyConfirmStarted = resolve; });
  const confirmGate = new Promise((resolve) => { releaseConfirm = resolve; });
  const harness = createHarness({
    pageMode: 'customer',
    records: [],
    requestPayment: async () => approvedCardResult(),
    fetch: async (url) => {
      if (url.includes('/api/lookup?')) return jsonResponse({ matches: [trade] });
      if (url.endsWith('/api/lookup/confirm')) {
        notifyConfirmStarted();
        await confirmGate;
        return jsonResponse({ ok: true, tradeId: trade.tradeId });
      }
      throw new Error('unexpected print-during-sync request: ' + url);
    }
  });
  await harness.initPromise;

  const charge = harness.context.doCharge(trade);
  await confirmStarted;
  const receiptButton = harness.lastResult().buttons.find((button) => button.label === '영수증 출력');
  await receiptButton.onClick();

  const printing = harness.lastResult();
  assert.strictEqual(
    printing.title,
    '결제가 완료되었어요',
    'receipt printing must not navigate away while reservation confirmation is pending'
  );
  assert.strictEqual(printing.timerMs, 0);
  assert.ok(!printing.buttons.some((button) => button.label === '확인'));
  assert.match(harness.toasts.at(-1).message, /영수증.*출력/);

  releaseConfirm();
  await charge;

  assert.strictEqual(harness.lastResult().title, '결제가 완료되었어요');
  assert.ok(harness.lastResult().buttons.some((button) => button.label === '확인'));
  assert.strictEqual(harness.printCalls.length, 1);
}

async function testReceiptFailureDuringLedgerSyncKeepsPaymentFlowLocked() {
  const trade = reservationTrade({ tradeId: '260715-PRINT-FAILURE-DURING-SYNC' });
  let releaseConfirm;
  let notifyConfirmStarted;
  const confirmStarted = new Promise((resolve) => { notifyConfirmStarted = resolve; });
  const confirmGate = new Promise((resolve) => { releaseConfirm = resolve; });
  const harness = createHarness({
    pageMode: 'customer',
    records: [],
    requestPayment: async () => approvedCardResult(),
    printReceipt: async () => { throw new Error('printer unavailable'); },
    fetch: async (url) => {
      if (url.includes('/api/lookup?')) return jsonResponse({ matches: [trade] });
      if (url.endsWith('/api/lookup/confirm')) {
        notifyConfirmStarted();
        await confirmGate;
        return jsonResponse({ ok: true, tradeId: trade.tradeId });
      }
      throw new Error('unexpected print-failure request: ' + url);
    }
  });
  await harness.initPromise;

  const charge = harness.context.doCharge(trade);
  await confirmStarted;
  const receiptButton = harness.lastResult().buttons.find((button) => button.label === '영수증 출력');
  await receiptButton.onClick();

  assert.strictEqual(harness.lastResult().title, '결제가 완료되었어요');
  assert.strictEqual(harness.lastResult().timerMs, 0);
  assert.match(harness.toasts.at(-1).message, /영수증 출력.*실패/);

  releaseConfirm();
  await charge;
  assert.ok(harness.lastResult().buttons.some((button) => button.label === '확인'));
}

async function testRecoveryHistoryFailureKeepsPendingForAnotherRetry() {
  const pending = {
    paymentKey: 'recover-payment-key',
    tradeId: '260715-RECOVER',
    amount: 22000
  };
  const harness = createHarness({
    pageMode: 'customer',
    records: [],
    storageValues: { pending: JSON.stringify(pending) },
    failReceiptWrites: 1,
    getPayment: async () => approvedCardResult(),
    fetch: async (url) => {
      if (url.endsWith('/api/lookup/confirm')) {
        return jsonResponse({ ok: true, tradeId: pending.tradeId });
      }
      throw new Error('unexpected recovery request: ' + url);
    }
  });

  await harness.initPromise;

  assert.strictEqual(
    harness.fetchCalls.filter((call) => call.url.endsWith('/api/lookup/confirm')).length,
    1,
    'recovery must still confirm an externally approved payment'
  );
  assert.deepStrictEqual(harness.pending(), pending, 'failed history recovery must retain pending for another boot');
}

async function testRecoveryNonSuccessClearsStalePending() {
  const pending = {
    paymentKey: 'not-approved-payment-key',
    tradeId: '260715-NOT-APPROVED',
    amount: 22000
  };
  const harness = createHarness({
    pageMode: 'customer',
    storageValues: { pending: JSON.stringify(pending) },
    getPayment: async () => ({ type: 'CANCELED' })
  });

  await harness.initPromise;

  assert.strictEqual(harness.pending(), null, 'non-success payment lookup should clear the stale pending marker');
}

function assertNoInteractiveCancelMenu(harness) {
  const interactiveMenus = harness.pages.filter((entry) => (
    entry.type === 'select' &&
    (entry.page.title === 'VILLAGE 직원 설정' || entry.page.title === '최근 결제 취소')
  ));
  assert.strictEqual(interactiveMenus.length, 0, 'storage degradation must keep cancel settings non-interactive');
  const finalPage = harness.pages.at(-1);
  assert.strictEqual(finalPage.type, 'result');
  assert.strictEqual(finalPage.page.status, 'error');
  assert.match(finalPage.page.title, /결제 기록|저장소/);
  const labels = (finalPage.page.buttons || []).map((button) => button.label);
  assert.ok(labels.includes('다시 시도'));
  assert.ok(!labels.includes('직원 설정 열기'));
  assert.ok(!labels.includes('취소 목록'));
}

async function testSettingsReadRejectionShowsNonInteractiveDegradedState() {
  const harness = createHarness({ receiptReadError: new Error('storage read rejected') });

  await harness.initPromise;

  assertNoInteractiveCancelMenu(harness);
}

async function testSettingsCorruptJsonShowsNonInteractiveDegradedState() {
  const harness = createHarness({ receiptRawValue: '{broken json' });

  await harness.initPromise;

  assertNoInteractiveCancelMenu(harness);
}

async function testCancelableListReadFailureNeverClaimsZeroEligiblePayments() {
  const harness = createHarness({ pageMode: 'customer', receiptReadError: new Error('read unavailable') });
  await harness.initPromise;
  harness.pages.length = 0;

  await harness.context.showCancelablePayments();

  const result = harness.lastResult();
  assert.strictEqual(result.status, 'error');
  assert.match(result.title, /결제 기록|저장소/);
  assert.doesNotMatch(result.title, /취소 가능한 최근 결제가 없/);
}

async function testPendingLedgerRetryReadFailureRejectsInsteadOfReportingZero() {
  const harness = createHarness({ pageMode: 'customer', receiptReadError: new Error('read unavailable') });
  await harness.initPromise;

  await assert.rejects(
    () => harness.context.retryPendingCancelSyncs(),
    /read unavailable|결제 기록|저장소/
  );
}

async function testRawPaymentNormalizationForCardCashAndBarcode() {
  const harness = createHarness({ pageMode: 'customer' });
  await harness.initPromise;
  const normalize = harness.context.normalizePaymentResponse;

  const card = JSON.parse(JSON.stringify(normalize({
    paymentMethod: 'CARD',
    card: {
      timestamp: '2026-07-15T10:00:00.000Z',
      approvalNumber: 'RAW-CARD-1',
      installment: 3,
      isSelfIssuance: false
    },
    extraData: { source: 'card' }
  }, 11000)));
  assert.deepStrictEqual(card, {
    paymentMethod: 'CARD',
    amount: 11000,
    tax: 1000,
    supplyValue: 10000,
    tip: 0,
    timestamp: '2026-07-15T10:00:00.000Z',
    approvalNumber: 'RAW-CARD-1',
    installment: 3,
    extraData: { source: 'card' },
    isSelfIssuance: false
  });

  const cash = JSON.parse(JSON.stringify(normalize({
    paymentMethod: 'CASH',
    cash: {
      cashReceipt: {
        timestamp: '2026-07-15T10:01:00.000Z',
        approvalNumber: 'RAW-CASH-1',
        isSelfIssuance: true
      }
    }
  }, 5500)));
  assert.strictEqual(cash.paymentMethod, 'CASH');
  assert.strictEqual(cash.timestamp, '2026-07-15T10:01:00.000Z');
  assert.strictEqual(cash.approvalNumber, 'RAW-CASH-1');
  assert.strictEqual(cash.isSelfIssuance, true);
  assert.strictEqual(cash.tax, 500);
  assert.strictEqual(cash.supplyValue, 5000);

  const barcode = JSON.parse(JSON.stringify(normalize({
    paymentMethod: 'BARCODE',
    barcode: {
      timestamp: '2026-07-15T10:02:00.000Z',
      approvalNumber: 'RAW-BARCODE-1'
    }
  }, 3300)));
  assert.strictEqual(barcode.paymentMethod, 'BARCODE');
  assert.strictEqual(barcode.timestamp, '2026-07-15T10:02:00.000Z');
  assert.strictEqual(barcode.approvalNumber, 'RAW-BARCODE-1');
  assert.strictEqual(barcode.tax, 300);
  assert.strictEqual(barcode.supplyValue, 3000);
}

async function testLegacyIncompleteRecordHydratesBeforeBuildingCancelPayload() {
  const legacy = {
    tradeId: 'manual-legacy',
    sourceType: 'manual',
    paymentKey: 'legacy-payment-key',
    amount: 11000,
    paidAt: '2026-07-15T09:00:00.000Z',
    customerName: '레거시 직접 결제'
  };
  const harness = createHarness({
    pageMode: 'customer',
    records: [legacy],
    getPayment: async () => approvedCardResult({
      card: {
        approvalNumber: 'LEGACY-APPROVAL-1',
        timestamp: '2026-07-15T09:00:00.000Z',
        installment: 2
      },
      response: { extraData: { legacy: true } }
    }),
    getPaymentCancel: async () => { throw paymentNotFound('code'); },
    requestPaymentCancel: async () => approvedCardResult({
      card: {
        approvalNumber: 'LEGACY-CANCEL-1',
        timestamp: '2026-07-15T13:00:00.000Z'
      }
    })
  });
  await harness.initPromise;

  await harness.context.executeFullPaymentCancel(legacy);

  assert.strictEqual(harness.getPaymentCalls.length, 1);
  assert.deepStrictEqual(
    JSON.parse(JSON.stringify(harness.getPaymentCalls[0])),
    { paymentKey: 'legacy-payment-key' }
  );
  assert.strictEqual(harness.requestCalls.length, 1);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(harness.requestCalls[0])), {
    paymentKey: 'legacy-payment-key',
    paymentMethod: 'CARD',
    tax: 1000,
    supplyValue: 10000,
    tip: 0,
    timestamp: '2026-07-15T09:00:00.000Z',
    approvalNumber: 'LEGACY-APPROVAL-1',
    installment: 2,
    timeoutMs: 60000,
    extraData: { legacy: true },
    isSelfIssuance: false,
    localeCode: 'ko'
  });
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
  await testStrictReceiptReadAllowsActuallyAbsentKey();
  await testStrictReceiptReadRejectsMissingStorageApi();
  await testStrictReceiptReadRejectsInvalidStoreShape();
  await testStrictReceiptWriteRejectsSdkFailure();
  await testStrictReceiptWriteDetectsReadBackMismatch();
  await testReservationApprovalHistoryFailureStillConfirmsAndKeepsPending();
  await testReservationApprovalCombinesHistoryAndLedgerWarnings();
  await testManualApprovalHistoryFailureShowsApprovedWarning();
  await testNormalReservationSuccessRemainsUnchanged();
  await testReservationApprovalReplacesOrderWhileReceiptHistoryPersists();
  await testManualApprovalReplacesOrderWhileReceiptHistoryPersists();
  await testReservationApprovalShowsReceiptBeforeLedgerSyncFinishes();
  await testReceiptPrintedDuringLedgerSyncKeepsPaymentFlowLocked();
  await testReceiptFailureDuringLedgerSyncKeepsPaymentFlowLocked();
  await testRecoveryHistoryFailureKeepsPendingForAnotherRetry();
  await testRecoveryNonSuccessClearsStalePending();
  await testSettingsReadRejectionShowsNonInteractiveDegradedState();
  await testSettingsCorruptJsonShowsNonInteractiveDegradedState();
  await testCancelableListReadFailureNeverClaimsZeroEligiblePayments();
  await testPendingLedgerRetryReadFailureRejectsInsteadOfReportingZero();
  await testRawPaymentNormalizationForCardCashAndBarcode();
  await testLegacyIncompleteRecordHydratesBeforeBuildingCancelPayload();
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
