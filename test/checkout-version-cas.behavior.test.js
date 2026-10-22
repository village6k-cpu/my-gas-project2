'use strict';
const test=require('node:test'), assert=require('node:assert/strict'), fs=require('node:fs'), vm=require('node:vm'), path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'../supabaseSync.js'),'utf8');
const tid='261023-999',sid=tid+'-01',sid2=tid+'-02';
const v0='2026-10-23T00:00:00.123456+00:00',v1='2026-10-23T00:00:01.123457+00:00';
function harness() {
  const rows=new Map([[sid,{trade_id:tid,schedule_id:sid,checkout_state:'pending',updated_at:v0,removed_at:null}],
    [sid2,{trade_id:tid,schedule_id:sid2,checkout_state:'pending',updated_at:v0,removed_at:null}]]);
  const calls=[],flags={};let revision=0;
  const response=data=>({getResponseCode:()=>200,getContentText:()=>JSON.stringify(data)});
  function fetch(url,request) {
    calls.push({url,...request});const p=new URL(url).searchParams,id=p.get('schedule_id')?.replace(/^eq\./,''),row=rows.get(id);
    if(request.method==='get') { if(flags.readFail)throw Error('offline');return response(row?[{...row}]:[...rows.values()].filter(r=>p.get('schedule_id')?.startsWith('in.')&&p.get('schedule_id').includes(r.schedule_id))); }
    assert.equal(request.method,'patch');
    const match=row&&(!p.has('updated_at')||p.get('updated_at')==='eq.'+row.updated_at)&&(!p.has('removed_at')||row.removed_at===null);
    if(!match)return response([]);
    row.updated_at=`2026-10-23T00:00:0${++revision}.123457+00:00`;
    if(!flags.baselineGuard)row.checkout_state=JSON.parse(request.payload).checkout_state;
    if(flags.loseResponse)throw Error('response lost');
    return response([{...row}]);
  }
  const c={UrlFetchApp:{fetch,fetchAll:requests=>requests.map(r=>fetch(r.url,r))}};vm.runInNewContext(source,c);
  c.SUPA_CFG_=()=>({url:'https://example.invalid',apikey:'test'});c.supaToken_=()=> 'test';
  return {c,rows,calls,flags,write:(done,version=v0)=>c.supaSetScheduleItemCheckoutState_(tid,sid,done,version)};
}
test('opaque microsecond token is an atomic PATCH condition and direct ACK carries the resulting token',()=>{
  const h=harness(),r=h.write(true);assert.equal(r.ok,true);assert.equal(r.applied,true);assert.equal(r.updatedAt,v1);
  const p=new URL(h.calls[0].url).searchParams;assert.equal(p.get('updated_at'),'eq.'+v0);assert.equal(p.get('removed_at'),'is.null');
  assert.equal(JSON.parse(h.calls[0].payload).updated_at,undefined);
});
test('missing or invalid expected token fails closed before any HTTP request',()=>{
  for(const token of [undefined,'','today','now','2026-10-23']) { const h=harness();const r=h.c.supaSetScheduleItemCheckoutState_(tid,sid,true,token);assert.equal(r.ok,false);assert.equal(r.code,'CHECKOUT_REFRESH_REQUIRED');assert.equal(h.calls.length,0); }
});
test('A then B then delayed A cannot undo B after any GAS receipt expiry',()=>{
  const h=harness(),a=h.write(true),b=h.write(false,a.updatedAt),late=h.write(true);
  assert.equal(b.ok,true);assert.equal(late.ok,false);assert.equal(late.code,'CHECKOUT_CONFLICT');assert.equal(late.outcomeUnknown,false);
  assert.equal(late.canonicalState,'pending');assert.equal(h.rows.get(sid).checkout_state,'pending');assert.equal(late.applied,false);
});
test('never-delivered A and ABA both retain their old version, not just the old boolean',()=>{
  const h=harness();h.rows.get(sid).updated_at=v1;
  const a=h.write(true);assert.equal(a.ok,false);assert.equal(a.code,'CHECKOUT_CONFLICT');assert.equal(h.rows.get(sid).checkout_state,'pending');
});
test('zero matched rows already at target converge without claiming applied or making a second PATCH',()=>{
  const h=harness();h.rows.get(sid).checkout_state='taken';h.rows.get(sid).updated_at=v1;
  const r=h.write(true);assert.equal(r.ok,true);assert.equal(r.applied,false);assert.equal(r.updatedAt,v1);assert.equal(h.calls.filter(c=>c.method==='patch').length,1);
});
test('lost applied response is only converged and cannot advance a dependent intent',()=>{
  const h=harness();h.flags.loseResponse=true;const r=h.write(true);assert.equal(r.ok,true);assert.equal(r.applied,false);assert.equal(r.updatedAt,v1);
});
test('unavailable readback preserves uncertainty and never replays a conditional PATCH',()=>{
  const h=harness();h.flags.loseResponse=true;h.flags.readFail=true;const r=h.write(true);assert.equal(r.ok,false);assert.equal(r.outcomeUnknown,true);assert.equal(r.applied,false);assert.equal(h.calls.length,2);
});
test('removed rows and protected baseline mismatches never ACK or mutate the requested state',()=>{
  for(const kind of ['removed','baseline']) {const h=harness();if(kind==='removed')h.rows.get(sid).removed_at=v1;else h.flags.baselineGuard=true;
    const r=h.write(true);assert.equal(r.ok,false);assert.equal(r.outcomeUnknown,false);assert.equal(h.rows.get(sid).checkout_state,'pending');}
});
test('batch has independent atomic versions and preserves a verified partial success',()=>{
  const h=harness();h.rows.get(sid2).updated_at=v1;
  const r=h.c.supaSetScheduleItemCheckoutStatesBatch_(tid,[{scheduleId:sid,done:true,expectedUpdatedAt:v0},{scheduleId:sid2,done:true,expectedUpdatedAt:v0}]);
  assert.equal(r.ok,false);assert.equal(r.results[0].applied,true);assert.equal(r.results[1].code,'CHECKOUT_CONFLICT');
  assert.equal(h.rows.get(sid).checkout_state,'taken');assert.equal(h.rows.get(sid2).checkout_state,'pending');
});

