import test from 'node:test';import assert from 'node:assert/strict';
import {collectStockThread,scanStockWithLocalCollector,confirmStockWithLocalCollector} from './stock-collector.mjs';
const report={id:'verified-report',channel:'C123',ts:'100.001'};
const root={ts:report.ts,bot_id:'B1',metadata:{event_type:'inventory_risk_alert',event_payload:{id:report.id}}};
const reply={ts:'101.001',user:'UOWNER',text:'2개'};
test('collector paginates the entire verified thread before returning evidence',async()=>{
 const calls=[];const evidence=await collectStockThread(report,async(method,args)=>{calls.push(args);assert.equal(method,'conversations.replies');return args.cursor?{ok:true,messages:[reply]}:{ok:true,messages:[root],has_more:true,response_metadata:{next_cursor:'page2'}};});
 assert.equal(calls.length,2);assert.equal(calls[1].cursor,'page2');assert.deepEqual(evidence.messages,[root,reply]);assert.equal(evidence.complete,true);
 await assert.rejects(()=>collectStockThread(report,async()=>({ok:true,messages:[root],has_more:true})),/전체 조회/);
});
test('confirmation discards AI transcript fields and collects current Slack again',async()=>{
 const sent=[];const api=async body=>{sent.push(body);return body.mode==='stock_reports'?{reports:[report]}:{ok:true};};
 await confirmStockWithLocalCollector({reportId:report.id,confirmation:{sourceHash:'prior-read'},threadEvidence:{messages:[{text:'fabricated'}]},execute:true},false,api,async()=>({ok:true,messages:[root,reply]}));
 assert.equal(sent[1].execute,false);assert.deepEqual(sent[1].threadEvidence.messages,[root,reply]);assert.equal(sent[1].threadEvidence.reportId,report.id);
});
test('stock scan isolates a thread fetch error without hiding other reports',async()=>{
 let threads;const result=await scanStockWithLocalCollector(async body=>body.mode==='stock_reports'?{reports:[report,{...report,id:'other'}]}:(threads=body.threads,{ok:true,questions:[],errors:[]}),async()=>({ok:true,messages:[root,reply]}));
 assert.equal(threads.length,1);assert.equal(result.errors.length,1);assert.equal(result.errors[0].reportId,'other');
});
test('slow paginated stock reads have a total deadline and pass cancellation to transport',async()=>{
 let seenSignal;const started=Date.now();
 const result=await scanStockWithLocalCollector(async()=>({reports:[report]}),async(_m,args,options)=>{seenSignal=options.signal;if(!args.cursor)return {ok:true,messages:[root],has_more:true,response_metadata:{next_cursor:'next'}};await new Promise(resolve=>setTimeout(resolve,90));return {ok:true,messages:[reply]};},{timeoutMs:15});
 assert.ok(seenSignal.aborted);assert.equal(result.errors.length,1);assert.equal(result.questions.length,0);
});

test('report loading and reply validation receive independent stage budgets',async()=>{
 const api=async body=>{await new Promise(resolve=>setTimeout(resolve,70));return body.mode==='stock_reports'?{reports:[report]}:{ok:true,questions:[{report}],errors:[]};};
 const result=await scanStockWithLocalCollector(api,async()=>({ok:true,messages:[root,reply]}),{timeoutMs:120,totalTimeoutMs:500});
 assert.equal(result.questions.length,1);assert.deepEqual(result.errors,[]);
});
test('verified threads with no human reply do not rebuild server inventory context',async()=>{
 const calls=[];
 const result=await scanStockWithLocalCollector(async body=>{calls.push(body.mode);return body.mode==='stock_reports'?{reports:[report],catalogHash:'current-catalog'}:{ok:true,questions:[],errors:[]};},async()=>({ok:true,messages:[root,{ts:'101.002',bot_id:'B2',text:'bot reminder'}]}));
 assert.deepEqual(calls,['stock_reports']);assert.equal(result.catalogHash,'current-catalog');assert.deepEqual(result.questions,[]);
});
test('an overall deadline still bounds all stock stages and names the failing stage',async()=>{
 const began=Date.now();
 await assert.rejects(scanStockWithLocalCollector(async()=>{await new Promise(resolve=>setTimeout(resolve,90));return {reports:[report]};},async()=>({ok:true,messages:[root,reply]}),{timeoutMs:200,totalTimeoutMs:15}),/재고 보고서 조회 시간 초과/);
 assert.ok(Date.now()-began<80);
});
