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

const proofKey = 'inventorySemanticStore_v1_bootstrap';
function bootstrapHarness() {
  const h = harness(), documents = {}, documentEvents = [];
  h.c.PropertiesService.getDocumentProperties = () => ({
    getProperty: key => documents[key] ?? null,
    setProperty(key, value) {
      documentEvents.push(['set', key]);
      h.events.push(['doc-set', key]);
      if (key === proofKey && h.flags.fileCheckpointFail && JSON.parse(value).phase === 'creating' && JSON.parse(value).fileId) throw Error('interrupted file checkpoint');
      if (key === proofKey && h.flags.stagedProofFail && JSON.parse(value).phase === 'staged') throw Error('interrupted staged checkpoint');
      if (key === pointer && h.flags.docPointerFail === 'before') throw Error('document write failed');
      documents[key] = value;
      if (key === pointer && h.flags.docPointerFail === 'after') throw Error('uncertain document response');
    }
  });
  h.c.ScriptApp = { EventType: { CLOCK: 'clock' }, getProjectTriggers: () => [{
    getUniqueId: () => 'real-installed-clock', getHandlerFunction: () => 'inventoryRiskHeartbeat', getEventType: () => 'clock'
  }] };
  const fetch = h.c.UrlFetchApp.fetch;
  h.c.UrlFetchApp.fetch = (url, options) => {
    const original = h.c.PropertiesService.getDocumentProperties;
    if (h.flags.hidePublicManifest && documents[pointer]) h.c.PropertiesService.getDocumentProperties = () => ({ getProperty: () => null });
    try { return fetch(url, options); } finally { h.c.PropertiesService.getDocumentProperties = original; }
  };
  const stage = extra => h.c.migrateInventorySemanticStorage({ execute: true, phase: 'stage', targetStore: 'document',
    expectedSnapshotHash: h.c.getInventorySemanticStorageStatus().snapshotHash, ...extra });
  const observe = event => h.c.inventorySemanticStorageObserveTrigger_(event || { triggerUid: 'real-installed-clock' });
  const finalize = extra => { const s = h.c.getInventorySemanticStorageStatus();return h.c.migrateInventorySemanticStorage({
    execute: true, phase: 'finalize', targetStore: 'document', expectedSnapshotHash: s.snapshotHash, expectedManifestHash: s.manifestHash, ...extra }); };
  return { ...h, documents, documentEvents, stage, observe, finalize, migrate: () => { stage();observe();return finalize(); } };
}

test('document bootstrap stages complete raw evidence under full ScriptProperties without deleting legacy', () => {
  const h = bootstrapHarness(), a = h.add('inactive', { future: { raw: 'keep every field' } }), before = { ...h.values };
  h.props.setProperty = () => { throw Error('ScriptProperties full'); };const status = h.stage();
  assert.equal(status.manifestStore, 'document');assert.equal(status.bootstrapPhase, 'staged');
  assert.equal(h.documents[pointer] !== undefined, true);assert.equal(h.values[pointer], undefined);
  assert.deepEqual(h.values, before);assert.equal(h.c.inventorySemanticStorageRead_()[a.key], a.raw);
  assert.equal(h.files.size, 1);assert.equal(h.stage().manifestHash, status.manifestHash);assert.equal(h.files.size, 1);
  assert.ok(!h.events.some(e => e[0] === 'delete'));
});

test('finalization requires actual current-generation public and installed clock observations', () => {
  const h = bootstrapHarness(), a = h.add();h.stage();
  assert.throws(() => h.finalize(), /trigger|관측/);
  h.observe({});h.observe({ triggerUid: 'manual-or-other' });
  assert.throws(() => h.finalize(), /trigger|관측/);assert.equal(h.values[a.key], a.raw);
  h.observe();h.flags.oldPublic = true;assert.throws(() => h.finalize(), /public reader/);assert.equal(h.values[a.key], a.raw);
  h.flags.oldPublic = false;const status = h.finalize();assert.equal(status.legacyCount, 0);assert.equal(status.bootstrapPhase, 'active');
  assert.equal(h.c.inventorySemanticStorageRead_()[a.key], a.raw);assert.equal(h.files.size, 1);
});

