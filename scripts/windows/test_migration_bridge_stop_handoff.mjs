import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import http from 'node:http';
import {fixture} from '../../test/helpers/migration_bridge_fixture.mjs';
import {connectCurrentBridgeProducerFence,installCurrentBridgeFenceOnInspectedSource} from './migration_bridge_producer_adapter.mjs';
const handoff=await import('./migration_bridge_stop_handoff.mjs').catch(()=>({}));
const sha=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const intent='a'.repeat(64),id='SYNTHETIC-CONTROLLER';
function sourceAlive(pid){try{process.kill(pid,0);return true;}catch(e){if(e.code==='ESRCH')return false;throw e;}}
function options(f,kind){
  let command=null,report=null,scheduled=false;
  return {url:f.ws,expected:f.expected,token:'fixture-handoff-owner',intentSha256:intent,controllerId:id,
    maxWaitMs:10000,pollMs:20,io:{sourceAlive:()=>sourceAlive(f.expected.pid),
      async publish(value){report={...value,sha256:sha(value)};
        command={action:kind==='abort'?'abort':'stop',controller_id:id,intent_sha256:intent,observation_sha256:kind==='wrong'?'f'.repeat(64):report.sha256};
        return {sha256:report.sha256};},
      async readCommand(){return command;},async invalidateReady(){command=null;},
      async acknowledgeStop(ack){if(kind==='stop'&&!scheduled){scheduled=true;setTimeout(()=>process.kill(f.expected.pid,'SIGKILL'),30);}return {sha256:sha(ack)};}}};
}

test('the parent can fence producers, drain accepted workers, then connect the same fence for HTTP closure',async t=>{
  const f=await fixture(t,{actual:true,transport:'gateway'}),config=options(f,'abort');
  const producer=await installCurrentBridgeFenceOnInspectedSource(f.ws,f.expected,config.token);
  await producer.fence();
  const report=await handoff.holdCurrentBridgeForStop({...config,producerMode:'connect'});
  assert.equal(report.aborted,true);await producer.resume();
});

test('a closed-source abort restores HTTP and retains the parent-owned producer fence',async t=>{
  assert.equal(typeof handoff.holdCurrentBridgeForStop,'function','parent stop handoff participant required');
  const f=await fixture(t,{actual:true,transport:'gateway'});
  const report=await handoff.holdCurrentBridgeForStop(options(f,'abort'));
  assert.equal(report.aborted,true);assert.equal(report.source_stopped,false);
  assert.equal((await fetch(`http://127.0.0.1:${f.expected.port}/health`)).status,200);
  const p=await connectCurrentBridgeProducerFence(f.ws,f.expected,'fixture-handoff-owner');await p.resume();
});

test('only a matching observation and independently observed exit complete the bridge participant',async t=>{
  const f=await fixture(t,{actual:true,transport:'gateway'});
  const report=await handoff.holdCurrentBridgeForStop(options(f,'stop'));
  assert.equal(report.bridge_exit_observed,true);assert.equal(report.full_source_stop_authorized,false);
  assert.match(report.accepted_observation_sha256,/^[a-f0-9]{64}$/);assert.equal(sourceAlive(f.expected.pid),false);
});

test('a stop command for another observation fails and reopens HTTP without stopping anything',async t=>{
  const f=await fixture(t,{actual:true,transport:'gateway'});
  await assert.rejects(handoff.holdCurrentBridgeForStop(options(f,'wrong')),/observation|command/i);
  assert.equal(sourceAlive(f.expected.pid),true);assert.equal((await fetch(`http://127.0.0.1:${f.expected.port}/health`)).status,200);
  const p=await connectCurrentBridgeProducerFence(f.ws,f.expected,'fixture-handoff-owner');await p.resume();
});

test('an uncertain parent acknowledgement cannot complete the participant or close the process',async t=>{
  const f=await fixture(t,{actual:true,transport:'gateway'}),config=options(f,'badack');
  config.io.acknowledgeStop=async()=>({sha256:'b'.repeat(64)});
  await assert.rejects(handoff.holdCurrentBridgeForStop(config),/acknowledgement hash/);
  assert.equal(sourceAlive(f.expected.pid),true);assert.equal((await fetch(`http://127.0.0.1:${f.expected.port}/health`)).status,200);
  const p=await connectCurrentBridgeProducerFence(f.ws,f.expected,'fixture-handoff-owner');await p.resume();
});

test('an unexpected source exit without parent stop acceptance cannot become a successful handoff',async t=>{
  const f=await fixture(t,{actual:true,transport:'gateway'}),config=options(f,'abort');let killed=false;
  config.io.readCommand=async()=>{if(!killed){killed=true;setTimeout(()=>process.kill(f.expected.pid,'SIGKILL'),30);}return null;};
  await assert.rejects(handoff.holdCurrentBridgeForStop(config),/Inspector|HTTP|source/i);
  assert.equal(sourceAlive(f.expected.pid),false);
});

test('a disconnected preaccepted claim never publishes readiness and can still be aborted',async t=>{
  const f=await fixture(t,{actual:true,transport:'gateway'}),config=options(f,'abort');
  const req=http.request({host:'127.0.0.1',port:f.expected.port,path:'/hermes/v1/events?consumer_id=SYNTHETIC&wait_ms=60000',headers:{Authorization:'Bearer SYNTHETIC-NOT-A-CREDENTIAL'}});
  req.on('error',()=>{});req.end();await new Promise(r=>setTimeout(r,80));req.destroy();
  let invalidated=false;
  config.io.publish=async()=>{assert.fail('busy source must never publish readiness');};
  config.io.invalidateReady=async()=>{invalidated=true;};
  config.io.readCommand=async()=>({action:'abort',controller_id:id,intent_sha256:intent,observation_sha256:null});
  assert.equal((await handoff.holdCurrentBridgeForStop(config)).aborted,true);assert.equal(invalidated,true);
  const p=await connectCurrentBridgeProducerFence(f.ws,f.expected,'fixture-handoff-owner');await p.resume();
});

for(const change of ['controller','observation'])test(`a post-ack ${change} change plus actual source exit remains a protocol failure`,async t=>{
  const f=await fixture(t,{actual:true,transport:'gateway'}),config=options(f,'protocol-change');
  const originalRead=config.io.readCommand;let acked=false;
  config.io.acknowledgeStop=async ack=>{acked=true;return {sha256:sha(ack)};};
  config.io.readCommand=async()=>{
    const command=await originalRead();if(!acked)return command;
    process.kill(f.expected.pid,'SIGKILL');while(sourceAlive(f.expected.pid))await new Promise(r=>setTimeout(r,5));
    return {...command,...(change==='controller'?{controller_id:'WRONG-CONTROLLER'}:{observation_sha256:'d'.repeat(64)})};
  };
  await assert.rejects(handoff.holdCurrentBridgeForStop(config),/command|observation/i);
  assert.equal(sourceAlive(f.expected.pid),false);
});
