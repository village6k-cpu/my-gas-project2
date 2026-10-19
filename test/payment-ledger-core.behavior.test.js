const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const appRoot = path.join(__dirname, '../apps/today-dashboard');
const localRequire = createRequire(path.join(appRoot, 'package.json'));
const ts = localRequire('typescript');
const source = fs.readFileSync(path.join(appRoot, 'lib/server/paymentLedger.ts'), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const copy = value => JSON.parse(JSON.stringify(value));
const account = (changes = {}) => ({ trade_id: '261020-001', customer_name: '김수납', payer_name: '김수납', billed_amount: 100000, paid_amount: 0, opening_paid: 0, balance: 100000, credit: 0, review_required: false, contract_status: '예약', checkout_at: '2026-10-20T09:00:00+09:00', revision: 1, needs_projection: false, baseline_at: '2026-10-19T00:00:00Z', ...changes });
const receipt = (changes = {}) => ({ id: 'receipt-1', source: 'bank', source_id: 'bank-1', amount: 100000, allocated_amount: 0, remaining_amount: 100000, occurred_at: '2026-10-20T00:00:00Z', payer_name: '김수납', status: 'active', revision: 1, review_reason: null, allocations: [], ...changes });
function harness(options = {}) {
  const events = [];
  const calls = { rpc: [], gas: [], queries: [] };
  const state = { accounts: copy(options.accounts || [account()]), receipts: copy(options.receipts || [receipt()]), aliases: copy(options.aliases || []) };
  function query(table) {
    const filters = [];
    let single = false;
    let range = null;
    const chain = {};
    for (const method of ['select', 'order', 'eq', 'in', 'gt', 'range', 'single', 'maybeSingle', 'update']) {
      chain[method] = (...args) => {
        calls.queries.push({ table, method, args: copy(args) });
        if (['eq', 'in', 'gt'].includes(method)) filters.push({ method, key: args[0], value: args[1] });
        if (method === 'range') range = args;
        if (['single', 'maybeSingle'].includes(method)) single = true;
        return chain;
      };
    }
    chain.then = (resolve, reject) => {
      let rows;
      if (table === 'payment_account_balances' || table === 'payment_accounts') rows = state.accounts;
      else if (table === 'payment_receipt_balances' || table === 'payment_receipts') rows = state.receipts;
      else if (table === 'payment_receipt_aliases') rows = state.aliases;
      else if (table === 'payment_allocations') rows = state.receipts.flatMap(r => r.allocations.map(a => ({ ...a, receipt_id: r.id })));
      else throw Error('Unexpected table: ' + table);
      rows = rows.filter(row => filters.every(f => f.method === 'eq' ? row[f.key] === f.value : f.method === 'in' ? f.value.includes(row[f.key]) : row[f.key] > f.value));
      if (range) rows = rows.slice(range[0], range[1] + 1);
      return Promise.resolve({ data: copy(single ? rows[0] || null : rows), error: null }).then(resolve, reject);
    };
    return chain;
  }
  const db = {
    from: query,
    async rpc(name, args) {
      events.push(name); calls.rpc.push({ name, args: copy(args) });
      if (name === 'payment_ingest_receipt') {
        const input = args.p_receipt;
        if (!state.receipts.length) state.receipts.push(receipt({ ...input, id: 'receipt-1', remaining_amount: input.amount }));
        if (input.status === 'cancelled') state.receipts[0].status = 'cancelled';
        return { data: { success: true, receiptId: state.receipts[0].id, duplicate: !!options.duplicate }, error: null };
      }
      if (name === 'payment_set_allocations') {
        if (options.allocateError) return { data: null, error: { message: options.allocateError } };
        const target = state.receipts.find(r => r.id === args.p_receipt_id);
        target.allocations = copy(args.p_allocations);
        target.allocated_amount = target.allocations.reduce((sum, a) => sum + a.amount, 0);
        target.remaining_amount = target.amount - target.allocated_amount;
        target.revision++;
      }
      if (name === 'payment_require_review') state.accounts.find(a => a.trade_id === args.p_trade_id).review_required = true;
      return { data: { success: true }, error: null };
    },
  };
  const mod = { exports: {} };
  vm.runInNewContext(compiled, {
    module: mod, exports: mod.exports, Buffer, Date, Error, console,
    process: { env: { PAYMENT_LEDGER_ENABLED: 'true', PAYMENT_LEDGER_CUTOVER_AT: '2026-10-19T00:00:00Z', NEXT_PUBLIC_SUPABASE_URL: 'https://test.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'test-service' } },
    require(id) {
      if (id === 'node:crypto') return require(id);
      if (id === '@supabase/supabase-js') return { createClient: () => db };
      if (id === './gasInternalKey.mjs') return { getVillageGasInternalKey: () => 'test-internal' };
      if (id === './gasPublic') return { gasPost: async payload => {
        calls.gas.push(copy(payload)); events.push('gas:' + payload.action);
        if (options.gasError) throw Error(options.gasError);
        if (payload.action === 'paymentLedgerSnapshot') return { success: true, accounts: options.snapshotAccounts === undefined ? state.accounts : options.snapshotAccounts };
        if (payload.action === 'paymentLedgerProjection') return { success: true, applied: [], rejected: [] };
        throw Error('Unexpected GAS action');
      } };
      throw Error('Unexpected module: ' + id);
    },
  });
  return { api: mod.exports, state, events, calls };
}
const inputFor = source => ({ source, sourceId: source + '-1', amount: 100000, occurredAt: '2026-10-20T00:00:00Z', payerName: '김수납' });
const frontInput = { tradeId: '261020-001', paymentKey: 'front-1', paidAmount: 26400, approvalNumber: '12345678', timestamp: '2026-10-20T09:00:00+09:00', customerName: '김수납' };

test('Toss amount and date coincidence offers a candidate but never automatically allocates', async () => {
  const h = harness({ receipts: [receipt({ source: 'toss' })] });
  assert.equal(h.api.receiptCandidates(h.state.receipts[0], h.state.accounts).length, 1, 'fixture must be a matching amount/date candidate');
  const result = await h.api.ingestPayment(inputFor('toss'), 'test', { refresh: false, project: false });
  assert.equal(result.status, 'unmatched');
  assert.equal(h.calls.rpc.some(call => call.name === 'payment_set_allocations'), false);
});
test('unique bank payer can automatically allocate on first receipt revision', async () => {
  const h = harness();
  const result = await h.api.ingestPayment(inputFor('bank'), 'test', { refresh: false, project: false });
  assert.equal(result.status, 'allocated');
  const allocation = h.calls.rpc.find(call => call.name === 'payment_set_allocations');
  assert.deepEqual(allocation.args.p_allocations, [{ trade_id: '261020-001', amount: 100000 }]);
});
test('duplicate bank receipt manually unlinked at a later revision never automatically rematches', async () => {
  const h = harness({ duplicate: true, receipts: [receipt({ revision: 3 })] });
  const result = await h.api.ingestPayment(inputFor('bank'), 'repeated_bank_feed', { refresh: false, project: false });
  assert.equal(result.duplicate, true);
  assert.equal(result.status, 'unmatched');
  assert.equal(h.calls.rpc.some(call => call.name === 'payment_set_allocations'), false);
  assert.equal(h.state.receipts[0].revision, 3);
});
test('front approval is durably ingested before GAS snapshot failure', async () => {
  const h = harness({ receipts: [], gasError: 'GAS timeout' });
  await assert.rejects(h.api.recordFrontPayment(frontInput), /GAS timeout/);
  assert.equal(h.state.receipts.length, 1);
  assert.equal(h.state.receipts[0].source, 'front');
  assert.equal(h.state.receipts[0].source_id, frontInput.paymentKey);
  assert.equal(h.state.receipts[0].amount, 26400);
  assert.equal(h.state.receipts[0].raw.tradeId, frontInput.tradeId);
  assert.ok(h.events.indexOf('payment_ingest_receipt') < h.events.indexOf('gas:paymentLedgerSnapshot'));
  assert.equal(h.calls.rpc.some(call => call.name === 'payment_set_allocations'), false);
});
test('front approval remains unmatched after allocation fails, with original identity retained', async () => {
  const h = harness({ receipts: [], allocateError: 'receipt revision conflict' });
  await assert.rejects(h.api.recordFrontPayment(frontInput), /receipt revision conflict/);
  assert.equal(h.state.receipts[0].remaining_amount, 26400);
  assert.deepEqual(h.state.receipts[0].allocations, []);
  const ingest = h.calls.rpc.find(call => call.name === 'payment_ingest_receipt').args.p_receipt;
  assert.equal(ingest.approval_number, frontInput.approvalNumber);
  assert.equal(ingest.occurred_at, '2026-10-20T00:00:00.000Z');
  assert.ok(h.events.indexOf('payment_ingest_receipt') < h.events.indexOf('payment_set_allocations'));
});
test('payable lookup blocks explicit reservation of unallocated approval even when canonical source is toss', async () => {
  const h = harness({ accounts: [account(), account({ trade_id: '261020-002' })], receipts: [receipt({ source: 'toss', explicit_trade_id: '261020-001', remaining_amount: 26400 })] });
  const payable = await h.api.getPayablePaymentBalances(['261020-001', '261020-002']);
  assert.deepEqual(Array.from(payable, a => a.trade_id), ['261020-002']);
  assert.equal(h.calls.queries.some(call => call.table === 'payment_receipt_balances' && call.method === 'eq' && call.args[0] === 'source'), false, 'deduplicated source must not bypass pending approval protection');
});
test('historical card cancellation with opening paid requires review instead of silently preserving paid status', async () => {
  const h = harness({ receipts: [], accounts: [account({ opening_paid: 26400, paid_amount: 26400, balance: 73600, baseline_at: '2026-10-20T00:00:00Z' })] });
  const result = await h.api.recordFrontPayment({ ...frontInput, timestamp: '2026-10-18T09:00:00+09:00', cancelled: true });
  assert.equal(result.pendingReview, true);
  const review = h.calls.rpc.find(call => call.name === 'payment_require_review');
  assert.equal(review.args.p_trade_id, '261020-001');
  assert.match(review.args.p_request_id, /^historical-cancel:/);
  assert.equal(h.state.accounts[0].review_required, true);
  assert.equal(h.calls.rpc.some(call => call.name === 'payment_set_allocations'), false);
  assert.ok(h.events.indexOf('payment_ingest_receipt') < h.events.indexOf('payment_require_review'));
});
test('new cancellation after baseline does not incorrectly flag historical opening paid', async () => {
  const h = harness({ receipts: [], accounts: [account({ opening_paid: 26400, baseline_at: '2026-10-19T00:00:00Z' })] });
  const result = await h.api.recordFrontPayment({ ...frontInput, cancelled: true });
  assert.equal(result.ok, true);
  assert.equal(h.calls.rpc.some(call => call.name === 'payment_require_review'), false);
});
test('manual pending and recovered key identities ingest the same unbound approval receipt', async () => {
  const h = harness({ receipts: [] });
  for (const tradeId of ['manual-pending', 'manual-front-1']) {
    const result = await h.api.recordFrontPayment({ ...frontInput, tradeId });
    assert.equal(result.ok, true);
    assert.equal(result.unallocatedAmount, 26400);
  }
  const ingests = h.calls.rpc.filter(call => call.name === 'payment_ingest_receipt');
  assert.equal(ingests.length, 2);
  assert.equal(ingests[0].args.p_receipt.raw.tradeId, null);
  assert.equal(ingests[1].args.p_receipt.raw.tradeId, null);
  assert.deepEqual(ingests[0].args.p_receipt, ingests[1].args.p_receipt, 'changing a local manual display key must not change the immutable approval payload');
  assert.equal(ingests[0].args.p_request_id, ingests[1].args.p_request_id);
  assert.equal(h.calls.rpc.some(call => call.name === 'payment_set_allocations'), false);
});
test('front approval replay acknowledges staff-unlinked receipt without automatically relinking it', async () => {
  const h = harness({ duplicate: true, receipts: [receipt({ source: 'front', source_id: 'front-1', amount: 26400, remaining_amount: 26400, revision: 3, allocations: [] })] });
  const result = await h.api.recordFrontPayment(frontInput);
  assert.equal(result.ok, true);
  assert.equal(result.allocatedAmount, 0);
  assert.equal(result.unallocatedAmount, 26400);
  assert.equal(h.state.receipts[0].revision, 3);
  assert.equal(h.calls.rpc.some(call => call.name === 'payment_set_allocations'), false);
});
test('missing requested GAS account snapshot rejects refresh and never exposes an old payable account', async () => {
  const h = harness({ accounts: [account()], snapshotAccounts: [] });
  await assert.rejects(h.api.refreshPaymentAccounts(['261020-001']), /장부에서 예약을 찾지 못/);
  assert.equal(h.calls.rpc.some(call => call.name === 'payment_refresh_accounts'), false, 'incomplete snapshot must not be accepted as a current refresh');
  await assert.rejects(h.api.getPayablePaymentBalances(['261020-001']), /장부에서 예약을 찾지 못/);
  assert.equal(h.calls.queries.some(call => call.table === 'payment_account_balances'), false, 'stale account must not be used after authoritative source omits the reservation');
});
