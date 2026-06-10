const assert = require('assert');
const fs = require('fs');
const { spawnSync } = require('child_process');
const path = require('path');
const { pathToFileURL } = require('url');

const root = path.resolve(__dirname, '..');
const repairPath = path.join(root, 'apps/today-dashboard/lib/data/timelineMerge.ts');
const syncPath = path.join(root, 'apps/today-dashboard/lib/data/sync.ts');

assert(
  fs.existsSync(repairPath),
  'timeline equipment repair helper must exist so cached 0/0 equipment trades can be restored from GAS timeline data'
);

const repairUrl = pathToFileURL(repairPath).href;
const script = `
  import assert from 'node:assert';

  const { mergeTimelineTradeSnapshot, shouldRestoreMissingTimelineEquipments } = await import(${JSON.stringify(repairUrl)});

  const equipment = (name, scheduleId) => ({
    scheduleId,
    name,
    qty: 1,
    checkoutState: 'taken',
  });

  const existing = {
    tradeId: '260609-008',
    customerName: '박세현',
    customerPhone: '1053189025',
    checkoutAt: '2026-06-11T05:00:00.000Z',
    returnAt: '2026-06-14T05:00:00.000Z',
    contractStatus: '예약',
    setupDone: true,
    setupDoneAt: '2026-06-10T01:00:00.000Z',
    returnDone: false,
    paymentMethod: '계좌이체',
    noteCheckout: '반출 메모 보존',
    returnCounts: { '기존 품목': { good: 1, damaged: 0, lost: 0 } },
    equipments: [],
    photos: [],
    riskWarnings: [],
  };

  const timeline = {
    ...existing,
    customerPhone: '010-5318-9025',
    amount: 150000,
    equipments: [
      equipment('소니 A7S3 바디세트', '260609-008-2'),
      equipment('NP-FZ100', '260609-008-6'),
    ],
  };

  assert.strictEqual(
    shouldRestoreMissingTimelineEquipments(existing, timeline),
    true,
    'empty cached equipment list must be marked repairable when timeline has items'
  );

  const repaired = mergeTimelineTradeSnapshot(existing, timeline);
  assert.deepStrictEqual(
    repaired.equipments.map((item) => item.name),
    ['소니 A7S3 바디세트', 'NP-FZ100'],
    'empty cached equipment list must be restored from timeline items'
  );
  assert.strictEqual(repaired.setupDone, true, 'checkout completion state must stay preserved');
  assert.strictEqual(repaired.paymentMethod, '계좌이체', 'payment state must stay preserved');
  assert.deepStrictEqual(repaired.returnCounts, existing.returnCounts, 'return counts must stay preserved');
  assert.strictEqual(repaired.customerPhone, '010-5318-9025', 'fresh customer phone should still be refreshed');

  const alreadyDetailed = {
    ...existing,
    equipments: [equipment('현장 추가 라인', 'local-1')],
  };
  const preserved = mergeTimelineTradeSnapshot(alreadyDetailed, timeline);
  assert.deepStrictEqual(
    preserved.equipments.map((item) => item.name),
    ['현장 추가 라인'],
    'non-empty equipment lists must not be overwritten by timeline polling'
  );

  console.log('today-dashboard missing equipment repair checks passed');
`;

const result = spawnSync(
  process.execPath,
  ['--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', '--input-type=module', '-e', script],
  { encoding: 'utf8' }
);

if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);

assert.strictEqual(result.status, 0, 'today-dashboard missing equipment repair behavior test must pass');

const syncSource = fs.readFileSync(syncPath, 'utf8');
assert(
  syncSource.includes('shouldRestoreMissingTimelineEquipments(ex, tl)'),
  'pollTimelineChanges must detect empty cached equipment lists during timeline polling'
);
assert(
  syncSource.includes('mergeTimelineTradeSnapshot(ex, tl)'),
  'pollTimelineChanges must use the repair merge helper while preserving ops state'
);
