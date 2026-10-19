const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const appRoot = path.join(__dirname, '../apps/today-dashboard');
const localRequire = createRequire(path.join(appRoot, 'package.json'));
const ts = localRequire('typescript');
const next = localRequire('next/server');
const normalizePhoneLast8 = x => String(x).replace(/\D/g, '').slice(-8);
const source = fs.readFileSync(path.join(appRoot, 'app/api/lookup/route.ts'), 'utf8');
const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
function load(rows, state) {
  const gasCalls = [];
  const query = { select(){return this;},order(){return this;},eq(){return this;},ilike(){return this;},or(){return this;},neq(){return this;},limit(){return this;},in(){return this;},then(resolve){return Promise.resolve({data:rows,error:null}).then(resolve);} };
  const sb = { from: name => name === 'trades' ? query : {...query,then: resolve => Promise.resolve({data:[],error:null}).then(resolve)} };
  const mod = {exports:{}};
  const env = {LOOKUP_TOKEN:'test-token',NEXT_PUBLIC_SUPABASE_URL:'https://example.supabase.co',SUPABASE_SERVICE_ROLE_KEY:'test-service'};
  vm.runInNewContext(js, {exports:mod.exports,module:mod,process:{env},console,Headers,require:id=>{
    if(id==='next/server')return next;
    if(id==='@supabase/supabase-js')return {createClient:()=>sb};
    if(id.includes('phoneNormalize'))return {normalizePhoneLast8};
    if(id.includes('gasPublic'))return {gasPost:async payload=>{gasCalls.push(payload);if(state instanceof Error)throw state;return state;}};
    throw new Error(id);
  }});
  return {route:mod.exports,gasCalls};
}
const row = (id,status=null) => ({trade_id:id,customer_name:'테스트',customer_phone:'010-1234-5678',amount:10000,checkout_at:'2026-10-20',deposit_status:status,contract_status:'예약'});
const item = (canPay,status='',amount=12000) => ({found:true,canPay,depositStatus:status,amount,paymentMethod:''});
const request = query => new next.NextRequest('https://example.com/api/lookup?'+query,{headers:{'x-lookup-token':'test-token'}});
(async()=>{
  for(const query of ['reservation=PAID','phone=01012345678']){
    const {route}=load([row('PAID')],{success:true,items:{PAID:item(false,'입금완료')}});
    const response=await route.GET(request(query));
    assert.deepEqual((await response.json()).matches,[], 'stale unpaid mirror must not expose ledger-paid trade');
    assert.match(response.headers.get('cache-control'),/no-store/);
  }
  const {route,gasCalls}=load([row('PAID'),row('OPEN')],{success:true,items:{PAID:item(false,'입금완료'),OPEN:item(true,'미입금',24000)}});
  const data=await (await route.GET(request('phone=01012345678'))).json();
  assert.deepEqual(data.matches.map(x=>[x.tradeId,x.amount,x.depositStatus]),[['OPEN',24000,'미입금']]);
  assert.equal(gasCalls.length,1,'one authoritative batch read per lookup');
  for(const failure of [new Error('timeout'),{error:'denied'},null,{success:true,items:{}}]){
    const {route}=load([row('OPEN')],failure);
    assert.equal((await route.GET(request('reservation=OPEN'))).status,502,'unknown authoritative state must block payment');
  }
  const missing=load([row('GONE')],{success:true,items:{GONE:{found:false,canPay:false}}});
  assert.deepEqual((await (await missing.route.GET(request('reservation=GONE'))).json()).matches,[]);
  const paid=load([row('PAID','입금완료')],new Error('must not fetch'));
  assert.deepEqual((await (await paid.route.GET(request('reservation=PAID'))).json()).matches,[]);
  assert.equal(paid.gasCalls.length,0);
  console.log('Toss paid lookup: 10 behavior checks passed');
})().catch(e=>{console.error(e);process.exitCode=1;});
