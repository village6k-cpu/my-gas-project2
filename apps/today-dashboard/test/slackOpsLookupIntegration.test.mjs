import test from 'node:test';
import assert from 'node:assert/strict';
import './helpers/tsResolve.mjs';
const {lookupSlackOpsEvent,applySlackOpsPlan}=await import('../lib/server/slackOps.ts');
process.env.NEXT_PUBLIC_SUPABASE_URL='https://slack-ops.test';process.env.SUPABASE_SERVICE_ROLE_KEY='test-only';
const hash='a'.repeat(64),ts='1788742182.394589';
const originalFetch=globalThis.fetch;
let calls=[],duplicate=false,phase='unknown';
const stored=()=>({channel_id:'C0B6ZJZ2XU3',message_ts:ts,thread_ts:ts,source_hash:hash,phase_hint:phase,customer_hint:'깨진',trade_id_hint:null,status:'needs_context',applied_plan:null,raw_context:{root:{text:'이소연 감독님 fx3\n깨진건 아니고 lcd 메인보드가 나간거 같습니다'},replies:[]}});
const trade={trade_id:'260904-005',customer_name:'이소연',checkout_at:'2026-09-05T12:00:00Z',return_at:'2026-09-06T13:00:00Z',note_checkin:null,note_checkout:null,return_counts:{}};
const item={trade_id:trade.trade_id,schedule_id:'260904-005-01',name:'소니 FX3',qty:1,taken_qty:1};
const query={customer:'이소연',equipment:['fx3'],phase:'checkin'};
const plan={channelId:'C0B6ZJZ2XU3',messageTs:ts,sourceHash:hash,tradeId:trade.trade_id,phase:'checkin',summary:'이소연 FX3 LCD 이상',actions:[],resolution:query};
test.beforeEach(()=>{
 calls=[];duplicate=false;phase='unknown';
 globalThis.fetch=async(input,options={})=>{
  const url=new URL(typeof input==='string'?input:input.url||input.href);const method=options.method||input.method||'GET';calls.push({url,method});
  assert.equal(method,'GET','lookup and dry-run must not mutate the database');
  const table=url.pathname.split('/').at(-1);const headers=new Headers(options.headers||input.headers);const single=headers.get('accept')?.includes('vnd.pgrst.object');
  let rows=[];
  if(table==='slack_ops_events') rows=[stored()];
  else if(table==='trades') rows=duplicate?[trade,{...trade,trade_id:'260904-006'}]:[trade];
  else if(table==='schedule_items') rows=duplicate?[item,{...item,trade_id:'260904-006',schedule_id:'260904-006-01'}]:[item];
  else throw new Error('unexpected '+table);
  const eq=url.searchParams.get('trade_id');if(eq?.startsWith('eq.'))rows=rows.filter(r=>r.trade_id===eq.slice(3));
  return new Response(JSON.stringify(single?rows[0]??null:rows),{status:200,headers:{'content-type':'application/json'}});
 };
});
test.afterEach(()=>{globalThis.fetch=originalFetch;});
test('stored erroneous regex hint is repaired by read-only source-grounded lookup',async()=>{
 const result=await lookupSlackOpsEvent({messageTs:ts,sourceHash:hash},query);
 assert.equal(result.selectedTradeId,trade.trade_id);assert.equal(result.notesOnly,true);
 assert.ok(calls.every(c=>c.method==='GET'));assert.equal(stored().status,'needs_context');
});
test('lookup cannot use a stale Slack revision or fabricated customer',async()=>{
 await assert.rejects(lookupSlackOpsEvent({messageTs:ts,sourceHash:'b'.repeat(64)},query),/바뀌/);
 await assert.rejects(lookupSlackOpsEvent({messageTs:ts,sourceHash:hash},{...query,customer:'홍길동'}),/원문/);
});
test('memo dry-run rechecks evidence and never writes',async()=>{
 const result=await applySlackOpsPlan(plan,false);
 assert.equal(result.dryRun,true);assert.equal(result.preview.tradeId,trade.trade_id);
});
test('a candidate appearing between lookup and apply blocks the old plan',async()=>{
 assert.equal((await lookupSlackOpsEvent({messageTs:ts,sourceHash:hash},query)).selectedTradeId,trade.trade_id);
 duplicate=true;await assert.rejects(applySlackOpsPlan(plan,false),/확정되지/);
});
test('memo-only authority cannot be reused for return quantities',async()=>{
 await assert.rejects(applySlackOpsPlan({...plan,actions:[{type:'return_count',scheduleId:item.schedule_id,good:0,damaged:1,lost:0}]},false),/메모만/);
});
