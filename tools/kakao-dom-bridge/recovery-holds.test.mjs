import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHermesGatewayChannel } from './hermes-gateway-channel.mjs';
const hash = x => createHash('sha256').update(x).digest('hex');
const event = (id, room='old-room', revision=1) => ({job_id:id,room_key:room,room_revision:revision,detected_at:'2026-10-23T00:00:00.000Z'});
async function fixture(run) {
 const directory=await mkdtemp(path.join(tmpdir(),'village-recovery-holds-'));
 const clock={now:Date.parse('2026-10-23T00:00:00.000Z')};
 const file=id=>path.join(directory,'hermes-gateway',hash(id)+'.json');
 const options={directory,leaseMs:1000,now:()=>clock.now};
 const seed=createHermesGatewayChannel(options);
 try { await run({directory,clock,file,seed,options,async hold(id){const raw=await readFile(file(id));return {jobId:id,sha256:hash(raw)};}}); }
 finally {await rm(directory,{recursive:true,force:true});}
}

test('expired historical claim is held byte-for-byte while a higher same-room revision runs',async()=>{
 await fixture(async({seed,clock,file,options,hold})=>{
  await seed.enqueue(event('old'));
  const oldClaim=await seed.claim({consumerId:'old',waitMs:0});
  const held=await hold('old'), before=await readFile(file('old'));
  clock.now+=5000;
  const channel=createHermesGatewayChannel({...options,heldJobs:[held]});
  assert.equal(await channel.claim({consumerId:'new',waitMs:0}),null);
  assert.equal((await channel.enqueue(event('old'))).job_id,'old');
  assert.equal(await channel.latestRoomRevision('old-room'),1);
  assert.equal((await channel.get('old')).state,'claimed');
  await assert.rejects(channel.renewLease(oldClaim),{code:'recovery_job_held'});
  await channel.enqueue(event('new','old-room',2));
  const claim=await channel.claim({consumerId:'new',waitMs:0});
  assert.equal(claim.job_id,'new');
  assert.deepEqual(await readFile(file('old')),before);
  const status=await channel.status({readOnly:true});
  assert.equal(status.counts.claimed,2);
  assert.equal(status.execution_counts.claimed,1);
  assert.equal(status.recovery_hold.jobs,1);
 });
});

test('held pending applications and failure notices never become recovery candidates or delivered',async()=>{
 await fixture(async({seed,file,options,hold})=>{
  for(const id of ['pending-app','failed-app']){
   await seed.enqueue(event(id,id));
   const claim=await seed.claim({consumerId:'seed',waitMs:0});
   await seed.complete({...claim,decision:{customer_reply:'no_reply'}});
   if(id==='failed-app'){
    const app=await seed.claimApplication({jobId:id});
    await seed.beginApplication({job_id:id,application_id:app.application_id});
    await seed.failApplication({job_id:id,application_id:app.application_id,error:{type:'ambiguous_post_apply_restart'}});
   }
  }
  const heldJobs=await Promise.all(['pending-app','failed-app'].map(hold));
  const before=await Promise.all(heldJobs.map(h=>readFile(file(h.jobId))));
  const channel=createHermesGatewayChannel({...options,heldJobs});
  assert.deepEqual(await channel.listPendingApplications(),[]);
  assert.deepEqual(await channel.listPendingApplicationFailureNotifications(),[]);
  assert.deepEqual(await channel.listPendingFailureNotifications(),[]);
  assert.deepEqual(await channel.listPendingAuditProjections(),[]);
  assert.deepEqual(await channel.listAuditProjectionCandidates(),[]);
  await assert.rejects(channel.claimApplication({jobId:'pending-app'}),{code:'recovery_job_held'});
  const failed=await channel.get('failed-app');
  await assert.rejects(channel.markApplicationFailureNotified({job_id:'failed-app',application_id:failed.application.application_id}),{code:'recovery_job_held'});
  assert.equal((await channel.status({readOnly:true})).unnotified_application_failures,1);
  for(let i=0;i<heldJobs.length;i++)assert.deepEqual(await readFile(file(heldJobs[i].jobId)),before[i]);
 });
});