test('protocol probe describes only the server code contract without properties, locks or database access',()=>{
  const h=harness();
  const forbidden=new Proxy({}, {get(){throw Error('probe must not access a service');}});
  h.c.PropertiesService=forbidden;h.c.LockService=forbidden;h.c.DriveApp=forbidden;
  assert.deepEqual(JSON.parse(JSON.stringify(h.c.getCheckoutMutationProtocol())),
    {protocol:'checkout_updated_at_cas_v1',expectedUpdatedAtRequired:true});
  assert.equal(h.calls.length,0);
});

test('protocol probe is routed through internal run while public catalog credentials are denied',()=>{
  const h=harness();vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../sheetAPI.js'),'utf8'),h.c);
  const r=h.c.runFunction('getCheckoutMutationProtocol',{args:[]});assert.equal(r.success,true);
  assert.equal(r.result.protocol,'checkout_updated_at_cas_v1');
  h.c.jsonResponse=(body,status)=>({body,status});
  h.c.PropertiesService={getScriptProperties:()=>({getProperty:key=>{
    assert.equal(key,'VILLAGE_API_WRITE_KEY_V1');return 'test-internal-key';
  }})};
  const denied=h.c.handleRequestCore_({parameter:{},postData:{contents:JSON.stringify({key:'village2026',action:'run',func:'getCheckoutMutationProtocol'})}});
  assert.equal(denied.status,403);assert.equal(h.calls.length,0);
  const allowed=h.c.handleRequestCore_({parameter:{},postData:{contents:JSON.stringify({key:'test-internal-key',action:'run',func:'getCheckoutMutationProtocol'})}});
  assert.equal(allowed.body.success,true);assert.equal(allowed.body.result.protocol,'checkout_updated_at_cas_v1');
  assert.equal(h.calls.length,0);
});
