const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const crypto = require('node:crypto');
const code = ts.transpileModule(fs.readFileSync(path.join(__dirname,'../app/api/gas/route.ts'),'utf8'), {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
class Req extends Request { get nextUrl() { return new URL(this.url); } }
function harness(leaseError, authed=true) {
  let gasCalls=0; const tokens=[]; const loaded={exports:{}};
  const db={rpc:async(name,args)=>{
    if(name==='lock_packing_completion'){tokens.push(args.p_token);return {data:!leaseError,error:leaseError};}
    return {data:{done:true,doneAt:'2026-10-28T00:00:00Z',revision:1}};
  },from:()=>({update:()=>({eq:()=>({eq:async()=>({error:null})})})})};
  const deps={'next/server':{NextRequest:Req,NextResponse:Response},'next/cache':{revalidateTag:()=>{},unstable_cache:f=>f},'node:crypto':crypto,
    '@/lib/server/authCache':{isAuthedRequest:async()=>authed},'@/lib/server/inventoryAuditDb':{getInventoryAuditServiceClient:()=>db},'@/lib/server/gasInternalKey.mjs':{getVillageGasInternalKey:()=> 'test-only'}};
  vm.runInNewContext(code,{module:loaded,exports:loaded.exports,require:n=>deps[n],URL,URLSearchParams,Request,Response,AbortSignal,Date,Map,Set,process:{env:{}},console:{error:()=>{}},fetch:async()=>{gasCalls++;return Response.json({setupDone:true,completionRevision:1,setupDoneAt:'2026-10-28T00:00:00Z'});}});
  const post = () => loaded.exports.POST(new Req('https://example.test/api/gas',{method:'POST',body:JSON.stringify({action:'toggleSetup',tid:'261028-999',done:true,mutationId:'same-outbox-request'})}));
  return {post,get:()=>loaded.exports.GET(new Req('https://example.test/api/gas?action=toggleReturn&tid=261028-999&done=true&mutationId=same-outbox-request')),tokens,gasCalls:()=>gasCalls};
}
test('draft/shortage rejection never calls GAS, including legacy GET',async()=>{
  const h=harness({code:'P0001',message:'구성품 준비 미확정'});
  assert.equal((await h.post()).status,409);assert.equal((await h.get()).status,409);assert.equal(h.gasCalls(),0);
});
test('busy and network failures remain retryable; explicit inspection rejection is final',async()=>{
  for(const code of ['55P03','', 'PGRST000']){
    const response=await harness({code,message:'temporary'}).post();assert.equal(response.status,503);assert.equal((await response.json()).retryable,true);
  }
  assert.equal((await (await harness({code:'P0001',message:'incomplete'}).post()).json()).retryable,false);
});
test('same completion mutation uses a stable lease token through retries',async()=>{
  const h=harness(null);assert.equal((await h.post()).status,200);assert.equal((await h.post()).status,200);
  assert.equal(h.tokens.length,2);assert.equal(h.tokens[0],h.tokens[1]);assert.equal(h.gasCalls(),2);
});
test('unauthenticated completion never reaches database or GAS',async()=>{
  const h=harness(null,false);assert.equal((await h.post()).status,401);assert.equal(h.tokens.length,0);assert.equal(h.gasCalls(),0);
});
