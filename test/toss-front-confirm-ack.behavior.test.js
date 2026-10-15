const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const root = path.resolve(__dirname, '..');
const localRequire = createRequire(path.join(root, 'apps/today-dashboard/package.json'));
const ts = localRequire('typescript');
const next = localRequire('next/server');
const source = fs.readFileSync(path.join(root, 'apps/today-dashboard/app/api/lookup/confirm/route.ts'), 'utf8');
const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
function load(gasResult) {
  const m = { exports: {} };
  const original = process.env.LOOKUP_TOKEN;
  process.env.LOOKUP_TOKEN = 'test-token';
  try {
    new Function('require', 'module', 'exports', js)((id) => id === 'next/server' ? next : { gasPost: async () => gasResult }, m, m.exports);
  } finally {
    if (original == null) delete process.env.LOOKUP_TOKEN;
    else process.env.LOOKUP_TOKEN = original;
  }
  return m.exports;
}
function request(body, token = 'test-token') {
  return new next.NextRequest('http://localhost/api/lookup/confirm', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-lookup-token': token }, body: JSON.stringify(body),
  });
}
(async () => {
  const oldError = console.error;
  console.error = () => {};
  try {
    for (const failure of [{ error: '인증 실패' }, { success: false, wroteSheet: false, warning: '거래ID 없음' }, {}, null]) {
      const res = await load(failure).POST(request({ tradeId: '261008-008' }));
      assert.equal(res.status, 502, 'GAS HTTP 200 semantic failure must retain terminal pending payment');
      assert.ok((await res.json()).error);
    }
    const route = load({ success: true, wroteSheet: true });
    assert.equal((await route.POST(request({ tradeId: '261008-008' }))).status, 200);
    assert.equal((await route.POST(request(null))).status, 400);
    assert.equal((await route.POST(request({ tradeId: '261008-008', method: '현금' }))).status, 400);
    assert.equal((await route.POST(request({ tradeId: '261008-008' }, 'wrong'))).status, 401);
    assert.ok(route.maxDuration > 60);
  } finally { console.error = oldError; }
  console.log('Toss confirm authoritative acknowledgement: 8 checks passed');
})().catch((error) => { console.error(error); process.exitCode = 1; });
