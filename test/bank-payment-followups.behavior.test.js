const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const { runInNewContext } = require('node:vm');
const { test } = require('node:test');
const app = path.resolve(__dirname, '../apps/today-dashboard');
const ts = createRequire(path.join(app, 'package.json'))('typescript');
const { outputText } = ts.transpileModule(readFileSync(path.join(app, 'lib/server/bankPaymentFollowups.ts'), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
});
const exportsModule = {};
runInNewContext(outputText, { exports: exportsModule, require: () => ({}) });
const { planBankPaymentFollowup } = exportsModule;
const item = { work_type: 'payment_check', state: 'open', first_opened_at: '2026-11-10T11:02:15Z',
  title: '예약자 대여료 김입금 명의 입금 확인',
  payload: { action_family: 'payment_reconcile', business_key: '261103-008', follow_up_task_key: 'payment-check:261103-008' } };
const account = { trade_id: '261103-008', payer_name: '예약자', billed_amount: null, contract_status: '예약' };
const receipt = { id: 'bank-1', source: 'bank', status: 'active', occurred_at: '2026-11-10T10:57:08Z',
  amount: 254961, allocated_amount: 0, remaining_amount: 254961,
  raw: { remark1: '김입금', remark2: '090003', remark3: '모바일' }, allocations: [] };

test('an early miss is reclassified when the original appears, even if billing is blank', () => {
  assert.equal(planBankPaymentFollowup(item, account, []), null);
  const plan = planBankPaymentFollowup(item, account, [receipt]);
  assert.equal(plan.state, 'candidate');
  assert.equal(plan.payer, '김입금');
  assert.equal(plan.amount, 254961);
  assert.equal(plan.reason, '청구액 확인 필요');
});

test('only a live receipt allocated to this trade and acknowledged by the sheet closes the payment check', () => {
  const paid = { ...account, billed_amount: 254961, paid_amount: 254961, balance: 0, status: '입금완료', revision: 4, projected_revision: 4 };
  const linked = { ...receipt, remaining_amount: 0, allocated_amount: 254961, allocations: [{ trade_id: '261103-008', amount: 254961 }] };
  assert.equal(planBankPaymentFollowup(item, paid, [linked]).state, 'confirmed');
  assert.equal(planBankPaymentFollowup(item, { ...paid, projected_revision: 3 }, [linked]), null);
  assert.equal(planBankPaymentFollowup(item, paid, [{ ...linked, status: 'cancelled' }]), null);
  assert.equal(planBankPaymentFollowup(item, paid, [{ ...linked, allocations: [{ trade_id: '261103-009', amount: 254961 }] }]), null);
});

test('duplicate senders, a different Korean day, and staff work in progress do not create a match', () => {
  assert.equal(planBankPaymentFollowup(item, account, [receipt, { ...receipt, id: 'bank-2' }]), null);
  assert.equal(planBankPaymentFollowup(item, account, [{ ...receipt, occurred_at: '2026-11-09T14:59:59Z' }]), null);
  assert.equal(planBankPaymentFollowup({ ...item, state: 'in_progress' }, account, [receipt]), null);
});
