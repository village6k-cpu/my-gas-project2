import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {once} from 'node:events';
import {createHash} from 'node:crypto';
import {fixture} from '../../test/helpers/migration_bridge_fixture.mjs';
import {atOwnedBridgeBoundary,withVerifiedBridgeInspector} from './migration_bridge_inspector_session.mjs';

const adapter = await import('./migration_bridge_work_probe.mjs').catch(() => ({}));
const sha = b => createHash('sha256').update(b).digest('hex');
const wait = ms => new Promise(r => setTimeout(r, ms));

async function debugOwner(url) {
  const socket=new WebSocket(url);
  await once(socket,'open');
  let next=0,paused=null;const pending=new Map();
  socket.addEventListener('message',event=>{
    const m=JSON.parse(event.data);
    if(m.id) {const p=pending.get(m.id);if(p){pending.delete(m.id);m.error?p.reject(Error(m.error.message)):p.resolve(m.result);}}
    else if(m.method==='Debugger.paused')paused=m.params;
    else if(m.method==='Debugger.resumed')paused=null;
  });
  return {socket,get paused(){return paused;},command(method,params={}) {
    const id=++next;return new Promise((resolve,reject)=>{pending.set(id,{resolve,reject});socket.send(JSON.stringify({id,method,params}));});
  }};
}

test('probe is implemented before use', () => {
  assert.equal(typeof adapter.observeBridgePrivateWork,'function','read-only private-work observer is required');
});

test('a foreign debugger pause arriving during loaded-source checks prevents the verified callback',async t=>{
  const {ws,expected}=await fixture(t);const other=await debugOwner(ws);await other.command('Debugger.enable');
  const Original=globalThis.WebSocket;let injected=false,called=false,pendingRequest,pauseConfirmed=false;
  globalThis.WebSocket=class extends Original {
    send(data){
      if(!injected && JSON.parse(data).method==='Debugger.getScriptSource') {
        injected=true;
        void (async()=>{await other.command('Debugger.pause');
          pendingRequest=fetch(`http://127.0.0.1:${expected.port}/migration-private-work/11111111-1111-1111-1111-111111111111`);
          const until=Date.now()+1500;
          while(!other.paused && Date.now()<until)await wait(5);pauseConfirmed=!!other.paused;super.send(data);})();
      }else super.send(data);
    }
  };
  try {
    await assert.rejects(withVerifiedBridgeInspector(ws,expected,()=>{called=true;}),/Unowned debugger pause/);
    assert.equal(called,false);assert.ok(other.paused,'foreign owner retains pause');
  } finally {
    globalThis.WebSocket=Original;if(other.paused)await other.command('Debugger.resume');
    if(pendingRequest)await (await pendingRequest).arrayBuffer();
    await other.command('Debugger.disable');other.socket.close();assert.equal(pauseConfirmed,true,'pause injection must actually pause target');
  }
});

test('an enabled poller whose first sweep has never started is observed through its private running binding',async t=>{
  const {ws,expected}=await fixture(t,{busy:'action-idle'});
  const result=await adapter.observeBridgePrivateWork(ws,expected);assert.equal(result.idle,true,JSON.stringify(result));
  assert.equal(result.action_poller_running,false);
});

test('a retained reader observes live flags after the nonce request has completed',async t=>{
  const {ws,expected}=await fixture(t);
  await atOwnedBridgeBoundary(ws,expected,async({client,frame,identity})=>({
    reader:await adapter.captureBridgePrivateWorkReader(client,frame,expected),identity
  }),{afterResume:async({reader,identity},client)=>{
    const first=await adapter.readCapturedBridgePrivateWork(client,reader,identity,expected);assert.equal(first.idle,true);
    const changed=await client.command('Runtime.evaluate',{expression:'globalThis.__fixtureToggleWorker();void 0'});
    assert.equal(changed.exceptionDetails,undefined);
    const second=await adapter.readCapturedBridgePrivateWork(client,reader,identity,expected);
    assert.equal(second.flags.workerRunning,true);assert.equal(second.idle,false);
  }});
});

