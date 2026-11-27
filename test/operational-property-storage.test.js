const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('./helpers/gas-storage-vm');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const nativeVm = require('node:vm');

const pointer = 'OPERATIONS_RECORDS_STORE_V1';
const fileId = 'private_operational_records_v1';
const photoKey = 'dashboardPhotoUpload_v2_client-1';
const requestId = 'RQ-261107-001';
const requestKey = 'preRegStock_v1_state_' + requestId;
const receiptKey = 'historicalDiscountRestore_v1_261107-001';

function fixture() {
  const now = Date.parse('2026-11-07T06:00:00Z');
  const values = new Map([
    [pointer, JSON.stringify({ version: 1, fileId, readyAt: now, guideDeliveryReadyAt: now })],
    ['preRegStock_v1_enabled', 'true'],
    ['CONTRACT_TEMPLATE_ID', 'fixture-template']
  ]);
  const flags = { full: true, failSheet: false, failDelete: false, failBackup: false, corruptDrive: false, capacityBytes: Infinity };
  const usedBytes = () => [...values].reduce((n, [key, value]) => n + Buffer.byteLength(key + value), 0);
  const base = {
    getProperty: key => values.get(key) ?? null,
    getProperties: () => Object.fromEntries(values),
    setProperty(key, value) {
      if (flags.full && !values.has(key)) throw Error('Property storage quota exceeded');
      const previousBytes = values.has(key) ? Buffer.byteLength(key + values.get(key)) : 0;
      if (usedBytes() - previousBytes + Buffer.byteLength(key + value) > flags.capacityBytes) {
        throw Error('Property storage quota exceeded');
      }
      values.set(key, String(value));
    },
    deleteProperty(key) {
      if (flags.failDelete) throw Error('Property delete failed');
      values.delete(key);
    },
    setProperties(patch) { for (const [key, value] of Object.entries(patch)) this.setProperty(key, value); }
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
    let maxColumns = 26;
    const sheet = {
      rows,
      getLastRow: () => rows.length,
      getMaxRows: () => maxRows,
      getMaxColumns: () => maxColumns,
      deleteColumns(first, count) { assert.equal(first + count - 1, maxColumns); maxColumns -= count; },
      insertRowsAfter(row, count) { assert.equal(row, maxRows); maxRows += count; },
      appendRow(row) {
        if (flags.failSheet) throw Error('Sheet write failed');
        assert.equal(script.hasLock(), true);
        rows.push(row.slice());
        maxRows = Math.max(maxRows, rows.length);
        return sheet;
      },
      getRange(first, col, count = 1, width = 1) {
        assert.ok(first + count - 1 <= maxRows);
        return {
          getValues: () => Array.from({ length: count }, (_, i) =>
            Array.from({ length: width }, (_, j) => rows[first + i - 1]?.[col + j - 1] ?? '')),
          getValue: () => rows[first - 1]?.[col - 1] ?? '',
          setValues(batch) {
            if (flags.failSheet) throw Error('Sheet write failed');
            assert.equal(script.hasLock(), true);
            batch.forEach((row, i) => {
              const target = rows[first + i - 1] || (rows[first + i - 1] = []);
              row.forEach((value, j) => { target[col + j - 1] = value; });
            });
          },
          setValue(value) {
            if (flags.failSheet) throw Error('Sheet write failed');
            const target = rows[first - 1] || (rows[first - 1] = []); target[col - 1] = value;
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
  const sheets = { inventory: fakeSheet(), photos: fakeSheet(), receipts: fakeSheet(), runtime: fakeSheet() };
  const book = { getSheetByName: name => sheets[name] || null,
    insertSheet(name) { assert.equal(sheets[name], undefined); return sheets[name] = fakeSheet(); } };
  const files = new Map(), fileFlags = { sharing: 'PRIVATE' };
  let fileSequence = 0;
  function blob(input) {
    const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input);
    return { getBytes: () => bytes, getDataAsString: () => bytes.toString('utf8') };
  }
  function file(id, savedBlob) {
    return { getId: () => id, setSharing(access) { fileFlags.sharing = access; },
      getSharingAccess: () => fileFlags.sharing, getEditors: () => [], getViewers: () => [],
      getBlob: () => flags.corruptDrive ? blob('corrupt') : savedBlob };
  }
  files.set(fileId, file(fileId));
  class Clock extends Date { static now() { return now; } }
  const ctx = vm.createContext({
    Date: Clock,
    PropertiesService: { getScriptProperties: () => base },
    LockService: { getScriptLock: () => script, getUserLock: () => user },
    SpreadsheetApp: {
      openById(id) { assert.equal(id, fileId); return book; },
      flush() {}
    },
    Utilities: {
      newBlob: text => blob(text),
      gzip: input => blob(zlib.gzipSync(input.getBytes())),
      ungzip: input => blob(zlib.gunzipSync(input.getBytes())),
      computeDigest: (_, text) => [...crypto.createHash('sha256').update(text).digest()],
      getUuid: () => 'test-id',
      DigestAlgorithm: { SHA_256: 'sha256' },
      Charset: { UTF_8: 'utf8' }
    },
    DriveApp: { Access: { PRIVATE: 'PRIVATE' }, Permission: { NONE: 'NONE' },
      getFileById(id) { assert.equal(files.has(id), true); return files.get(id); },
      createFile(savedBlob) {
        if (flags.failBackup) throw Error('Backup creation failed');
        const id = 'private_payload_' + ++fileSequence, saved = file(id, savedBlob); files.set(id, saved); return saved;
      } }
  });
  for (const filename of ['villagePropertyStore.js', 'dashboardPhotoClaimStorage.js', 'operationalPropertyStorage.js', 'preRegistrationStockAlerts.js', 'guideDeliverySafety.js']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', filename), 'utf8'), ctx);
  }
  const store = group => ctx.operationalPropertyStore_(group);
  const migrate = () => ctx.migrateOperationalProperties({
    expectedSnapshotHash: ctx.getOperationalPropertyStorageStatus().snapshotHash
  });
  return { ctx, values, flags, sheets, now, store, migrate, base, usedBytes, files };
}

function activateRuntime(f) {
  const config = JSON.parse(f.values.get(pointer));
  config.runtimeReadyAt = f.now;
  f.values.set(pointer, JSON.stringify(config));
}

test('settings initialization is independent of GAS file order and preserves the explicit guide safety flag', () => {
  const names = ['guideDeliverySafety.js', 'operationalPropertyStorage.js', 'villagePropertyStore.js'];
  const source = names.map(name => fs.readFileSync(path.join(__dirname, '..', name), 'utf8')).join('\n');
  const context = { PropertiesService: { getScriptProperties: () => ({
    getProperty: key => key === 'GUIDE_ALIMTALK_SUSPENDED' ? 'false' : null
  }) } };
  nativeVm.runInNewContext(source, context);
  assert.equal(context.GUIDE_DELIVERY_INCIDENT_SUSPENDED_, false);
  assert.equal(context.villageScriptProperties_().getProperty('GUIDE_ALIMTALK_SUSPENDED'), 'false');
});

test('setting reads remain available to authenticate diagnostics even when a storage pointer is damaged', () => {
  const f = fixture(); f.values.set(pointer, '{broken');
  const p = f.ctx.villageScriptProperties_();
  assert.equal(p.getProperty('CONTRACT_TEMPLATE_ID'), 'fixture-template');
  assert.throws(() => p.getProperty('PAYMENT_REV_261126-001'));
});

test('every growing operational family is classified outside settings, including future record names', () => {
  const f = fixture();
  for (const key of ['itemCheck_261126-001-01_checkout', 'returnDone_261126-001',
    'PAYMENT_REV_261126-001', 'REG_ALIM_SENT_261126-001', 'contractRegenRetry_v1_261126-001',
    'slackOpsOnsiteIdempotency_v1', 'SUPA_TOKEN', 'SUPA_SYNC_LEASE_v1',
    'CONFIRM_REQUEST_SEQUENCE_V1_261126', 'dashboardPostItNotes_v1', 'futureJobReceipt_261126-001']) {
    assert.equal(f.ctx.operationalPropertyGroup_(key), 'runtime', key);
  }
  for (const key of ['CONTRACT_TEMPLATE_ID', 'VILLAGE_API_WRITE_KEY_V1',
    'SUPABASE_BOT_PASSWORD', 'inventoryRisk_v1_slackToken', 'preRegStock_v1_enabled', pointer]) {
    assert.equal(f.ctx.operationalPropertyGroup_(key), null, key);
  }
});

test('an active unified store never sends a new operation to a full settings store', () => {
  const f = fixture(); activateRuntime(f);
  const p = f.ctx.villageScriptProperties_(), before = f.usedBytes();
  for (const key of ['returnDone_261126-001', 'PAYMENT_REV_261126-001', 'futureJobReceipt_261126-001']) {
    assert.equal(p.setProperty(key, 'saved').getProperty(key), 'saved');
    assert.equal(f.values.has(key), false);
  }
  assert.equal(f.usedBytes(), before);
  assert.equal(p.setProperty('CONTRACT_TEMPLATE_ID', 'same-setting'), p);
  assert.equal(f.values.get('CONTRACT_TEMPLATE_ID'), 'same-setting');
});

test('old specialized stores route leases and other mismatched records through the unified store', () => {
  const f = fixture(); activateRuntime(f);
  const inventory = f.store('inventory');
  inventory.setProperty('preRegStock_v1_lease', '{"owner":"original"}');
  assert.equal(inventory.getProperty('preRegStock_v1_lease'), '{"owner":"original"}');
  assert.equal(f.values.has('preRegStock_v1_lease'), false);
  assert.equal(inventory.getProperties().preRegStock_v1_lease, '{"owner":"original"}');
});

test('unified bulk writes and key scans preserve the Properties interface without growing settings', () => {
  const f = fixture(); activateRuntime(f);
  const p = f.ctx.villageScriptProperties_();
  const patch = { 'setupDone_261126-001': 'true', 'returnDone_261126-001': 'true',
    [requestKey]: '{"pending":true}', [receiptKey]: '{"phase":"pending"}' };
  assert.equal(p.setProperties(patch, false), p);
  for (const [key, value] of Object.entries(patch)) {
    assert.equal(p.getProperty(key), value);
    assert.equal(p.getProperties()[key], value);
    assert.equal(p.getKeys().includes(key), true);
    assert.equal(f.values.has(key), false);
  }
  assert.equal(p.deleteProperty('returnDone_261126-001'), p);
  assert.equal(p.getProperty('returnDone_261126-001'), null);
  assert.equal(p.getKeys().includes('returnDone_261126-001'), false);
});

test('a missing destination fails closed instead of writing operations back to settings', () => {
  const f = fixture(); activateRuntime(f);
  f.sheets.runtime.rows[0] = ['broken', 'header'];
  const p = f.ctx.villageScriptProperties_();
  assert.throws(() => p.setProperty('PAYMENT_REV_261126-001', '3'), /invalid/);
  assert.equal(f.values.has('PAYMENT_REV_261126-001'), false);
});

test('record reads observe concurrent value changes and do not cache absent records', () => {
  const f = fixture(); activateRuntime(f);
  const p = f.ctx.villageScriptProperties_(), key = 'returnDone_261126-001';
  assert.equal(p.getProperty(key), null);
  f.sheets.runtime.rows.push([key, 'v:1']);
  assert.equal(p.getProperty(key), '1');
  f.sheets.runtime.rows[1][1] = 'v:0';
  assert.equal(p.getProperty(key), '0');
});

test('bulk reads skip completely empty grid gaps while rejecting orphan values and duplicate keys', () => {
  const f = fixture(); activateRuntime(f);
  f.ctx.operationalPropertyWithLock_(() => {
    f.sheets.runtime.appendRow(['returnDone_261126-001', 'v:1']);
    f.sheets.runtime.appendRow(['', '']);
    f.sheets.runtime.appendRow(['setupDone_261126-001', 'v:1']);
  });
  const p = f.ctx.villageScriptProperties_();
  assert.equal(p.getProperties()['setupDone_261126-001'], '1');
  f.sheets.runtime.rows[2] = ['', 'v:orphan'];
  assert.throws(() => p.getProperties(), /Invalid/);
  f.sheets.runtime.rows[2] = ['returnDone_261126-001', 'v:duplicate'];
  assert.throws(() => p.getProperties(), /duplicate/);
});

test('writes append safely when a long execution has stale grid capacity metadata', () => {
  const f = fixture(); activateRuntime(f);
  const p = f.ctx.villageScriptProperties_();
  p.setProperty('returnDone_261126-001', 'original');
  f.sheets.runtime.getMaxRows = () => 1;
  f.sheets.runtime.insertRowsAfter = () => assert.fail('Stale row capacity must never insert inside existing records');
  p.setProperties({ 'setupDone_261126-001': '1', 'setupDoneAt_261126-001': '2' }, false);
  assert.equal(p.getProperty('returnDone_261126-001'), 'original');
  assert.equal(p.getProperty('setupDone_261126-001'), '1');
  assert.equal(p.getProperty('setupDoneAt_261126-001'), '2');
  assert.equal(f.sheets.runtime.rows.some(row => !row[0]), false);
});

test('migration appends safely with stale capacity without shifting verified records', () => {
  const f = fixture(); f.flags.full = false; activateRuntime(f);
  f.ctx.prepareOperationalPropertyStorage();
  f.sheets.runtime.getMaxRows = () => 1;
  f.sheets.runtime.insertRowsAfter = () => assert.fail('Migration must not resize from cached capacity');
  f.values.set('setupDone_261126-001', '1');
  assert.equal(f.migrate().moved, 1);
  assert.equal(f.ctx.villageScriptProperties_().getProperty('setupDone_261126-001'), '1');
});

test('the live storage probe verifies every physical group and removes only its own nonce records', () => {
  const f = fixture(); activateRuntime(f);
  const before = Object.fromEntries(f.values);
  const result = f.ctx.probeOperationalPropertyStorage();
  assert.equal(result.ok, true);
  assert.equal(result.groups.length, 4);
  assert.equal(result.groups.every(row => row.write === 'verified' && row.cleanup === 'deleted_verified'), true);
  assert.deepEqual(Object.fromEntries(f.values), before);
  for (const sheet of Object.values(f.sheets)) assert.equal(sheet.rows.slice(1).every(row => row[1] === ''), true);
});

test('a storage probe failure never falls back to settings or claims successful persistence', () => {
  const f = fixture(); activateRuntime(f); f.flags.failSheet = true;
  const result = f.ctx.probeOperationalPropertyStorage();
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'operational_write_not_verified');
  assert.equal([...f.values.keys()].some(key => key.startsWith('operationalStorageProbe_')), false);
});

test('payloads beyond the cell limit use private files and preserve exact unicode text', () => {
  const f = fixture(); activateRuntime(f);
  const p = f.ctx.villageScriptProperties_(), key = 'futureLargeReceipt_261126-001';
  const value = '한글🙂\n={unchanged} '.repeat(5000);
  p.setProperty(key, value);
  assert.match(f.sheets.runtime.rows[1][1], /^f:/);
  assert.equal(p.getProperty(key), value);
  assert.equal(f.values.has(key), false);
  f.ctx.OPERATIONAL_PROPERTY_PAYLOADS_ = Object.create(null);
  f.flags.corruptDrive = true;
  assert.throws(() => p.getProperty(key), /hash mismatch/);
});

test('all-operation migration waits for the staged reader cutover and never restarts its clock', () => {
  const f = fixture(); f.flags.full = false;
  const key = 'returnDone_261126-001'; f.values.set(key, '1');
  const first = f.ctx.prepareOperationalPropertyStorage();
  assert.equal(first.runtimeMode, 'staged');
  assert.equal(f.ctx.prepareOperationalPropertyStorage().runtimeReadyAt, first.runtimeReadyAt);
  assert.throws(f.migrate, /not ready/);
  assert.equal(f.values.get(key), '1');
  activateRuntime(f);
  assert.equal(f.migrate().moved, 1);
  assert.equal(f.ctx.villageScriptProperties_().getProperty(key), '1');
});

test('migration archives and verifies exact values before legacy deletion, including retry after failure', () => {
  const f = fixture(); f.flags.full = false;
  const key = 'registeredTradePriceReceipt_v1_original';
  f.values.set(key, '{"mutationId":"keep-me","amount":97020}');
  f.ctx.prepareOperationalPropertyStorage(); activateRuntime(f);
  f.flags.failBackup = true;
  assert.throws(f.migrate, /Backup creation failed/);
  assert.equal(f.values.has(key), true);
  assert.equal(f.sheets.runtime.rows.length, 1);
  f.flags.failBackup = false; f.flags.failDelete = true;
  assert.throws(f.migrate, /Property delete failed/);
  assert.equal(f.values.has(key), true);
  assert.equal(f.sheets.property_migrations.rows[1][6], 'backed_up');
  f.values.set(key, '{"mutationId":"keep-me","amount":123456}');
  f.flags.failDelete = false;
  const result = f.migrate();
  assert.equal(result.backup.verified, true);
  assert.equal(result.moved, 1);
  assert.equal(f.values.has(key), false);
  assert.equal(f.ctx.villageScriptProperties_().getProperty(key), '{"mutationId":"keep-me","amount":123456}');
  const archived = JSON.parse(zlib.gunzipSync(f.files.get(result.backup.fileId).getBlob().getBytes()).toString('utf8'));
  assert.deepEqual(archived.records, [[key, '{"mutationId":"keep-me","amount":123456}']]);
  assert.equal(f.sheets.property_migrations.rows[2][6], 'migrated:1');
  assert.equal(f.values.get('CONTRACT_TEMPLATE_ID'), 'fixture-template');
});

test('all-operation migration uses bounded batches and leaves no dynamic settings records', () => {
  const f = fixture(); f.flags.full = false;
  for (let i = 0; i < 127; i++) f.values.set('futureReceipt_' + i, String(i));
  f.ctx.prepareOperationalPropertyStorage(); activateRuntime(f);
  assert.equal(f.migrate().moved, 50);
  assert.equal(f.migrate().moved, 50);
  assert.equal(f.migrate().moved, 27);
  assert.equal(f.ctx.getOperationalPropertyStorageStatus().legacyCount, 0);
  const p = f.ctx.villageScriptProperties_();
  for (let i = 0; i < 127; i++) assert.equal(p.getProperty('futureReceipt_' + i), String(i));
  assert.equal(f.sheets.runtime.rows.length, 128);
  const key = 'futureReceipt_0'; f.values.set(key, 'stale old deployment');
  assert.throws(f.migrate, /Unexpected legacy writer/);
  f.ctx.VILLAGE_SCRIPT_PROPERTIES_FACADE_ = null;
  const routed = f.ctx.villageScriptProperties_();
  assert.equal(routed.getProperty(key), '0');
  assert.equal(routed.getProperties()[key], '0');
  f.values.set('unknownOldWriter_261126-001', 'stale');
  assert.equal(routed.getProperty('unknownOldWriter_261126-001'), null);
  assert.equal(routed.getKeys().includes('unknownOldWriter_261126-001'), false);
  assert.equal(f.values.get(key), 'stale old deployment');
});

test('durable record storage failures cannot be converted into successful completion revisions', () => {
  const f = fixture();
  const source = fs.readFileSync(path.join(__dirname, '..', 'checkAvailability.js'), 'utf8');
  vm.runInContext(source.slice(source.indexOf('function dashboardCompletionRevisionKey_('),
    source.indexOf('function ensureDashboardCompletionRevision_(')), f.ctx);
  const props = { __villageRoutedStorage: true,
    getProperty() { return '10'; }, setProperty() { throw Error('storage quota unavailable'); },
    setProperties() { throw Error('storage quota unavailable'); } };
  assert.throws(() => f.ctx.trySetScriptProperty_(props, 'returnDone_261126-001', '1'), /unavailable/);
  assert.throws(() => f.ctx.trySetScriptProperties_(props, { 'returnDone_261126-001': '1' }), /unavailable/);
  assert.throws(() => f.ctx.nextDashboardCompletionRevision_(props, '261126-001', 'return'), /unavailable/);
});

test('guide receipt migration frees the shared quota for equipment removal without losing delivery proof', () => {
  const f = fixture();
  f.flags.full = false;
  const source = fs.readFileSync(path.join(__dirname, '..', 'checkAvailability.js'), 'utf8');
  f.ctx.DASHBOARD_MUTATION_LOG_PREFIX_ = 'dashboardMutationLog_v2_';
  f.ctx.DASHBOARD_MUTATION_LOG_TTL_MS_ = 86400000;
  vm.runInContext(source.slice(source.indexOf('function normalizeDashboardMutationId_('),
    source.indexOf('function dashboardCompletionRevisionKey_(')), f.ctx);
  const expected = new Map();
  for (let i = 1; i <= 732; i++) {
    const key = 'GUIDE_DELIVERY_V3_out_261123_' + String(i).padStart(3, '0');
    const raw = JSON.stringify({ state: i % 2 ? 'pending' : 'delivered', requestNum: 'request-' + i, receiptNum: 'receipt-' + i });
    expected.set(key, raw);
    f.values.set(key, raw);
  }
  f.flags.capacityBytes = f.usedBytes();
  const beginRemoval = () => f.ctx.beginDashboardMutation_(f.base, '261123-001', 'remove-1', 'equipmentRemoveBatch:schedule:261123-001-01', 'exact-target');
  assert.throws(beginRemoval, /storage quota/);
  let moved = 0;
  for (let i = 0; i < 5; i++) moved += f.migrate().moved;
  assert.equal(moved, 732);
  assert.equal(f.ctx.getOperationalPropertyStorageStatus().legacyCount, 0);
  for (const [key, raw] of expected) {
    assert.equal(f.values.has(key), false);
    assert.equal(JSON.stringify(f.ctx.guideSafetyRead_(key)), raw);
  }
  assert.equal(beginRemoval().skip, false);
  f.ctx.commitDashboardMutation_(f.base, '261123-001', 'remove-1', 'equipmentRemoveBatch:schedule:261123-001-01');
  assert.equal(beginRemoval().skip, true, 'equipment removal retries must retain their durable deduplication');
  const bytes = f.usedBytes();
  f.ctx.guideSafetyWrite_('GUIDE_DELIVERY_V3_in_261123_001', { state: 'unknown', requestNum: 'keep-on-retry' });
  assert.equal(f.usedBytes(), bytes, 'new guide records must not fill Script Properties again');
  assert.equal(f.ctx.guideSafetyRead_('GUIDE_DELIVERY_V3_in_261123_001').requestNum, 'keep-on-retry');
});

test('guide storage activation waits out executions of the old guide reader', () => {
  const f = fixture();
  f.flags.full = false;
  f.values.set(pointer, JSON.stringify({ version: 1, fileId, readyAt: f.now - 86400000 }));
  const key = 'GUIDE_DELIVERY_V3_out_261123_001';
  f.ctx.guideSafetyWrite_(key, { state: 'pending', requestNum: 'original' });
  assert.equal(f.values.has(key), true);
  assert.throws(f.migrate, /not ready/);
  const staged = f.ctx.prepareOperationalPropertyStorage();
  assert.equal(staged.guideDeliveryMode, 'staged');
  const config = JSON.parse(f.values.get(pointer));
  assert.equal(config.readyAt, f.now - 86400000, 'existing record groups must stay readable');
  assert.equal(config.guideDeliveryReadyAt, f.now + 420000);
  f.ctx.prepareOperationalPropertyStorage();
  assert.equal(JSON.parse(f.values.get(pointer)).guideDeliveryReadyAt, config.guideDeliveryReadyAt);
  assert.throws(f.migrate, /not ready/);
  f.values.set(pointer, JSON.stringify({ ...config, guideDeliveryReadyAt: f.now }));
  assert.equal(f.migrate().moved, 1);
  f.flags.full = true;
  assert.equal(f.ctx.guideSafetyRead_(key).requestNum, 'original');
  f.ctx.guideSafetyWrite_(key, { state: 'delivered', requestNum: 'original' });
  assert.equal(f.ctx.guideSafetyRead_(key).state, 'delivered');
});

test('migrated pending and delivered guide receipts prevent duplicate customer sends', () => {
  for (const state of ['pending', 'unknown', 'delivered', 'rejected']) {
    const f = fixture(), key = 'GUIDE_DELIVERY_V3_out_261123_001';
    const operationAt = new Date(f.now + 3600000), cust = { name: '테스트', tel: '01012345678' };
    f.values.set(key, JSON.stringify({ state, requestNum: 'original', binding: cust.tel + '|' + cust.name + '|' + operationAt.getTime() }));
    assert.equal(f.migrate().moved, 1);
    f.ctx.GUIDE_DELIVERY_INCIDENT_SUSPENDED_ = false;
    f.ctx.normalizeAlimtalkReceiver_ = phone => phone;
    f.ctx.verifyGuideRecord_ = record => record;
    f.ctx.sendAlimtalk = () => assert.fail('migration must never authorize another customer send');
    const result = f.ctx.sendGuideSafely_('261123-001', 'checkout', cust, operationAt);
    assert.equal(result.sent, false);
    assert.equal(result.state, state);
    assert.equal(f.ctx.guideSafetyRead_(key).requestNum, 'original');
  }
});

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
