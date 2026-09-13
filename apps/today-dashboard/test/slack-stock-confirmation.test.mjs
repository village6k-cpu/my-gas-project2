import test from 'node:test';
import assert from 'node:assert/strict';
import {validateStockConfirmation,stockThreadHash,stockGasRequest,stockQuestionBatch} from '../lib/server/slackStockCore.mjs';
const context={report:{id:'report-1',channel:'C123',ts:'100.001',names:['신규 삼각대']},ownerIds:['UOWNER'],messages:[{ts:'100.001',bot_id:'B1',text:'실재고 몇 개인가요?'},{ts:'101.001',user:'UOWNER',text:'삼각대 1개 있어'}],catalog:[{name:'신규 삼각대',components:[]}],equipment:[]};
const plan={catalogName:'신규 삼각대',stockTotal:1,stockMaintenance:0,category:'삼각대',major:'그립',sourceMessageTs:'101.001',quote:'삼각대 1개 있어',sourceHash:stockThreadHash(context.messages)};
test('native AI interpretation is accepted with whole owner reply and current report evidence',()=>{const r=validateStockConfirmation(plan,context);assert.equal(r.stockTotal,1);assert.equal(r.catalogName,'신규 삼각대');});
test('stock confirmation rejects staff, stale edited replies, fabricated quotes and unrelated catalog',()=>{
 for(const [p,c] of [[plan,{...context,ownerIds:['USTAFF']}],[{...plan,sourceHash:'old'},context],[{...plan,quote:'1개'},context],[{...plan,catalogName:'다른장비'},context]])assert.throws(()=>validateStockConfirmation(p,c));
});
test('creation cannot overwrite an already identified asset or invent an invalid count',()=>{
 assert.throws(()=>validateStockConfirmation(plan,{...context,equipment:[{id:'T1',name:'신규 삼각대',stock:4}]}));
 for(const count of [-1,1.2,'1',10000])assert.throws(()=>validateStockConfirmation({...plan,stockTotal:count},context));
 assert.throws(()=>validateStockConfirmation({...plan,stockMaintenance:2},context));
});

test('stock sheet reads use GAS query selectors, while mutations retain POST body',()=>{
 const read=stockGasRequest('https://gas.test/exec','key','read',{sheet:'장비마스터',range:'A:L'});
 assert.equal(read.options.method,'GET');assert.equal(read.url.searchParams.get('sheet'),'장비마스터');assert.equal(read.url.searchParams.get('range'),'A:L');
 const write=stockGasRequest('https://gas.test/exec','key','equipmentMasterSync',{rows:[],append:[{id:'EQ-1'}]});
 assert.equal(write.options.method,'POST');assert.equal(JSON.parse(write.options.body).append[0].id,'EQ-1');
});
test('unanswered old reports cannot starve later owner replies',()=>{
 const reports=Array.from({length:25},(_,i)=>({id:String(i).padStart(2,'0')})),seen=new Set();
 for(let i=0;i<4;i++)for(const row of stockQuestionBatch(reports,i*600000))seen.add(row.id);
 assert.equal(seen.size,25);
});
