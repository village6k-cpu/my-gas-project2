import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import './helpers/tsResolve.mjs';
import {stockThreadHash} from '../lib/server/slackStockCore.mjs';
const {scanStockQuestions,confirmStockQuestion,retryConfirmedStockMirrors}=await import('../lib/server/slackStock.ts');
process.env.NEXT_PUBLIC_SUPABASE_URL='https://stock-db.test';process.env.SUPABASE_SERVICE_ROLE_KEY='test-only';process.env.GAS_SYNC_URL='https://gas.test/exec';process.env.VILLAGE_GAS_INTERNAL_KEY='private';process.env.SLACK_BOT_TOKEN='test-only';process.env.SLACK_INVENTORY_OWNER_IDS='UOWNER';
const headers=['구분','장비ID','카테고리','장비명','총보유수량','가용수량','대여중수량','정비중수량','상태','비고'];
const report={id:'report-1',channel:'C123',ts:'100.001',names:['신규 삼각대']};
const messages=[{ts:report.ts,bot_id:'B1',text:'신규 삼각대 실재고?',metadata:{event_type:'preregistration_stock_alert',event_payload:{id:report.id}}},{ts:'101.001',user:'UOWNER',text:'삼각대 1개 있어'}];
const evidence={reportId:report.id,channel:report.channel,ts:report.ts,complete:true,messages};
const plan={reportId:report.id,threadEvidence:evidence,confirmation:{catalogName:'신규 삼각대',stockTotal:1,stockMaintenance:0,category:'삼각대',major:'그립',sourceMessageTs:'101.001',quote:messages[1].text,sourceHash:stockThreadHash(messages)}};
let ledger,receipts,sheet,failAfterAppend,rpcCalls,appendCalls,requests;
const originalFetch=globalThis.fetch;
test.beforeEach(()=>{
 ledger=null;receipts=[];sheet=[];failAfterAppend=false;rpcCalls=0;appendCalls=0;requests=[];
 const gas={PropertiesService:{getScriptProperties:()=>({getProperty:()=> 'private'})},console};
 vm.createContext(gas);vm.runInContext(fs.readFileSync(new URL('../../../sheetAPI.js',import.meta.url),'utf8'),gas);
 gas.jsonResponse=x=>x;gas.invalidateConfirmListCache_=()=>{};
 gas.runFunction=(name)=>{assert.equal(name,'getInventoryStockQuestions');return {success:true,result:{reports:[report],sets:[{name:'신규 삼각대',price:10000,components:[]}],equipment:[]}};};
 gas.readSheet=(name,range)=>{assert.equal(name,'장비마스터');assert.equal(range,'A:L');if(failAfterAppend&&appendCalls){failAfterAppend=false;throw Error('readback offline');}return {headers,data:sheet};};
 gas.syncEquipmentMaster=(rows,append)=>{assert.equal(rows.length,0);appendCalls++;const r=append[0];sheet.push([r.major,r.id,r.category,r.name,r.total,'','',r.maint,r.state,r.note]);return {success:true,updated:0,appended:1,skipped:[]};};
 globalThis.fetch=async(input,options={})=>{
 const url=new URL(typeof input==='string'?input:input.url||input.href),method=options.method||input.method||'GET',body=options.body?JSON.parse(options.body):null;requests.push({url,method,body});
 if(url.hostname==='gas.test')return Response.json(gas.handleRequestCore_({parameter:Object.fromEntries(url.searchParams),...(body?{postData:{contents:JSON.stringify(body)}}:{})}));
 if(url.hostname==='slack.com')throw Error('Slack credentials must remain local');
 const table=url.pathname.split('/').at(-1);let result;
 if(table==='confirm_missing_inventory_stock'){rpcCalls++;ledger={equipment_id:'TRI-900',...body.p_item,state:'정상',note:'',updated_at:'2026-09-14T00:00:00Z'};receipts=[{equipment_id:ledger.equipment_id,synced_at:null,last_attempted_at:null}];result={ok:true,equipmentId:ledger.equipment_id};}
 else if(table==='equipment_ledger')result=ledger;
 else if(table==='inventory_stock_confirmations'){
 if(method==='PATCH'){receipts.forEach(r=>Object.assign(r,body));result=null;}else result=receipts.filter(r=>!r.synced_at);
 }else throw Error('unexpected endpoint '+table);
 return Response.json(result);
 };
});
test.afterEach(()=>globalThis.fetch=originalFetch);
test('owner reply intake stays read-only and real GAS dispatcher receives correct read selectors',async()=>{
 const scan=await scanStockQuestions([evidence]);assert.equal(scan.questions.length,1);assert.equal(rpcCalls,0);
 const preview=await confirmStockQuestion(plan,false);assert.equal(preview.item.stock_total,1);assert.equal(rpcCalls,0);
});
test('post-commit mirror failure retries projection only and reads the actual sheet back',async()=>{
 const result=await confirmStockQuestion(plan,true);assert.equal(result.mirror.pending,true);assert.equal(rpcCalls,1);
 failAfterAppend=true;assert.equal((await retryConfirmedStockMirrors())[0].pending,true);assert.equal(appendCalls,1);assert.equal(receipts[0].synced_at,null);
 const retry=await retryConfirmedStockMirrors();assert.equal(retry[0].verified,true);assert.equal(rpcCalls,1);assert.equal(appendCalls,1);assert.ok(receipts[0].synced_at);
 assert.ok(requests.some(r=>r.url.hostname==='gas.test'&&r.method==='GET'&&r.url.searchParams.get('sheet')==='장비마스터'));
});

test('cloud requires fresh collector evidence and rejects forged report receipts',async()=>{
 await assert.rejects(()=>scanStockQuestions(),/로컬 수집기/);
 const forged={...evidence,messages:[{...messages[0],metadata:{event_type:'preregistration_stock_alert',event_payload:{id:'wrong'}}},messages[1]]};
 const scan=await scanStockQuestions([forged]);assert.equal(scan.questions.length,0);assert.equal(scan.errors.length,1);
 await assert.rejects(()=>confirmStockQuestion({...plan,threadEvidence:undefined},true),/원문 수집/);assert.equal(rpcCalls,0);
});
