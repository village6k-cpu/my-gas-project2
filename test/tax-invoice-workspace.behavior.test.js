const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const crypto = require('node:crypto');
const source = fs.readFileSync(require.resolve('../taxInvoiceWorkspace.js'), 'utf8');
const clone = x => JSON.parse(JSON.stringify(x));
const buyer = ['123-45-67890', '빌리지 고객사', '대표자', 'invoice@example.com', '서울', '서비스', '영상'];
const ledger = () => ['2026-11-02', '고객', '', '', '261102-001', '01012345678', buyer[1], buyer[0], '43,890', '계좌이체(VAT포함)', '세금계산서', '미발행', '미입금', '', ''];
const contract = () => ['261102-001', '고객', '', '', '2026-11-02 10:00', '2026-11-03 00:00', '', '', '', '예약'];
function harness(options = {}) {
  const rows = options.rows || [ledger()], contracts = options.contracts || [contract()], master = options.buyers || [buyer];
  const props = new Map(), calls = []; let writes = 0;
  const sheet = values => ({ getLastRow: () => values.length + 1, getRange: (r, c, n, width) => ({ getDisplayValues: () => values.slice(r - 2, r - 2 + n).map(row => row.slice(c - 1, c - 1 + width)) }) });
  const parent = { getSheetByName: name => { assert.equal(name, '발행처DB'); return sheet(master); } };
  const financial = { ...sheet(rows), getParent: () => parent };
  const context = vm.createContext({ Date, Number, JSON, getVillageTradeSheet_: () => financial,
    SpreadsheetApp: { getActiveSpreadsheet: () => ({ getSheetByName: name => { assert.equal(name, '계약마스터'); return sheet(contracts); } }) },
    PropertiesService: { getScriptProperties: () => ({ getProperty: k => props.get(k) || null, setProperty: (k, v) => { writes++; props.set(k, v); }, deleteProperty: k => { writes++; props.delete(k); } }) },
    LockService: { getScriptLock: () => ({ tryLock: () => !options.busy, releaseLock() {} }) },
    Utilities: { DigestAlgorithm: { SHA_256: 'sha256' }, Charset: { UTF_8: 'utf8' }, computeDigest: (_, value) => [...crypto.createHash('sha256').update(value).digest()] },
    requestDirectTaxInvoice(tid, payload) {
      calls.push(clone(payload));
      assert.equal(context.invoiceWorkspaceIssueGuard_(tid, payload.invoiceWorkspaceToken), null);
      if (options.unknown) throw Error('network timeout');
      if (options.postMismatch) { rows[0][8] = '55,000'; return { status: 'OK' }; }
      const b = [payload.invoiceeCorpNum, payload.invoiceeCorpName, payload.invoiceeCEOName, payload.invoiceeEmail, payload.invoiceeAddr, payload.invoiceeBizType, payload.invoiceeBizClass];
      if (!master.some(row => String(row[0]).replace(/\D/g, '') === b[0])) master.push(b);
      rows[0][6] = b[1]; rows[0][7] = b[0]; rows[0][10] = '세금계산서'; rows[0][11] = '발행완료'; rows[0][14] = 'PROVIDER-ISSUED-1';
      return { status: 'OK', success: true };
    },
  });
  vm.runInContext(source, context);
  const read = (options = {}) => clone(context.getTaxInvoiceWorkspace_(['261102-001'], options)).items[0];
  const request = snapshot => ({ tradeId: snapshot.tradeId, fingerprint: snapshot.fingerprint, buyer: snapshot.buyer, mutationId: 'a'.repeat(64), dryRun: false });
  return { context, rows, contracts, master, read, request, calls, props, get writes() { return writes; } };
}
test('canonical finance amount and buyer produce ready snapshot with exact VAT split', () => {
  const h = harness(), r = h.read();
  assert.equal(r.canIssue, true); assert.equal(r.amount, 43890); assert.equal(r.tax, 3990); assert.equal(r.supplyCost, 39900);
  assert.equal(r.purposeType, '청구'); assert.equal(r.buyer.corpNum, '1234567890'); assert.equal(h.writes, 0);
});
test('dry run issues nothing, writes nothing, and verifies the displayed snapshot', () => {
  const h = harness(), r = h.read(); const result = h.context.issueTaxInvoiceWorkspace_({ ...h.request(r), dryRun: true });
  assert.equal(result.success, true); assert.equal(result.dryRun, true); assert.equal(h.calls.length, 0); assert.equal(h.writes, 0);
});
test('one click issues once, reads actual management key and keeps original financial amount', () => {
  const h = harness(), r = h.read(), body = h.request(r);
  const out = h.context.issueTaxInvoiceWorkspace_(body);
  assert.equal(out.success, true); assert.equal(out.item.status, 'issued'); assert.equal(out.item.mgtKey, 'PROVIDER-ISSUED-1');
  assert.equal(h.calls[0].amount, 43890); assert.equal(h.calls[0].invoiceeEmail, 'invoice@example.com');
  assert.equal(h.context.issueTaxInvoiceWorkspace_(body).alreadyIssued, true); assert.equal(h.calls.length, 1);
});
test('changed finance amount or business master invalidates the displayed fingerprint', () => {
  for (const change of [h => { h.rows[0][8] = '44,000'; }, h => { h.master[0][4] = '부산'; }]) {
    const h = harness({ buyers: [clone(buyer)] }), before = h.read(); change(h);
    assert.equal(h.context.issueTaxInvoiceWorkspace_(h.request(before)).success, false); assert.equal(h.calls.length, 0);
  }
});
test('missing and duplicate identities, unknown amount and cancelled contract block issuance', () => {
  const fixtures = [
    { buyers: [] }, { rows: [ledger(), ledger()] }, { contracts: [contract(), contract()] },
    { rows: [Object.assign(ledger(), { 8: '' })] }, { contracts: [Object.assign(contract(), { 9: '취소' })] },
    { buyers: [Object.assign(clone(buyer), { 3: 'not-an-email' })] }, { buyers: [buyer, buyer] },
    { rows: [Object.assign(ledger(), { 10: '현금영수증(전화번호)' })] },
  ];
  for (const fixture of fixtures) { const h = harness(fixture), r = h.read(); assert.equal(r.canIssue, false); assert.equal(h.context.issueTaxInvoiceWorkspace_(h.request(r)).success, false); assert.equal(h.calls.length, 0); }
});
test('unknown provider outcome blocks replay with a new mutation ID and older issuing UI', () => {
  const h = harness({ unknown: true }), r = h.read();
  assert.equal(h.context.issueTaxInvoiceWorkspace_(h.request(r)).outcomeUnknown, true);
  assert.equal(h.read().canIssue, false); assert.equal(h.context.invoiceWorkspaceIssueGuard_(r.tradeId, '').outcomeUnknown, true);
  assert.equal(h.context.issueTaxInvoiceWorkspace_({ ...h.request(r), mutationId: 'b'.repeat(64) }).success, false); assert.equal(h.calls.length, 1);
});
test('positive provider response without matching persisted invoice is not completion', () => {
  const h = harness({ postMismatch: true }), r = h.read();
  assert.equal(h.context.issueTaxInvoiceWorkspace_(h.request(r)).outcomeUnknown, true); assert.equal(h.calls.length, 1);
});
test('new buyer can be previewed and issued, existing buyer cannot be silently overwritten', () => {
  const h = harness({ buyers: [clone(buyer)] });
  const existing = h.read().buyer;
  assert.equal(h.read({ buyer: { ...existing, email: 'another@example.com' } }).canIssue, false);
  const fresh = { ...existing, corpNum: '9999999999', corpName: '새 발행처' };
  const preview = h.read({ buyer: fresh }); assert.equal(preview.canIssue, true);
  assert.equal(h.context.issueTaxInvoiceWorkspace_(h.request(preview)).success, true);
});
test('selecting another saved buyer uses the same fingerprint at preview and issuance', () => {
  const h = harness({ buyers: [clone(buyer), ['9999999999', '다른 회사', '대표', 'other@example.com', '', '', '']] });
  const preview = h.read({ buyerId: '9999999999' }); assert.equal(preview.canIssue, true);
  assert.equal(h.context.issueTaxInvoiceWorkspace_(h.request(preview)).success, true);
});
test('an already-issued invoice cannot complete a request for a different recipient', () => {
  const h = harness(), r = h.read(); h.context.issueTaxInvoiceWorkspace_(h.request(r));
  const result = h.context.issueTaxInvoiceWorkspace_({ ...h.request(r), buyer: { ...r.buyer, email: 'different@example.com' } });
  assert.equal(result.success, false); assert.match(result.error, /수신처|발행처/); assert.equal(h.calls.length, 1);
});
test('an invoice issued elsewhere at a changed amount cannot acknowledge an old preview', () => {
  const h = harness(), before = h.read(); h.rows[0][8] = '55,000'; h.rows[0][11] = '발행완료'; h.rows[0][14] = 'OTHER-ISSUE';
  const out = h.context.issueTaxInvoiceWorkspace_({ ...h.request(before), dryRun: true });
  assert.equal(out.success, false); assert.equal(out.alreadyIssued, true); assert.equal(h.calls.length, 0);
});
test('batch workspace keeps independently prepared buyer for each work and detects changed issued amount', () => {
  const h = harness({ buyers: [clone(buyer), ['9999999999', '다른 회사', '대표', 'other@example.com', '', '', '']] });
  const a = h.read(), b = h.read({ buyerId: '9999999999' });
  const result = h.context.getTaxInvoiceWorkspace_([a.tradeId], { targets: [{ key: 'A', tradeId: a.tradeId, buyer: a.buyer }, { key: 'B', tradeId: a.tradeId, buyer: b.buyer }] });
  assert.equal(result.items[0].buyer.corpNum, a.buyer.corpNum); assert.equal(result.items[1].buyer.corpNum, b.buyer.corpNum);
  h.context.issueTaxInvoiceWorkspace_(h.request(a));
  const after = h.context.getTaxInvoiceWorkspace_([a.tradeId], { targets: [{ key: 'A', tradeId: a.tradeId, expectedAmount: 55000 }, { key: 'B', tradeId: a.tradeId, buyer: b.buyer }] });
  assert.equal(after.items[0].status, 'needs_info'); assert.equal(after.items[1].status, 'needs_info');
});

