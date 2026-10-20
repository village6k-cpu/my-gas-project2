import test from 'node:test';
import assert from 'node:assert/strict';
import { validateAllocationDraft, suggestedAllocation, isCancelledReceipt } from '../lib/paymentAllocationForm.ts';

test('one combined receipt can be split across reservations', () => {
  const result = validateAllocationDraft(100000, [{ tradeId: 'A', amount: '60000' }, { tradeId: 'B', amount: '40000' }], [], '합산 입금');
  assert.equal(result.error, '');
  assert.equal(result.total, 100000);
  assert.equal(result.allocations.length, 2);
});
test('partial allocation preserves the remainder instead of forcing full payment', () => {
  const result = validateAllocationDraft(100000, [{ tradeId: 'A', amount: '26400' }], [], '');
  assert.equal(result.error, '');
  assert.equal(100000 - result.total, 73600);
});
test('cannot allocate more money than was received', () => {
  assert.match(validateAllocationDraft(100, [{ tradeId: 'A', amount: '101' }], [], '').error, /초과/);
});
test('invalid currency entries never silently become valid allocations', () => {
  for (const amount of ['-1', '1.1', '1e3', '', 'NaN', 'Infinity', '9007199254740992', '1,000']) {
    assert.notEqual(validateAllocationDraft(10000, [{ tradeId: 'A', amount }], [], '').error, '', amount);
  }
});
test('duplicate reservations rejected even when an amount is zero', () => {
  assert.match(validateAllocationDraft(100, [{ tradeId: 'A', amount: '0' }, { tradeId: 'A', amount: '50' }], [], '').error, /한 번/);
});
test('removing or reducing an existing allocation requires a correction reason', () => {
  const before = [{ tradeId: 'A', amount: 100 }];
  assert.match(validateAllocationDraft(100, [], before, ' ').error, /사유/);
  assert.match(validateAllocationDraft(100, [{ tradeId: 'A', amount: '50' }], before, '').error, /사유/);
  const removed = validateAllocationDraft(100, [{ tradeId: 'A', amount: '0' }], before, '잘못 연결');
  assert.equal(removed.error, '');
  assert.deepEqual(removed.allocations, []);
});
test('moving an allocation also requires a correction reason', () => {
  assert.match(validateAllocationDraft(100, [{ tradeId: 'B', amount: '100' }], [{ tradeId: 'A', amount: 100 }], '').error, /사유/);
});
test('increasing an allocation does not count as removing a previous allocation', () => {
  assert.equal(validateAllocationDraft(100, [{ tradeId: 'A', amount: '100' }], [{ tradeId: 'A', amount: 50 }], '').error, '');
});
test('suggestions never exceed receipt remainder or current reservation balance', () => {
  assert.equal(suggestedAllocation(50000, 26400), 26400);
  assert.equal(suggestedAllocation(20000, 26400), 20000);
  assert.equal(suggestedAllocation(-100, 26400), 0);
});
test('cancelled and refunded receipts are not editable', () => {
  for (const state of ['CANCELED', 'cancelled', 'voided', 'REFUNDED', '결제취소', '환불완료']) assert.equal(isCancelledReceipt(state), true);
  assert.equal(isCancelledReceipt('approved'), false);
});

test('historical opening balance requires an integer amount, evidence, and valid revision', async () => {
  const { validateOpeningBalance } = await import('../lib/paymentAllocationForm.ts');
  assert.equal(validateOpeningBalance('0', '이전 수납 확인 완료', 1).error, '');
  assert.equal(validateOpeningBalance('26400', '이전 통장 내역 대조', 3).amount, 26400);
  for (const value of ['', '-1', '1.5', '1e3', '9007199254740992']) assert.notEqual(validateOpeningBalance(value, '근거 자료 확인 완료', 1).error, '');
  for (const revision of [0, -1, 1.1, NaN]) assert.notEqual(validateOpeningBalance('26400', '근거 자료 확인 완료', revision).error, '');
  assert.notEqual(validateOpeningBalance('26400', ' 확인 ', 1).error, '');
});

test('balance validation considers replacement of this receipts existing allocation', async () => {
  const { allocationBalanceError } = await import('../lib/paymentAllocationForm.ts');
  const trade = { tradeId: 'A', billedAmount: 100, paidAmount: 80, reviewRequired: false };
  assert.equal(allocationBalanceError([{ tradeId: 'A', amount: 50 }], [{ tradeId: 'A', amount: 30 }], [trade]), '');
  assert.match(allocationBalanceError([{ tradeId: 'A', amount: 51 }], [{ tradeId: 'A', amount: 30 }], [trade]), /잔액/);
  assert.match(allocationBalanceError([{ tradeId: 'A', amount: 10 }], [], [{ ...trade, reviewRequired: true }]), /기준 확인/);
  assert.match(allocationBalanceError([{ tradeId: 'A', amount: 10 }], [], [{ ...trade, billedAmount: null }]), /청구 금액/);
  assert.match(allocationBalanceError([{ tradeId: 'A', amount: 10 }], [], []), /잔액/);
  assert.equal(allocationBalanceError([], [{ tradeId: 'A', amount: 30 }], [{ ...trade, reviewRequired: true }]), '');
});
