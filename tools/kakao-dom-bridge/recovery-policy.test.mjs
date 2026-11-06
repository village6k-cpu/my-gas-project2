import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {loadRecoveryHoldManifest,recoveryRuntimeConfig,recoveryGeneralPostAllowed,liveRecoveryReplyConfig} from './recovery-hold-policy.mjs';
const directory=path.resolve('test-queue');const manifest={schema:'village-gateway-held-jobs/v1',queueDirectory:path.join(directory,'hermes-gateway'),freezeBefore:'2026-10-24T02:00:00.000Z',entries:[{jobId:'old',sha256:'a'.repeat(64)}]};
const load=value=>loadRecoveryHoldManifest(path.resolve('manifest.json'),{directory,readFileSync:()=>JSON.stringify(value)});
test('recovery manifest binds exact queue, cutoff, job IDs and bytes',()=>{const out=load(manifest);assert.equal(out.heldJobs.length,1);assert.equal(out.freezeBefore,manifest.freezeBefore);assert.match(out.sha256,/^[a-f0-9]{64}$/);});
test('invalid scope, loose date, duplicate or extra entry data fail closed',()=>{
 for(const value of [{...manifest,queueDirectory:path.resolve('different')},{...manifest,freezeBefore:'2026-10-24'},{...manifest,entries:[...manifest.entries,...manifest.entries]},{...manifest,entries:[{...manifest.entries[0],ignore:true}]},{...manifest,entries:[]}])assert.throws(()=>load(value),/Recovery hold/);
 assert.throws(()=>loadRecoveryHoldManifest('relative.json',{directory}),/absolute/);
});
test('recovery keeps delivery held until a particular live job passes its own gate',()=>{
 const config={autoSendEnabled:true,slackFollowUpEnabled:true,writesEnabled:true};
 assert.equal(recoveryRuntimeConfig(config,false),config);
 const held=recoveryRuntimeConfig(config,manifest);
 assert.equal(held.autoSendEnabled,false);assert.equal(held.slackFollowUpEnabled,false);
 const job={detectedAt:'2026-11-06T08:30:00Z',events:[{reason:'top_row_changed'}]};
 assert.equal(liveRecoveryReplyConfig(held,job,{eligible:true}).autoSendEnabled,true);
 for(const [other,gate] of [[job,{eligible:false}],[{...job,detectedAt:manifest.freezeBefore},{eligible:true}],
  [{...job,events:[{recoveryOnly:true}]},{eligible:true}],[{...job,detectedAt:'invalid'},{eligible:true}]]){
  assert.equal(liveRecoveryReplyConfig(held,other,gate).autoSendEnabled,false);
 }
 assert.equal(liveRecoveryReplyConfig(recoveryRuntimeConfig({...config,autoSendEnabled:false},manifest),job,{eligible:true}).autoSendEnabled,false);
 assert.equal(liveRecoveryReplyConfig(recoveryRuntimeConfig(config,true),job,{eligible:true}).autoSendEnabled,false);
 assert.equal(recoveryGeneralPostAllowed('/events'),true);assert.equal(recoveryGeneralPostAllowed('/manual-send'),false);
});

import {buildGatewayHealthReadback} from './hermes-gateway-http.mjs';
test('recovery health exposes eligible work without hiding historical counts',()=>{
 const historical={ready:2,claimed:1,failed:34},active={ready:1,claimed:0,failed:0};
 const h=buildGatewayHealthReadback({status:{counts:historical,execution_counts:active,application_counts:{failed:149},execution_application_counts:{failed:0},recovery_hold:{jobs:7004,freeze_before:'cutoff'}}});
 assert.equal(h.queue.claimed,0);assert.equal(h.queue.ready,1);assert.equal(h.application_counts.failed,0);
 assert.deepEqual(h.historical_counts,historical);assert.equal(h.historical_application_counts.failed,149);assert.equal(h.recovery_hold.jobs,7004);
});