test('old public 804 prevents even a stage intent or file from being created', () => {
  const h = bootstrapHarness();h.add();h.flags.oldPublic = true;
  assert.throws(() => h.stage(), /public reader/);assert.equal(h.files.size, 0);assert.deepEqual(h.documents, {});
});

test('uncertain document pointer writes resume the verified same generation without duplicate files', () => {
  const h = bootstrapHarness(), a = h.add();h.flags.docPointerFail = 'before';
  assert.throws(() => h.stage());assert.equal(h.files.size, 1);assert.equal(h.values[a.key], a.raw);
  h.flags.docPointerFail = undefined;h.stage();assert.equal(h.files.size, 1);h.observe();h.finalize();assert.equal(h.files.size, 1);
});

test('unknown create outcome is never retried automatically and explicit file reconciliation verifies hashes', () => {
  const h = bootstrapHarness();h.add();h.flags.createFail = true;assert.throws(() => h.stage());
  h.flags.createFail = false;assert.throws(() => h.stage(), /uncertain|불확실|fileId/);assert.equal(h.files.size, 0);
  assert.throws(() => h.stage({ resumeFileId: 'unrelated-file' }), /missing|검증|file/i);assert.equal(h.files.size, 0);
});

test('conflicting Script and Document pointers fail closed without choosing one authority', () => {
  const h = bootstrapHarness();h.add();h.stage();h.values[pointer] = h.documents[pointer].replace(/file-\d+/, 'different-file');
  assert.throws(() => h.c.inventorySemanticStorageRead_(), /conflict|충돌/);
  assert.throws(() => h.finalize(), /conflict|충돌/);assert.ok(!h.events.some(e => e[0] === 'delete'));
});

test('trigger observation cannot prove a different generation or suppress monitor execution', () => {
  const h = bootstrapHarness();h.add();h.stage();h.observe();
  const proof = JSON.parse(h.documents[proofKey]);proof.triggerObservation.snapshotHash = 'a'.repeat(64);h.documents[proofKey] = JSON.stringify(proof);
  assert.throws(() => h.finalize(), /trigger|관측/);
  h.c.inventorySemanticStorageObserveTrigger_ = () => { throw Error('optional observation unavailable'); };
  h.c.recordInventoryPropertyCapacityDiagnostic_ = () => {};
  let pre = 0, flush = 0;h.c.flushPreRegistrationStockAlerts = () => { pre++; };h.c.flushInventoryRiskAlerts = () => { flush++;return 'same-result'; };
  const code = fs.readFileSync(path.join(__dirname, '../inventoryRiskDelivery.js'), 'utf8');
  vm.runInContext(code.slice(code.indexOf('function inventoryRiskHeartbeat('), code.indexOf('function requestInventoryRiskScan_(')), h.c);
  assert.equal(h.c.inventoryRiskHeartbeat({ triggerUid: 'real-installed-clock' }), 'same-result');assert.equal(pre, 1);assert.equal(flush, 1);
});

test('stage checks the public reader against the actual staged pointer, not just legacy metadata', () => {
  const h = bootstrapHarness(), a = h.add();h.flags.hidePublicManifest = true;
  assert.throws(() => h.stage(), /public reader/);assert.equal(h.values[a.key], a.raw);assert.equal(h.files.size, 1);
  h.flags.hidePublicManifest = false;h.stage();assert.equal(h.files.size, 1);
});

test('pointer-written but stage-checkpoint interruption resumes the same file and proof', () => {
  const h = bootstrapHarness(), a = h.add();h.flags.stagedProofFail = true;
  assert.throws(() => h.stage());assert.ok(h.documents[pointer]);assert.equal(h.values[a.key], a.raw);
  h.flags.stagedProofFail = false;assert.equal(h.stage().bootstrapPhase, 'staged');assert.equal(h.files.size, 1);
  h.observe();assert.equal(h.finalize().legacyCount, 0);
});

test('explicit orphan reconciliation checkpoints its file before pointer activation and survives another interruption', () => {
  const h = bootstrapHarness(), a = h.add();h.flags.fileCheckpointFail = true;
  assert.throws(() => h.stage());assert.equal(h.files.size, 1);assert.equal(JSON.parse(h.documents[proofKey]).fileId, undefined);
  h.flags.fileCheckpointFail = false;h.flags.stagedProofFail = true;
  assert.throws(() => h.stage({ resumeFileId: [...h.files.keys()][0] }));assert.ok(h.documents[pointer]);
  h.flags.stagedProofFail = false;assert.equal(h.stage().bootstrapPhase, 'staged');
  assert.equal(h.files.size, 1);assert.equal(h.values[a.key], a.raw);h.observe();assert.equal(h.finalize().legacyCount, 0);
});

