const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const appRoot = path.join(__dirname, '../apps/today-dashboard');
const localRequire = createRequire(path.join(appRoot, 'package.json'));
const ts = localRequire('typescript');
const next = localRequire('next/server');

function loadRoute(name, { rows = [], balances = [], recordError, token = 'terminal-token' } = {}) {
  const calls = { queries: [], balances: [], records: [], gas: [] };
  function query(table) {
    const chain = {};
    for (const method of ['select', 'order', 'eq', 'ilike', 'or', 'neq', 'limit', 'in']) {
      chain[method] = (...args) => { calls.queries.push({ table, method, args }); return chain; };
    }
    chain.then = resolve => Promise.resolve({ data: table === 'trades' ? rows : [], error: null }).then(resolve);
    return chain;
  }
  const dependencies = {
    'next/server': next,
    '@supabase/supabase-js': { createClient: () => ({ from: query }) },
    '@/lib/server/gasPublic': { gasPost: async value => { calls.gas.push(value); throw new Error('enabled allocation routes must not blindly mark a full reservation paid/refunded'); } },
    '@/lib/server/phoneNormalize': { normalizePhoneLast8: value => String(value).replace(/\D/g, '').slice(-8) },
    '@/lib/server/paymentLedger': {
      paymentLedgerEnabled: () => true,
      getPayablePaymentBalances: async ids => { calls.balances.push(Array.from(ids)); if (balances instanceof Error) throw balances; return balances; },
      recordFrontPayment: async value => { calls.records.push(JSON.parse(JSON.stringify(value))); if (recordError) throw recordError; return { ok: true, receiptId: 'receipt-1', allocatedAmount: value.tradeId.startsWith('manual-') ? 0 : value.paidAmount }; },
    },
  };
  const source = fs.readFileSync(path.join(appRoot, 'app/api/lookup', name, 'route.ts'), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const mod = { exports: {} };
  vm.runInNewContext(compiled, { exports: mod.exports, module: mod, Headers, console: { error() {}, warn() {} }, process: { env: { LOOKUP_TOKEN: token, NEXT_PUBLIC_SUPABASE_URL: 'https://test.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'test-service' } }, require: id => { if (!(id in dependencies)) throw Error('unmocked import ' + id); return dependencies[id]; } });
  return { route: mod.exports, calls };
}
function request(name, body, token = 'terminal-token') {
  return new next.NextRequest('https://dashboard.test/api/lookup/' + name, { method: 'POST', headers: { 'content-type': 'application/json', 'x-lookup-token': token }, body: JSON.stringify(body) });
}
const row = (id, status = '입금완료') => ({ trade_id: id, customer_name: '수납 테스트', customer_phone: '010-1234-5678', amount: 10000, checkout_at: '2026-10-20', deposit_status: status, contract_status: '예약' });
const payment = { tradeId: '261020-001', paidAmount: 26400, paymentKey: 'approval-key', approvalNumber: '12345678', timestamp: '2026-10-20T09:10:11+09:00', method: '카드결제' };

test('lookup returns current remaining balance after onsite additions even if mirror says fully paid', async () => {
  for (const query of ['phone=01012345678', 'reservation=261020-001']) {
    const { route, calls } = loadRoute('', { rows: [row('261020-001'), row('PAID')], balances: [{ trade_id: '261020-001', balance: 26400, billed_amount: 126400, paid_amount: 100000, status: '부분입금' }] });
    const response = await route.GET(new next.NextRequest('https://dashboard.test/api/lookup?' + query, { headers: { 'x-lookup-token': 'terminal-token' } }));
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).matches.map(({ tradeId, amount, paidAmount, billedAmount }) => ({ tradeId, amount, paidAmount, billedAmount })), [{ tradeId: '261020-001', amount: 26400, paidAmount: 100000, billedAmount: 126400 }]);
    assert.deepEqual(calls.balances, [['261020-001', 'PAID']]);
    assert.equal(calls.gas.length, 0);
    assert.equal(calls.queries.some(call => call.method === 'or' && String(call.args).includes('deposit_status')), false, 'stale paid status must not hide an outstanding balance before canonical lookup');
    assert.match(response.headers.get('cache-control'), /no-store/);
  }
});
test('lookup hides zero-balance or uncertain accounts omitted by authoritative ledger', async () => {
  const { route } = loadRoute('', { rows: [row('PAID'), row('REVIEW', '부분입금')], balances: [] });
  const response = await route.GET(new next.NextRequest('https://dashboard.test/api/lookup?phone=01012345678', { headers: { 'x-lookup-token': 'terminal-token' } }));
  assert.deepEqual((await response.json()).matches, []);
});
test('lookup blocks stale amounts if canonical balance lookup fails', async () => {
  const { route } = loadRoute('', { rows: [row('OPEN')], balances: new Error('balance unavailable') });
  assert.equal((await route.GET(new next.NextRequest('https://dashboard.test/api/lookup?reservation=OPEN', { headers: { 'x-lookup-token': 'terminal-token' } }))).status, 502);
});
test('enabled confirmation forwards immutable approval identity and amount to receipt ledger', async () => {
  const { route, calls } = loadRoute('confirm');
  const response = await route.POST(request('confirm', payment));
  assert.equal(response.status, 200);
  assert.deepEqual(calls.records, [payment]);
  assert.equal(calls.gas.length, 0);
  assert.equal(response.headers.get('access-control-allow-origin'), '*');
});
test('manual approval is forwarded with manual identity and stays available for staff allocation', async () => {
  const { route, calls } = loadRoute('confirm');
  const body = { ...payment, tradeId: 'manual-payment-1' };
  const response = await route.POST(request('confirm', body));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).allocatedAmount, 0);
  assert.deepEqual(calls.records, [body]);
  assert.equal(calls.gas.length, 0);
});
test('cancellation references original approval time and removes only this receipt contribution', async () => {
  const { route, calls } = loadRoute('cancel');
  const { paidAmount, method, ...original } = payment;
  const body = { ...original, amount: paidAmount, cancelApprovalNumber: 'CANCEL123' };
  const response = await route.POST(request('cancel', body));
  assert.equal(response.status, 200);
  assert.deepEqual(calls.records, [{ ...body, paidAmount: 26400, cancelled: true }]);
  assert.equal(calls.gas.length, 0);
});
test('confirm and cancel enforce terminal token before touching receipts and preserve retry on errors', async () => {
  for (const name of ['confirm', 'cancel']) {
    const validBody = { ...payment, amount: payment.paidAmount };
    const { route, calls } = loadRoute(name, { recordError: new Error('ledger write failed') });
    assert.equal((await route.POST(request(name, validBody, 'wrong'))).status, 401);
    assert.equal(calls.records.length, 0);
    assert.equal((await route.POST(request(name, validBody))).status, 502);
    assert.equal(calls.records.length, 1);
    assert.equal(calls.gas.length, 0);
    // Explicitly missing configured token is represented as empty, not a runtime bypass.
    const missing = loadRoute(name, { token: '' });
    assert.equal((await missing.route.POST(request(name, validBody))).status, 503);
    assert.equal(missing.calls.records.length, 0);
  }
});
