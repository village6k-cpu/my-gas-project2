'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '..', 'inventoryRiskDelivery.js'), 'utf8');
const prefix = 'inventoryRisk_v1_', scanKey = prefix + 'lastScan';

function env(options = {}) {
  const original = { at: '2026-10-22T00:00:00Z', coverage: { complete: true }, conflicts: 4, risks: 2 };
  const values = { [scanKey]: JSON.stringify(original), PRIVATE_TOKEN: 'must-never-leave-storage',
    'preRegStock_v1_state_RQ-261022-001': '한글', 'preRegStock_v1_state_RQ-261022-002': 'abc',
    ...(options.values || {}) };
  let held = false, writes = 0, scans = 0, pendingChecks = 0;
  const props = { getProperty: (key) => values[key] ?? null, getProperties: () => ({ ...values }), deleteProperty: (key) => { delete values[key]; },
    setProperty(key, value) { writes++; if (options.quota) throw Error('property storage quota'); values[key] = value; } };
  const lock = { tryLock() { if (options.lockBusy) return false; if (options.beforeLock) options.beforeLock(values); held = true; return true; },
    releaseLock() { held = false; } };
  const c = { INVENTORY_RISK_PREFIX_: prefix, PropertiesService: { getScriptProperties: () => props },
    Utilities: { newBlob: (text) => { assert.equal(held, false, 'byte calculation must not hold ScriptLock'); return { getBytes: () => [...Buffer.from(text)] }; } },
    LockService: { getScriptLock: () => lock } };
  vm.runInNewContext(source, c);
  const flush = c.flushInventoryRiskAlerts;
  c.flushPreRegistrationStockAlerts = () => { pendingChecks++; return { status: 'pending' }; };
  c.flushInventoryRiskAlerts = () => { scans++; return { status: 'scheduled' }; };
  return { c, flush, values, original, writes: () => writes, scans: () => scans, pendingChecks: () => pendingChecks };
}

test('heartbeat stores one bounded value-free capacity snapshot while preserving prior scan fields', () => {
  const e = env();
  assert.equal(e.c.inventoryRiskHeartbeat().status, 'scheduled');
  const stored = JSON.parse(e.values[scanKey]), diagnostic = stored.propertyCapacity;
  assert.ok(diagnostic);
  for (const [key, value] of Object.entries(e.original)) assert.deepEqual(stored[key], value);
  assert.equal(diagnostic.propertyCount, 4);
  assert.ok(diagnostic.categories.some((row) => row.prefix === 'preRegStock_v1_state_*' && row.count === 2));
  assert.ok(diagnostic.totalBytes > diagnostic.valueBytes);
  assert.ok(Buffer.byteLength(JSON.stringify(diagnostic)) <= 3000);
  assert.ok(!JSON.stringify(diagnostic).includes('must-never-leave-storage'));
  assert.ok(!JSON.stringify(diagnostic).includes('한글'));
  e.c.inventoryRiskHeartbeat();
  assert.equal(e.writes(), 1);
  assert.equal(e.scans(), 2);
  assert.equal(e.pendingChecks(), 2);
});

for (const options of [{ quota: true }, { lockBusy: true },
  { values: { [prefix + 'lease']: JSON.stringify({ owner: 'other', until: Date.now() + 60000 }) } },
  { values: { [scanKey]: JSON.stringify({ retained: 'x'.repeat(8400) }) } }]) {
  test('diagnostic failure or active work never blocks heartbeat or deletes existing state: ' + Object.keys(options)[0], () => {
    const e = env(options), before = { ...e.values };
    assert.equal(e.c.inventoryRiskHeartbeat().status, 'scheduled');
    assert.deepEqual(e.values, before);
    assert.equal(e.scans(), 1);
    assert.equal(e.pendingChecks(), 1);
  });
}

test('a scan changed before the brief diagnostic lock is never overwritten', () => {
  const e = env({ beforeLock: (values) => { values[scanKey] = '{"at":"newer"}'; } });
  e.c.inventoryRiskHeartbeat();
  assert.equal(e.values[scanKey], '{"at":"newer"}');
  assert.equal(e.writes(), 0);
});

test('capacity totals include every key and group state generations and delivery trade IDs together', () => {
  const e = env({ values: {
    'inventoryRisk_v1_state_aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee_0': '한글'.repeat(20),
    'inventoryRisk_v1_state_11111111-2222-3333-4444-555555555555_1': 'second generation',
    'GUIDE_DELIVERY_V3_out_261022_001': '{"status":"sent"}',
    'GUIDE_DELIVERY_V3_out_261023_002': '{"status":"unknown"}'
  } });
  const before = { ...e.values };
  e.c.inventoryRiskHeartbeat();
  const d = JSON.parse(e.values[scanKey]).propertyCapacity;
  assert.equal(d.propertyCount, Object.keys(before).length);
  assert.equal(d.totalBytes, Object.entries(before).reduce((sum, [key, value]) => sum + Buffer.byteLength(key) + Buffer.byteLength(value), 0));
  assert.equal(d.valueBytes, Object.values(before).reduce((sum, value) => sum + Buffer.byteLength(value), 0));
  assert.equal(d.categories.reduce((sum, row) => sum + row.totalBytes, 0), d.totalBytes);
  assert.equal(d.categories.reduce((sum, row) => sum + row.count, 0), d.propertyCount);
  assert.equal(d.categories.find((row) => row.prefix === 'inventoryRisk_v1_state_*').count, 2);
  assert.equal(d.categories.find((row) => row.prefix === 'GUIDE_DELIVERY_V3_out_*').count, 2);
});

test('many long property names remain bounded without losing overall byte totals', () => {
  const values = Object.fromEntries(Array.from({ length: 300 }, (_, i) => ['category' + i + '_'.repeat(100), 'x'.repeat(i)]));
  const e = env({ values }), before = { ...e.values };
  e.c.inventoryRiskHeartbeat();
  const d = JSON.parse(e.values[scanKey]).propertyCapacity;
  assert.ok(d);
  assert.equal(d.categories.length, 10);
  assert.equal(d.largest.length, 5);
  assert.equal(d.propertyCount, Object.keys(before).length);
  assert.equal(d.totalBytes, Object.entries(before).reduce((sum, [key, value]) => sum + Buffer.byteLength(key) + Buffer.byteLength(value), 0));
  assert.ok(Buffer.byteLength(JSON.stringify(d)) <= 3000);
});

test('a later normal scan retains the existing diagnostic without another capture', () => {
  const e = env();
  e.c.inventoryRiskHeartbeat();
  const diagnostic = JSON.parse(e.values[scanKey]).propertyCapacity;
  e.values[prefix + 'enabled'] = 'true';
  e.c.inventoryRiskClaim_ = () => 'owner';
  e.c.inventoryRiskRelease_ = () => {};
  e.c.inventoryRiskLoadState_ = () => ({ entries: {}, pending: null });
  e.c.inventoryRiskNotificationSchedule_ = () => ({ due: true });
  e.c.getInventoryRiskReport = () => ({ generatedAt: 'newer', coverage: { complete: false }, conflictCount: 9, riskCount: 1 });
  e.c.inventoryRiskDailyDraft_ = () => ({ text: '' });
  assert.equal(e.flush().status, 'identity_review_queued');
  const scan = JSON.parse(e.values[scanKey]);
  assert.equal(scan.at, 'newer');
  assert.equal(scan.conflicts, 9);
  assert.deepEqual(scan.propertyCapacity, diagnostic);
  const writes = e.writes();
  e.c.inventoryRiskHeartbeat();
  assert.equal(e.writes(), writes);
});