test('ordinary legacy and active heartbeats skip migration lock, whole-store reads and Drive while preserving monitor work', () => {
  for (const active of [false, true]) {
    const h = bootstrapHarness();h.add();if (active) h.migrate();
    h.props.getProperties = () => { assert.fail('ordinary heartbeat must not read all ScriptProperties for migration'); };
    h.c.DriveApp.getFileById = () => { assert.fail('ordinary heartbeat must not read Drive for migration'); };
    h.c.LockService.getScriptLock = () => { assert.fail('ordinary heartbeat must not take migration lock'); };
    h.c.ScriptApp.getProjectTriggers = () => { assert.fail('ordinary heartbeat must not list triggers for migration'); };
    h.c.recordInventoryPropertyCapacityDiagnostic_ = () => {};
    let pre = 0, flush = 0;h.c.flushPreRegistrationStockAlerts = () => { pre++; };h.c.flushInventoryRiskAlerts = () => { flush++;return 'same-result'; };
    const code = fs.readFileSync(path.join(__dirname, '../inventoryRiskDelivery.js'), 'utf8');
    vm.runInContext(code.slice(code.indexOf('function inventoryRiskHeartbeat('), code.indexOf('function requestInventoryRiskScan_(')), h.c);
    // Direct observer invocation also ensures the heartbeat's fail-open wrapper cannot conceal an unnecessary read.
    h.observe();assert.equal(h.c.inventoryRiskHeartbeat({ triggerUid: 'real-installed-clock' }), 'same-result');
    assert.equal(pre, 1);assert.equal(flush, 1);
  }
});

test('a genuine staged trigger replaces obsolete build or trigger identity proof', () => {
  const h = bootstrapHarness();h.add();h.stage();h.observe();
  const proof = JSON.parse(h.documents[proofKey]);proof.triggerObservation.readerBuild = 'old-build';
  proof.triggerObservation.triggerUid = 'removed-clock';h.documents[proofKey] = JSON.stringify(proof);
  assert.throws(() => h.finalize(), /trigger|관측/);h.observe();assert.equal(h.finalize().bootstrapPhase, 'active');
});

test('existing Script manifest remains readable and writable without a Document pointer', () => {
  const h = bootstrapHarness(), a = h.add();h.migrate();
  h.values[pointer] = h.documents[pointer];delete h.documents[pointer];delete h.documents[proofKey];
  assert.equal(h.c.getInventorySemanticStorageStatus().manifestStore, 'script');
  h.c.inventorySemanticStorageWrite_([{ ...a.review, futureRawField: 'kept in existing script-backed authority' }]);
  assert.equal(JSON.parse(h.c.inventorySemanticStorageRead_()[a.key]).futureRawField, 'kept in existing script-backed authority');
  assert.equal(h.documents[pointer], undefined);
});

test('legacy reader and dry run preserve raw evidence without Drive or property writes', () => {
  const h = bootstrapHarness(), a = h.add('old scope', { futureField: { evidence: 'retain' } }), before = { ...h.values };
  assert.equal(typeof h.c.inventorySemanticStorageRead_, 'function');
  assert.equal(h.c.inventorySemanticStorageRead_()[a.key], a.raw);
  const result = h.c.migrateInventorySemanticStorage({ execute: false });
  assert.equal(result.mode, 'legacy');assert.equal(result.recordCount, 1);assert.equal(h.files.size, 0);
  assert.deepEqual(h.values, before);assert.equal(h.events.length, 0);
});

