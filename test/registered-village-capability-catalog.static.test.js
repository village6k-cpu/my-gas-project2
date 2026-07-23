'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { CAPABILITIES } = require('../scripts/windows/village-operation-broker.js');

const source = fs.readFileSync(path.resolve(__dirname, '..', 'sheetAPI.js'), 'utf8');

test('GAS publishes a compact first-class capability catalog instead of a stale generic-write hint', () => {
  assert.match(source, /case\s+["']capabilities["']/);
  assert.match(source, /function\s+getVillageOperationCapabilities_/);
  assert.match(source, /schedule\.change_dates/);
  assert.match(source, /confirmation_request\.create/);
  assert.match(source, /customer\.send_estimate/);
  assert.match(source, /operation\.receipt/);
  assert.match(source, /case\s+["']operationReceipt["']/);
  assert.match(source, /function\s+withVillageOperationReceipt_/);
  assert.match(source, /status:\s*["']in_progress["']/);
  assert.match(source, /verification:\s*["']authoritative_server_ack["']/);
  assert.match(source, /policy:\s*["']customer_send["']/);
  assert.match(source, /liveSourceDiscoveryAllowed:\s*false/);
  assert.doesNotMatch(source, /available:\s*\{[\s\S]{0,600}write["']/);
});

test('every broker API capability has the exact GAS capability binding', () => {
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);
  const gasCapabilities = sandbox.getVillageOperationCapabilities_().capabilities;
  const gasById = new Map(gasCapabilities.map((item) => [item.id, item]));
  assert.equal(gasById.size, gasCapabilities.length, 'GAS capability IDs must be unique');

  for (const [id, spec] of Object.entries(CAPABILITIES)) {
    if (spec.handler !== 'api') continue;
    const gas = gasById.get(id);
    assert.ok(gas, `GAS catalog is missing broker API capability ${id}`);
    assert.equal(gas.action, spec.apiAction, `${id} action`);
    assert.equal(gas.policy, spec.policy, `${id} policy`);
    const gasVerification = gas.verification
      || (gas.policy === 'read_only' ? 'authoritative_read' : 'authoritative_server_ack');
    assert.equal(gasVerification, spec.verification, `${id} verification`);
  }
});

test('GAS operation receipts make a repeated Hermes mutation idempotent', () => {
  const values = {};
  const properties = {
    getProperty: (key) => values[key] ?? null,
    setProperty: (key, value) => { values[key] = String(value); },
    deleteProperty: (key) => { delete values[key]; },
    getProperties: () => ({ ...values })
  };
  const sandbox = {
    console,
    Utilities: {
      DigestAlgorithm: { SHA_256: 'sha256' },
      Charset: { UTF_8: 'utf8' },
      computeDigest: (_algorithm, text) => Array.from(crypto.createHash('sha256').update(text).digest())
        .map((value) => value > 127 ? value - 256 : value)
    },
    PropertiesService: { getScriptProperties: () => properties },
    LockService: {
      getScriptLock: () => ({ waitLock() {}, releaseLock() {} })
    },
    ContentService: {
      MimeType: { JSON: 'json' },
      createTextOutput: (text) => ({
        getContent: () => String(text),
        setMimeType() { return this; }
      })
    }
  };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);
  const operationId = '33333333-3333-4333-8333-333333333333';
  const body = {
    key: 'village2026',
    action: 'addEquip',
    capability: 'equipment.add',
    operationId,
    tid: '260723-010',
    equipName: 'FX3'
  };
  const event = { parameter: {}, postData: { contents: JSON.stringify(body) } };
  let mutations = 0;
  const execute = () => {
    mutations += 1;
    return sandbox.jsonResponse({ success: true, added: true });
  };

  const first = JSON.parse(sandbox.withVillageOperationReceipt_(event, execute).getContent());
  const replay = JSON.parse(sandbox.withVillageOperationReceipt_(event, execute).getContent());
  const receipt = sandbox.readVillageOperationReceipt_(operationId);
  const changed = {
    parameter: {},
    postData: { contents: JSON.stringify({ ...body, equipName: 'FX6' }) }
  };
  const mismatch = JSON.parse(sandbox.withVillageOperationReceipt_(changed, execute).getContent());

  assert.equal(first.success, true);
  assert.equal(replay.idempotentReplay, true);
  assert.equal(receipt.status, 'applied');
  assert.equal(mismatch.status, 'ERROR');
  assert.equal(mutations, 1);

  const failedOperationId = '44444444-4444-4444-8444-444444444444';
  const failedEvent = {
    parameter: {},
    postData: { contents: JSON.stringify({ ...body, operationId: failedOperationId }) }
  };
  let failedCalls = 0;
  sandbox.withVillageOperationReceipt_(failedEvent, () => {
    failedCalls += 1;
    return sandbox.jsonResponse({ ok: false, message: 'rejected' });
  });
  const failedReplay = JSON.parse(sandbox.withVillageOperationReceipt_(failedEvent, () => {
    failedCalls += 1;
    return sandbox.jsonResponse({ success: true });
  }).getContent());
  assert.equal(sandbox.readVillageOperationReceipt_(failedOperationId).status, 'indeterminate');
  assert.equal(failedReplay.status, 'indeterminate');
  assert.equal(failedCalls, 1);

  const invalidBinding = {
    parameter: {},
    postData: { contents: JSON.stringify({
      ...body,
      operationId: '55555555-5555-4555-8555-555555555555',
      capability: 'equipment.typo'
    }) }
  };
  let invalidCalls = 0;
  const invalidResult = JSON.parse(sandbox.withVillageOperationReceipt_(invalidBinding, () => {
    invalidCalls += 1;
    return sandbox.jsonResponse({ success: true });
  }).getContent());
  assert.equal(invalidResult.status, 'ERROR');
  assert.equal(invalidCalls, 0);

  const oldReceiptKey = `village_operation_receipt_v1_${operationId}`;
  const oldReceipt = JSON.parse(values[oldReceiptKey]);
  oldReceipt.updatedAtMs = Date.now() - 31 * 86400000;
  values[oldReceiptKey] = JSON.stringify(oldReceipt);
  values.village_operation_receipt_pruned_at_v1 = '0';
  const pruneEvent = {
    parameter: {},
    postData: { contents: JSON.stringify({
      ...body,
      operationId: `${Math.floor(Date.now() / 1000)}-66666666-6666-4666-8666-666666666666`
    }) }
  };
  sandbox.withVillageOperationReceipt_(pruneEvent, () => sandbox.jsonResponse({ success: true }));
  const expired = JSON.parse(sandbox.handleRequestCore_({
    parameter: { key: 'village2026', action: 'operationReceipt', operationId },
    postData: null
  }).getContent());
  assert.equal(expired.status, 'expired');
  assert.equal(expired.retrySafe, false);
});
