const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const root = path.resolve(__dirname, '..');
const loaded = { exports: require('./helpers/load-typescript.cjs').load(path.join(root, 'apps/today-dashboard/lib/domain/status.ts')) };
const { tradesForTab } = loaded.exports;
const at = (day, time = '12:00') => `2026-10-${day}T${time}:00+09:00`;
const trade = (id, checkoutAt, returnAt, contractStatus = '예약') => ({ tradeId: id, checkoutAt, returnAt, contractStatus });
const rows = [
  trade('past', at('19'), at('20')),
  trade('ongoing', at('20'), at('22')),
  trade('today', at('21'), at('21', '23:59')),
  trade('midnight-out', at('22', '00:00'), at('23', '00:00')),
  trade('midnight-return', at('20'), at('21', '00:00')),
  trade('after-midnight', at('22', '00:30'), at('23')),
  trade('future', at('23'), at('24')),
  trade('cancelled', at('21'), at('22'), '취소'),
];
const ids = tab => Array.from(tradesForTab(rows, '2026-10-21', tab), t => t.tradeId);
assert.deepStrictEqual(ids('all').sort(), ['midnight-out', 'ongoing', 'today']);
assert.deepStrictEqual(ids('checkout'), ['today', 'midnight-out']);
assert.deepStrictEqual(ids('checkin'), ['today']);
console.log('today all-tab scope behavior checks passed');
