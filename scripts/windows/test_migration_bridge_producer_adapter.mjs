import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from '../../test/helpers/migration_bridge_fixture.mjs';
import {observeBridgePrivateWork} from './migration_bridge_work_probe.mjs';
const adapter=await import('./migration_bridge_producer_adapter.mjs').catch(()=>({}));

test('CURRENT isolated gateway source can fence every producer and restore exact normal serving',async t=>{
  assert.equal(typeof adapter.installCurrentBridgeFenceOnInspectedSource,'function','source-bound producer adapter required');
  const {ws,expected}=await fixture(t,{actual:true,transport:'gateway'});
  const control=await adapter.installCurrentBridgeFenceOnInspectedSource(ws,expected,'fixture-current-owner');
  const fenced=await control.fence();
  assert.equal(fenced.mode,'fenced');assert.equal(fenced.producers_owned,true);
  assert.equal(fenced.producer_names.length,6);
  assert.equal((await fetch(`http://127.0.0.1:${expected.port}/events`,{method:'POST'})).status,503);
  assert.equal((await fetch(`http://127.0.0.1:${expected.port}/hermes/v1/events`)).status,503);
  const observation=await observeBridgePrivateWork(ws,expected);
  assert.equal(observation.stop_authorized,false);
  assert.equal(observation.promises.applicationTail,'fulfilled');
  assert.equal((await control.snapshot()).preexisting_work_verified,false);
  const reconnected=await adapter.connectCurrentBridgeProducerFence(ws,expected,'fixture-current-owner');
  assert.equal((await reconnected.snapshot()).mode,'fenced');
  await assert.rejects(adapter.connectCurrentBridgeProducerFence(ws,expected,'wrong-owner'),/evaluation rejected|owner/);
  assert.equal((await reconnected.resume()).mode,'released');
  assert.equal((await fetch(`http://127.0.0.1:${expected.port}/events`,{method:'POST',body:'{}'})).status===503,false);
});

test('uninitialized coordinator fails without installing a producer fence',async t=>{
  assert.equal(typeof adapter.installCurrentBridgeFenceOnInspectedSource,'function');
  const {ws,expected}=await fixture(t,{actual:true,transport:'gateway_no_send'});
  await assert.rejects(adapter.installCurrentBridgeFenceOnInspectedSource(ws,expected,'fixture-current-owner'),/evaluation rejected|coordinator/);
  assert.equal((await fetch(`http://127.0.0.1:${expected.port}/health`)).status,200);
});

test('CURRENT held recovery timer cannot restart application recovery, registration or Supabase sweep while fenced',async t=>{
  const {ws,expected}=await fixture(t,{actual:true,transport:'gateway',recoveryHold:true});
  const originalTimers=await adapter.observeCurrentBridgeRuntimeTimers(ws,expected);
  assert.deepEqual(originalTimers,{digest:false,notice_cleanup:false});
  const control=await adapter.installCurrentBridgeFenceOnInspectedSource(ws,expected,'fixture-held-owner');
  await control.fence();
  await new Promise(r=>setTimeout(r,150));
  const state=await control.snapshot();
  for(const name of ['recoverPendingApplications','runRegistrationRetrySweep','runSupabaseRecoverySweep'])assert.ok(state.blocked_calls[name]>0,name);
  assert.equal(state.preexisting_work_verified,false);
  assert.equal(state.stop_authorized,false);
  await control.resume();
  assert.deepEqual(await adapter.observeCurrentBridgeRuntimeTimers(ws,expected),originalTimers);
});

test('a pending runtime start cannot install its interval after producer fencing',async t=>{
  const {ws,expected}=await fixture(t,{busy:'timer-start'});
  await assert.rejects(adapter.observeCurrentBridgeRuntimeTimers(ws,expected),/runtime|Runtime/);
});

test('CURRENT running digest and cleanup intervals remain the same live timers across fence and abort',async t=>{
  const {ws,expected}=await fixture(t,{actual:true,transport:'gateway',v2:true});
  assert.deepEqual(await adapter.observeCurrentBridgeRuntimeTimers(ws,expected),{digest:true,notice_cleanup:true});
  const control=await adapter.installCurrentBridgeFenceOnInspectedSource(ws,expected,'fixture-running-owner');
  await control.fence();await new Promise(r=>setTimeout(r,100));
  const state=await control.snapshot();
  assert.ok(state.runtime_blocked_calls.digest>0);assert.ok(state.runtime_blocked_calls.notice_cleanup>0);
  await control.resume();
  assert.deepEqual(await adapter.observeCurrentBridgeRuntimeTimers(ws,expected),{digest:true,notice_cleanup:true});
});