test('migration preserves exact raw strings, unknown fields, inactive evidence and unrelated ledgers', () => {
  const h = bootstrapHarness(), a = h.add(), b = h.add('missing scope', { futureField: 'still durable' }), unrelated = h.values.GUIDE_DELIVERY_V3_out_1;
  const result = h.migrate();assert.equal(result.mode, 'drive');assert.equal(result.legacyCount, 0);
  assert.equal(h.files.size, 1);assert.equal(h.values.GUIDE_DELIVERY_V3_out_1, unrelated);
  const records = h.c.inventorySemanticStorageRead_();assert.equal(records[a.key], a.raw);assert.equal(records[b.key], b.raw);
  assert.ok(!JSON.stringify(result).includes('한글'));assert.ok(!JSON.stringify(result).includes('private-key'));
  const commit = h.events.findIndex(x => x[0] === 'doc-set' && x[1] === pointer), cleanup = h.events.findIndex(x => x[0] === 'delete');
  assert.ok(commit > h.events.findIndex(x => x[0] === 'read'));assert.ok(cleanup > commit);
});

for (const failure of ['oldPublic', 'createFail', 'publicFile', 'corruptRead']) test('migration fails closed before changing authority: ' + failure, () => {
  const h = bootstrapHarness();h.add();const before = { ...h.values };h.flags[failure] = true;
  assert.throws(() => h.migrate(), /public reader|Drive quota|private|gzip|header/i);assert.deepEqual(h.values, before);assert.ok(!h.events.some(x => x[0] === 'delete'));
  if (failure === 'oldPublic') assert.equal(h.files.size, 0);
});

test('a source mutation after public probe fails the lock-time CAS without file creation', () => {
  const h = bootstrapHarness(), a = h.add();h.flags.duringProbe = () => { h.values[a.key] = a.raw + ' '; };
  assert.throws(() => h.migrate(), /changed|CAS/i);assert.equal(h.files.size, 0);assert.equal(h.documents[pointer], undefined);
});

for (const when of ['before', 'after']) test('ambiguous manifest write reconciles exact durable readback: ' + when, () => {
  const h = bootstrapHarness(), a = h.add();h.flags.docPointerFail = when;
  if (when === 'before') { assert.throws(() => h.migrate());assert.equal(h.values[a.key], a.raw);assert.equal(h.documents[pointer], undefined); }
  else { assert.equal(h.migrate().mode, 'drive');assert.equal(h.c.inventorySemanticStorageRead_()[a.key], a.raw);assert.equal(h.values[a.key], undefined); }
  assert.equal(h.files.size, 1, 'uncommitted files remain available for explicit recovery');
});

test('interrupted legacy cleanup keeps verified Drive authority and safely resumes without another file', () => {
  const h = bootstrapHarness(), a = h.add();h.flags.deleteFail = true;assert.throws(() => h.migrate());
  assert.ok(h.documents[pointer]);assert.equal(h.c.inventorySemanticStorageRead_()[a.key], a.raw);
  assert.throws(() => h.c.inventorySemanticStorageWrite_([a.review]), /migration|cleanup/i);
  h.flags.deleteFail = false;assert.equal(h.migrate().legacyCount, 0);assert.equal(h.files.size, 1);
});

test('active file corruption or loss never falls back to stale legacy evidence or an empty catalog', () => {
  const h = bootstrapHarness(), a = h.add();h.migrate();h.values[a.key] = a.raw;h.flags.unavailable = true;h.clearMemory();
  assert.throws(() => h.c.inventorySemanticStorageRead_(), /unavailable/i);
  h.flags.unavailable = false;h.flags.corruptRead = true;h.clearMemory();assert.throws(() => h.c.inventorySemanticStorageRead_());
});

test('valid gzip with changed content fails SHA verification and explicit sharing fails closed', () => {
  const h = bootstrapHarness();h.add();h.migrate();h.flags.changedPayload = true;h.clearMemory();
  assert.throws(() => h.c.inventorySemanticStorageRead_(), /hash/);
  h.flags.changedPayload = false;h.files.values().next().value.state.editors.push('unexpected-editor');h.clearMemory();
  assert.throws(() => h.c.inventorySemanticStorageRead_(), /private/);
});

