'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '..', 'inventoryRiskDelivery.js'), 'utf8');
const prefix = 'inventoryRisk_v1_', scanKey = prefix + 'lastScan';
const preservedIncidentError = JSON.stringify({ at: '2026-10-21T22:54:33.712Z', message: '재고 경보 전송·상태 확인 필요' });

function env(options = {}) {
  const original = { at: '2026-10-22T00:00:00Z', coverage: { complete: true }, conflicts: 4, risks: 2 };
  const values = { [scanKey]: JSON.stringify(original), PRIVATE_TOKEN: 'must-never-leave-storage',
    'preRegStock_v1_state_RQ-261022-001': '한글', 'preRegStock_v1_state_RQ-261022-002': 'abc',
    ...(options.values || {}) };
  let held = false, writes = 0, scans = 0, pendingChecks = 0;
  const cache = {};
  const props = { getProperty: (key) => values[key] ?? null, getProperties: () => ({ ...values }), deleteProperty: (key) => { delete values[key]; },
    setProperty(key, value) {
      writes++;
      if (options.beforeSet) options.beforeSet(key, value, values);
      if (options.quota || options.scanWriteError && key === scanKey) throw Error(options.scanWriteError || 'property storage quota');
      values[key] = value;
    } };
  const lock = { tryLock() { if (options.lockBusy) return false; if (options.beforeLock) options.beforeLock(values); held = true; return true; },
    releaseLock() { held = false; } };
  const c = { INVENTORY_RISK_PREFIX_: prefix, PropertiesService: { getScriptProperties: () => props },
    CacheService: { getScriptCache: () => ({ put: (key, value) => { if (options.cacheError) throw Error('cache unavailable'); cache[key] = value; } }) },
    Utilities: { newBlob: (text) => { assert.equal(held, false, 'byte calculation must not hold ScriptLock'); return { getBytes: () => [...Buffer.from(text)] }; } },
    LockService: { getScriptLock: () => lock } };
  vm.runInNewContext(source, c);
  const flush = c.flushInventoryRiskAlerts;
  c.flushPreRegistrationStockAlerts = () => { pendingChecks++; return { status: 'pending' }; };
  c.flushInventoryRiskAlerts = () => { scans++; return { status: 'scheduled' }; };
  return { c, flush, values, original, cache, writes: () => writes, scans: () => scans, pendingChecks: () => pendingChecks };
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

test('only actual storage quota replaces the preserved incident error with a smaller ASCII capacity snapshot', () => {
  const e = env({ scanWriteError: 'You have exceeded property storage quota', values: {
    [prefix + 'lastError']: preservedIncidentError,
    'GUIDE_DELIVERY_V3_out_261023_001': 'x'.repeat(250),
    'GUIDE_DELIVERY_V3_out_261022_002': 'x'.repeat(250)
  } });
  const before = { ...e.values }, total = Object.entries(before).reduce((sum, [key, value]) => sum + Buffer.byteLength(key) + Buffer.byteLength(value), 0);
  assert.equal(e.c.inventoryRiskHeartbeat().status, 'scheduled');
  const compact = e.values[prefix + 'lastError'], fields = compact.split('|');
  assert.equal(fields[0], 'capacity-v1');
  assert.equal(Number(fields[1]), Object.keys(before).length);
  assert.equal(Number(fields[2]), total);
  assert.equal(fields[3], 'GUIDE_DELIVERY_V3_out_*');
  assert.equal(Number(fields[5]), 2);
  assert.ok(/^[\x20-\x7e]+$/.test(compact));
  assert.ok(Buffer.byteLength(compact) <= Buffer.byteLength(preservedIncidentError));
  assert.deepEqual(Object.keys(e.values).sort(), Object.keys(before).sort());
  for (const key of Object.keys(before)) if (key !== prefix + 'lastError') assert.equal(e.values[key], before[key]);
  assert.ok(Object.values(e.cache).includes(preservedIncidentError));
  const writes = e.writes();e.c.inventoryRiskHeartbeat();
  assert.equal(e.writes(), writes, 'completed compact diagnostic is captured only once');
});

for (const scenario of ['absent', 'different', 'newer', 'race', 'nonquota', 'lease', 'scanrace']) {
  test('compact quota fallback preserves unrelated/newer error and active work: ' + scenario, () => {
    const errorKey = prefix + 'lastError';
    const options = { scanWriteError: 'property storage quota', values: { [errorKey]: preservedIncidentError } };
    if (scenario === 'absent') options.values = {};
    if (scenario === 'different') options.values[errorKey] = JSON.stringify({ at: '2026-10-21T22:54:33.712Z', message: 'different' });
    if (scenario === 'newer') options.values[errorKey] = JSON.stringify({ at: '2026-10-23T00:00:00Z', message: '재고 경보 전송·상태 확인 필요' });
    if (scenario === 'race') options.beforeLock = (values) => { values[errorKey] = 'new concurrent failure'; };
    if (scenario === 'nonquota') options.scanWriteError = 'Service invoked too many times';
    if (scenario === 'lease') options.beforeSet = (key, _value, values) => { if (key === scanKey) values[prefix + 'lease'] = JSON.stringify({ until: Date.now() + 60000 }); };
    if (scenario === 'scanrace') options.beforeSet = (key, _value, values) => { if (key === scanKey) values[scanKey] = '{"at":"newer"}'; };
    const e = env(options);
    e.c.inventoryRiskHeartbeat();
    assert.ok(!(e.values[errorKey] || '').startsWith('capacity-v1|'));
    assert.equal(e.scans(), 1);
    assert.equal(e.pendingChecks(), 1);
    if (scenario === 'race') assert.equal(e.values[errorKey], 'new concurrent failure');
  });
}

test('optional cache preservation failure never blocks the bounded fallback or heartbeat', () => {
  const e = env({ scanWriteError: 'property storage quota', cacheError: true, values: { [prefix + 'lastError']: preservedIncidentError } });
  assert.equal(e.c.inventoryRiskHeartbeat().status, 'scheduled');
  assert.match(e.values[prefix + 'lastError'], /^capacity-v1\|/);
});
