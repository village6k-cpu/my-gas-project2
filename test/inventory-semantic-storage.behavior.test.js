'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm');
const crypto = require('node:crypto'), zlib = require('node:zlib'), path = require('node:path');
const prefix = 'inventorySemantic_v1_', pointer = 'inventorySemanticStore_v1_manifest';
function harness() {
  const values = { GUIDE_DELIVERY_V3_out_1: '{"state":"unknown"}', CONFIG: 'private-config', VILLAGE_API_WRITE_KEY_V1: 'private-key' };
  const files = new Map(), events = [], flags = {}, snapshot = { sets: [{ name: 'kit', components: [{ name: 'part', quantity: 1, tracked: true }] }], equipment: [], sourceIssues: [] };
  let serial = 0, locked = false;
  const blob = value => ({ getBytes: () => [...Buffer.from(value)], getDataAsString: () => Buffer.from(value).toString('utf8') });
  const props = {
    getProperties: () => ({ ...values }), getProperty: key => values[key] ?? null,
    setProperty(key, value) {
      events.push(['set', key]);
      if (key === pointer && flags.pointerFail === 'before') throw Error('quota');
      values[key] = value;
      if (key === pointer && flags.pointerFail === 'after') throw Error('uncertain response');
    },
    deleteProperty(key) { events.push(['delete', key]);if (flags.deleteFail) throw Error('interrupted');delete values[key]; }
  };
  const c = { PropertiesService: { getScriptProperties: () => props }, Utilities: {
    DigestAlgorithm: { SHA_256: 'sha256' }, Charset: { UTF_8: 'utf8' },
    computeDigest: (_, text) => [...crypto.createHash('sha256').update(text).digest()], getUuid: () => 'generation-' + (++serial),
    newBlob: value => blob(value), gzip: value => blob(zlib.gzipSync(Buffer.from(value.getBytes()))), ungzip: value => blob(zlib.gunzipSync(Buffer.from(value.getBytes())))
  }, DriveApp: { Access: { PRIVATE: 'private' }, Permission: { NONE: 'none' },
    createFile(value) {
      events.push(['create']);if (flags.createFail) throw Error('Drive quota');
      const id = 'file-' + (++serial), state = { content: value, access: 'private', editors: [], viewers: [] };
      const file = { getId: () => id, setSharing(access) { state.access = flags.publicFile ? 'anyone' : access;return file; },
        getSharingAccess: () => state.access, getEditors: () => state.editors, getViewers: () => state.viewers,
        getBlob() { if (flags.corruptRead) return blob('not gzip');if (flags.changedPayload) return blob(zlib.gzipSync(Buffer.from('{"format":"changed"}')));return state.content; }, state };
      files.set(id, file);if (flags.duringCreate) flags.duringCreate();return file;
    }, getFileById(id) { events.push(['read', id]);if (flags.unavailable) throw Error('Drive unavailable');if (!files.has(id)) throw Error('missing file');return files.get(id); }
  }, LockService: { getScriptLock: () => ({ tryLock() { if (flags.busy) return false;assert.equal(locked, false);locked = true;return true; }, releaseLock() { locked = false; } }) },
  UrlFetchApp: { fetch(url, options) {
    events.push(['probe']);assert.match(url, /^https:\/\/script\.google\.com\/macros\/s\/.+\/exec$/);
    assert.ok(!url.includes('private-key'));const body = JSON.parse(options.payload);assert.equal(body.key, 'private-key');
    assert.equal(body.func, 'getInventorySemanticStorageStatus');assert.equal(body.action, 'run');
    const args = typeof body.args === 'string' ? JSON.parse(body.args) : body.args;
    const result = c.getInventorySemanticStorageStatus(args[0]);
    if (flags.oldPublic) result.readerBuild = 'old-public-804';
    if (flags.duringProbe) flags.duringProbe();
    return { getResponseCode: () => 200, getContentText: () => JSON.stringify({ success: true, result }) };
  } }, readInventoryRiskSnapshot_: () => snapshot,
  inventoryRiskDigest_: value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex') };
  vm.createContext(c);
  for (const name of ['inventoryRisk.js', 'inventorySemanticStorage.js', 'inventorySemanticReview.js']) {
    const file = path.join(__dirname, '..', name);if (fs.existsSync(file)) vm.runInContext(fs.readFileSync(file, 'utf8'), c);
  }
  function add(name = 'kit', extra = {}) {
    const review = { setName: name, componentName: 'part', sourceHash: 'original', disposition: 'included', allocations: [], reason: '한글 원문 evidence', reviewedAt: '2026-09-14T00:00:00Z', ...extra };
    const key = c.inventorySemanticKey_(review);values[key] = JSON.stringify(review);return { key, review, raw: values[key] };
  }
  function migrate() { const status = c.getInventorySemanticStorageStatus();return c.migrateInventorySemanticStorage({ execute: true, expectedSnapshotHash: status.snapshotHash }); }
  return { c, values, props, files, events, flags, add, migrate, snapshot, clearMemory: () => { c.INVENTORY_SEMANTIC_STORAGE_MEMORY_ = null; } };
}

test('legacy reader and dry run preserve raw evidence without Drive or property writes', () => {
  const h = harness(), a = h.add('old scope', { futureField: { evidence: 'retain' } }), before = { ...h.values };
  assert.equal(typeof h.c.inventorySemanticStorageRead_, 'function');
  assert.equal(h.c.inventorySemanticStorageRead_()[a.key], a.raw);
  const result = h.c.migrateInventorySemanticStorage({ execute: false });
  assert.equal(result.mode, 'legacy');assert.equal(result.recordCount, 1);assert.equal(h.files.size, 0);
  assert.deepEqual(h.values, before);assert.equal(h.events.length, 0);
});

test('migration preserves exact raw strings, unknown fields, inactive evidence and unrelated ledgers', () => {
  const h = harness(), a = h.add(), b = h.add('missing scope', { futureField: 'still durable' }), unrelated = h.values.GUIDE_DELIVERY_V3_out_1;
  const result = h.migrate();assert.equal(result.mode, 'drive');assert.equal(result.legacyCount, 0);
  assert.equal(h.files.size, 1);assert.equal(h.values.GUIDE_DELIVERY_V3_out_1, unrelated);
  const records = h.c.inventorySemanticStorageRead_();assert.equal(records[a.key], a.raw);assert.equal(records[b.key], b.raw);
  assert.ok(!JSON.stringify(result).includes('한글'));assert.ok(!JSON.stringify(result).includes('private-key'));
  const commit = h.events.findIndex(x => x[0] === 'set' && x[1] === pointer), cleanup = h.events.findIndex(x => x[0] === 'delete');
  assert.ok(commit > h.events.findIndex(x => x[0] === 'read'));assert.ok(cleanup > commit);
});

for (const failure of ['oldPublic', 'createFail', 'publicFile', 'corruptRead']) test('migration fails closed before changing authority: ' + failure, () => {
  const h = harness();h.add();const before = { ...h.values };h.flags[failure] = true;
  assert.throws(() => h.migrate(), /public reader|Drive quota|private|gzip|header/i);assert.deepEqual(h.values, before);assert.ok(!h.events.some(x => x[0] === 'delete'));
  if (failure === 'oldPublic') assert.equal(h.files.size, 0);
});

test('a source mutation after public probe fails the lock-time CAS without file creation', () => {
  const h = harness(), a = h.add();h.flags.duringProbe = () => { h.values[a.key] = a.raw + ' '; };
  assert.throws(() => h.migrate(), /changed|CAS/i);assert.equal(h.files.size, 0);assert.equal(h.values[pointer], undefined);
});

for (const when of ['before', 'after']) test('ambiguous manifest write reconciles exact durable readback: ' + when, () => {
  const h = harness(), a = h.add();h.flags.pointerFail = when;
  if (when === 'before') { assert.throws(() => h.migrate());assert.equal(h.values[a.key], a.raw);assert.equal(h.values[pointer], undefined); }
  else { assert.equal(h.migrate().mode, 'drive');assert.equal(h.c.inventorySemanticStorageRead_()[a.key], a.raw);assert.equal(h.values[a.key], undefined); }
  assert.equal(h.files.size, 1, 'uncommitted files remain available for explicit recovery');
});

test('interrupted legacy cleanup keeps verified Drive authority and safely resumes without another file', () => {
  const h = harness(), a = h.add();h.flags.deleteFail = true;assert.throws(() => h.migrate());
  assert.ok(h.values[pointer]);assert.equal(h.c.inventorySemanticStorageRead_()[a.key], a.raw);
  assert.throws(() => h.c.inventorySemanticStorageWrite_([a.review]), /migration|cleanup/i);
  h.flags.deleteFail = false;assert.equal(h.migrate().legacyCount, 0);assert.equal(h.files.size, 1);
});

test('active file corruption or loss never falls back to stale legacy evidence or an empty catalog', () => {
  const h = harness(), a = h.add();h.migrate();h.values[a.key] = a.raw;h.flags.unavailable = true;h.clearMemory();
  assert.throws(() => h.c.inventorySemanticStorageRead_(), /unavailable/i);
  h.flags.unavailable = false;h.flags.corruptRead = true;h.clearMemory();assert.throws(() => h.c.inventorySemanticStorageRead_());
});

test('valid gzip with changed content fails SHA verification and explicit sharing fails closed', () => {
  const h = harness();h.add();h.migrate();h.flags.changedPayload = true;h.clearMemory();
  assert.throws(() => h.c.inventorySemanticStorageRead_(), /hash/);
  h.flags.changedPayload = false;h.files.values().next().value.state.editors.push('unexpected-editor');h.clearMemory();
  assert.throws(() => h.c.inventorySemanticStorageRead_(), /private/);
});

test('copy-on-write commits a whole batch, retains the prior file and avoids no-op generations', () => {
  const h = harness(), a = h.add(), b = h.add('second');h.migrate();const old = h.values[pointer];
  h.c.inventorySemanticStorageWrite_([{ ...a.review, reason: 'updated together' }, { ...b.review, reason: 'updated together' }]);
  assert.notEqual(h.values[pointer], old);assert.equal(h.files.size, 2);
  const current = h.c.inventorySemanticStorageRead_();assert.equal(JSON.parse(current[a.key]).reason, 'updated together');assert.equal(JSON.parse(current[b.key]).reason, 'updated together');
  h.c.inventorySemanticStorageWrite_([{ ...a.review, reason: 'updated together' }, { ...b.review, reason: 'updated together' }]);assert.equal(h.files.size, 2);
  h.flags.pointerFail = 'before';assert.throws(() => h.c.inventorySemanticStorageWrite_([{ ...a.review, reason: 'not committed' }]));
  assert.equal(JSON.parse(h.c.inventorySemanticStorageRead_()[a.key]).reason, 'updated together');
});

test('existing semantic apply and reader use the Drive authority without reintroducing per-scope properties', () => {
  const h = harness();h.add();h.migrate();const scope = h.c.inventorySemanticScopes_(h.snapshot)[0];
  const result = h.c.applyInventorySemanticReview({ reason: 'all evidence retained', resolutions: [{ ...scope, disposition: 'included', allocations: [] }] });
  assert.equal(result.verified, true);assert.equal(Object.keys(h.values).filter(k => k.startsWith(prefix)).length, 0);
  h.c.inventoryApplySemanticReviews_(h.snapshot);assert.equal(h.snapshot.sets[0].components[0].tracked, false);
  assert.equal(h.snapshot.sets[0].components[0].semanticReview.reason, 'all evidence retained');
});

test('a missing adapter cannot fall back to legacy after activation', () => {
  const h = harness();h.add();h.migrate();h.c.inventorySemanticStorageRead_ = undefined;h.c.inventorySemanticStorageWrite_ = undefined;
  assert.throws(() => h.c.inventoryApplySemanticReviews_(h.snapshot), /reader|저장소/);
  const scope = h.c.inventorySemanticScopes_(h.snapshot)[0];
  assert.throws(() => h.c.applyInventorySemanticReview({ reason: 'retain', resolutions: [{ ...scope, disposition: 'included', allocations: [] }] }), /reader|저장소/);
});

test('storage status and migration are routed as internal run functions with their exact arguments', () => {
  const h = harness();h.add();vm.runInContext(fs.readFileSync(path.join(__dirname, '../sheetAPI.js'), 'utf8'), h.c);
  const status = h.c.runFunction('getInventorySemanticStorageStatus', { args: [{ nonce: 'caller-proof' }] });
  assert.equal(status.success, true);assert.equal(status.result.nonce, 'caller-proof');
  const dry = h.c.runFunction('migrateInventorySemanticStorage', { args: [{ execute: false }] });
  assert.equal(dry.success, true);assert.equal(dry.result.mode, 'legacy');assert.equal(h.files.size, 0);
});

test('legacy evidence changed during file creation cannot become the active snapshot', () => {
  const h = harness(), a = h.add();h.flags.duringCreate = () => { h.values[a.key] = a.raw + ' '; };
  assert.throws(() => h.migrate(), /CAS|changed/i);assert.equal(h.values[pointer], undefined);assert.equal(h.values[a.key], a.raw + ' ');
});

test('concurrent manifest replacement is retained, never overwritten or automatically restored', () => {
  const h = harness(), a = h.add();h.migrate();const external = h.values[pointer] + ' ';
  h.flags.duringCreate = () => { h.values[pointer] = external; };
  assert.throws(() => h.c.inventorySemanticStorageWrite_([{ ...a.review, reason: 'new' }]), /CAS|changed/i);
  assert.equal(h.values[pointer], external);assert.equal(h.files.size, 2);
});

test('metadata audit still counts all exact preserved evidence after migration', () => {
  const h = harness(), a = h.add(), b = h.add('inactive');h.migrate();
  const result = h.c.auditInventorySemanticStorage();
  assert.equal(result.records.count, 2);assert.equal(result.records.valueBytes, Buffer.byteLength(a.raw) + Buffer.byteLength(b.raw));
  assert.equal(result.storage.mode, 'drive');assert.equal(result.storage.legacyCount, 0);assert.equal(result.deletionCandidates, 0);
});

test('capacity probe dispatch forwards the explicit byte request without changing the generic auth route', () => {
  const h = harness();h.c.probeScriptPropertiesCapacity = bytes => ({ success: true, bytes });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../sheetAPI.js'), 'utf8'), h.c);
  const result = h.c.runFunction('probeScriptPropertiesCapacity', { args: [64] });
  assert.equal(result.success, true);assert.equal(result.result.bytes, 64);
});

test('public catalog credential cannot read storage metadata, probe capacity or execute migration', () => {
  const h = harness();h.add();vm.runInContext(fs.readFileSync(path.join(__dirname, '../sheetAPI.js'), 'utf8'), h.c);
  h.c.jsonResponse = (body, status) => ({ body, status });
  for (const func of ['getInventorySemanticStorageStatus', 'migrateInventorySemanticStorage', 'probeScriptPropertiesCapacity']) {
    const result = h.c.handleRequestCore_({ parameter: {}, postData: { contents: JSON.stringify({ key: 'village2026', action: 'run', func, args: [{ execute: true }] }) } });
    assert.equal(result.status, 403);assert.equal(result.body.error, 'internal credential required');
  }
  assert.equal(h.files.size, 0);assert.equal(h.events.length, 0);
});
