const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const crypto = require('node:crypto');
class Req extends Request { get nextUrl() { return new URL(this.url); } }
const code = ts.transpileModule(fs.readFileSync(path.join(__dirname,'../app/api/gas/route.ts'),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
const version = '2026-11-04T04:43:11.326978+00:00';
const payload = {action:'toggleItems',tid:'261023-011',items:JSON.stringify([{scheduleId:'261023-011-02',done:true,expectedUpdatedAt:version,mutationId:'click-1'}])};
function harness({authed=true,result,error}={}) {
 const calls=[]; let gasCalls=0; const module={exports:{}};
 const deps={'next/server':{NextRequest:Req,NextResponse:Response},'next/cache':{revalidateTag(){},unstable_cache:f=>f},'node:crypto':crypto,
 '@/lib/server/authCache':{isAuthedRequest:async()=>authed},'@/lib/server/inventoryAuditDb':{getInventoryAuditServiceClient:()=>({rpc:async(name,args)=>{calls.push({name,args});return {data:result??{success:true,tradeId:payload.tid,results:[{scheduleId:'261023-011-02',ok:true,applied:true,checked:true,updatedAt:version}]},error};}})},
 '@/lib/server/gasInternalKey.mjs':{getVillageGasInternalKey(){throw Error('item checks must not need GAS');}}};
 vm.runInNewContext(code,{module,exports:module.exports,require:n=>deps[n],URL,URLSearchParams,Request,Response,AbortSignal,Date,Map,Set,process:{env:{}},console:{error(){}},fetch:async()=>{gasCalls++;throw Error('property storage quota');}});
 return {calls,gasCalls:()=>gasCalls,post:body=>module.exports.POST(new Req('https://example.test/api/gas',{method:'POST',body:JSON.stringify(body??payload)})),get:()=>module.exports.GET(new Req('https://example.test/api/gas?'+new URLSearchParams(payload)))};
}
test('본체 체크는 GAS 속성 공간과 무관하게 정본 CAS에 저장한다 (POST/기존 GET)',async()=>{
 const h=harness();for(const call of [h.post,h.get]) {const r=await call();assert.equal(r.status,200);assert.equal((await r.json()).results[0].checked,true);}
 assert.equal(h.gasCalls(),0);assert.equal(h.calls.length,2);assert.equal(h.calls[0].name,'apply_checkout_item_checks');
 assert.equal(h.calls[0].args.p_items[0].expectedUpdatedAt,version,'microseconds stay exact');
});
test('직원 인증·행 기준 토큰 검증은 유지한다',async()=>{
 const unauth=harness({authed:false});assert.equal((await unauth.post()).status,401);assert.equal(unauth.calls.length,0);
 for(const items of ['[]','not json',JSON.stringify([{scheduleId:'other-trade-1',done:true,expectedUpdatedAt:version}]),JSON.stringify([{scheduleId:'261023-011-02',done:true}])]){
 const h=harness();assert.equal((await h.post({...payload,items})).status,400);assert.equal(h.calls.length,0);}
});
test('DB 일시 장애는 실패 완료로 확정하지 않고 재시도한다',async()=>{
 const h=harness({error:{code:'PGRST000',message:'temporary'}});const r=await h.post();assert.equal(r.status,503);assert.equal((await r.json()).retryable,true);
});
test('본체 체크 저장 중에도 구성품 클릭을 수락하고 구조 변경만 막는다',async()=>{
 const source=fs.readFileSync(path.join(__dirname,'../lib/data/store.ts'),'utf8');
 const start=source.indexOf('export function savePackingCheck('),end=source.indexOf('export async function savePacking(',start);
 const module={exports:{}};let queued=0;
 const context={module,exports:module.exports,activeTradeTransitions:new Set(),pendingRemoveEquipmentTrades:new Set(),hasTradePending:()=>true,packingCheckQueue:{pending:()=>false,check:async()=>{queued++;}}};
 vm.runInNewContext(ts.transpileModule(source.slice(start,end),{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText,context);
 await module.exports.savePackingCheck(payload.tid,'line',true);assert.equal(queued,1);
 context.activeTradeTransitions.add(payload.tid);await assert.rejects(module.exports.savePackingCheck(payload.tid,'line',true));assert.equal(queued,1);
});