test('copy-on-write commits a whole batch, retains the prior file and avoids no-op generations', () => {
  const h = bootstrapHarness(), a = h.add(), b = h.add('second');h.migrate();const old = h.documents[pointer];
  h.c.inventorySemanticStorageWrite_([{ ...a.review, reason: 'updated together' }, { ...b.review, reason: 'updated together' }]);
  assert.notEqual(h.documents[pointer], old);assert.equal(h.files.size, 2);
  const current = h.c.inventorySemanticStorageRead_();assert.equal(JSON.parse(current[a.key]).reason, 'updated together');assert.equal(JSON.parse(current[b.key]).reason, 'updated together');
  h.c.inventorySemanticStorageWrite_([{ ...a.review, reason: 'updated together' }, { ...b.review, reason: 'updated together' }]);assert.equal(h.files.size, 2);
  h.flags.docPointerFail = 'before';assert.throws(() => h.c.inventorySemanticStorageWrite_([{ ...a.review, reason: 'not committed' }]));
  assert.equal(JSON.parse(h.c.inventorySemanticStorageRead_()[a.key]).reason, 'updated together');
});

test('existing semantic apply and reader use the Drive authority without reintroducing per-scope properties', () => {
  const h = bootstrapHarness();h.add();h.migrate();const scope = h.c.inventorySemanticScopes_(h.snapshot)[0];
  const result = h.c.applyInventorySemanticReview({ reason: 'all evidence retained', resolutions: [{ ...scope, disposition: 'included', allocations: [] }] });
  assert.equal(result.verified, true);assert.equal(Object.keys(h.values).filter(k => k.startsWith(prefix)).length, 0);
  h.c.inventoryApplySemanticReviews_(h.snapshot);assert.equal(h.snapshot.sets[0].components[0].tracked, false);
  assert.equal(h.snapshot.sets[0].components[0].semanticReview.reason, 'all evidence retained');
});

test('a missing adapter cannot fall back to legacy after activation', () => {
  const h = bootstrapHarness();h.add();h.migrate();h.c.inventorySemanticStorageRead_ = undefined;h.c.inventorySemanticStorageWrite_ = undefined;
  assert.throws(() => h.c.inventoryApplySemanticReviews_(h.snapshot), /reader|저장소/);
  const scope = h.c.inventorySemanticScopes_(h.snapshot)[0];
  assert.throws(() => h.c.applyInventorySemanticReview({ reason: 'retain', resolutions: [{ ...scope, disposition: 'included', allocations: [] }] }), /reader|저장소/);
});

test('storage status and migration are routed as internal run functions with their exact arguments', () => {
  const h = bootstrapHarness();h.add();vm.runInContext(fs.readFileSync(path.join(__dirname, '../sheetAPI.js'), 'utf8'), h.c);
  const status = h.c.runFunction('getInventorySemanticStorageStatus', { args: [{ nonce: 'caller-proof' }] });
  assert.equal(status.success, true);assert.equal(status.result.nonce, 'caller-proof');
  const dry = h.c.runFunction('migrateInventorySemanticStorage', { args: [{ execute: false }] });
  assert.equal(dry.success, true);assert.equal(dry.result.mode, 'legacy');assert.equal(h.files.size, 0);
});

test('legacy evidence changed during file creation cannot become the active snapshot', () => {
  const h = bootstrapHarness(), a = h.add();h.flags.duringCreate = () => { h.values[a.key] = a.raw + ' '; };
  assert.throws(() => h.migrate(), /CAS|changed/i);assert.equal(h.documents[pointer], undefined);assert.equal(h.values[a.key], a.raw + ' ');
});

test('concurrent manifest replacement is retained, never overwritten or automatically restored', () => {
  const h = bootstrapHarness(), a = h.add();h.migrate();const external = h.documents[pointer] + ' ';
  h.flags.duringCreate = () => { h.documents[pointer] = external; };
  assert.throws(() => h.c.inventorySemanticStorageWrite_([{ ...a.review, reason: 'new' }]), /CAS|changed/i);
  assert.equal(h.documents[pointer], external);assert.equal(h.files.size, 2);
});

test('metadata audit still counts all exact preserved evidence after migration', () => {
  const h = bootstrapHarness(), a = h.add(), b = h.add('inactive');h.migrate();
  const result = h.c.auditInventorySemanticStorage();
  assert.equal(result.records.count, 2);assert.equal(result.records.valueBytes, Buffer.byteLength(a.raw) + Buffer.byteLength(b.raw));
  assert.equal(result.storage.mode, 'drive');assert.equal(result.storage.legacyCount, 0);assert.equal(result.deletionCandidates, 0);
});

