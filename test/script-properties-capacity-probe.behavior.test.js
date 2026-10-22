'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '..', 'supabaseSync.js'), 'utf8');
const uuid = '01234567-89ab-4def-8123-0123456789ab';
const key = 'scriptPropertiesCapacityProbe_v1_' + uuid;

function probe(options = {}, bytes) {
  const values = new Map([['village_operation_receipt_v1_protected', 'receipt'], ['active_lease', 'active']]);
  if (options.collision) values.set(key, 'preexisting');
  const calls = { set: [], deleted: [], gets: 0, locks: 0, releases: 0 };
  let locked = false;
  const props = {
    getProperty(name) {
      assert.equal(locked, true, 'every read must hold ScriptLock');
      calls.gets++;
      if (options.ownershipRace && calls.gets === 3) values.set(name, 'foreign-value');
      return values.has(name) ? values.get(name) : null;
    },
    setProperty(name, value) {
      assert.equal(locked, true);
      calls.set.push({ name, value });
      if (options.quota) throw new Error('You have exceeded the property storage quota. Please remove some properties and try again.');
      values.set(name, value);
      if (options.uncertainWrite) throw new Error('private transport detail');
    },
    deleteProperty(name) {
      assert.equal(locked, true);
      calls.deleted.push(name);
      if (options.cleanupFailure) throw new Error('private cleanup detail');
      if (!options.deleteNoop) values.delete(name);
    },
  };
  const context = {
    PropertiesService: { getScriptProperties: () => props },
    Utilities: { getUuid: () => uuid },
    LockService: { getScriptLock: () => ({
      tryLock(ms) { calls.locks++; assert.ok(ms <= 1500); locked = !options.busy; return locked; },
      releaseLock() { calls.releases++; locked = false; },
    }) },
  };
  vm.runInNewContext(source.slice(source.indexOf('function probeScriptPropertiesCapacity('), source.indexOf('function cleanupOldTradeProps(')), context);
  const result = JSON.parse(JSON.stringify(context.probeScriptPropertiesCapacity(bytes)));
  assert.equal(values.get('village_operation_receipt_v1_protected'), 'receipt');
  assert.equal(values.get('active_lease'), 'active');
  assert.ok(calls.deleted.every((name) => name === key));
  assert.ok(!JSON.stringify(result).includes('private'));
  return { result, values, calls };
}

test('capacity probe creates one bounded 128-byte record, verifies it, and deletes only its exact owned value', () => {
  const { result, values, calls } = probe();
  assert.equal(result.ok, true);
  assert.equal(result.capacity, 'available');
  assert.equal(result.cleanup, 'deleted_verified');
  assert.equal(result.valueBytes, 128);
  assert.equal(result.otherKeysDeleted, 0);
  assert.equal(calls.set.length, 1);
  assert.equal(Buffer.byteLength(calls.set[0].value), 128);
  assert.equal(calls.set[0].name, key);
  assert.equal(calls.deleted.length, 1);
  assert.equal(calls.releases, 1);
  assert.equal(values.has(key), false);
});

test('capacity probe reports an actual storage quota rejection without another write or deleting unrelated data', () => {
  const { result, calls } = probe({ quota: true });
  assert.equal(result.ok, false);
  assert.equal(result.capacity, 'quota_exceeded');
  assert.equal(result.cleanup, 'absent');
  assert.equal(calls.set.length, 1);
  assert.equal(calls.deleted.length, 0);
  assert.equal(calls.releases, 1);
});

test('capacity probe preserves a changed owner instead of deleting it', () => {
  const { result, values, calls } = probe({ ownershipRace: true });
  assert.equal(result.ok, false);
  assert.equal(result.cleanup, 'ownership_changed');
  assert.equal(calls.deleted.length, 0);
  assert.equal(values.get(key), 'foreign-value');
});

test('capacity probe reports cleanup failures and leaves its exact key for explicit recovery', () => {
  const { result, values, calls } = probe({ cleanupFailure: true });
  assert.equal(result.ok, false);
  assert.equal(result.capacity, 'available');
  assert.equal(result.cleanup, 'failed');
  assert.equal(result.probeKey, key);
  assert.equal(values.has(key), true);
  assert.equal(calls.set.length, 1);
  assert.equal(calls.deleted.length, 1);
  assert.equal(calls.releases, 1);
});

test('capacity probe requires deletion readback and never retries a failed deletion', () => {
  const { result, values, calls } = probe({ deleteNoop: true });
  assert.equal(result.ok, false);
  assert.equal(result.cleanup, 'delete_not_confirmed');
  assert.equal(values.has(key), true);
  assert.equal(calls.deleted.length, 1);
});

test('capacity probe preserves a preexisting UUID key and does not generate a second attempt', () => {
  const { result, values, calls } = probe({ collision: true });
  assert.equal(result.ok, false);
  assert.equal(result.capacity, 'unknown');
  assert.equal(result.reason, 'key_collision');
  assert.equal(values.get(key), 'preexisting');
  assert.equal(calls.set.length, 0);
  assert.equal(calls.deleted.length, 0);
});

test('capacity probe classifies uncertain writes as unknown and cleans only a proven owned partial write', () => {
  const { result, values, calls } = probe({ uncertainWrite: true });
  assert.equal(result.ok, false);
  assert.equal(result.capacity, 'unknown');
  assert.equal(result.cleanup, 'deleted_verified');
  assert.equal(calls.set.length, 1);
  assert.equal(calls.deleted.length, 1);
  assert.equal(values.has(key), false);
});

test('capacity probe returns busy without touching storage when the lock is unavailable', () => {
  const { result, calls } = probe({ busy: true });
  assert.equal(result.reason, 'busy');
  assert.equal(calls.gets, 0);
  assert.equal(calls.set.length, 0);
  assert.equal(calls.releases, 0);
});

test('capacity probe rejects unbounded or invalid requests before acquiring a lock or writing', () => {
  for (const bytes of [0, 63, 129, 1000000, NaN, Infinity, 'private-invalid', 127.5]) {
    const { result, calls } = probe({}, bytes);
    assert.equal(result.reason, 'invalid_probe_size');
    assert.equal(calls.locks, 0);
    assert.equal(calls.set.length, 0);
  }
});
