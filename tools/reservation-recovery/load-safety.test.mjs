import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import path from 'node:path';import os from 'node:os';import {pathToFileURL} from 'node:url';
const root=process.env.VILLAGE_RUNTIME_ROOT;if(!root)throw Error('Set VILLAGE_RUNTIME_ROOT to the staged isolated runtime');
const {flushPricingOwnerNotices}=await import(pathToFileURL(path.join(root,'production-runtime/tools/ai-browser-worker/pricing-owner-notices.mjs')));
test('system failures stay durable, successes stay silent, and actual owner questions deliver',async t=>{
 const d=await fs.mkdtemp(path.join(os.tmpdir(),'notice-isolation-'));t.after(()=>fs.rm(d,{recursive:true}));
 for(const [id,text]of [['a','상담 자동처리 확인 필요\n고객: 테스트'],['b','자동 가격·서류 처리 알림'],['c','자동 가격·서류 확인 필요\n단가 미확정']]){
  await fs.writeFile(path.join(d,id.repeat(64)+'.json'),JSON.stringify({schema:'village-pricing-owner-notice/v1',state:'pending',channel:'UTEST',text,clientMsgId:id}));
 }
 const sent=[];await flushPricingOwnerNotices(d,{token:'test-only',fetchImpl:async(url,opts)=>{sent.push(JSON.parse(opts.body));return{ok:true,json:async()=>({ok:true,ts:'test.1'})};}});
 assert.equal(sent.length,1);assert.match(sent[0].text,/단가 미확정/);
 assert.equal(JSON.parse(await fs.readFile(path.join(d,'a'.repeat(64)+'.json'))).state,'pending');
 assert.equal(JSON.parse(await fs.readFile(path.join(d,'b'.repeat(64)+'.json'))).state,'suppressed');
});