test('real closure maps and promise states are observed without leaking private values or changing source', async t => {
  const {ws,expected} = await fixture(t);
  const result = await adapter.observeBridgePrivateWork(ws,expected);
  assert.equal(result.observation_only,true); assert.equal(result.stop_authorized,false);
  assert.equal(result.idle,true,JSON.stringify(result));
  assert.deepEqual(result.http_in_flight,{confirmationInFlight:0,documentInFlight:0,registeredReservationChangeInFlight:0,confirmedReservationCommitInFlight:0});
  assert.deepEqual(result.promises,{applicationTail:'fulfilled',projectionInFlight:'absent',mutationTail:'fulfilled',recoveryTail:'fulfilled',workerChain:'fulfilled'});
  assert.equal(JSON.stringify(result).includes('NEVER-REPORT'),false);
  for(const row of Object.values(expected.modules)) assert.equal(sha(await fs.readFile(row.path)),row.sha256);
  assert.equal((await fetch(`http://127.0.0.1:${expected.port}/health`)).status,200,'debugger always resumes');
});

for (const busy of ['http','app','audit','channel','manual','worker','recovery','chain','registration','p0-active','p0-catchup','shadow','action-poll']) {
  test(`preexisting ${busy} work blocks idle observation`, async t => {
    const {ws,expected} = await fixture(t,{busy});
    const before=Date.now();
    const result = await adapter.observeBridgePrivateWork(ws,expected);
    assert.equal(result.idle,false);
    assert.equal(result.stop_authorized,false);
    assert.equal(JSON.stringify(result).includes('PRIVATE-CUSTOMER'),false);
    assert.equal(JSON.stringify(result).includes('NEVER-REPORT'),false);
    assert.ok(Date.now()-before<3000,'observation must not wait on the pending channel tail');
    assert.equal((await fetch(`http://127.0.0.1:${expected.port}/fixture-responsive`)).status,200);
  });
}

test('wrong process or loaded source hash fails closed and leaves server responding', async t => {
  const {ws,expected} = await fixture(t);
  await assert.rejects(adapter.observeBridgePrivateWork(ws,{...expected,pid:expected.pid+1}),/ownership/);
  const modules = structuredClone(expected.modules); modules.http.sha256='0'.repeat(64);
  await assert.rejects(adapter.observeBridgePrivateWork(ws,{...expected,modules}),/hash/);
  assert.equal((await fetch(`http://127.0.0.1:${expected.port}/health`)).status,200);
});

test('CURRENT production source, isolated from all external traffic, exposes its four private maps', async t => {
  const {ws,expected} = await fixture(t,{actual:true});
  const result = await adapter.observeBridgePrivateWork(ws,expected);
  assert.equal(result.idle,true,JSON.stringify(result));
  assert.equal(Object.keys(result.http_in_flight).length,4);
  assert.deepEqual(result.promises,{applicationTail:'absent',projectionInFlight:'absent',mutationTail:'absent',recoveryTail:'absent',workerChain:'fulfilled'});
  assert.equal(result.stop_authorized,false);
});

test('CURRENT no-send gateway source exposes its real channel mutation tail', async t => {
  const {ws,expected} = await fixture(t,{actual:true,transport:'gateway_no_send'});
  const result=await adapter.observeBridgePrivateWork(ws,expected);
  assert.equal(result.promises.mutationTail,'fulfilled');
  assert.equal(result.idle,true,JSON.stringify(result));
});

test('failure while paused removes breakpoint and resumes the owned server', async t => {
  const {ws,expected}=await fixture(t,{mismatchPort:true});
  await assert.rejects(adapter.observeBridgePrivateWork(ws,expected),/evaluation rejected/);
  assert.equal((await fetch(`http://127.0.0.1:${expected.port}/health`)).status,200);
});

test('observer never resumes a pause owned by another debugger',async t=>{
  const {ws,expected}=await fixture(t);
  const owner=await debugOwner(ws);
  let request;
  try {
    await owner.command('Debugger.enable');await owner.command('Debugger.pause');
    request=fetch(`http://127.0.0.1:${expected.port}/fixture-responsive`,{signal:AbortSignal.timeout(20000)}).catch(()=>null);
    const until=Date.now()+2000;while(!owner.paused && Date.now()<until)await wait(10);
    assert.ok(owner.paused);
    await assert.rejects(adapter.observeBridgePrivateWork(ws,expected),/pause|observation request/);
    assert.ok(owner.paused,'unrelated debugger pause must remain owned by its original debugger');
    await owner.command('Debugger.evaluateOnCallFrame',{callFrameId:owner.paused.callFrames[0].callFrameId,expression:'1'});
  } finally {
    if(owner.paused)await owner.command('Debugger.resume');owner.socket.close();if(request)await request;
  }
});
