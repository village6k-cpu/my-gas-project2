const test = require('node:test'), assert = require('node:assert/strict');
const load = import('../apps/today-dashboard/lib/followups/invoice-model.mjs');
const work = (changes = {}) => ({ id: 'work-1', version: 1, state: 'open', title: '고객 세금계산서 발행', summary: '거래 261102-001 세금계산서 요청', payload: { business_key: '261102-001' }, room_key: 'chat:12345', ...changes });
const snapshot = { tradeId: '261102-001', customerName: '고객', status: 'ready', canIssue: true, missing: [] };
test('typed business reference wins over an incidental trade mentioned in the conversation', async () => {
  const { invoiceWorkReferences } = await load;
  assert.deepEqual(invoiceWorkReferences(work({ summary: '이전 260901-002 언급도 있음' })).ids, ['261102-001']);
});
test('combined and corrected requests are visible but cannot invoke a single-trade issue', async () => {
  const { invoiceRequestRow } = await load;
  for (const title of ['고객 두 대여건 합산 계산서 발행', '고객 계산서 정정 발행', '고객 계산서 재발행']) {
    const row = invoiceRequestRow(work({ title }), snapshot); assert.equal(row.canIssue, false); assert.equal(row.status, 'needs_info'); assert.ok(row.complexReason);
    assert.equal(invoiceRequestRow(work({ title }), { ...snapshot, status: 'issued' }).status, 'needs_info', 'an old invoice is not proof that a correction request was fulfilled');
  }
});
test('unlinked request is never automatically assigned from customer name', async () => {
  const { invoiceRequestRow } = await load;
  const row = invoiceRequestRow(work({ summary: '고객 계산서 부탁', payload: {} }));
  assert.equal(row.item, null); assert.equal(row.canIssue, false); assert.deepEqual(row.tradeIds, []);
});
test('verified invoice stays in issued history; manually completed work alone is not issuance evidence', async () => {
  const { invoiceRequestRow, invoiceRequestSummary } = await load;
  const ready = invoiceRequestRow(work(), snapshot);
  const closed = invoiceRequestRow(work({ state: 'resolved' }), snapshot);
  const issued = invoiceRequestRow(work({ state: 'resolved' }), { ...snapshot, status: 'issued', canIssue: false });
  assert.equal(closed.canIssue, false); assert.equal(closed.status, 'needs_info');
  assert.equal(issued.status, 'issued'); assert.deepEqual(invoiceRequestSummary([ready, closed, issued]), { total: 3, pending: 1, ready: 1, needsInfo: 0, issued: 1 });
  assert.match(ready.conversationUrl, /\/chats\/12345$/);
});
test('manual linkage survives refresh and verified issuance evidence controls completed history', async () => {
  const { invoiceWorkReferences } = await load;
  const draft = invoiceWorkReferences(work({ resolution_evidence: { invoiceDraft: { tradeId: '261102-002', buyer: { corpNum: '9999999999' } } } }));
  assert.deepEqual(draft.ids, ['261102-002']); assert.equal(draft.buyer.corpNum, '9999999999');
  const issued = invoiceWorkReferences(work({ state: 'resolved', resolution_evidence: { invoiceDraft: { tradeId: '261102-002' }, taxInvoice: { tradeId: '261102-003', mgtKey: 'issued-key', amount: 43890 } } }));
  assert.deepEqual(issued.ids, ['261102-003']); assert.equal(issued.expectedAmount, 43890);
});
