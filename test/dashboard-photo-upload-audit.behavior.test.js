'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'supabaseSync.js'), 'utf8');
const now = Date.parse('2026-10-22T17:00:00Z');
const ttl = 24 * 60 * 60 * 1000;
const prefix = 'dashboardPhotoUpload_v2_';
const identity = { tid: '261021-001', phase: 'checkout', photoId: 'private-photo-id', fileId: 'private-file-id', relativePath: 'private/path.jpg', row: 2 };
const row = [identity.tid, identity.photoId, identity.fileId, identity.relativePath, '반출'];
const receipt = { success: true, tid: identity.tid, phase: identity.phase, photo: { fileId: identity.fileId, sheetValue: identity.relativePath, row: 2 } };

function runAudit(claims, { rows = [row], unavailable = false } = {}) {
  const all = Object.fromEntries(Object.entries(claims).map(([key, value]) => [prefix + key, typeof value === 'string' ? value : JSON.stringify(value)]));
  all.village_operation_receipt_v1_protected = 'protected receipt';
  const before = JSON.stringify(all);
  let ledgerReads = 0;
  const context = {
    Date: class extends Date { static now() { return now; } },
    PropertiesService: { getScriptProperties: () => ({ getProperties: () => ({ ...all }) }) },
    Utilities: {
      newBlob: (value) => ({ getBytes: () => [...Buffer.from(value, 'utf8')] }),
      DigestAlgorithm: { SHA_256: 'sha256' },
      computeDigest: (_, value) => [...crypto.createHash('sha256').update(value).digest()],
    },
    Logger: { log() {} },
    getDashboardPhotoSheet_: () => {
      ledgerReads++;
      if (unavailable) throw new Error('private URL/token must not escape');
      return { getLastRow: () => rows.length + 1, getLastColumn: () => 5,
        getRange: () => ({ getDisplayValues: () => rows.map((item) => [...item]) }) };
    },
    getDashboardPhotoSchema_: () => ({ tradeIdCol: 1, keyCol: 2, fileIdCol: 3, photoCol: 4, phaseCol: 5, maxCol: 5 }),
    getDashboardPhotoWriteCol_: () => 4,
    normalizeEquipmentCheckTradeId_: (value) => String(value).trim(),
    normalizeDashboardPhotoPhase_: (value) => ({ '반출': 'checkout', '반납': 'checkin' }[value] || value),
  };
  vm.runInNewContext(source.slice(source.indexOf('function auditScriptProperties()'), source.indexOf('function cleanupOldTradeProps(')), context);
  const result = JSON.parse(JSON.stringify(context.auditScriptProperties()));
  assert.equal(JSON.stringify(all), before, 'audit must never mutate any property');
  return { audit: result.dashboardPhotoUploads, ledgerReads, all };
}

test('photo audit uses state.at, reports exact UTF-8 capacity, and keeps expired done receipts protected', () => {
  const { audit, ledgerReads, all } = runAudit({ 'old-key-20200101': { ...identity, at: now - 1000, state: 'done', result: receipt, memo: '비공개 메모' },
    expired: { ...identity, at: now - ttl - 1, state: 'done', result: receipt } });
  assert.equal(audit.count, 2);
  assert.equal(audit.entries[0].ageMs, 1000);
  assert.equal(audit.entries[0].legacyCleanupEligible, false);
  assert.equal(audit.entries[1].legacyCleanupEligible, true);
  assert.equal(audit.legacyCleanupEligibleCount, 1);
  assert.equal(audit.valueBytes, Object.entries(all).filter(([key]) => key.startsWith(prefix)).reduce((sum, [, value]) => sum + Buffer.byteLength(value), 0));
  assert.equal(audit.byState.done.count, 2);
  assert.equal(ledgerReads, 1);
  for (const entry of audit.entries) {
    assert.equal(entry.receiptStatus, 'consistent_success');
    assert.equal(entry.ledgerStatus, 'matched');
    assert.equal(entry.safeToDelete, false);
    assert.match(entry.keyHash, /^[a-f0-9]{64}$/);
  }
  assert.equal(audit.driveReadback, 'not_checked');
  for (const secret of [...Object.values(identity).filter((value) => typeof value === 'string'), '비공개 메모', 'old-key-20200101']) {
    if (secret === 'checkout') continue;
    assert.ok(!JSON.stringify(audit).includes(secret), `audit exposed ${secret}`);
  }
});

