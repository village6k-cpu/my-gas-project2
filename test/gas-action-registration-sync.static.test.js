const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

// 새 GAS 액션은 세 곳에 등록해야 동작한다. 하나만 빠져도 앱이 런타임에 죽는다.
//   1) sheetAPI.js  switch case          — GAS가 실제로 처리
//   2) sheetAPI.js  능력 레지스트리       — 영수증/검증 계층이 아는 액션
//   3) 프록시 허용목록(app/api/gas)       — 앱이 통과시켜 주는 액션
// 실제 사고(2026-08): removeEquips를 1·2에만 넣고 3을 빠뜨려 사장 화면에
// "action 'removeEquips' 미허용" 빨간 토스트가 떴다.

const api = read('sheetAPI.js');
const proxy = read('apps/today-dashboard/app/api/gas/route.ts');

function setEntries(source, name) {
  const from = source.indexOf(`const ${name} = new Set([`);
  assert.ok(from >= 0, `${name} 정의를 찾을 수 있어야 한다`);
  const to = source.indexOf(']);', from);
  return new Set(
    source.slice(from, to).match(/"[a-zA-Z][a-zA-Z0-9_]*"/g)?.map((s) => s.slice(1, -1)) ?? [],
  );
}

const proxyWrites = setEntries(proxy, 'WRITE_ACTIONS');
const proxyReads = setEntries(proxy, 'READ_ACTIONS');
const proxyAll = new Set([...proxyWrites, ...proxyReads]);

const capabilityActions = new Set(
  (api.match(/action:\s*"[a-zA-Z][a-zA-Z0-9_]*"/g) ?? []).map((s) => s.split('"')[1]),
);

const switchActions = new Set(
  (api.match(/^\s*case "[a-zA-Z][a-zA-Z0-9_]*":/gm) ?? []).map((s) => s.split('"')[1]),
);

test('프록시가 허용한 액션은 GAS가 실제로 처리할 수 있어야 한다', () => {
  const missing = [...proxyAll].filter((action) => !switchActions.has(action));
  assert.deepEqual(missing, [],
    `프록시는 통과시키는데 GAS switch에 없는 액션 — 호출하면 GAS가 알 수 없는 action으로 실패한다`);
});

test('앱이 쓰는 GAS 액션은 프록시 허용목록에 있어야 한다', () => {
  const store = read('apps/today-dashboard/lib/data/store.ts');
  const used = new Set(
    (store.match(/gasMutation(?:Retrying)?\("([a-zA-Z][a-zA-Z0-9_]*)"/g) ?? [])
      .map((s) => s.match(/"([a-zA-Z0-9_]+)"/)[1]),
  );
  assert.ok(used.size > 0, '앱이 호출하는 액션을 찾을 수 있어야 한다');
  const missing = [...used].filter((action) => !proxyAll.has(action));
  assert.deepEqual(missing, [],
    "앱이 호출하는데 프록시가 막는 액션 — 화면에 \"action '...' 미허용\" 오류가 뜬다");
});

// 원장을 바꾸지 않아 레지스트리 항목이 필요 없는 것들. 새 액션을 여기 넣으려면
// 왜 정책이 필요 없는지 근거가 있어야 한다.
const CAPABILITY_EXEMPT = new Map([
  ['aiParse', '원장을 건드리지 않는 Claude 파싱 호출'],
  ['registerAsync', '등록 자체가 confirmation_request.register(final_registration)로 등록돼 있는 예약 래퍼'],
  ['onsiteAddon', 'sheetAPI에서 recordOnsiteAddon과 같은 핸들러 별칭 — 레지스트리는 정식 이름으로 등록됨'],
]);

// 이 배치 작업 이전부터 레지스트리 항목이 없던 쓰기 액션들. 정책(영수증/검증)을 붙일지는
// 별도 판단이 필요해 여기 남긴다. 새로 추가되는 액션은 위 테스트가 계속 잡는다.
const CAPABILITY_KNOWN_GAPS = new Set([
  'updateTrade',
  'updateTradeDiscount',
  'repairTradeProjection',
]);

test('쓰기 액션은 능력 레지스트리에도 등록돼야 한다', () => {
  // 레지스트리는 영수증/검증 정책이 붙는 곳이다. 빠지면 정책 없이 쓰기가 통과한다.
  const missing = [...proxyWrites].filter((action) =>
    !capabilityActions.has(action) && !CAPABILITY_EXEMPT.has(action) && !CAPABILITY_KNOWN_GAPS.has(action));
  assert.deepEqual(missing, [],
    '프록시가 쓰기로 통과시키는데 sheetAPI 능력 레지스트리에 없는 액션');
});

test('레지스트리 면제 목록이 낡지 않았다', () => {
  // 면제였던 액션이 나중에 레지스트리에 들어갔다면 면제를 지워야 가드가 계속 산다.
  const stale = [...CAPABILITY_EXEMPT.keys(), ...CAPABILITY_KNOWN_GAPS]
    .filter((action) => capabilityActions.has(action) || !proxyWrites.has(action));
  assert.deepEqual(stale, [], '더 이상 필요 없는 면제/기존누락 표시는 지워야 한다');
});

test('이번 사고 회귀: removeEquips가 세 곳 모두에 있다', () => {
  assert.ok(switchActions.has('removeEquips'), 'GAS switch case');
  assert.ok(capabilityActions.has('removeEquips'), 'GAS 능력 레지스트리');
  assert.ok(proxyWrites.has('removeEquips'), '프록시 쓰기 허용목록');
  // 단건 경로도 함께 살아 있어야 한다(배치 실패 시 재시도 경로).
  assert.ok(switchActions.has('removeEquip') && proxyWrites.has('removeEquip'));
});
