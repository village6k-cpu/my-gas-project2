'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const api = fs.readFileSync(path.join(root, 'sheetAPI.js'), 'utf8');
const availability = fs.readFileSync(path.join(root, 'checkAvailability.js'), 'utf8');
const contractGenerator = fs.readFileSync(path.join(root, 'generatecontract.js'), 'utf8');

test('sheetAPI exposes one first-class registered-trade date mutation', () => {
  assert.match(api, /case\s+["']scheduleChangeDates["']/);
  assert.match(api, /changeRegisteredTradeDates\s*\(/);
  assert.match(api, /postBody\.args/);
});

test('generic writes cannot escape their allowlisted sheet through an A1 qualifier', () => {
  assert.match(api, /function\s+isRangeBoundToSheet_/);
  assert.match(api, /isRangeBoundToSheet_\s*\(wSheet,\s*postBody\.range\)/);
  assert.match(api, /range[^\n]{0,160}(?:sheet|시트)[^\n]{0,160}(?:match|일치|허용)/i);
});

test('date mutation validates under a lock before writing all authoritative layers', () => {
  const start = availability.indexOf('function changeRegisteredTradeDates');
  assert.ok(start >= 0, 'bounded date-change function must exist');
  const nextTopLevel = availability.indexOf('\nfunction ', start + 1);
  const end = nextTopLevel > start ? nextTopLevel : availability.length;
  const body = availability.slice(start, end);

  assert.match(body, /LockService\.getScriptLock\(\)/);
  assert.match(body, /tryLock\s*\(/);
  assert.match(body, /allowConflicts/);
  assert.match(body, /dryRun/);
  assert.match(body, /Utilities\.formatDate\([^\n]+['"]UTC['"][^\n]+['"]yyyy-MM-dd['"]\)/);
  assert.match(body, /getScheduleData/);
  assert.match(body, /equipmentExactMap/);
  assert.match(body, /equipmentSheet\.getRange\(2,\s*1,\s*equipmentLast\s*-\s*1,\s*12\)/);
  assert.doesNotMatch(body, /findEquipment\s*\(/);
  assert.match(body, /setNamesWithComponents/);
  assert.match(body, /UNRESOLVED_INVENTORY/);
  assert.match(body, /계약마스터/);
  assert.match(body, /스케줄상세/);
  assert.match(body, /개고생2_URL/);
  assert.match(body, /거래내역/);
  assert.match(body, /regenerateContractById/);
  assert.match(body, /supaMarkTradeDirty_/);
  assert.match(body, /invalidateDashboardCache/);
  assert.match(body, /invalidateTimelineCache/);
  assert.match(body, /readback/);
  assert.match(body, /rollback|롤백/i);
  assert.match(body, /rollbackRegeneration/);
  assert.match(body, /rollbackReadback/);
  assert.match(body, /rollback verified|rollback 검증 완료/i);
  assert.match(body, /sameRequestedPeriod/);
  assert.match(body, /currentSchedulePeriods/);
  assert.match(body, /ledger[\s\S]{0,500}(?:contractLink|links)/);
  assert.match(body, /customerNotificationSent\s*:\s*false/);

  const preflight = body.indexOf('conflicts');
  const firstWrite = body.search(/\.setValues?\s*\(/);
  assert.ok(preflight >= 0 && firstWrite > preflight, 'availability preflight must precede the first write');
});

test('contract regeneration can require and report a verified ledger link update', () => {
  assert.match(contractGenerator, /function\s+updateContractLink\([^)]*options/);
  assert.match(contractGenerator, /strictLedgerLink/);
  assert.match(contractGenerator, /matchedRows/);
  assert.match(contractGenerator, /linkUpdate/);
  assert.match(contractGenerator, /fileId[\s\S]{0,220}(?:필수|required|missing)/i);
});
