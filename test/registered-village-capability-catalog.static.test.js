'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const source = fs.readFileSync(path.resolve(__dirname, '..', 'sheetAPI.js'), 'utf8');

test('GAS publishes a compact first-class capability catalog instead of a stale generic-write hint', () => {
  assert.match(source, /case\s+["']capabilities["']/);
  assert.match(source, /function\s+getVillageOperationCapabilities_/);
  assert.match(source, /schedule\.change_dates/);
  assert.match(source, /confirmation_request\.create/);
  assert.match(source, /customer\.send_estimate/);
  assert.match(source, /policy:\s*["']customer_send["']/);
  assert.match(source, /liveSourceDiscoveryAllowed:\s*false/);
  assert.doesNotMatch(source, /available:\s*\{[\s\S]{0,600}write["']/);
});
