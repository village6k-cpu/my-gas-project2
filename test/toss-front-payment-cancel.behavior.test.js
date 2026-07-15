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
        return options.getPaymentCancel(payload, lookupCalls.length);
      },
      async requestPaymentCancel(payload) {
        requestCalls.push(payload);
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
    console,
    setTimeout,
    clearTimeout,
    crypto: { randomUUID: () => 'test-payment-key' },
    CONFIG: {},
    VILLAGE_PAGE_MODE: 'settings',
    TossFrontSDK: sdk,
    document: { getElementById: () => null }
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(appSource, sandbox, { filename: 'toss-front-plugin/village-front/app.js' });

  return {
    context: sandbox,
    lookupCalls,
    requestCalls,
    pages,
    toasts,
    records: () => records,
    lastResult: () => pages.filter((entry) => entry.type === 'result').at(-1).page
  };
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
