import test from 'node:test';
import assert from 'node:assert/strict';
import './helpers/tsResolve.mjs';
const {lookupSlackOpsEvent, markSlackOpsEvent, scanSlackOpsEvents, applySlackOpsPlan}=await import('../lib/server/slackOps.ts');
process.env.NEXT_PUBLIC_SUPABASE_URL='https://slack-channels.test';
process.env.SUPABASE_SERVICE_ROLE_KEY='test-only';
const originalFetch=globalThis.fetch;
const first='C0B6ZJZ2XU3', second='C0BMNA501R9', ts='1789041616.664879', hash='b'.repeat(64);
let calls=[];
test.beforeEach(()=>{
 calls=[];
 globalThis.fetch=async(input,options={})=>{
  const url=new URL(typeof input==='string'?input:input.url||input.href);
  const method=options.method||input.method||'GET';
  const body=options.body?JSON.parse(options.body):null;
  calls.push({url,method,body});
  const channel=url.searchParams.get('channel_id')?.slice(3);
  const table=url.pathname.split('/').at(-1);
  const headers=new Headers(options.headers||input.headers);
  let data=[];
  if(table==='slack_ops_events'){
   const row={channel_id:channel,message_ts:ts,thread_ts:ts,source_hash:hash,status:channel===second?'pending':'applied',phase_hint:'checkin',raw_context:{root:{ts,text:'[반납] 김민수 FX3 이상'}}};
   data=method==='POST'?[]:headers.get('accept')?.includes('vnd.pgrst.object')?row:[row];
  }
  return new Response(JSON.stringify(data),{headers:{'content-type':'application/json'}});
 };
});
test.afterEach(()=>{globalThis.fetch=originalFetch;});
const event=(channelId)=>({channelId,messageTs:ts,sourceHash:hash,phaseHint:'checkin',root:{ts,text:'[반납] 김민수 FX3 이상'}});
test('work-order lookup and mark use their own channel even when timestamps collide',async()=>{
 await lookupSlackOpsEvent(event(second),{customer:'김민수',phase:'checkin'});
 await markSlackOpsEvent(event(second),'ignored','이미 반영됨');
 const rows=calls.filter(c=>c.url.pathname.endsWith('/slack_ops_events'));
 assert.ok(rows.length>=2);assert.ok(rows.every(c=>c.url.searchParams.get('channel_id')===`eq.${second}`));
});
test('work-order scan cannot inherit the other channel completed status',async()=>{
 const result=await scanSlackOpsEvents([event(second)]);
 assert.equal(result.pending.length,1);assert.equal(result.pending[0].event.channel_id,second);
 assert.ok(calls.filter(c=>c.method==='GET'&&c.url.pathname.endsWith('/slack_ops_events')).every(c=>c.url.searchParams.get('channel_id')===`eq.${second}`));
 assert.equal(calls.find(c=>c.method==='POST').body[0].status,'pending');
});
test('mixed-channel scan and unapproved channel fail before database access',async()=>{
 await assert.rejects(scanSlackOpsEvents([event(first),event(second)]),/채널/);
 await assert.rejects(lookupSlackOpsEvent(event('CUNKNOWN'),{}),/채널/);
 await assert.rejects(markSlackOpsEvent(event('CUNKNOWN'),'ignored','x'),/채널/);
 assert.equal(calls.length,0);
});
test('work-order apply validates its own stored event and legacy lookup still uses the original channel',async()=>{
 await assert.rejects(applySlackOpsPlan({...event(second),tradeId:'260910-001',phase:'checkin',summary:'FX3 이상',actions:[],resolution:{customer:'김민수',phase:'checkin'}},false),/확정되지/);
 assert.equal(calls.find(c=>c.url.pathname.endsWith('/slack_ops_events')).url.searchParams.get('channel_id'),`eq.${second}`);
 calls=[];
 await lookupSlackOpsEvent({messageTs:ts,sourceHash:hash},{});
 assert.equal(calls[0].url.searchParams.get('channel_id'),`eq.${first}`);
});
