import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
const source = fs.readFileSync(new URL('../lib/domain/status.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const module = { exports: {} };
const packingModule = { exports: {} };
const catalogModule = { exports: {} };
vm.runInNewContext(ts.transpileModule(fs.readFileSync(new URL('../lib/domain/packingCatalog.ts', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, { module: catalogModule, exports: catalogModule.exports });
vm.runInNewContext(ts.transpileModule(fs.readFileSync(new URL('../lib/domain/packing.ts', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, { module: packingModule, exports: packingModule.exports, structuredClone, require: name => { assert.equal(name, "./packingCatalog"); return catalogModule.exports; } });
vm.runInNewContext(compiled, { module, exports: module.exports, Date, Intl, require: name => { assert.equal(name, './packing'); return packingModule.exports; } });
const { timeLabel, shortDate, phaseForDate, timeSortKey, timeBand, reservationDay, tradesForTab, searchTradeEvents, tabCounts } = module.exports;
const originalTZ = process.env.TZ;
for (const zone of ['Asia/Seoul', 'UTC', 'America/Los_Angeles']) {
  test(`reservation midnight belongs to previous operating day at 24:00 in ${zone}`, () => {
    process.env.TZ = zone;
    try {
      const trade = { checkoutAt: '2026-10-21T15:00:00Z', returnAt: '2026-10-22T15:00:00Z' };
      assert.equal(timeLabel(trade.checkoutAt), '24:00');
      assert.equal(timeLabel('2026-10-22T00:00:00+09:00'), '24:00');
      assert.equal(timeLabel('2026-10-22T00:00:00'), '24:00');
      assert.equal(shortDate(trade.checkoutAt), '10/21');
      assert.equal(shortDate(trade.returnAt), '10/22');
      assert.equal(phaseForDate(trade, '2026-10-21'), 'checkout');
      assert.equal(phaseForDate(trade, '2026-10-22'), 'checkin');
      assert.equal(phaseForDate(trade, '2026-10-23'), 'none');
      assert.equal(timeSortKey(trade.checkoutAt), 1440);
      assert.equal(timeBand(trade.checkoutAt), '저녁');
      assert.equal(reservationDay('2026-01-01T00:00:00+09:00'), '2025-12-31');
      assert.equal(reservationDay('2028-03-01T00:00:00+09:00'), '2028-02-29');
      assert.equal(reservationDay('2026-03-01T00:00:00+09:00'), '2026-02-28');
      assert.equal(reservationDay('2026-10-22T00:00:01+09:00'), '2026-10-22');
      assert.equal(reservationDay('2026-10-22T00:00:00.001+09:00'), '2026-10-22');
      assert.equal(reservationDay('2026-10-22T00:30:00+09:00'), '2026-10-22');
      const midnight = { ...trade, tradeId: '261019-008', customerName: '권승민', equipments: [], riskWarnings: [] };
      const late = { ...midnight, tradeId: 'late', checkoutAt: '2026-10-21T23:59:00+09:00' };
      assert.deepEqual(Array.from(tradesForTab([midnight, late], '2026-10-21', 'checkout'), t => t.tradeId), ['late', '261019-008']);
      assert.equal(tradesForTab([midnight], '2026-10-21', 'all').length, 1);
      assert.equal(tradesForTab([midnight], '2026-10-22', 'checkin').length, 1);
      assert.equal(tradesForTab([midnight], '2026-10-22', 'checkout').length, 0);
      assert.equal(tradesForTab([midnight], '2026-10-23', 'all').length, 0);
      assert.equal(tabCounts([midnight], '2026-10-21').checkout, 1);
      assert.deepEqual(Array.from(searchTradeEvents([midnight], '권승민'), e => [e.phase, e.date]), [['checkout', '2026-10-21'], ['checkin', '2026-10-22']]);
      assert.equal(midnight.checkoutAt, '2026-10-21T15:00:00Z');
      assert.equal(timeLabel('2026-10-22T03:00:00Z'), '12:00 (정오)');
      assert.equal(timeLabel('2026-10-22T00:30:00+09:00'), '00:30');
      assert.equal(timeLabel('2026-10-22T23:59:00+09:00'), '23:59');
      assert.equal(timeSortKey('2026-10-22T23:59:00+09:00'), 1439);
      assert.equal(timeBand('2026-10-22T23:59:00+09:00'), '저녁');
      assert.equal(shortDate('2026-12-31T15:00:00Z'), '12/31');
    } finally {
      if (originalTZ === undefined) delete process.env.TZ; else process.env.TZ = originalTZ;
    }
  });
}
