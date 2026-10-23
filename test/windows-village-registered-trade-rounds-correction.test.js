'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeCorrectionInput,
  runRegisteredTradeCorrection,
} = require('../scripts/windows/village-registered-trade-correction.js');

const input = {
  tradeId: '261014-007',
  operationId: '11111111-2222-4333-8444-555555555555',
  roundsChange: { expectedRounds: 3, rounds: 1 },
  sendEstimate: false,
};

test('Windows accepts explicit numeric half rounds without coercion or quarter-round expansion', () => {
  assert.equal(normalizeCorrectionInput({ ...input, roundsChange: { expectedRounds: 3, rounds: 2.5 } }).roundsChange.rounds, 2.5);
  for (const rounds of ['2.5', 2.25, 0.5, Infinity, null]) assert.throws(() => normalizeCorrectionInput({ ...input, roundsChange: { expectedRounds: 3, rounds } }));
});
const config = {
  VILLAGE2_API_URL: 'https://script.google.com/macros/s/synthetic/exec',
  VILLAGE2_API_KEY: 'synthetic',
};
const copy = value => JSON.parse(JSON.stringify(value));

function payload() {
  const before = {
    contract: { startDate: '2026-10-14', startTime: '18:00', endDate: '2026-10-17', endTime: '18:00', rounds: 3, status: '반납완료', discountType: '일반' },
    schedule: { periods: ['2026-10-14|18:00|2026-10-17|18:00'], rows: [{ scheduleId: '261014-007-01', setName: '', name: 'FX3', qty: 2, unitPrice: 60000, isComponent: false }], topLevelQuantities: { FX3: 2 } },
    ledger: null,
  };
  const after = {
    contract: { ...before.contract, rounds: 1, billingRounds: 1 },
    schedule: copy(before.schedule),
    ledger: { rows: 1, amount: 120000, startDate: '2026-10-14', dates: ['2026-10-14'], contractLink: 'https://docs.example/contract', links: ['https://docs.example/contract'] },
  };
  const roundsReadback = {
    expectedRounds: 3, rounds: 1, contractAmount: 120000, ledgerAmount: 120000,
    contractUrl: 'https://docs.example/contract', beforeDigest: 'a'.repeat(64), afterDigest: 'b'.repeat(64),
  };
  return {
    success: true, status: 'CORRECTED', tradeId: input.tradeId, operationId: input.operationId,
    stages: ['contractChangeRounds', 'regenerateContract'],
    contractRegeneration: { success: true, fileId: 'contract', url: 'https://docs.example/contract', finalAmount: 120000, linkUpdate: { success: true } },
    readback: after, authoritativeReadback: { before, after, roundsChange: roundsReadback },
    roundsReadback, customerNotificationSent: false,
  };
}

test('Windows runner accepts only bounded rounds-only input and forwards one existing correction action with no send', async () => {
  const normalized = normalizeCorrectionInput(input);
  assert.deepEqual(normalized.roundsChange, input.roundsChange);
  for (const roundsChange of [
    { expectedRounds: 0, rounds: 1 }, { expectedRounds: 3, rounds: 100 },
    { expectedRounds: 3, rounds: 3 }, { expectedRounds: '3', rounds: 1 },
  ]) assert.throws(() => normalizeCorrectionInput({ ...input, roundsChange }));
  assert.throws(() => normalizeCorrectionInput({ ...input, add: [{ name: 'FX6', qty: 1 }] }), /rounds/i);
  assert.throws(() => normalizeCorrectionInput({ ...input, expectedPeriod: { startDate: '2026-10-14', startTime: '18:00', endDate: '2026-10-17', endTime: '18:00' } }), /rounds/i);
  assert.throws(() => normalizeCorrectionInput({ ...input, sendEstimate: true }), /rounds|send/i);

  const calls = [];
  const result = await runRegisteredTradeCorrection({
    config, input,
    fetchImpl: async (_url, options) => {
      calls.push(JSON.parse(options.body));
      return { ok: true, json: async () => payload() };
    },
  });
  assert.equal(result.verified, true);
  assert.equal(result.send.attempted, false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].action, 'scheduleCorrectRegisteredTrade');
  assert.deepEqual(calls[0].args.roundsChange, input.roundsChange);
});

test('Windows runner requires authoritative rounds, unchanged unrelated state, and generated contract/ledger amount agreement', async () => {
  for (const corrupt of [
    value => { value.readback.contract.rounds = 2; value.authoritativeReadback.after.contract.rounds = 2; },
    value => { value.roundsReadback.ledgerAmount += 1; },
    value => { value.roundsReadback.contractAmount += 1; },
    value => { delete value.readback.contract.billingRounds; },
    value => { value.readback.schedule.rows[0].qty = 3; value.authoritativeReadback.after.schedule.rows[0].qty = 3; },
    value => { delete value.roundsReadback; },
  ]) {
    const bad = payload(); corrupt(bad);
    await assert.rejects(runRegisteredTradeCorrection({
      config, input,
      fetchImpl: async () => ({ ok: true, json: async () => bad }),
    }), /readback/i);
  }
});
