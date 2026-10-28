import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {once} from 'node:events';
const subject=await import('./migration_bridge_producer_fence.mjs').catch(()=>({}));
const wait=ms=>new Promise(r=>setTimeout(r,ms));
const names=['runSupabaseRecoverySweep','runSlackActionPoll','runP0SlackEscalationSweep',
  'cleanupIdleKakaoConversationTabs','runRegistrationRetrySweep','recoverPendingApplications'];

async function fixture(t,options={}) {
  const calls=[];let release;
  const held=new Promise(r=>{release=r;});
  const functions=Object.fromEntries(names.map(n=>[n,async()=>{calls.push(n);if(options.hold===n)await held;return [];} ]));
  let flush=async()=>{calls.push('flushRoom');if(options.hold==='flushRoom')await held;};
  let dispatch=async()=>{calls.push('dispatchAiJob');};
  const original=async(req,res)=>{calls.push(req.url);if(req.url==='/accepted')await held;res.end('ok');};
  const server=http.createServer(original);server.keepAliveTimeout=5;server.keepAliveTimeoutBuffer=0;
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const port=server.address().port;
  const entries=names.map(name=>({name,get:()=>functions[name],set:v=>{functions[name]=v;}}));
  const tracked=[{name:'flushRoom',get:()=>flush,set:v=>{flush=v;}},{name:'dispatchAiJob',get:()=>dispatch,set:v=>{dispatch=v;}}];
  const runtimes=['digest','notice_cleanup'].map(name=>({name,was_running:!options.pausedRuntimes,
    timer:options.pausedRuntimes?null:setInterval(()=>calls.push(name+'-tick'),10000),start(){calls.push(name+'-start');},stop(){calls.push(name+'-stop');}}));
  for(const runtime of runtimes)runtime.timer?.unref();
  const config={server,token:'fixture-owner',entries,tracked,runtimes,immediatePollerEnabled:false};
  const originalTimerCallbacks=runtimes.map(r=>r.timer? r.timer._onTimeout:null);
  t.after(()=>{release();for(const runtime of runtimes)if(runtime.timer)clearInterval(runtime.timer);server.closeAllConnections();server.close();});
  assert.equal(typeof subject.installCurrentBridgeProducerFence,'function','current producer fence required');
  const control=subject.installCurrentBridgeProducerFence({...config,...options.override});
  return {control,calls,functions,release,server,original,config,originalTimerCallbacks,flush:()=>flush(),
    request:(url,method='GET')=>fetch(`http://127.0.0.1:${port}${url}`,{method})};
}

test('all six current producer paths are paused, including guarded recovery and registration retry',async t=>{
  const f=await fixture(t);f.control.fence('fixture-owner');
  for(const n of names)await f.functions[n]();
  assert.equal(f.calls.some(n=>names.includes(n)),false);
  assert.deepEqual(f.calls,[]);
  const state=f.control.snapshot();assert.equal(state.producers_owned,true);
  assert.deepEqual(state.blocked_calls,Object.fromEntries(names.map(n=>[n,1])));
  assert.equal(state.preexisting_work_verified,false);assert.equal(state.stop_authorized,false);assert.equal(state.drained,false);
  assert.equal(state.http_closed,false);assert.equal(f.server.listening,true);
});

test('new claims, input and maintenance are refused; accepted-result protocol and harmless probe remain available',async t=>{
  const f=await fixture(t);f.control.fence('fixture-owner');
  for(const [method,url] of [['POST','/events'],['POST','/maintenance/recover'],['POST','/manual-send'],['GET','/hermes/v1/events?wait_ms=1']])assert.equal((await f.request(url,method)).status,503);
  assert.equal((await f.request('/hermes/v1/results','POST')).status,200);
  assert.equal((await f.request('/migration-private-work/12345678-1234-1234-1234-123456789abc')).status,200);
  assert.equal((await f.request('/migration-private-work/not-a-nonce')).status,503);
});

