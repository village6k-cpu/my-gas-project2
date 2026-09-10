import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { prepareContextQuestion } from '../tools/slack-heybilli-sync/slack-heybilli-sync.mjs';

test('lookup CLI prints the read-only result to the agent',async()=>{
 const requests=[];
 const server=createServer((req,res)=>{let body='';req.on('data',c=>body+=c);req.on('end',()=>{requests.push(JSON.parse(body));res.setHeader('content-type','application/json');res.end(JSON.stringify({ok:true,selectedTradeId:'260906-010',notesOnly:true}));});});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 try {
  const child=spawn(process.execPath,[resolve('tools/slack-heybilli-sync/slack-heybilli-sync.mjs'),'lookup'],{env:{...process.env,HERMES_HOME:resolve('test/nonexistent-hermes'),SLACK_HEYBILLI_API_URL:`http://127.0.0.1:${server.address().port}`,SLACK_HEYBILLI_API_TOKEN:'fixture',SLACK_HEYBILLI_WRITE_ENABLED:'0'}});
  let out='',err='';child.stdout.on('data',c=>out+=c);child.stderr.on('data',c=>err+=c);
  child.stdin.end(JSON.stringify({event:{messageTs:'1788825130.404889',sourceHash:'a'.repeat(64)},query:{equipment:['시네로이드'],time:'11:00',phase:'checkout'}}));
  const exit=await new Promise(r=>child.on('close',r));assert.equal(exit,0,err);
  assert.ok(out.trim(),'lookup response must reach AI stdout');assert.equal(JSON.parse(out).selectedTradeId,'260906-010');
  assert.deepEqual(requests.map(r=>r.mode),['lookup']);
 }finally{await new Promise(r=>server.close(r));}
});
test('questions require a lookup and resolved cards never ask for identity',async()=>{
 let calls=0;const query={customer:'정원근',phase:'checkin'};const body={event:{messageTs:'1788747301.049709',sourceHash:'a'.repeat(64)},query};
 const lookup=async request=>{calls++;assert.equal(request.mode,'lookup');return {selectedTradeId:'260803-007'};};
 await assert.rejects(prepareContextQuestion({writeEnabled:false},body,lookup),/DRY-RUN/);
 await assert.rejects(prepareContextQuestion({writeEnabled:true},{event:body.event},lookup),/query/);
 assert.equal(calls,0);
 await assert.rejects(prepareContextQuestion({writeEnabled:true},body,lookup),/확인됐습니다/);
 assert.equal(calls,1);
 await assert.rejects(prepareContextQuestion({writeEnabled:true},body,async()=>{throw new Error('database offline');}),/database offline/);
 assert.equal((await prepareContextQuestion({writeEnabled:true},body,async()=>({selectedTradeId:null,reason:'ambiguous'}))).reason,'ambiguous');
});
