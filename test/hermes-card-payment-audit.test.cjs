'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { audit, summarize, validateSelector } = require('../scripts/hermes/village-card-payment-audit/scripts/audit.cjs');

const account = { trade_id: '260101-001', customer_name: '시험고객', checkout_at: '2026-01-01T00:00:00Z', billed_amount: 100, opening_paid: 0, paid_amount: 200, review_required: false };
const current = { ...account, observed_at: '2026-01-02T00:00:00Z' };
const allocations = [1, 2].map(n => ({ receipt_id: 'receipt' + n, trade_id: account.trade_id, amount: 100 }));
const receipts = [1, 2].map(n => ({ id: 'receipt' + n, source: 'front', amount: 100, occurred_at: `2026-01-01T07:08:0${n}Z`, approval_number: '0000000' + n, status: 'active', review_reason: null }));
const aliases = receipts.flatMap(r => ['front', 'toss'].map(source => ({ source, source_id: source + r.id, receipt_id: r.id,
  trade_id: source === 'front' ? account.trade_id : null,
  financial_identity: { amount: r.amount, approval_number: r.approval_number, occurred_at: r.occurred_at } })));

test('two distinct approvals are counted once each, not once per terminal/provider alias', () => {
  const result = summarize(account, current, allocations, receipts, aliases, []);
  assert.equal(result.activeCardApprovalCount, 2);
  assert.equal(result.credit, 100);
  assert.equal(result.activeCardAllocated, 200);
  assert.ok(result.approvals.every(r => r.providerVerified));
  assert.equal(result.approvals[0].approvedAtKst, '2026-01-01T16:08:01.000+09:00');
  assert.deepEqual(result.warnings, []);
});

test('reversal is retained as evidence but excluded from paid and excess amounts', () => {
  const result = summarize({ ...account, paid_amount: 100 }, current, allocations,
    [receipts[0], { ...receipts[1], status: 'cancelled' }], aliases, [{ receipt_id: 'receipt2', event_type: 'receipt_cancelled' }]);
  assert.equal(result.activeCardApprovalCount, 1);
  assert.equal(result.credit, 0);
  assert.equal(result.approvals[1].status, 'cancelled');
  assert.deepEqual(result.approvals[1].eventTypes, ['receipt_cancelled']);
});

test('split allocations and historical opening balance are not extra card approvals', () => {
  const result = summarize({ ...account, opening_paid: 20, paid_amount: 70 }, current,
    [{ ...allocations[0], amount: 50 }], [receipts[0]], aliases.slice(0, 2), []);
  assert.equal(result.activeCardReceiptTotal, 100);
  assert.equal(result.activeCardAllocated, 50);
  assert.equal(result.paidAmount, 70);
  assert.equal(result.activeCardApprovalCount, 1);
});

test('wrong approval identity, changed billing and concurrent changes are explicit', () => {
  const wrong = aliases.map(a => a.source === 'toss' ? { ...a, financial_identity: { ...a.financial_identity, approval_number: 'wrong' } } : a);
  const result = summarize({ ...account, paid_amount: 100 }, { ...current, billed_amount: 300 }, allocations, receipts, wrong, []);
  assert.equal(result.billingChanged, true);
  assert.equal(result.credit, 0);
  assert.ok(result.approvals.every(r => !r.providerVerified));
  assert.equal(result.warnings.length, 3);
});

test('unknown billing never becomes zero; missing receipt warns', () => {
  const result = summarize(account, { ...current, billed_amount: null }, allocations, [receipts[0]], aliases, []);
  assert.equal(result.credit, null);
  assert.equal(result.reviewRequired, true);
  assert.ok(result.warnings.includes('A linked receipt is missing'));
});