test('previously accepted HTTP request finishes once while new input is fenced',async t=>{
  const f=await fixture(t);const accepted=f.request('/accepted');
  while(!f.calls.includes('/accepted'))await wait(2);
  f.control.fence('fixture-owner');assert.equal(f.control.snapshot().pending_handlers,1);
  assert.equal((await f.request('/accepted')).status,503);
  f.release();assert.equal(await (await accepted).text(),'ok');await wait(5);
  assert.equal(f.control.snapshot().pending_handlers,0);assert.equal(f.calls.filter(n=>n==='/accepted').length,1);
});

test('started producer and room enqueue remain tracked until their original promise completes',async t=>{
  const f=await fixture(t,{hold:'recoverPendingApplications'});
  const pending=f.functions.recoverPendingApplications();f.control.fence('fixture-owner');
  assert.equal(f.control.snapshot().pending_producers,1);f.release();await pending;
  assert.equal(f.control.snapshot().pending_producers,0);
});

test('room enqueue cannot disappear when removed from the visible room queue',async t=>{
  const f=await fixture(t,{hold:'flushRoom'});const pending=f.flush();f.control.fence('fixture-owner');
  assert.equal(f.control.snapshot().pending_tracked_work,1);f.release();await pending;
  assert.equal(f.control.snapshot().pending_tracked_work,0);
});

test('pre-close abort restores exact originals without startup replay',async t=>{
  const f=await fixture(t);f.control.fence('fixture-owner');await f.control.resume('fixture-owner');
  assert.equal(f.server.listeners('request')[0],f.original);
  assert.equal((await f.request('/events')).status,200);
  for(const n of names)await f.functions[n]();
  assert.equal(f.calls.filter(n=>n==='digest-start').length,0);
  assert.equal(f.calls.filter(n=>n==='notice_cleanup-start').length,0);
  assert.throws(()=>f.control.fence('fixture-owner'),/released|state/);
});

test('wrong token or changed bindings cannot fence or restore another controller',async t=>{
  const f=await fixture(t);assert.throws(()=>f.control.fence('other'),/owner/);
  f.control.fence('fixture-owner');f.functions.runRegistrationRetrySweep=async()=>{};
  await assert.rejects(f.control.resume('fixture-owner'),/binding|owner/);
});

test('abort preserves runtimes that were enabled but already paused before this migration',async t=>{
  const f=await fixture(t,{pausedRuntimes:true});f.control.fence('fixture-owner');await f.control.resume('fixture-owner');
  assert.equal(f.calls.some(n=>n.endsWith('-start')),false,'resume must not start historically held runtime timers');
});

test('fence and abort preserve original live interval objects without replaying startup sweeps',async t=>{
  const f=await fixture(t),timers=f.config.runtimes.map(r=>r.timer),callbacks=f.originalTimerCallbacks;
  f.control.fence('fixture-owner');
  for(const timer of timers)timer._onTimeout.call(timer);
  assert.equal(f.calls.some(n=>n.endsWith('-tick')),false);
  await f.control.resume('fixture-owner');
  assert.equal(f.calls.some(n=>n.endsWith('-start')),false,'abort must not replay startup sweeps');
  timers.forEach((timer,i)=>{assert.equal(timer._onTimeout,callbacks[i]);assert.equal(timer._destroyed,false);});
});

test('missing registration/recovery fence or enabled unobservable immediate poller fails before installation',async t=>{
  const f=await fixture(t);await f.control.resume('fixture-owner').catch(()=>{});
  for(const config of [{...f.config,entries:f.config.entries.slice(0,-1)},
    {...f.config,entries:f.config.entries.filter(x=>x.name!=='runRegistrationRetrySweep')},
    {...f.config,immediatePollerEnabled:true}]) {
    assert.throws(()=>subject.installCurrentBridgeProducerFence(config),/contract|producer|poller/);
  }
});
