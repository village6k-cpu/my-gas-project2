const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm'), path = require('node:path');
const { createRequire } = require('node:module');
const appRoot = path.join(__dirname, '../apps/today-dashboard'), appRequire = createRequire(path.join(appRoot, 'package.json'));
const ts = appRequire('typescript'), next = appRequire('next/server');
const model = import('../apps/today-dashboard/lib/followups/invoice-model.mjs');
const clone = x => JSON.parse(JSON.stringify(x));
const work = { id: '11111111-1111-4111-8111-111111111111', version: 1, work_type: 'tax_invoice', state: 'open', title: '고객 계산서 발행', summary: '261102-001 계산서 요청', payload: { business_key: '261102-001' }, first_opened_at: '2026-11-02T01:00:00.000Z' };
const item = { tradeId: '261102-001', customerName: '고객', status: 'ready', canIssue: true, amount: 43890, buyer: { corpNum: '1234567890', email: 'invoice@example.com' }, fingerprint: 'a'.repeat(64), missing: [] };
const body = { action: 'issue', id: work.id, expectedVersion: 1, tradeId: item.tradeId, fingerprint: item.fingerprint, buyer: item.buyer };
async function harness(options = {}) {
  const calls = { gas: [], rpc: [], updates: [], reads: 0 };
  const query = { select() { return this; }, eq() { return this; }, in() { return this; }, order() { return this; }, range() { return this; },
    update(data) { this.patch = clone(data); calls.updates.push(clone(data)); return this; }, maybeSingle() {
    calls.reads++; return Promise.resolve({ data: { ...clone(work), ...(options.work || {}), ...(this.patch || {}), ...(options.concurrent && calls.reads > 1 ? { version: 2 } : {}) }, error: null });
  }, then(resolve) { return Promise.resolve({ data: options.listWork || [], error: null }).then(resolve); } };
  const db = { from: () => ({ ...query }), async rpc(name, args) { calls.rpc.push({ name, args }); return { data: options.completionConflict ? { applied: false, row: null } : { applied: true, row: { state: 'resolved', version: 2, resolution_evidence: {} } }, error: null }; } };
  const module = { exports: {} }, m = await model;
  const source = fs.readFileSync(path.join(appRoot, 'lib/server/invoiceRequests.ts'), 'utf8');
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  vm.runInNewContext(js, { module, exports: module.exports, process: { env: { NEXT_PUBLIC_SUPABASE_URL: 'https://test.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'test-service' } }, console, require: id => {
    if (id === '@supabase/supabase-js') return { createClient: () => db };
    if (id === 'node:crypto') return require(id);
    if (id.includes('invoice-model')) return m;
    if (id.includes('gasPublic')) return { gasPost: async input => {
      calls.gas.push(clone(input));
      if (input.action === 'taxInvoiceWorkspace') return { success: true, buyers: [], items: (input.options.targets || input.tids.map(tradeId => ({ key: tradeId, tradeId }))).map(target => ({ ...clone(item), tradeId: target.tradeId, workspaceKey: target.key, ...(target.buyer ? { buyer: target.buyer } : {}) })) };
      if (input.dryRun === true) return { success: true, item: { ...clone(item), ...(options.preview || {}) }, ...(options.alreadyIssued ? { alreadyIssued: true } : {}) };
      if (options.timeout) throw Error('network timeout');
      if (options.unknown) return { success: false, outcomeUnknown: true, error: '発行結果確認必要' };
      return { success: true, item: { ...clone(item), status: 'issued', canIssue: false, mgtKey: 'PROVIDER-1', ...(options.issued || {}) } };
    } };
    throw Error('unmocked ' + id);
  } });
  return { api: module.exports, calls };
}
test('real issuance verifies dry-run first and completes only after persisted provider evidence', async () => {
  const h = await harness(); const result = await h.api.processInvoiceRequest(body, 'heybilli:actor');
  assert.equal(result.issued, true); assert.equal(result.row.workState, 'resolved'); assert.equal(result.row.version, 2);
  assert.deepEqual(h.calls.gas.map(c => c.dryRun), [true, false]); assert.equal(h.calls.rpc.length, 1);
  assert.equal(h.calls.updates[0].resolution_evidence.taxInvoice.mgtKey, 'PROVIDER-1');
});
test('dry run never sends an invoice or completes a work item', async () => {
  const h = await harness(); const result = await h.api.processInvoiceRequest({ ...body, dryRun: true }, 'actor');
  assert.equal(result.dryRun, true); assert.equal(h.calls.gas.length, 1); assert.equal(h.calls.rpc.length, 0); assert.equal(h.calls.updates.length, 0);
});
test('provider timeout, negative acknowledgment and missing management key never complete work', async () => {
  for (const options of [{ timeout: true }, { unknown: true }, { issued: { mgtKey: '' } }]) {
    const h = await harness(options); await assert.rejects(h.api.processInvoiceRequest(body, 'actor')); assert.equal(h.calls.rpc.length, 0);
  }
});
test('amount review and concurrent work edit block the final external call', async () => {
  for (const options of [{ preview: { canIssue: false } }, { concurrent: true }]) {
    const h = await harness(options); await assert.rejects(h.api.processInvoiceRequest(body, 'actor')); assert.equal(h.calls.gas.length, 1); assert.equal(h.calls.rpc.length, 0);
  }
});
test('correction and combined requests cannot use the single-trade issue endpoint', async () => {
  for (const title of ['고객 합산 계산서 요청', '고객 계산서 정정 요청']) {
    const h = await harness({ work: { title } }); await assert.rejects(h.api.processInvoiceRequest(body, 'actor')); assert.equal(h.calls.gas.length, 0);
  }
});
test('completion conflict reports invoice success without replaying external issuance', async () => {
  const h = await harness({ completionConflict: true }); const result = await h.api.processInvoiceRequest(body, 'actor');
  assert.equal(result.issued, true); assert.ok(result.warning); assert.equal(result.row.status, 'issued'); assert.equal(result.row.workState, 'open'); assert.equal(h.calls.gas.length, 2);
});
test('both HTTP methods authenticate before accessing work, finance or issuance', async () => {
  const mod = { exports: {} }; let calls = 0;
  const source = fs.readFileSync(path.join(appRoot, 'app/api/follow-ups/invoices/route.ts'), 'utf8');
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  vm.runInNewContext(js, { module: mod, exports: mod.exports, require: id => {
    if (id === 'next/server') return next;
    if (id.includes('authCache')) return { getAuthedUser: async () => null };
    if (id.includes('invoiceRequests')) return { listInvoiceRequests: () => calls++, processInvoiceRequest: () => calls++, searchInvoiceTrades: () => calls++ };
    throw Error(id);
  } });
  for (const method of ['GET', 'POST']) assert.equal((await mod.exports[method](new next.NextRequest('https://example.test/api/follow-ups/invoices', { method }))).status, 401);
  assert.equal(calls, 0);
});
test('prepare persists the explicitly chosen trade and buyer with a new version', async () => {
  const h = await harness(); const result = await h.api.processInvoiceRequest({ ...body, action: 'prepare', tradeId: '261102-002' }, 'actor');
  assert.equal(result.row.version, 2); assert.equal(h.calls.updates[0].resolution_evidence.invoiceDraft.tradeId, '261102-002');
  assert.equal(h.calls.rpc.length, 0); assert.ok(h.calls.gas.every(c => c.action === 'taxInvoiceWorkspace'));
});
test('prepare dry run does not write a selection or send an invoice', async () => {
  const h = await harness(); const result = await h.api.processInvoiceRequest({ ...body, action: 'prepare', dryRun: true }, 'actor');
  assert.equal(result.dryRun, true); assert.equal(h.calls.updates.length, 0); assert.equal(h.calls.rpc.length, 0);
});
test('list refresh uses the prepared target and verified evidence instead of original trade text', async () => {
  const prepared = { ...clone(work), resolution_evidence: { invoiceDraft: { tradeId: '261102-002', buyer: item.buyer } } };
  const h = await harness({ listWork: [prepared] }); const result = await h.api.listInvoiceRequests();
  assert.equal(result.rows[0].item.tradeId, '261102-002'); assert.equal(h.calls.gas[0].options.targets[0].key, work.id);
});
