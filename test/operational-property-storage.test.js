const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');

const pointer = 'OPERATIONS_RECORDS_STORE_V1';
const fileId = 'private_operational_records_v1';
const photoKey = 'dashboardPhotoUpload_v2_client-1';
const requestId = 'RQ-261107-001';
const requestKey = 'preRegStock_v1_state_' + requestId;
const receiptKey = 'historicalDiscountRestore_v1_261107-001';

function fixture() {
  const now = Date.parse('2026-11-07T06:00:00Z');
  const values = new Map([
    [pointer, JSON.stringify({ version: 1, fileId, readyAt: now })],
    ['preRegStock_v1_enabled', 'true'],
    ['CONTRACT_TEMPLATE_ID', 'fixture-template']
  ]);
  const flags = { full: true, failSheet: false, failDelete: false };
  const base = {
    getProperty: key => values.get(key) ?? null,
    getProperties: () => Object.fromEntries(values),
    setProperty(key, value) {
      if (flags.full && !values.has(key)) throw Error('Property storage quota exceeded');
      values.set(key, String(value));
    },
    deleteProperty(key) {
      if (flags.failDelete) throw Error('Property delete failed');
      values.delete(key);
    }
  };
  function lock() {
    let held = false;
    return {
      hasLock: () => held,
      waitLock() { assert.equal(held, false); held = true; },
      releaseLock() { assert.equal(held, true); held = false; }
    };
  }
  const script = lock(), user = lock();
  function fakeSheet() {
    const rows = [['key', 'encoded_value']];
    let maxRows = 2;
    const sheet = {
      rows,
      getLastRow: () => rows.length,
      getMaxRows: () => maxRows,
      insertRowsAfter(row, count) { assert.equal(row, maxRows); maxRows += count; },
      getRange(first, col, count = 1, width = 1) {
        assert.ok(first + count - 1 <= maxRows);
        return {
          getValues: () => Array.from({ length: count }, (_, i) =>
            Array.from({ length: width }, (_, j) => rows[first + i - 1]?.[col + j - 1] ?? '')),
          getValue: () => rows[first - 1]?.[col - 1] ?? '',
          setValues(batch) {
            if (flags.failSheet) throw Error('Sheet write failed');
            assert.equal(script.hasLock(), true);
            assert.equal(col, 1);
            batch.forEach((row, i) => { rows[first + i - 1] = [...row]; });
          },
          createTextFinder(key) {
            const finder = {
              matchEntireCell: () => finder,
              matchCase: () => finder,
              findAll: () => rows.slice(first - 1, first - 1 + count)
                .flatMap((row, i) => row[0] === key ? [{ getRow: () => first + i }] : [])
            };
            return finder;
          }
        };
      }
    };
    return sheet;
  }
  const sheets = { inventory: fakeSheet(), photos: fakeSheet(), receipts: fakeSheet() };
  class Clock extends Date { static now() { return now; } }
  const ctx = vm.createContext({
    Date: Clock,
    PropertiesService: { getScriptProperties: () => base },
    LockService: { getScriptLock: () => script, getUserLock: () => user },
    SpreadsheetApp: {
      openById(id) { assert.equal(id, fileId); return { getSheetByName: name => sheets[name] }; },
      flush() {}
    },
    Utilities: {
      newBlob: text => ({ getBytes: () => Buffer.from(text) }),
      computeDigest: (_, text) => [...crypto.createHash('sha256').update(text).digest()],
      getUuid: () => 'test-id',
      DigestAlgorithm: { SHA_256: 'sha256' },
      Charset: { UTF_8: 'utf8' }
    }
  });
  for (const filename of ['dashboardPhotoClaimStorage.js', 'operationalPropertyStorage.js', 'preRegistrationStockAlerts.js']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', filename), 'utf8'), ctx);
  }
  const store = group => ctx.operationalPropertyStore_(group);
  const migrate = () => ctx.migrateOperationalProperties({
    expectedSnapshotHash: ctx.getOperationalPropertyStorageStatus().snapshotHash
  });
  return { ctx, values, flags, sheets, now, store, migrate };
}

