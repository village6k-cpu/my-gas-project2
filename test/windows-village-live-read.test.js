const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const {spawnSync} = require('node:child_process');

const {
  buildAutopilotRequest,
  parseEnv,
  summarizeAutopilotPayload
} = require(path.resolve(__dirname, '..', 'scripts', 'windows', 'village-live-read.js'));

test('native finance selection reads the configured file without a Windows default or real request',t=>{
  const base=fs.realpathSync(os.tmpdir());
  const root=fs.mkdtempSync(path.join(base,'village-native-finance-'));
  t.after(()=>{
    assert.equal(path.dirname(fs.realpathSync(root)),base);
    assert.ok(path.basename(root).startsWith('village-native-finance-'));
    fs.rmSync(root,{recursive:true,force:true});
  });
  const file=path.join(root,'native.env');
  fs.writeFileSync(file,'VILLAGE2_API_URL=https://script.google.com/macros/s/native/exec\nVILLAGE2_API_KEY=native-fixture\n');
  const modulePath=path.resolve(__dirname,'../scripts/windows/village-live-read.js');
  const script=`require(${JSON.stringify(modulePath)}).readLiveRevenue({fetchImpl:async url=>{
    if(new URL(url).searchParams.get('key')!=='native-fixture')throw Error('Wrong configuration');
    return {ok:true,json:async()=>({ok:true,kpi:{revenueThisMonth:3,revenueLastMonth:2,txThisMonth:1,txLastMonth:1}})};
  }}).then(value=>console.log(JSON.stringify(value))).catch(()=>process.exitCode=1);`;
  const child=spawnSync(process.execPath,['-e',script],{env:{...process.env,VILLAGE_FINANCE_ENV:file},encoding:'utf8'});
  assert.equal(child.status,0,'native finance must not open a Windows path');
  assert.equal(JSON.parse(child.stdout).revenueThisMonth,3);
});

test('parseEnv reads the two Village API settings without exposing unrelated values', () => {
  const parsed = parseEnv([
    'UNRELATED=do-not-return',
    'VILLAGE2_API_URL=https://script.google.com/macros/s/example/exec',
    'VILLAGE2_API_KEY="example-key"',
    ''
  ].join('\n'));

  assert.deepEqual(parsed, {
    VILLAGE2_API_URL: 'https://script.google.com/macros/s/example/exec',
    VILLAGE2_API_KEY: 'example-key'
  });
});

test('buildAutopilotRequest permits only the read-only Village autopilot action', () => {
  const request = buildAutopilotRequest({
    VILLAGE2_API_URL: 'https://script.google.com/macros/s/example/exec',
    VILLAGE2_API_KEY: 'example-key'
  });

  const url = new URL(request.url);
  assert.equal(request.method, 'GET');
  assert.equal(url.origin, 'https://script.google.com');
  assert.equal(url.searchParams.get('action'), 'autopilot');
  assert.equal(url.searchParams.get('key'), 'example-key');
  assert.equal(url.searchParams.has('sheet'), false);
  assert.equal(url.searchParams.has('range'), false);
});

test('summarizeAutopilotPayload returns only aggregate revenue fields', () => {
  const summary = summarizeAutopilotPayload({
    ok: true,
    generatedAt: '2026-07-21T04:00:00.000Z',
    kpi: {
      thisMonth: '2026-07',
      lastMonth: '2026-06',
      revenueThisMonth: 15608000,
      revenueLastMonth: 33824000,
      txThisMonth: 42,
      txLastMonth: 80
    },
    todos: [{ customerName: 'must not leak' }],
    reactivation: [{ phone: 'must not leak' }]
  });

  assert.deepEqual(summary, {
    ok: true,
    source: 'Village 2.0 GAS autopilot',
    generatedAt: '2026-07-21T04:00:00.000Z',
    thisMonth: '2026-07',
    lastMonth: '2026-06',
    revenueThisMonth: 15608000,
    revenueLastMonth: 33824000,
    transactionCountThisMonth: 42,
    transactionCountLastMonth: 80,
    revenueDelta: -18216000,
    revenueChangePercent: -53.85525070955535
  });
  assert.equal(JSON.stringify(summary).includes('must not leak'), false);
});

test('summarizeAutopilotPayload rejects incomplete responses instead of guessing', () => {
  assert.throws(
    () => summarizeAutopilotPayload({ ok: true, kpi: { revenueThisMonth: 1 } }),
    /missing required revenue KPI/i
  );
  assert.throws(
    () => summarizeAutopilotPayload({ ok: false, error: 'failed' }),
    /Village autopilot response was not successful/i
  );
});
