const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { createRequire } = require('module');

const root = path.resolve(__dirname, '..');
const dashboardRoot = path.join(root, 'apps/today-dashboard');
const dashboardRequire = createRequire(path.join(dashboardRoot, 'package.json'));
const ts = dashboardRequire('typescript');
const nextServer = dashboardRequire('next/server');
const routeFile = path.join(dashboardRoot, 'app/api/lookup/cancel/route.ts');
const routeSource = fs.readFileSync(routeFile, 'utf8');

function loadRoute({ lookupToken, gasPost }) {
  const compiled = ts.transpileModule(routeSource, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true
    },
    fileName: routeFile
  }).outputText;
  const routeModule = { exports: {} };
  const localRequire = (id) => {
    if (id === 'next/server') return nextServer;
    if (id === '@/lib/server/gasPublic') return { gasPost };
    return dashboardRequire(id);
  };
  const wrapper = new Function('require', 'module', 'exports', '__filename', '__dirname', compiled);
  const previousToken = process.env.LOOKUP_TOKEN;
  if (lookupToken == null) delete process.env.LOOKUP_TOKEN;
  else process.env.LOOKUP_TOKEN = lookupToken;
  try {
    wrapper(localRequire, routeModule, routeModule.exports, routeFile, path.dirname(routeFile));
  } finally {
    if (previousToken == null) delete process.env.LOOKUP_TOKEN;
    else process.env.LOOKUP_TOKEN = previousToken;
  }
  return routeModule.exports;
}

function request(body, token = 'route-token') {
  const headers = { 'content-type': 'application/json' };
  if (token != null) headers['x-lookup-token'] = token;
  return new nextServer.NextRequest('http://localhost/api/lookup/cancel', {
    method: 'POST',
    headers,
    body
  });
}

function assertCors(response) {
  assert.strictEqual(response.headers.get('access-control-allow-origin'), '*');
  assert.match(response.headers.get('access-control-allow-methods') || '', /POST/);
  assert.match(response.headers.get('access-control-allow-headers') || '', /x-lookup-token/i);
}

async function responseJson(response, expectedStatus) {
  assert.strictEqual(response.status, expectedStatus);
  assertCors(response);
  return response.json();
}

async function run() {
  let gasCalls = 0;
  const noConfig = loadRoute({
    lookupToken: null,
    gasPost: async () => { gasCalls += 1; }
  });
  const noConfigBody = await responseJson(
    await noConfig.POST(request(JSON.stringify({ tradeId: 'trade-1', paymentKey: 'pay-1' }), null)),
    503
  );
  assert.match(noConfigBody.error, /LOOKUP_TOKEN/);
  assert.strictEqual(gasCalls, 0);

  const gasPayloads = [];
  const route = loadRoute({
    lookupToken: 'route-token',
    gasPost: async (payload) => {
      gasPayloads.push(payload);
      return { ok: true, updated: 1 };
    }
  });

  const preflight = await route.OPTIONS();
  assert.strictEqual(preflight.status, 204);
  assertCors(preflight);

  await responseJson(
    await route.POST(request(JSON.stringify({ tradeId: 'trade-1', paymentKey: 'pay-1' }), 'wrong')),
    401
  );
  await responseJson(await route.POST(request('{')), 400);
  await responseJson(await route.POST(request('null')), 400);
  await responseJson(await route.POST(request('[]')), 400);
  await responseJson(
    await route.POST(request(JSON.stringify({ tradeId: '  ', paymentKey: 'pay-1' }))),
    400
  );
  await responseJson(
    await route.POST(request(JSON.stringify({ tradeId: 'trade-1', paymentKey: '  ' }))),
    400
  );
  assert.strictEqual(gasPayloads.length, 0);

  const success = await responseJson(
    await route.POST(request(JSON.stringify({
      tradeId: ' trade-1 ',
      paymentKey: ' pay-1 ',
      amount: 11000,
      cancelApprovalNumber: 'cancel-approval-1'
    }))),
    200
  );
  assert.deepStrictEqual(gasPayloads, [{
    action: 'updateTradeProof',
    tid: 'trade-1',
    field: 'depositStatus',
    value: '환불'
  }]);
  assert.deepStrictEqual(success, {
    ok: true,
    tradeId: 'trade-1',
    paymentKey: 'pay-1',
    amount: 11000,
    cancelApprovalNumber: 'cancel-approval-1',
    depositStatus: '환불',
    gasResult: { ok: true, updated: 1 }
  });

  const semanticFailureRoute = loadRoute({
    lookupToken: 'route-token',
    gasPost: async () => ({ error: '거래내역에서 거래ID를 찾지 못했습니다.' })
  });
  const originalConsoleError = console.error;
  console.error = () => {};
  try {
    const semanticFailure = await responseJson(
      await semanticFailureRoute.POST(
        request(JSON.stringify({ tradeId: 'missing-trade', paymentKey: 'pay-1' }))
      ),
      502
    );
    assert.match(semanticFailure.error, /거래ID/);
  } finally {
    console.error = originalConsoleError;
  }

  const failingRoute = loadRoute({
    lookupToken: 'route-token',
    gasPost: async () => { throw new Error('mock GAS failure'); }
  });
  console.error = () => {};
  try {
    const failed = await responseJson(
      await failingRoute.POST(request(JSON.stringify({ tradeId: 'trade-1', paymentKey: 'pay-1' }))),
      502
    );
    assert.match(failed.error, /mock GAS failure/);
  } finally {
    console.error = originalConsoleError;
  }

  console.log('toss-front lookup cancel route checks passed');
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
