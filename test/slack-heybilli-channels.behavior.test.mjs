import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
const first='C0B6ZJZ2XU3',second='C0BMNA501R9';
async function run(command,body,extra={}){
 const dir=await mkdtemp(join(tmpdir(),'slack-channel-test-'));
 try{
  const preload=join(dir,'mock.mjs');
  await writeFile(preload,`globalThis.fetch=async(input,options={})=>{const url=new URL(input);const body=options.body?JSON.parse(options.body):null; if(url.pathname.endsWith('/conversations.history') && [url.searchParams.get('channel'),'*'].includes(process.env.TEST_FAIL_CHANNEL))return new Response(JSON.stringify({ok:false,error:'not_in_channel'})); process.stderr.write(JSON.stringify({url:String(url),body})+'\\n');let result={ok:true}; if(url.hostname==='slack.com'){ const method=url.pathname.split('/').at(-1);if(method==='auth.test')result.user_id='UBOT';else if(method==='conversations.history')result.messages=[{ts:'1789041616.664879',text:'[반납] 김민수 FX3 미반납',user:'UHUMAN'}];else if(method==='conversations.replies')result.messages=[];else if(method==='chat.getPermalink')result.permalink='https://slack.test/source';}else if(body?.mode==='scan')result.pending=body.events.map(e=>({event:{channel_id:e.channelId,message_ts:e.messageTs,source_hash:e.sourceHash},candidates:[]}));else if(body?.mode==='lookup')result.selectedTradeId=null;else if(body?.mode==='apply')result.changed=true;return new Response(JSON.stringify(result),{headers:{'content-type':'application/json'}});};`);
  const child=spawn(process.execPath,['--import',pathToFileURL(preload).href,resolve('tools/slack-heybilli-sync/slack-heybilli-sync.mjs'),...command],{env:{...process.env,HERMES_HOME:dir,SLACK_BOT_TOKEN:'fixture',SLACK_HEYBILLI_API_TOKEN:'fixture',SLACK_HEYBILLI_API_URL:'https://internal.test/ops',SLACK_HEYBILLI_WRITE_ENABLED:'1',SLACK_HEYBILLI_CHANNEL_IDS:`${first},${second}`,SLACK_HEYBILLI_CHANNEL_START_TS:JSON.stringify({[second]:1789041600}),...extra}});
  let out='',err='';child.stdout.on('data',c=>out+=c);child.stderr.on('data',c=>err+=c);child.stdin.end(body?JSON.stringify(body):'');
  const code=await new Promise(r=>child.on('close',r));
  const calls=err.split('\n').filter(s=>s.startsWith('{')).map(s=>JSON.parse(s));
  return {code,out,err,calls};
 }finally{await rm(dir,{recursive:true,force:true});}
}
const event={channelId:second,messageTs:'1789041616.664879',sourceHash:'a'.repeat(64)};
test('one scan reads both channels independently and applies the new-channel start boundary',async()=>{
 const r=await run(['scan']);assert.equal(r.code,0,r.err);
 const histories=r.calls.filter(c=>c.url.includes('conversations.history')).map(c=>new URL(c.url));
 assert.deepEqual(histories.map(u=>u.searchParams.get('channel')),[first,second]);
 assert.ok(Number(histories[1].searchParams.get('oldest'))>=1789041600);
 assert.deepEqual(JSON.parse(r.out).pending.map(e=>e.event.channel_id),[first,second]);
});
test('apply and ask post only in the event source channel; ignore and lookup retain its identity',async()=>{
 for(const command of ['apply','ask','ignore','lookup']){
  const body=command==='apply'?{...event,tradeId:'260910-001',phase:'checkin',summary:'FX3 이상',actions:[]}:{event,query:{},reason:'이미 반영됨',question:'예정 시간은 언제인가요?'};
  const r=await run(command==='apply'?['apply','--write']:[command],body);assert.equal(r.code,0,r.err);
  for(const call of r.calls.filter(c=>c.url.includes('conversations.replies')||c.url.includes('chat.postMessage')))assert.equal(new URL(call.url).searchParams.get('channel'),second);
  for(const call of r.calls.filter(c=>c.body?.event))assert.equal(call.body.event.channelId,second);
 }
});
test('multiple configured channels reject omitted or unconfigured identity before any external call',async()=>{
 for(const eventValue of [{messageTs:event.messageTs,sourceHash:event.sourceHash},{...event,channelId:'CUNKNOWN'}]){
  const r=await run(['ignore'],{event:eventValue,reason:'x'});assert.notEqual(r.code,0);assert.equal(r.calls.length,0);
 }
});
test('one unavailable channel does not discard healthy-channel work and total failure remains visible',async()=>{
 const partial=await run(['scan'],null,{TEST_FAIL_CHANNEL:second});
 assert.equal(partial.code,0,partial.err);
 assert.deepEqual(JSON.parse(partial.out).pending.map(e=>e.event.channel_id),[first]);
 assert.match(partial.err,/C0BMNA501R9.*not_in_channel/);
 const failed=await run(['scan'],null,{TEST_FAIL_CHANNEL:'*'});
 assert.notEqual(failed.code,0);assert.match(failed.err,/not_in_channel/);
});
