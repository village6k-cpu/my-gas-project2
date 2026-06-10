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
    typeof status.searchTradeEvents,
    'function',
    'today-dashboard search must expose searchTradeEvents(trades, query)'
  );

  const equipment = (name, scheduleId) => ({
    scheduleId,
    name,
    qty: 1,
    checkoutState: 'taken',
  });

  const trade = {
    tradeId: '260607-001',
    customerName: '김기환',
    customerPhone: '010-1234-5678',
    company: '빌리지 테스트',
    checkoutAt: new Date(2026, 5, 7, 12, 0, 0).toISOString(),
    returnAt: new Date(2026, 5, 8, 14, 0, 0).toISOString(),
    contractStatus: '반출',
    setupDone: true,
    returnDone: false,
    equipments: [equipment('소니 FX3 바디', 'S-1')],
    photos: [],
    riskWarnings: [],
  };

  const events = status.searchTradeEvents([trade], '김기환');

  assert.deepStrictEqual(
    events.map((event) => event.trade.tradeId + ':' + event.phase),
    ['260607-001:checkout', '260607-001:checkin'],
    'search must return both checkout and checkin events for each matching trade'
  );

  assert.deepStrictEqual(
    events.map((event) => event.groupLabel),
    ['2026년 6월 7일 (일) · 반출', '2026년 6월 8일 (월) · 반납'],
    'search events must carry date and phase labels so the UI does not hide the paired side'
  );

  assert.strictEqual(
    status.searchTradeEvents([trade], '12345678').length,
    2,
    'phone search must also expand a matching trade into both events'
  );

  assert.strictEqual(
    status.searchTradeEvents([trade], 'fx3').length,
    2,
    'equipment search must also expand a matching trade into both events'
  );

  console.log('today-dashboard search event static checks passed');
`;

const result = spawnSync(
  process.execPath,
  ['--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', '--input-type=module', '-e', script],
  { encoding: 'utf8' }
);

if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);

assert.strictEqual(result.status, 0, 'today-dashboard search event behavior test must pass');