test('reservation queues still save when Script Properties rejects a new property', () => {
  const f = fixture();
  const key = 'preRegStock_v1_dirty_' + requestId;
  f.ctx.queuePreRegistrationStockCheck_(requestId, { includeRegistered: true });
  const inventory = f.store('inventory');
  assert.equal(inventory.getProperty(key), f.now + ':test-id');
  assert.equal(inventory.getProperty('preRegStock_v1_registered_' + requestId), 'true');
  assert.equal(f.values.has(key), false);
  assert.deepEqual(Array.from(f.ctx.preRegistrationStockPendingKeys_(inventory.getProperties())), [key]);
});

test('new large photo claims persist without using the property store and keep their replay lifetime', () => {
  const f = fixture();
  const photo = f.store('photos');
  const large = JSON.stringify({ state: 'done', at: f.now, result: '한'.repeat(4000) });
  photo.setProperty(photoKey, large);
  assert.equal(photo.getProperty(photoKey), large);
  assert.equal(f.values.has(photoKey), false);
  photo.setProperty(photoKey, JSON.stringify({ state: 'done', at: f.now - 86400001 }));
  assert.equal(photo.getProperty(photoKey), null);
  assert.equal(f.sheets.photos.rows.length, 2);
});

test('migration preserves exact bytes, pending receipts and unrelated settings', () => {
  const f = fixture();
  const values = {
    [requestKey]: '{"pending":{"id":"original","relayToken":"keep-this"}}',
    [photoKey]: JSON.stringify({ state: 'file', at: f.now, fileId: 'already-uploaded' }),
    [receiptKey]: '{"phase":"pending","mutationId":"preserve-original"}'
  };
  for (const [key, raw] of Object.entries(values)) f.values.set(key, raw);
  assert.equal(f.migrate().moved, 3);
  assert.equal(f.migrate().moved, 0);
  assert.equal(f.store('inventory').getProperty(requestKey), values[requestKey]);
  assert.equal(f.store('photos').getProperty(photoKey), values[photoKey]);
  assert.equal(f.store('receipts').getProperty(receiptKey), values[receiptKey]);
  assert.equal(f.values.get('CONTRACT_TEMPLATE_ID'), 'fixture-template');
  assert.ok(Object.keys(values).every(key => !f.values.has(key)));
});

test('failed destination write and interrupted duplicate removal preserve legacy authority', () => {
  const f = fixture();
  f.values.set(requestKey, '{"pending":true}');
  f.flags.failSheet = true;
  assert.throws(f.migrate, /Sheet write failed/);
  assert.equal(f.values.get(requestKey), '{"pending":true}');
  f.flags.failSheet = false;
  f.flags.failDelete = true;
  assert.throws(f.migrate, /Property delete failed/);
  f.flags.failDelete = false;
  f.store('inventory').setProperty(requestKey, '{"pending":false}');
  assert.equal(f.migrate().moved, 1);
  assert.equal(f.store('inventory').getProperty(requestKey), '{"pending":false}');
  assert.equal(f.sheets.inventory.rows.length, 2);
});

test('the migration requires current evidence and waits for old executions', () => {
  const f = fixture();
  const stale = f.ctx.getOperationalPropertyStorageStatus().snapshotHash;
  f.values.set(requestKey, 'newer');
  assert.throws(() => f.ctx.migrateOperationalProperties({ expectedSnapshotHash: stale }), /snapshot changed/);
  f.values.set(pointer, JSON.stringify({ version: 1, fileId, readyAt: f.now + 420000 }));
  assert.throws(f.migrate, /not ready/);
  assert.equal(f.store('inventory').getProperty(requestKey), 'newer');
  assert.equal(f.sheets.inventory.rows.length, 1);
});

test('an invalid or unavailable destination fails instead of falling back to the full quota', () => {
  const f = fixture();
  f.sheets.photos.rows[0] = ['incorrect', 'header'];
  assert.throws(() => f.store('photos').getProperty(photoKey), /invalid/);
  assert.throws(() => f.store('photos').setProperty(photoKey, '{}'), /invalid/);
  assert.equal(f.values.has(photoKey), false);
});
