'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm');
const path = require('node:path'), crypto = require('node:crypto'), zlib = require('node:zlib');
const prefix = 'inventorySemantic_v1_';
function harness(options = {}) {
  const values = { API_SECRET: 'never-return-secret', durableReceipt: '{"pending":"never-remove"}' };
  const snapshot = { sets: [], equipment: [{ id: 'E1', name: 'private equipment' }], schedules: [], sourceIssues: [] };
  const blob = (value) => ({ getBytes: () => [...Buffer.from(value)], getDataAsString: () => Buffer.from(value).toString('utf8') });
  const c = { Utilities: {
    newBlob: (value) => blob(value), gzip: (value) => blob(zlib.gzipSync(Buffer.from(value.getBytes()))),
    ungzip: (value) => blob(zlib.gunzipSync(Buffer.from(value.getBytes()))), base64Encode: (value) => Buffer.from(value).toString('base64')
  }, PropertiesService: { getScriptProperties: () => ({
    getProperties: () => ({ ...values }), getProperty: (key) => values[key] ?? null,
    setProperty: () => assert.fail('audit cannot write Script Properties'), deleteProperty: () => assert.fail('audit cannot delete Script Properties')
  }) }, inventoryRiskDigest_: (value) => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex'),
  readInventoryRiskSnapshot_: () => { if (options.failSnapshot) throw Error('private connection detail'); return snapshot; } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../inventorySemanticReview.js'), 'utf8'), c);
  function add(kind, i) {
    const set = { name: 'private set ' + i, components: [{ name: 'private component ' + i, quantity: 1, tracked: true }] };
    snapshot.sets.push(set);
    const scope = c.inventorySemanticScopes_({ sets: [set] })[0];
    const review = { ...scope, disposition: 'stock', allocations: [{ equipmentId: 'E1', equipmentName: 'private equipment', quantity: 1 }],
      reason: 'private evidence '.repeat(50), decidedBy: 'native_ai', reviewedAt: '2026-09-14T00:49:47.000Z' };
    if (kind === 'source_changed') review.sourceHash = 'old';
    if (kind === 'equipment_identity_changed') review.allocations[0].equipmentName = 'previous identity';
    if (kind === 'missing_scope') snapshot.sets.pop();
    if (kind === 'ambiguous_scope') set.components.push({ ...set.components[0], quantity: 2 });
    values[c.inventorySemanticKey_(review)] = kind === 'invalid_record' ? 'invalid-json' : JSON.stringify(review);
  }
  return { c, values, snapshot, add };
}

test('semantic audit classifies active and ignored decisions without exposing evidence or changing any property', () => {
  const h = harness();
  ['active', 'source_changed', 'equipment_identity_changed', 'missing_scope', 'ambiguous_scope', 'invalid_record'].forEach((kind, i) => h.add(kind, i));
  const before = { ...h.values }, result = h.c.auditInventorySemanticStorage();
  assert.equal(result.mode, 'read_only');
  assert.equal(result.sourceComplete, true);
  assert.equal(result.records.count, 6);
  for (const kind of ['active', 'source_changed', 'equipment_identity_changed', 'missing_scope', 'ambiguous_scope', 'invalid_record']) assert.equal(result.classifications[kind].count, 1);
  assert.equal(result.reviewedAtDays['2026-09-14'].count, 5);
  assert.equal(result.records.valueBytes, Object.entries(before).filter(([key]) => key.startsWith(prefix)).reduce((n, [, value]) => n + Buffer.byteLength(value), 0));
  assert.equal(result.otherProperties.count, 2);
  assert.equal(result.otherProperties.changedDuringRead, 0);
  assert.equal(result.deletionCandidates, 0, 'stale AI evidence is not automatically disposable');
  assert.deepEqual(h.values, before);
  for (const text of ['private', 'never-return', 'never-remove', 'previous identity', 'E1']) assert.ok(!JSON.stringify(result).includes(text));
});

test('gzip estimates prove lossless round-trip and shared reason duplication without writing encoded records', () => {
  const h = harness();h.add('active', 1);h.add('active', 2);
  const before = { ...h.values }, result = h.c.auditInventorySemanticStorage();
  assert.equal(result.compression.roundTripVerifiedCount, 2);
  assert.equal(result.compression.failedCount, 0);
  assert.equal(result.compression.encoding, 'gzip_base64');
  assert.equal(result.compression.excludesStorageEnvelope, true);
  assert.equal(result.compression.individualSourceBytes, result.records.valueBytes);
  assert.equal(result.compression.individualSavedBytes, result.records.valueBytes - result.compression.individualBase64Bytes);
  assert.equal(result.compression.bundleInputBytes, Buffer.byteLength(JSON.stringify(Object.fromEntries(Object.entries(before).filter(([key]) => key.startsWith(prefix))))));
  assert.equal(result.compression.bundleSavedBytes, result.records.valueBytes - result.compression.bundleBase64Bytes);
  assert.ok(result.compression.individualSavedBytes > 0);
  assert.ok(result.compression.bundleSavedBytes > 0);
  assert.equal(result.reasonDuplication.distinctCount, 1);
  assert.equal(result.reasonDuplication.repeatedBytes, Buffer.byteLength('private evidence '.repeat(50)));
  assert.deepEqual(h.values, before);
});

for (const failure of ['snapshot', 'sourceIssues']) test('incomplete sources never classify stored decisions as safe to expire: ' + failure, () => {
  const h = harness({ failSnapshot: failure === 'snapshot' });h.add('active', 1);
  if (failure === 'sourceIssues') h.snapshot.sourceIssues.push('private auxiliary lookup failure');
  const result = h.c.auditInventorySemanticStorage();
  assert.equal(result.sourceComplete, false);
  assert.equal(result.classifications.source_unavailable.count, 1);
  assert.equal(result.classifications.active.count, 0);
  assert.equal(result.deletionCandidates, 0);
  assert.ok(!JSON.stringify(result).includes('private'));
});

test('runFunction exposes only the metadata audit entry point under the existing internal run route', () => {
  const h = harness();h.add('active', 1);
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../sheetAPI.js'), 'utf8'), h.c);
  const result = h.c.runFunction('auditInventorySemanticStorage', {});
  assert.equal(result.success, true);
  assert.equal(result.result.mode, 'read_only');
  assert.equal(result.result.records.count, 1);
});
