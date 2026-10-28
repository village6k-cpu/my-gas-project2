import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {fixture} from '../../test/helpers/migration_bridge_fixture.mjs';
import {installCurrentBridgeFenceOnInspectedSource} from './migration_bridge_producer_adapter.mjs';
const cli=await import('./migration_bridge_stop_cli.mjs').catch(()=>({}));
const sha=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const intent='a'.repeat(64),id='SYNTHETIC-CONTROLLER';
async function setup(t){
  const directory=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'village-stop-io-')));
  t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  return {directory,io:cli.createParticipantIo({directory,intentSha256:intent,controllerId:id,pid:process.pid})};
}
test('private IO persists exact observation and acknowledgement bytes before returning their hashes',async t=>{
  assert.equal(typeof cli.createParticipantIo,'function');
  const {directory,io}=await setup(t),evidence={controller_id:id,intent_sha256:intent,observed_unix_ms:Date.now()};
  const out=await io.publish(evidence);assert.equal(out.sha256,sha(evidence));
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(directory,'observations',out.sha256+'.json'))),evidence);
  assert.equal(JSON.parse(await fs.readFile(path.join(directory,'READY.json'))).sha256,out.sha256);
  const ack={...evidence,action:'stop'},a=await io.acknowledgeStop(ack);
  assert.equal(a.sha256,sha(ack));assert.deepEqual(JSON.parse(await fs.readFile(path.join(directory,'STOP-ACK.json'))),ack);
  await assert.rejects(io.acknowledgeStop({...ack,action:'other'}),/existing|changed/i);
});
test('private IO rejects foreign ready markers, malformed commands and changed persisted observations',async t=>{
  const {directory,io}=await setup(t);
  await fs.writeFile(path.join(directory,'READY.json'),JSON.stringify({controller_id:'FOREIGN',intent_sha256:intent}));
  await assert.rejects(io.invalidateReady(),/owner/i);
  await assert.rejects(io.publish({controller_id:id,intent_sha256:intent}),/owner/i);
  await fs.writeFile(path.join(directory,'COMMAND.json'),'{');
  await assert.rejects(io.readCommand(),/JSON|parse|property/i);
});
test('owned readiness can be invalidated, and an absent command is never a stop',async t=>{
  const {directory,io}=await setup(t);
  assert.equal(await io.readCommand(),null);assert.equal(await io.sourceAlive(),true);
  await io.publish({controller_id:id,intent_sha256:intent});await io.invalidateReady();
  await assert.rejects(fs.stat(path.join(directory,'READY.json')),e=>e.code==='ENOENT');
});
test('the parent cannot observe a stop acknowledgement before fsync finishes',async t=>{
  const {directory,io}=await setup(t),original=fs.open;
  let entered,release;const waiting=new Promise(r=>entered=r),proceed=new Promise(r=>release=r);
  fs.open=async(...args)=>{
    const handle=await original(...args);
    if(String(args[0]).includes('STOP-ACK.json')){
      const sync=handle.sync.bind(handle);handle.sync=async()=>{entered();await proceed;return sync();};
    }
    return handle;
  };
  t.after(()=>{fs.open=original;release();});
  const pending=io.acknowledgeStop({controller_id:id,intent_sha256:intent,action:'stop'});
  await waiting;
  await assert.rejects(fs.stat(path.join(directory,'STOP-ACK.json')),e=>e.code==='ENOENT');
  release();await pending;assert.ok(await fs.stat(path.join(directory,'STOP-ACK.json')));
});
test('references must remain below the private base, with exact hashes and no symlink traversal',async t=>{
  assert.equal(typeof cli.readBoundPrivate,'function');
  const {directory}=await setup(t),p=path.join(directory,'input.json');
  await fs.writeFile(p,'{}');const pin=createHash('sha256').update('{}').digest('hex');
  assert.deepEqual(await cli.readBoundPrivate({path:p,sha256:pin},directory),{});
  await assert.rejects(cli.readBoundPrivate({path:p,sha256:'f'.repeat(64)},directory),/changed/i);
  await assert.rejects(cli.readBoundPrivate({path:p,sha256:pin},path.join(directory,'other')),/private/i);
});