const config = { SUPABASE_URL: 'https://example.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'secret-placeholder', VILLAGE2_API_URL: 'https://script.google.com/macros/s/example/exec', VILLAGE2_API_KEY: 'gas-secret-placeholder' };
function mockFetch(calls, override = {}) {
  const data = { payment_account_balances: [account], payment_allocations: allocations, payment_receipts: receipts, payment_receipt_aliases: aliases, payment_events: [], ...override };
  return async (url, options) => {
    calls.push({ url: new URL(url), options });
    if (new URL(url).hostname === 'script.google.com') return { ok: true, json: async () => ({ success: true, accounts: [current] }) };
    const table = new URL(url).pathname.split('/').at(-1);
    return { ok: true, json: async () => data[table] };
  };
}

test('original customer/date scenario reads village schema and current billing without mutations', async () => {
  const calls = [];
  const result = await audit({ config, customer: '시험고객', checkoutDate: '2026-01-01', fetchImpl: mockFetch(calls) });
  assert.equal(result.trades[0].credit, 100);
  assert.equal(result.readOnly, true);
  for (const call of calls) {
    if (call.url.hostname === 'script.google.com') {
      assert.equal(call.options.method, 'POST');
      assert.deepEqual(JSON.parse(call.options.body), { action: 'paymentLedgerSnapshot', tids: [account.trade_id], key: config.VILLAGE2_API_KEY });
    } else {
      assert.equal(call.options.method, 'GET');
      assert.equal(call.options.headers['Accept-Profile'], 'village');
      assert.equal(call.options.redirect, 'error');
    }
  }
  assert.ok(!JSON.stringify(result).includes('secret-placeholder'));
});

test('missing account is not reported as no payment and triggers no further calls', async () => {
  const calls = [];
  const result = await audit({ config, tradeId: account.trade_id, fetchImpl: mockFetch(calls, { payment_account_balances: [] }) });
  assert.deepEqual(result.trades, []);
  assert.match(result.warning, /does not prove no payment/);
  assert.equal(calls.length, 1);
});

test('network errors never print credentials; truncated results cannot produce a conclusion', async () => {
  await assert.rejects(audit({ config, tradeId: account.trade_id, fetchImpl: async () => { throw new Error(config.SUPABASE_SERVICE_ROLE_KEY); } }), /Payment ledger unavailable: payment_account_balances/);
  await assert.rejects(audit({ config, tradeId: account.trade_id, fetchImpl: mockFetch([], { payment_account_balances: Array(500).fill(account) }) }), /Incomplete payment ledger result/);
});

test('invalid IDs, ambiguous selectors and impossible dates fail before a request', () => {
  assert.throws(() => validateSelector({ tradeId: '1),or=(true' }));
  assert.throws(() => validateSelector({ tradeId: account.trade_id, customer: '시험고객' }));
  assert.throws(() => validateSelector({ customer: '시험고객', checkoutDate: '2026-02-30' }));
});


test('NICEPAY is explicitly blocked even with a terminal alias; NICE requires terminal evidence', () => {
  for (const van of ['NICEPAY', 'NICE', 'KSNET', null]) {
    const events = [{ receipt_id: receipts[0].id, providerVan: van, providerCardVan: van }];
    const result = summarize(account, current, allocations, receipts, aliases, events).approvals[0].cancellation;
    assert.equal(result.van, van);
    assert.equal(result.cardlessReady, false);
    assert.equal(result.remoteExecutionAvailable, false);
    assert.equal(result.status, !van ? 'van_unverified' : van === 'NICE' ? 'terminal_verification_required' : 'unsupported_van');
    assert.equal(result.paymentKey, 'frontreceipt1');
  }
});
test('conflicting VAN evidence is not converted into support; cancelled receipts stay cancelled', () => {
  const events = [{ receipt_id: receipts[0].id, providerVan: 'NICEPAY', providerCardVan: 'NICE' }];
  assert.equal(summarize(account, current, allocations, receipts, aliases, events).approvals[0].cancellation.status, 'van_unverified');
  const result = summarize(account, current, allocations, [{ ...receipts[0], status: 'cancelled' }], aliases, events);
  assert.equal(result.approvals[0].cancellation.status, 'already_cancelled');
});