test('capacity probe dispatch forwards the explicit byte request without changing the generic auth route', () => {
  const h = bootstrapHarness();h.c.probeScriptPropertiesCapacity = bytes => ({ success: true, bytes });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../sheetAPI.js'), 'utf8'), h.c);
  const result = h.c.runFunction('probeScriptPropertiesCapacity', { args: [64] });
  assert.equal(result.success, true);assert.equal(result.result.bytes, 64);
});

test('public catalog credential cannot read storage metadata, probe capacity or execute migration', () => {
  const h = bootstrapHarness();h.add();vm.runInContext(fs.readFileSync(path.join(__dirname, '../sheetAPI.js'), 'utf8'), h.c);
  h.c.jsonResponse = (body, status) => ({ body, status });
  for (const func of ['getInventorySemanticStorageStatus', 'migrateInventorySemanticStorage', 'probeScriptPropertiesCapacity']) {
    const result = h.c.handleRequestCore_({ parameter: {}, postData: { contents: JSON.stringify({ key: 'village2026', action: 'run', func, args: [{ execute: true }] }) } });
    assert.equal(result.status, 403);assert.equal(result.body.error, 'internal credential required');
  }
  assert.equal(h.files.size, 0);assert.equal(h.events.length, 0);
});

test('null document context preserves nonempty preactivation legacy but cannot silently return empty evidence', () => {
  const h = bootstrapHarness(), a = h.add();h.c.PropertiesService.getDocumentProperties = () => null;
  assert.equal(h.c.inventorySemanticStorageRead_()[a.key], a.raw);
  assert.equal(h.c.getInventorySemanticStorageStatus().mode, 'legacy');
  delete h.values[a.key];assert.throws(() => h.c.inventorySemanticStorageRead_(), /DocumentProperties/);
  assert.equal(h.files.size, 0);
});

test('optional document metadata reads only the existing manifest and returns its hash without raw contents', () => {
  const h = bootstrapHarness();h.add();const raw = '{"fileId":"private-evidence-file","secret":"fixture-only"}', keys = [], before = { ...h.values };
  h.c.PropertiesService.getDocumentProperties = () => ({ getProperty(key) { keys.push(key);return raw; } });
  const result = { documentStore: h.c.inventorySemanticDocumentStoreMetadata_(), nonce: 'metadata' };
  assert.deepEqual(JSON.parse(JSON.stringify(result.documentStore)), {
    available: true, readable: true, manifestHash: crypto.createHash('sha256').update(raw).digest('hex'), identityVerified: false
  });
  assert.equal(result.nonce, 'metadata');assert.deepEqual(keys, [pointer]);assert.deepEqual(h.values, before);
  assert.equal(h.events.length, 0);assert.equal(h.files.size, 0);
  assert.ok(!JSON.stringify(result).includes('private-evidence-file'));assert.ok(!JSON.stringify(result).includes('fixture-only'));
});

test('an empty document store is readable but never evidence of shared store identity', () => {
  const h = bootstrapHarness();h.c.PropertiesService.getDocumentProperties = () => ({ getProperty: () => null });
  const result = h.c.getInventorySemanticStorageStatus({ includeDocumentStore: true }).documentStore;
  assert.equal(result.available, true);assert.equal(result.readable, true);assert.equal(result.manifestHash, null);assert.equal(result.identityVerified, false);
  assert.equal(h.events.length, 0);
});

for (const failure of ['null', 'acquire-throws', 'read-throws', 'api-missing']) test('optional document metadata contains access uncertainty without leaking details: ' + failure, () => {
  const h = bootstrapHarness();
  if (failure === 'api-missing') delete h.c.PropertiesService.getDocumentProperties;
  if (failure !== 'api-missing') h.c.PropertiesService.getDocumentProperties = () => {
    if (failure === 'null') return null;
    if (failure === 'acquire-throws') throw Error('permission denied for private-secret');
    return { getProperty() { throw Error('read failed for private-secret'); } };
  };
  const result = { documentStore: h.c.inventorySemanticDocumentStoreMetadata_() };
  assert.equal(result.documentStore.available, failure === 'null' ? false : failure === 'read-throws' ? true : null);
  assert.equal(result.documentStore.readable, false);assert.equal(result.documentStore.manifestHash, null);assert.equal(result.documentStore.identityVerified, false);
  assert.ok(!JSON.stringify(result).includes('private-secret'));assert.equal(h.events.length, 0);assert.equal(h.files.size, 0);
});
