import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
const source = fs.readFileSync(new URL('../lib/domain/status.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const module = { exports: {} };
vm.runInNewContext(compiled, { module, exports: module.exports, Date, Intl });
const { timeLabel, shortDate, phaseForDate, timeSortKey, timeBand } = module.exports;
const originalTZ = process.env.TZ;
for (const zone of ['Asia/Seoul', 'UTC', 'America/Los_Angeles']) {
  test(`reservation midnight retains Korean date and 24-hour label in ${zone}`, () => {
    process.env.TZ = zone;
    try {
      const trade = { checkoutAt: '2026-10-21T15:00:00Z', returnAt: '2026-10-22T15:00:00Z' };
      assert.equal(timeLabel(trade.checkoutAt), '00:00 (자정)');
      assert.equal(timeLabel('2026-10-22T00:00:00+09:00'), '00:00 (자정)');
      assert.equal(timeLabel('2026-10-22T00:00:00'), '00:00 (자정)');
      assert.equal(shortDate(trade.checkoutAt), '10/22');
      assert.equal(shortDate(trade.returnAt), '10/23');
      assert.equal(phaseForDate(trade, '2026-10-21'), 'none');
      assert.equal(phaseForDate(trade, '2026-10-22'), 'checkout');
      assert.equal(phaseForDate(trade, '2026-10-23'), 'checkin');
      assert.equal(timeSortKey(trade.checkoutAt), 0);
      assert.equal(timeBand(trade.checkoutAt), '오전');
      assert.equal(timeLabel('2026-10-22T03:00:00Z'), '12:00 (정오)');
      assert.equal(timeLabel('2026-10-22T00:30:00+09:00'), '00:30');
      assert.equal(timeLabel('2026-10-22T23:59:00+09:00'), '23:59');
      assert.equal(timeSortKey('2026-10-22T23:59:00+09:00'), 1439);
      assert.equal(timeBand('2026-10-22T23:59:00+09:00'), '저녁');
      assert.equal(shortDate('2026-12-31T15:00:00Z'), '1/1');
    } finally {
      if (originalTZ === undefined) delete process.env.TZ; else process.env.TZ = originalTZ;
    }
  });
}