test('photo audit describes actual state-independent cleanup policy and exact 24-hour boundary', () => {
  const { audit } = runAudit({ boundary: { at: now - ttl, state: 'pending' }, pending: { at: now - ttl - 1, state: 'pending' }, file: { ...identity, at: now - ttl - 1, state: 'file' } });
  assert.deepEqual(audit.entries.map((entry) => entry.legacyCleanupEligible), [false, true, true]);
  assert.equal(audit.byState.pending.count, 2);
  assert.equal(audit.byState.file.count, 1);
  assert.equal(audit.policy.ttlMs, ttl);
  assert.equal(audit.policy.stateIndependent, true);
  assert.equal(audit.policy.deletionExecuted, false);
});

test('photo audit separates malformed JSON, invalid shapes, missing times, invalid times, and future times', () => {
  const { audit } = runAudit({ broken: '{private', scalar: '42', missing: { state: 'pending' }, invalid: { state: 'file', at: 'private-invalid-at' }, future: { state: 'done', at: now + 1000 } });
  assert.deepEqual(audit.entries.map((entry) => entry.parseStatus), ['invalid_json', 'invalid_shape', 'object', 'object', 'object']);
  assert.deepEqual(audit.entries.map((entry) => entry.timestampStatus), ['missing', 'missing', 'missing', 'invalid', 'future']);
  // Existing cleanup leaves a truthy nonnumeric at untouched; the audit must not
  // quietly reinterpret it as expired or turn its key timestamp into state.at.
  assert.deepEqual(audit.entries.map((entry) => entry.legacyCleanupEligible), [true, true, true, false, false]);
  assert.equal(audit.invalidJsonCount, 1);
  assert.ok(!JSON.stringify(audit).includes('private'));
});

test('photo audit distinguishes ledger absence, duplicate identity, and conflicting persisted fields', () => {
  const claim = { ...identity, at: now, state: 'done', result: receipt };
  assert.equal(runAudit({ one: claim }, { rows: [] }).audit.entries[0].ledgerStatus, 'missing');
  assert.equal(runAudit({ one: claim }, { rows: [row, row] }).audit.entries[0].ledgerStatus, 'ambiguous');
  const conflict = [...row]; conflict[2] = 'different-file';
  assert.equal(runAudit({ one: claim }, { rows: [conflict] }).audit.entries[0].ledgerStatus, 'conflict');
  const phaseConflict = [...row]; phaseConflict[4] = '반납';
  assert.equal(runAudit({ one: claim }, { rows: [phaseConflict] }).audit.entries[0].ledgerStatus, 'conflict');
});

test('photo audit marks unavailable ledger readback without leaking its exception or asserting absence', () => {
  const { audit } = runAudit({ one: { ...identity, at: now, state: 'file' } }, { unavailable: true });
  assert.equal(audit.ledgerReadback, 'unavailable');
  assert.equal(audit.entries[0].ledgerStatus, 'unavailable');
  assert.ok(!JSON.stringify(audit).includes('private'));
});

test('photo audit does not equate a stored success receipt with matching canonical data', () => {
  const { audit } = runAudit({ wrong: { ...identity, at: now, state: 'done', result: { ...receipt, tid: 'different-trade' } },
    incomplete: { at: now, state: 'done', result: { success: true } } });
  assert.equal(audit.entries[0].receiptStatus, 'identity_mismatch');
  assert.equal(audit.entries[0].ledgerStatus, 'matched');
  assert.equal(audit.entries[1].receiptStatus, 'invalid_shape');
  assert.equal(audit.entries[1].ledgerStatus, 'incomplete_claim');
});

test('photo audit does not open the photo ledger when no claims exist', () => {
  const { audit, ledgerReads } = runAudit({});
  assert.equal(audit.count, 0);
  assert.equal(ledgerReads, 0);
  assert.equal(audit.ledgerReadback, 'not_needed');
});

