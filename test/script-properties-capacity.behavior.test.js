'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'supabaseSync.js'), 'utf8');

test('property audit measures UTF-8 storage by category without exposing stored values', () => {
  const all = {
    SUPABASE_SERVICE_KEY: 'never-return-this-secret',
    'preRegStock_v1_state_RQ-261022-001': '한글',
    'preRegStock_v1_state_RQ-261022-002': 'abc',
    'village_operation_receipt_v1_abc-def': 'receipt-content',
  };
  const context = {
    PropertiesService: { getScriptProperties: () => ({ getProperties: () => ({ ...all }) }) },
    Utilities: { newBlob: (value) => ({ getBytes: () => [...Buffer.from(value, 'utf8')] }) },
    Logger: { log() {} },
  };
  vm.runInNewContext(source.slice(source.indexOf('var SUPA_SYNC_ATTEMPT_'), source.indexOf('/** 거래ID 배열', source.indexOf('var SUPA_SYNC_ATTEMPT_'))) + '\n' + source.slice(source.indexOf('function auditScriptProperties()'), source.indexOf('function cleanupOldTradeProps(')), context);
  const result = JSON.parse(JSON.stringify(context.auditScriptProperties()));
  assert.equal(result.propertyCount, 4);
  assert.equal(result.storage.valueBytes, 48);
  assert.equal(result.storage.totalBytes, Object.entries(all).reduce((n, [key, value]) => n + Buffer.byteLength(key) + Buffer.byteLength(value), 0));
  assert.deepEqual(result.storage.categories.find((row) => row.prefix === 'preRegStock_v1_state_*'), {
    prefix: 'preRegStock_v1_state_*', count: 2, keyBytes: 68, valueBytes: 9, totalBytes: 77,
  });
  assert.ok(result.storage.largest.every((row) => typeof row.key === 'string' && row.totalBytes > 0 && !('value' in row)));
  for (const value of ['never-return-this-secret', '한글', 'receipt-content']) assert.ok(!JSON.stringify(result).includes(value));
});
