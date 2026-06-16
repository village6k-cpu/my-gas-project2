const assert = require('assert');
const { spawnSync } = require('child_process');
const path = require('path');
const { pathToFileURL } = require('url');

const root = path.resolve(__dirname, '..');
const statusPath = path.join(root, 'apps/today-dashboard/lib/domain/status.ts');
const statusUrl = pathToFileURL(statusPath).href;

const script = `
  import assert from 'node:assert';

  const status = await import(${JSON.stringify(statusUrl)});
  assert.strictEqual(
    typeof status.tradesForTab,
    'function',
    'today-dashboard must expose tradesForTab(trades, date, tab)'
  );

  const equipment = (scheduleId) => ({
    scheduleId,
    name: '소니 FX3 바디',
    qty: 1,
    checkoutState: 'taken',
  });

  const baseTrade = (tradeId, contractStatus) => ({
    tradeId,
    customerName: '김원석',
    customerPhone: '010-0000-0000',
    company: '',
    checkoutAt: new Date(2026, 5, 17, 6, 0, 0).toISOString(),
    returnAt: new Date(2026, 5, 18, 23, 0, 0).toISOString(),
    contractStatus,
    setupDone: false,
    returnDone: false,
    depositStatus: '미입금',
    paymentWarning: true,
    equipments: [equipment('SCH-' + tradeId)],
    returnCounts: {},
    photos: [],
    riskWarnings: [{ guidanceState: '발송권장' }],
  });

  const cancelled = baseTrade('260615-012', '취소');
  const active = baseTrade('260616-001', '예약');
  const trades = [cancelled, active];

  for (const tab of ['checkout', 'all', 'attention']) {
    assert.deepStrictEqual(
      status.tradesForTab(trades, '2026-06-17', tab).map((trade) => trade.tradeId),
      ['260616-001'],
      'cancelled trades must not render work cards in ' + tab + ' tab'
    );
  }

  assert.deepStrictEqual(
    status.tradesForTab(trades, '2026-06-18', 'checkin').map((trade) => trade.tradeId),
    ['260616-001'],
    'cancelled trades must not render return work cards on the return date'
  );

  assert.deepStrictEqual(
    status.searchTradeEvents(trades, '김원석').map((event) => event.trade.tradeId + ':' + event.phase),
    ['260616-001:checkout', '260616-001:checkin'],
    'cancelled trades must not render operator cards in search results'
  );

  console.log('today-dashboard cancelled work-card checks passed');
`;

const result = spawnSync(
  process.execPath,
  ['--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', '--input-type=module', '-e', script],
  { encoding: 'utf8' }
);

if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);

assert.strictEqual(result.status, 0, 'cancelled work-card behavior test must pass');
