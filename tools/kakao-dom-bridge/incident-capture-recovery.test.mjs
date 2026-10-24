import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import vm from 'node:vm';import {isIncidentCaptureRetry} from './incident-capture-recovery.mjs';
const cutoff='2026-10-24T03:00:00.000Z',now=Date.parse('2026-10-24T03:20:00Z');
const row={id:'row',event_hash:'dom-event',room_key:'chat:123',status:'ai_worker_error',detected_at:'2026-10-24T03:10:00Z',updated_at:'2026-10-24T03:10:10Z',payload:{capture_retry:{version:1,stage:'before_gateway_enqueue',state:'pending',next_attempt_at:'2026-10-24T03:11:00Z'},ai_worker_result:{error_type:'kakao_conversation_evidence_unavailable'}}};
test('only due post-cutoff zero-business-stage capture failures are eligible',()=>{assert.equal(isIncidentCaptureRetry(row,cutoff,now),true);for(const patch of [{detected_at:cutoff},{detected_at:'invalid'},{status:'completed'},{payload:{...row.payload,gateway_dispatch:{state:'ready'}}},{payload:{...row.payload,capture_retry:{...row.payload.capture_retry,state:'handed_off'}}},{payload:{...row.payload,capture_retry:{...row.payload.capture_retry,next_attempt_at:'2026-10-24T04:00:00Z'}}},{payload:{...row.payload,tool_operation:{state:'reserved'}}}])assert.equal(isIncidentCaptureRetry({...row,...patch},cutoff,now),false);});
const source=fs.readFileSync(new URL('./server.mjs',import.meta.url),'utf8');
function fn(name){const a=source.indexOf('async function '+name+'('),b=source.indexOf('\n}\n',a);assert.ok(a>=0);return source.slice(a,b+3);}
test('scoped capture query excludes historical rows before the remote batch limit',async()=>{let request;const c={URL,Date,CONFIG:{supabaseRecoveryLookbackHours:24},supabaseConfigured:()=>true,supabaseTableEndpoint:()=> 'https://example.invalid/events',supabaseHeaders:()=>({}),supabaseFetchWithTimeout:async(url)=>{request=new URL(url);return{response:{ok:true},data:[],text:''};}};vm.createContext(c);vm.runInContext(fn('fetchSupabaseRowsByStatuses'),c);await c.fetchSupabaseRowsByStatuses(['ai_worker_error'],24,{capturePending:true,afterDetectedAt:cutoff});assert.equal(request.searchParams.get('detected_at'),'gt.'+cutoff);assert.equal(request.searchParams.get('payload->capture_retry->>state'),'eq.pending');assert.equal(request.searchParams.has('created_at'),false);});
test('recovery event update is version guarded and refuses lost CAS instead of claiming success',async()=>{let request,posts=0;const c={URL,JSON,CONFIG:{},supabaseConfigured:()=>true,supabaseTableEndpoint:()=> 'https://example.invalid/events',supabaseHeaders:()=>({}),supabaseFetchWithTimeout:async(url)=>{posts++;request=new URL(url);return{response:{ok:true},data:[],text:''};}};vm.createContext(c);vm.runInContext(fn('updateSupabaseEventByHash'),c);const result=await c.updateSupabaseEventByHash('dom-event',{status:'processing_by_ai_worker'},{id:'row',status:'ai_worker_error',updated_at:'version'});assert.equal(request.searchParams.get('id'),'eq.row');assert.equal(request.searchParams.get('updated_at'),'eq.version');assert.equal(request.searchParams.get('status'),'eq.ai_worker_error');assert.equal(result.ok,false);assert.equal(posts,1);});

test('fresh processing lease and any business handoff are never reclaimed',()=>{
 assert.equal(isIncidentCaptureRetry({...row,status:'processing_by_ai_worker',claimed_at:'2026-10-24T03:19:00Z'},cutoff,now),false);
 assert.equal(isIncidentCaptureRetry({...row,status:'processing_by_ai_worker',claimed_at:'2026-10-24T03:01:00Z'},cutoff,now),true);
 for(const field of ['application','operation_receipt','tool_operations'])assert.equal(isIncidentCaptureRetry({...row,payload:{...row.payload,[field]:{}}},cutoff,now),false);
 assert.equal(isIncidentCaptureRetry(row,'invalid',now),false);
});
async function sweep(rows,{cas=true,lowValue=''}={}){
 const calls={claim:0,dispatch:0,skip:0,escalate:0};
 const c={Date,Math,CONFIG:{hermesTransport:'gateway',workerCommand:'',supabaseRecoveryEnabled:true,supabaseRecoveryBatchSize:2,workerTimeoutMs:100},gatewayTransportEnabled:true,supabaseConfigured:()=>true,recoveryHold:{freezeBefore:cutoff},isIncidentCaptureRetry:(r,f)=>isIncidentCaptureRetry(r,f,now),state:{},nowIso:()=>new Date(now).toISOString(),fetchRecoverableSupabaseRows:async()=>rows,shouldSkipSupabaseRowAsLowValue:()=>lowValue,shouldEscalateExhaustedSupabaseRow:()=>true,shouldRecoverSupabaseRow:()=>false,recoveryAttemptCount:()=>99,buildJobFromSupabaseRow:r=>r,markSupabaseRowClaimedForRecovery:async()=>{calls.claim++;return{ok:cas,row:cas?{id:'claimed'}:null};},dispatchAiJob:async()=>{calls.dispatch++;return{ok:true};},appendNdjson:()=>{},markSupabaseRowSkippedLowValue:()=>{calls.skip++;},markSupabaseRowEscalated:()=>{calls.escalate++;}};
 vm.createContext(c);vm.runInContext(fn('runSupabaseRecoverySweep'),c);const result=await c.runSupabaseRecoverySweep('test');return{calls,result};
}
test('incident sweep cannot mutate historical, handed-off or fresh claimed rows',async()=>{
 const rows=[{...row,detected_at:cutoff},{...row,payload:{...row.payload,gateway_dispatch:{}}},{...row,status:'processing_by_ai_worker',claimed_at:'2026-10-24T03:19:00Z'}];
 const {calls,result}=await sweep(rows);assert.deepEqual(calls,{claim:0,dispatch:0,skip:0,escalate:0});assert.equal(result.skipped,3);
});
test('zero-business capture is dispatched only after exact CAS and cannot be abandoned by an unrelated attempt cap',async()=>{
 const lost=await sweep([row],{cas:false});assert.equal(lost.calls.claim,1);assert.equal(lost.calls.dispatch,0);
 const won=await sweep([row]);assert.equal(won.calls.claim,1);assert.equal(won.calls.dispatch,1);assert.equal(won.calls.escalate,0);assert.equal(won.result.replayed,1);
});

test('incident capture never takes the historical unguarded low-value mutation branch',async()=>{
 const {calls}=await sweep([row],{cas:false,lowValue:'untrusted_backstop_row'});
 assert.equal(calls.skip,0);assert.equal(calls.claim,1);assert.equal(calls.dispatch,0);
});
