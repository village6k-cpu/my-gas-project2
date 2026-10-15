'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const gas = fs.readFileSync(path.resolve(__dirname, '../checkAvailability.js'), 'utf8');
const sheetApi = fs.readFileSync(path.resolve(__dirname, '../sheetAPI.js'), 'utf8');

function functionBody(name, nextName) {
  const start = gas.indexOf(`function ${name}`);
  const end = gas.indexOf(`\nfunction ${nextName}`, start + 1);
  assert.ok(start >= 0 && end > start, `${name} section missing`);
  return gas.slice(start, end);
}

test('rounds correction is narrow, lock-scoped to the exact I-cell, and regenerates strictly after unlock', () => {
  const body = functionBody('correctRegisteredTradeRounds_', 'repairRegisteredTradeCatalogPrices');
  const lockAt = body.indexOf('lock.tryLock(');
  const writeAt = body.indexOf('getRange(snapshot.contractRow, 9).setValue(correction.roundsChange.rounds)');
  const releaseAt = body.indexOf('lock.releaseLock()');
  const regenAt = body.indexOf("regenerateContractById(correction.tradeId, undefined, { strictLedgerLink: true })");
  assert.ok(lockAt >= 0 && writeAt > lockAt && releaseAt > writeAt && regenAt > releaseAt,
    'the exact contract I-cell write must be inside ScriptLock and strict regeneration must be after release');
  assert.doesNotMatch(body, /sendEstimate|sendRegisteredTradeCorrectionNotification_/);
  assert.match(body, /readRegisteredTradeRoundsSnapshot_/);
  assert.match(body, /readRegisteredTradePriceLedger_/);
});

test('rounds correction reuses schedule.correct_registered_trade without registering a generic writer', () => {
  assert.equal((sheetApi.match(/id: "schedule\.correct_registered_trade"/g) || []).length, 1);
  assert.equal((sheetApi.match(/action: "scheduleCorrectRegisteredTrade"/g) || []).length, 1);
  assert.doesNotMatch(sheetApi, /schedule\.change_rounds|scheduleChangeRounds|generic.*sheet.*write/i);
});