test('photo audit contains malformed field types without crashing or treating cleanup errors as deletion authority', () => {
  const { audit } = runAudit({ bad: { state: 'file', at: { toString: 'not callable' }, tid: { toString: 'private' },
    result: { ...receipt, photo: { ...receipt.photo, row: { toString: 'private' } } } } });
  assert.equal(audit.entries[0].timestampStatus, 'invalid');
  assert.equal(audit.entries[0].legacyCleanupEligible, null);
  assert.equal(audit.entries[0].legacyCleanupEvaluation, 'error');
  assert.equal(audit.entries[0].receiptStatus, 'invalid_shape');
  assert.equal(audit.entries[0].ledgerStatus, 'incomplete_claim');
  assert.equal(audit.entries[0].safeToDelete, false);
});

test('photo audit eligibility agrees with the existing cleanup predicate without running live cleanup', () => {
  const claims = { done: { state: 'done', at: now - ttl - 1 }, file: { state: 'file', at: now - ttl - 1 },
    pending: { state: 'pending', at: now - ttl - 1 }, boundary: { state: 'done', at: now - ttl },
    badJson: '{invalid', badTime: { at: 'not-a-number' }, missingTime: {} };
  const { audit, all } = runAudit(claims);
  const values = { ...all };
  const gas = fs.readFileSync(path.join(__dirname, '..', 'checkAvailability.js'), 'utf8');
  const context = { Date: { now: () => now }, DASHBOARD_PHOTO_UPLOAD_CLAIM_PREFIX_: prefix,
    CacheService: { getScriptCache: () => ({ get: () => null, put() {} }) } };
  vm.runInNewContext(gas.slice(gas.indexOf('function cleanupDashboardPhotoUploadClaims_('), gas.indexOf('function findDashboardPhotoUploadRow_(')), context);
  context.cleanupDashboardPhotoUploadClaims_({ getProperties: () => ({ ...values }), deleteProperty: (key) => { delete values[key]; } });
  Object.keys(claims).forEach((key, index) => assert.equal(audit.entries[index].legacyCleanupEligible, !(prefix + key in values)));
  assert.equal(values.village_operation_receipt_v1_protected, 'protected receipt');
});

test('photo audit expands absent DONE duplicates from the scoped success receipt without changing stored bytes or expiry', () => {
  const claim = { scope: identity.tid + '|' + identity.phase, state: 'done', at: now - ttl - 1,
    photoId: identity.photoId, result: { ...receipt, photo: { ...receipt.photo, phase: identity.phase } } };
  const { audit } = runAudit({ compact: claim });
  assert.equal(audit.entries[0].receiptStatus, 'consistent_success');
  assert.equal(audit.entries[0].ledgerStatus, 'matched');
  assert.equal(audit.entries[0].legacyCleanupEligible, true);
  assert.equal(audit.valueBytes, Buffer.byteLength(JSON.stringify(claim)));
  assert.equal(audit.entries[0].safeToDelete, false);
});

test('photo audit never overwrites an existing conflicting duplicate while expanding compact DONE evidence', () => {
  const claim = { scope: identity.tid + '|' + identity.phase, state: 'done', at: now,
    photoId: identity.photoId, fileId: 'conflicting-file',
    result: { ...receipt, photo: { ...receipt.photo, phase: identity.phase } } };
  const { audit } = runAudit({ compact: claim });
  assert.equal(audit.entries[0].receiptStatus, 'identity_mismatch');
  assert.equal(audit.entries[0].ledgerStatus, 'conflict');
});

test('photo audit requires a matching scope and DONE state before deriving compact identity', () => {
  const claim = { scope: identity.tid + '|' + identity.phase, state: 'done', at: now,
    photoId: identity.photoId, result: { ...receipt, photo: { ...receipt.photo, phase: identity.phase } } };
  const { audit } = runAudit({ wrongScope: { ...claim, scope: 'different|checkout' }, pending: { ...claim, state: 'pending' } });
  for (const entry of audit.entries) {
    assert.equal(entry.receiptStatus, 'identity_mismatch');
    assert.equal(entry.ledgerStatus, 'incomplete_claim');
  }
});
