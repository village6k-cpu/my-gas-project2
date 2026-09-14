import test from 'node:test';import assert from 'node:assert/strict';import {hermesPrompt} from '../tools/slack-heybilli-sync/slack-heybilli-sync.mjs';
import {scanStockWithLocalCollector} from '../tools/slack-heybilli-sync/stock-collector.mjs';
const investigations=[{id:'source1',name:'TVLogic 17인치',sourceHash:'hash',kinds:['unknown_equipment']}];
test('native AI runs for investigations alone before the owner replies',()=>{
 const text=hermesPrompt({pending:[],stockQuestions:[],stockInvestigations:investigations,stockCatalog:{equipment:[{id:'MON-012',name:'LVM-170A'}]}},{writeEnabled:true});assert.match(text,/review-stock/);assert.match(text,/LVM-170A/);
});
test('a slow unrelated Slack thread cannot discard already-read AI investigations',async()=>{
 const api=async body=>body.mode==='stock_reports'?{reports:[{id:'r',channel:'C123',ts:'100.001'}],investigations,catalog:{equipment:[]}}:{ok:true,questions:[],errors:[]};
 const result=await scanStockWithLocalCollector(api,async()=>{await new Promise(r=>setTimeout(r,80));throw Error('slow');},{timeoutMs:10});
 assert.deepEqual(result.investigations,investigations);assert.ok(result.errors.length);
});
test('the scan shares an absolute network deadline, leaving time to return collected AI work',async()=>{
 const {scanRequestSignal}=await import('../tools/slack-heybilli-sync/slack-heybilli-sync.mjs');const signal=scanRequestSignal({scanDeadlineMs:Date.now()+10},null,60000);await new Promise(r=>setTimeout(r,20));assert.equal(signal.aborted,true);
});
