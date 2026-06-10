const assert = require('assert');
const { spawnSync } = require('child_process');
const path = require('path');
const { pathToFileURL } = require('url');

const root = path.resolve(__dirname, '..');
const catalogUrl = pathToFileURL(path.join(root, 'apps/today-dashboard/lib/domain/catalog.ts')).href;

const script = `
  import assert from 'node:assert';
  const { normalizeItems } = await import(${JSON.stringify(catalogUrl)});

  const item = (patch) => ({
    scheduleId: patch.scheduleId,
    name: patch.name,
    qty: patch.qty ?? 1,
    checkoutState: patch.checkoutState ?? 'pending',
    setName: patch.setName,
    isSetHeader: patch.isSetHeader,
    isComponent: patch.isComponent,
    category: patch.category,
  });

  const normalized = normalizeItems([
    item({ scheduleId: '260609-009-01', name: 'MOVMAX RAZOR ARM', setName: 'MOVMAX RAZOR ARM', isSetHeader: true, checkoutState: 'taken' }),
    item({ scheduleId: '260609-009-02', name: '아이솔레이터 / 브라켓 / 도브테일 / 나토레일', setName: 'MOVMAX RAZOR ARM', isComponent: true, checkoutState: 'taken' }),
    item({ scheduleId: '260609-009-4802', name: 'MOVMAX RAZOR ARM', checkoutState: 'pending' }),
    item({ scheduleId: '260609-009-4806', name: '소니 FX3 바디세트', checkoutState: 'pending', category: '세트' }),
    item({ scheduleId: '260609-009-05', name: '소니 FX3 바디세트', setName: '소니 FX3 바디세트', isSetHeader: true, checkoutState: 'taken', category: '세트' }),
    item({ scheduleId: '260609-009-06', name: '소니 FX3 바디(케이지)', setName: '소니 FX3 바디세트', isComponent: true, checkoutState: 'taken' }),
    item({ scheduleId: '260609-009-4813', name: '베이비', checkoutState: 'pending' }),
    item({ scheduleId: '260609-009-12', name: '베이비', setName: '베이비', isSetHeader: true, checkoutState: 'taken' }),
    item({ scheduleId: '260609-009-14', name: '롱라인', qty: 2, isSetHeader: true, checkoutState: 'taken' }),
  ]);

  assert.deepStrictEqual(
    normalized.filter((it) => it.name === '소니 FX3 바디세트').map((it) => it.scheduleId),
    ['260609-009-05'],
    'timeline summary FX3 row must be suppressed when dashboard detail header exists'
  );

  assert.deepStrictEqual(
    normalized.filter((it) => it.name === 'MOVMAX RAZOR ARM').map((it) => it.scheduleId),
    ['260609-009-01'],
    'timeline summary set row must be suppressed when detailed set header and components exist'
  );

  assert.deepStrictEqual(
    normalized.filter((it) => it.name === '베이비').map((it) => it.scheduleId),
    ['260609-009-12'],
    'timeline summary single-item row must be suppressed when dashboard detail header exists'
  );

  assert(
    normalized.some((it) => it.scheduleId === '260609-009-06' && it.isComponent),
    'set components must be preserved under the detailed set header'
  );

  assert(
    normalized.some((it) => it.scheduleId === '260609-009-14' && it.name === '롱라인'),
    'non-duplicated dashboard detail rows must stay visible'
  );

  console.log('today-dashboard timeline summary dedupe checks passed');
`;

const result = spawnSync(
  process.execPath,
  ['--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', '--input-type=module', '-e', script],
  { encoding: 'utf8' }
);

if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);

assert.strictEqual(result.status, 0, 'timeline summary dedupe behavior test must pass');