test('manifest mismatch or missing job fails before unrelated reconciliation or writes',async()=>{
 await fixture(async({seed,clock,file,options,hold})=>{
  await seed.enqueue(event('protected'));
  await seed.enqueue(event('other','other-room'));
  await seed.claim({consumerId:'seed',waitMs:0});
  const held=await hold('protected');
  const before=await Promise.all(['protected','other'].map(id=>readFile(file(id))));
  clock.now+=5000;
  for(const heldJobs of [[{...held,sha256:'0'.repeat(64)}],[{jobId:'missing',sha256:'1'.repeat(64)}]]){
   const channel=createHermesGatewayChannel({...options,heldJobs});
   await assert.rejects(channel.claim({consumerId:'new',waitMs:0}),{code:'recovery_hold_mismatch'});
   for(let i=0;i<2;i++)assert.deepEqual(await readFile(file(['protected','other'][i])),before[i]);
  }
 });
});

test('held terminal reserved operations cannot be imported into audit or mutated through an idempotent path',async()=>{
 await fixture(async({seed,file,options,hold})=>{
  await seed.enqueue(event('reserved'));
  const claim=await seed.claim({consumerId:'seed',waitMs:0});
  await seed.reserveToolOperation({...claim,tool:'confirmation_request',request_digest:'request-digest'});
  const job=JSON.parse(await readFile(file('reserved'),'utf8'));
  job.state='superseded';job.superseded_by='newer';
  await writeFile(file('reserved'),JSON.stringify(job)+'\n');
  const held=await hold('reserved'),before=await readFile(file('reserved'));
  const channel=createHermesGatewayChannel({...options,heldJobs:[held]});
  assert.deepEqual(await channel.listAuditProjectionCandidates(),[]);
  await assert.rejects(channel.reserveToolOperation({...claim,tool:'confirmation_request',request_digest:'request-digest'}),{code:'recovery_job_held'});
  assert.deepEqual(await readFile(file('reserved')),before);
 });
});

test('invalid and duplicate hold declarations are rejected',()=>{
 for(const heldJobs of [null,{},[{jobId:'x',sha256:'bad'}],[{jobId:'x',sha256:'a'.repeat(64)},{jobId:'x',sha256:'a'.repeat(64)}]]){
  assert.throws(()=>createHermesGatewayChannel({directory:tmpdir(),heldJobs}),/recovery hold/i);
 }
});
test('the recovery cutoff also freezes historical jobs outside the selected risk manifest',async()=>{
 await fixture(async({seed,clock,file,options})=>{
  await seed.enqueue(event('old-unlisted'));
  await seed.claim({consumerId:'old',waitMs:0});
  const oldBytes=await readFile(file('old-unlisted'));
  clock.now+=5000;
  const cutoff=new Date(clock.now).toISOString();
  const channel=createHermesGatewayChannel({...options,freezeBefore:cutoff});
  assert.equal(await channel.claim({consumerId:'new',waitMs:0}),null);
  clock.now++;
  await channel.enqueue(event('post-cutover','old-room',2));
  assert.equal((await channel.claim({consumerId:'new',waitMs:0})).job_id,'post-cutover');
  assert.deepEqual(await readFile(file('old-unlisted')),oldBytes);
  const status=await channel.status({readOnly:true});
  assert.equal(status.recovery_hold.jobs,1);
  assert.equal(status.recovery_hold.freeze_before,cutoff);
 });
});
test('invalid hold initialization is terminal for that instance and cannot reread the entire queue repeatedly',async()=>{
 await fixture(async({seed,options})=>{
  await seed.enqueue(event('old'));let reads=0;
  const channel=createHermesGatewayChannel({...options,heldJobs:[{jobId:'missing',sha256:'a'.repeat(64)}],storage:{readFile:async(...args)=>{reads++;return readFile(...args);}}});
  await assert.rejects(channel.status({readOnly:true}),{code:'recovery_hold_mismatch'});const first=reads;assert.ok(first>0);
  await assert.rejects(channel.status({readOnly:true}),{code:'recovery_hold_mismatch'});assert.equal(reads,first);
 });
});
