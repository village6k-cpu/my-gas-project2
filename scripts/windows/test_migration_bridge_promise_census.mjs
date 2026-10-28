import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {fixture} from '../../test/helpers/migration_bridge_fixture.mjs';
import {atOwnedBridgeBoundary} from './migration_bridge_inspector_session.mjs';
import {observeBridgePrivateWork} from './migration_bridge_work_probe.mjs';
const module=await import('./migration_bridge_promise_census.mjs').catch(()=>({}));

async function census(t,expression='',maxObjects=4096) {
  assert.equal(typeof module.censusPendingNativePromises,'function','native pending-Promise census required');
  const {ws,expected}=await fixture(t);
  return atOwnedBridgeBoundary(ws,expected,()=>null,{afterResume:async(_,client)=>{
    if(expression){const r=await client.command('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:false});assert.equal(r.exceptionDetails,undefined,'fixture expression must execute');}
    return module.censusPendingNativePromises(client,{maxObjects});
  }});
}

test('an idle target returns a complete redacted native Promise census',async t=>{
  const result=await census(t);assert.equal(result.complete,true,JSON.stringify(result));
  assert.equal(result.counts.pending,0);assert.equal(result.idle,true);assert.equal(result.stop_authorized,false);
});

test('unbounded sleepers and Promise subclasses block closure without exposing fulfilled results',async t=>{
  const result=await census(t,"globalThis.__fixtureCensus=[new Promise(()=>{}),new(class extends Promise {})(()=>{}),Promise.resolve('PRIVATE-CUSTOMER-SECRET')]; void 0");
  assert.equal(result.complete,true,JSON.stringify(result));assert.ok(result.counts.pending>=2);
  assert.equal(result.idle,false);assert.equal(result.stop_authorized,false);
  assert.equal(JSON.stringify(result).includes('PRIVATE-CUSTOMER-SECRET'),false);
});

test('an incomplete or over-limit census cannot claim zero pending work',async t=>{
  const result=await census(t,'globalThis.__fixtureCensus=[Promise.resolve(),Promise.resolve(),Promise.resolve()];void 0',1);
  assert.equal(result.complete,false);assert.equal(result.idle,false);assert.equal(result.reason,'promise_object_limit');
  assert.equal(result.counts.pending,null);
});

test('a pending Promise in an additional VM realm is included in the census',async t=>{
  const result=await census(t,'globalThis.__fixtureVmCreate(); void 0');
  assert.equal(result.complete,true,JSON.stringify(result));assert.equal(result.idle,false);assert.ok(result.counts.pending>=1);assert.ok(result.context_count>=2);
});

test('a context created and destroyed during enumeration invalidates the census',async()=>{
  const client={contexts:new Map([[1,{id:1}]]),contextRevision:1,async command(method){
    if(method==='Runtime.evaluate')return {result:{objectId:'prototype'}};
    if(method==='Runtime.queryObjects'){
      this.contextRevision+=2;return {objects:{subtype:'array',objectId:'array'}};
    }
    if(method==='Runtime.getProperties')return {result:[{name:'length',value:{value:0}}]};
    return {};
  }};
  const result=await module.censusPendingNativePromises(client);
  assert.equal(result.complete,false);assert.equal(result.idle,false);
  assert.equal(result.reason,'execution_contexts_changed');assert.equal(result.counts.pending,null);
});

test('CURRENT disconnected long-poll evades private queue flags but remains in native Promise census',async t=>{
  const {ws,expected}=await fixture(t,{actual:true,transport:'gateway_no_send'});
  const request=http.request({host:'127.0.0.1',port:expected.port,path:'/hermes/v1/events?consumer_id=SYNTHETIC&wait_ms=60000',
    headers:{Authorization:'Bearer SYNTHETIC-NOT-A-CREDENTIAL'}});
  request.on('error',()=>{});request.end();await new Promise(r=>setTimeout(r,100));request.destroy();
  const privateWork=await observeBridgePrivateWork(ws,expected);assert.equal(privateWork.idle,true,JSON.stringify(privateWork));
  const result=await atOwnedBridgeBoundary(ws,expected,()=>null,{afterResume:(_,client)=>module.censusPendingNativePromises(client)});
  assert.equal(result.complete,true,JSON.stringify(result));assert.ok(result.counts.pending>0);assert.equal(result.idle,false);
});
