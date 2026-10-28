import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {fixture} from '../../test/helpers/migration_bridge_fixture.mjs';
import {installCurrentBridgeFenceOnInspectedSource} from './migration_bridge_producer_adapter.mjs';
const adapter=await import('./migration_bridge_http_adapter.mjs').catch(()=>({}));

test('CURRENT isolated source remains observable after HTTP closure and reopens the same server',async t=>{
  assert.equal(typeof adapter.withCurrentBridgeHttpClosure,'function','source-bound HTTP adapter required');
  const {ws,expected}=await fixture(t,{actual:true,transport:'gateway'});
  const producer=await installCurrentBridgeFenceOnInspectedSource(ws,expected,'fixture-closed-owner');await producer.fence();
  for(let attempt=0;attempt<2;attempt++) {
    const report=await adapter.withCurrentBridgeHttpClosure(ws,expected,'fixture-closed-owner',async control=>{
      const a=await control.observe(),b=await control.observe();
      assert.equal(a.http.http_closed,true);assert.equal(a.http.verification_hold_active,true);
      assert.equal(a.producer.producers_owned,true);assert.equal(a.private_work.owner.pid,expected.pid);
      assert.equal(a.private_work.idle,true);assert.equal(b.private_work.idle,true);
      assert.equal(a.native_promises.complete,true);assert.equal(a.native_promises.idle,true,JSON.stringify(a.native_promises));assert.equal(a.stop_authorized,false);
      await assert.rejects(fetch(`http://127.0.0.1:${expected.port}/health`));return a;
    });
    assert.equal(report.http.http_closed,true);
    assert.equal((await fetch(`http://127.0.0.1:${expected.port}/health`)).status,200);
    assert.equal((await producer.snapshot()).mode,'fenced');
  }
  await producer.resume();
});

test('CURRENT disconnected accepted handler remains visible after the listener closes',async t=>{
  assert.equal(typeof adapter.withCurrentBridgeHttpClosure,'function');
  const {ws,expected}=await fixture(t,{actual:true,transport:'gateway'});
  const request=http.request({host:'127.0.0.1',port:expected.port,path:'/hermes/v1/events?consumer_id=SYNTHETIC&wait_ms=60000',
    headers:{Authorization:'Bearer SYNTHETIC-NOT-A-CREDENTIAL'}});
  request.on('error',()=>{});request.end();await new Promise(r=>setTimeout(r,80));request.destroy();
  const producer=await installCurrentBridgeFenceOnInspectedSource(ws,expected,'fixture-disconnected-owner');await producer.fence();
  await adapter.withCurrentBridgeHttpClosure(ws,expected,'fixture-disconnected-owner',async control=>{
    const report=await control.observe();
    assert.equal(report.http.http_closed,true);assert.equal(report.private_work.idle,true);
    assert.equal(report.native_promises.complete,true);assert.ok(report.native_promises.counts.pending>0);
    assert.equal(report.idle,false);assert.equal(report.stop_authorized,false);
  });
  await producer.resume();
});

test('callback failure restores HTTP while keeping the producer fence owned',async t=>{
  const {ws,expected}=await fixture(t,{actual:true,transport:'gateway'});
  const producer=await installCurrentBridgeFenceOnInspectedSource(ws,expected,'fixture-failure-owner');await producer.fence();
  await assert.rejects(adapter.withCurrentBridgeHttpClosure(ws,expected,'fixture-failure-owner',async()=>{throw Error('SYNTHETIC CALLBACK FAILURE');}),/SYNTHETIC CALLBACK FAILURE/);
  assert.equal((await fetch(`http://127.0.0.1:${expected.port}/health`)).status,200);
  assert.equal((await producer.snapshot()).mode,'fenced');await producer.resume();
});

test('a different owner cannot close the source listener',async t=>{
  const {ws,expected}=await fixture(t,{actual:true,transport:'gateway'});
  const producer=await installCurrentBridgeFenceOnInspectedSource(ws,expected,'fixture-real-owner');await producer.fence();
  await assert.rejects(adapter.withCurrentBridgeHttpClosure(ws,expected,'fixture-wrong-owner',async()=>{}),/owner|evaluation rejected/i);
  assert.equal((await fetch(`http://127.0.0.1:${expected.port}/health`)).status,200);await producer.resume();
});