test('the actual Windows CLI loads its private pinned copy, publishes readiness and aborts its owned fixture',
  {skip:process.platform!=='win32'},async t=>{
  const base=await fs.realpath('C:/Village/migration-staging/studio-20260930/resume-20261027');
  const directory=await fs.mkdtemp(path.join(base,'SYNTHETIC-stop-cli-test-'));
  t.after(async()=>{assert.equal(path.dirname(directory),base);assert.ok(path.basename(directory).startsWith('SYNTHETIC-stop-cli-test-'));await fs.rm(directory,{recursive:true,force:true});});
  const f=await fixture(t,{actual:true,transport:'gateway'}),token='SYNTHETIC-private-parent-token';
  const producer=await installCurrentBridgeFenceOnInspectedSource(f.ws,f.expected,token);await producer.fence();
  const dependencies=[];
  for(const name of ['migration_bridge_stop_cli.mjs','migration_bridge_stop_handoff.mjs','migration_bridge_inspector_session.mjs',
      'migration_bridge_producer_adapter.mjs','migration_bridge_producer_fence.mjs','migration_bridge_http_adapter.mjs',
      'migration_bridge_http_closure.mjs','migration_bridge_work_probe.mjs','migration_bridge_promise_census.mjs']){
    const bytes=await fs.readFile(new URL(name,import.meta.url)),out=path.join(directory,name);await fs.writeFile(out,bytes);
    dependencies.push({path:out,sha256:createHash('sha256').update(bytes).digest('hex')});
  }
  async function ref(name,value){const out=path.join(directory,name),raw=JSON.stringify(value);await fs.writeFile(out,raw);return {path:out,sha256:createHash('sha256').update(raw).digest('hex')};}
  const intentRef=await ref('intent.json',{profiles:[{role:'bridge',...f.expected,started:1}]});
  const cfg={schema:'village-current-bridge-stop-participant/v1',controller_id:id,token,producer_mode:'connect',
    dependencies,intent:intentRef,expected:await ref('expected.json',f.expected),
    inspector:await ref('inspector.json',{pid:f.expected.pid,started:1,url:f.ws})};
  const configRef=await ref('config.json',cfg);
  const child=spawn(process.execPath,[path.join(directory,'migration_bridge_stop_cli.mjs'),'--config',configRef.path,'--config-sha',configRef.sha256,'--run'],{windowsHide:true,stdio:['ignore','pipe','pipe']});
  let errors='';child.stderr.on('data',b=>errors+=b);const exited=once(child,'exit');
  t.after(async()=>{if(child.exitCode===null&&child.signalCode===null){child.kill();await exited;}});
  const end=Date.now()+20000;let pointer;
  while(Date.now()<end){try{pointer=JSON.parse(await fs.readFile(path.join(directory,'READY.json')));break;}catch(e){if(e.code!=='ENOENT')throw e;}if(child.exitCode!==null)throw Error(errors);await new Promise(r=>setTimeout(r,30));}
  assert.ok(pointer,'actual CLI readiness missing: '+errors);
  await fs.writeFile(path.join(directory,'COMMAND.json'),JSON.stringify({action:'abort',controller_id:id,intent_sha256:intentRef.sha256,observation_sha256:null}));
  const [code]=await exited;assert.equal(code,0,errors);
  assert.equal(JSON.parse(await fs.readFile(path.join(directory,'RESULT.json'))).aborted,true);
  const recovered=await cli.recoverOwnedHttpSession({config:cfg,expected:f.expected,url:f.ws});
  assert.equal(recovered.producer_still_fenced,true);await producer.resume();
});
