import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {once} from 'node:events';
import {installCurrentBridgeProducerFence} from './migration_bridge_producer_fence.mjs';
const api=await import('./migration_bridge_http_closure.mjs').catch(()=>({}));
const wait=ms=>new Promise(r=>setTimeout(r,ms));

async function fixture(t,{preexisting=false,disconnected=false}={}) {
  let release,accepted=false,finished=0;
  const pending=new Promise(r=>{release=r;});
  const server=http.createServer(async(req,res)=>{if(req.url==='/accepted'){accepted=true;await pending;finished++;}res.end('ok');});
  server.keepAliveTimeout=5;server.keepAliveTimeoutBuffer=0;server.listen(0,'127.0.0.1');await once(server,'listening');
  const port=server.address().port;let request;
  if(preexisting) {
    if(disconnected) {request=http.request({host:'127.0.0.1',port,path:'/accepted'});request.on('error',()=>{});request.end();}
    else request=fetch(`http://127.0.0.1:${port}/accepted`);
    while(!accepted)await wait(2);
    if(disconnected){request.destroy();await wait(10);}
  }
  const names=['runSupabaseRecoverySweep','runSlackActionPoll','runP0SlackEscalationSweep','cleanupIdleKakaoConversationTabs','runRegistrationRetrySweep','recoverPendingApplications'];
  const fns=Object.fromEntries(names.map(n=>[n,async()=>[]]));let flush=async()=>{},dispatch=async()=>{};
  const fence=installCurrentBridgeProducerFence({server,token:'fixture-owner',entries:names.map(name=>({name,get:()=>fns[name],set:v=>{fns[name]=v;}})),
    tracked:[{name:'flushRoom',get:()=>flush,set:v=>{flush=v;}},{name:'dispatchAiJob',get:()=>dispatch,set:v=>{dispatch=v;}}],
    runtimes:[{name:'digest',timer:null},{name:'notice_cleanup',timer:null}],immediatePollerEnabled:false});
  let timer;
  t.after(async()=>{release();if(request&&!disconnected)await request;clearInterval(timer);server.closeAllConnections();server.close();});
  assert.equal(typeof api.installBridgeHttpClosure,'function','graceful HTTP close controller required');
  const closure=api.installBridgeHttpClosure({server,fence,token:'fixture-owner',setIntervalImpl:(...a)=>{timer=setInterval(...a);return timer;}});
  return {server,port,fence,closure,request,release,get finished(){return finished;},get hold(){return timer;},
    closed:async()=>{for(let n=0;n<500 && !closure.snapshot().http_closed;n++)await wait(2);assert.equal(closure.snapshot().http_closed,true);}};
}

test('HTTP close waits for a preinstallation accepted request and retains a referenced verification hold',async t=>{
  const f=await fixture(t,{preexisting:true});f.fence.fence('fixture-owner');f.closure.begin('fixture-owner');
  assert.equal(f.closure.snapshot().http_closed,false);assert.equal(f.hold.hasRef(),true);assert.equal(f.finished,0);
  f.release();assert.equal(await (await f.request).text(),'ok');await f.closed();
  assert.equal(f.finished,1);assert.equal(f.closure.snapshot().preexisting_work_verified,false);assert.equal(f.closure.snapshot().stop_authorized,false);
});

test('disconnected preinstallation handler can outlive HTTP close and is never reported as work closure',async t=>{
  const f=await fixture(t,{preexisting:true,disconnected:true});f.fence.fence('fixture-owner');f.closure.begin('fixture-owner');await f.closed();
  assert.equal(f.finished,0);assert.equal(f.closure.snapshot().preexisting_work_verified,false);assert.equal(f.closure.snapshot().drained,false);
  assert.equal(f.hold.hasRef(),true);f.release();await wait(5);assert.equal(f.finished,1);
});

test('unfenced or wrong owner cannot close the HTTP listener',async t=>{
  const f=await fixture(t);assert.throws(()=>f.closure.begin('fixture-owner'),/fence|owner/);
  f.fence.fence('fixture-owner');assert.throws(()=>f.closure.begin('different-owner'),/owner/);assert.equal(f.server.listening,true);
});

test('only one HTTP closure controller may own the source server',async t=>{
  const f=await fixture(t);assert.throws(()=>api.installBridgeHttpClosure({server:f.server,fence:f.fence,token:'second-owner'}),/owner|already/);
  assert.equal(f.server.listening,true);
});

test('abort reopens the same server and port while preserving its producer fence',async t=>{
  const f=await fixture(t);f.fence.fence('fixture-owner');f.closure.begin('fixture-owner');await f.closed();
  const reopened=await f.closure.abort('fixture-owner');assert.equal(reopened.mode,'open_fenced');assert.equal(f.server.address().port,f.port);
  assert.equal(reopened.verification_hold_active,false);assert.equal(f.hold._destroyed,true);
  assert.equal((await fetch(`http://127.0.0.1:${f.port}/events`,{method:'POST'})).status,503);
  await f.fence.resume('fixture-owner');assert.equal((await fetch(`http://127.0.0.1:${f.port}/events`,{method:'POST'})).status,200);
});

test('occupied port on abort is preserved and the HTTP controller does not claim recovery',async t=>{
  const f=await fixture(t);f.fence.fence('fixture-owner');f.closure.begin('fixture-owner');await f.closed();
  const occupant=http.createServer((req,res)=>res.end('other-owner'));t.after(()=>{occupant.closeAllConnections();occupant.close();});
  occupant.listen(f.port,'127.0.0.1');await once(occupant,'listening');
  await assert.rejects(f.closure.abort('fixture-owner'),/EADDRINUSE|occupied/);
  assert.equal(f.server.listening,false);assert.equal(f.closure.snapshot().mode,'reopen_failed');assert.equal(f.hold.hasRef(),true);
  assert.equal(await (await fetch(`http://127.0.0.1:${f.port}`)).text(),'other-owner');
});
