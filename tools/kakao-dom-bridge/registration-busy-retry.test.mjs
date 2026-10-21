import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHermesGatewayChannel } from './hermes-gateway-channel.mjs';
import { runRegistrationBusyRetry } from './registration-busy-retry.mjs';

async function fixture(run) {
  const directory = await mkdtemp(path.join(tmpdir(), 'registration-busy-'));
  const clock = { now: Date.parse('2026-10-21T00:00:00Z') };
  const open = () => createHermesGatewayChannel({ directory, now: () => clock.now });
  try {
    const channel = open();
    await channel.enqueue({ job_id: 'job-1', room_key: 'chat:123', room_revision: 1, detected_at: new Date(clock.now).toISOString() });
    const claim = await channel.claim({ consumerId: 'test' });
    const { reservation } = await channel.reserveToolOperation({ ...claim, tool: 'confirmed_reservation_commit', request_digest: 'digest' });
    const receipt = { schema: 'village-confirmed-reservation-commit-receipt/v1', receipt_id: 'busy-1',
      job_id: claim.job_id, room_key: claim.room_key, room_revision: 1, lease_id: claim.lease_id,
      operation_id: reservation.operation_id, request_digest: 'digest', status: 'blocked', target_scope: 'pending_request',
      request_id: 'RQ-261021-001', effective_request_id: null, trade_id: null, authorized_registration: { confirmed: true },
      applied_stages: [], attempted_stage: 'preflight', customer_reply: 'no_reply', created_at: new Date(clock.now).toISOString(),
      error: { type: 'registration_busy' }, authoritative_result: {
        schema: 'village-confirmed-reservation-commit-result/v1', success: false, status: 'blocked', attempted_stage: 'preflight',
        error: { type: 'registration_busy' }, applied_stages: [], replaced_request_ids: [], authoritative: null,
        request_id: null, effective_request_id: null, trade_id: null, customerNotificationAttempted: false, customerNotificationSent: false
      } };
    const finishModel = async ({finalize=true,audit=null}={}) => {
      await channel.complete({ job_id: claim.job_id, room_key: claim.room_key, room_revision: 1, lease_id: claim.lease_id, content: '{}' });
      if(finalize) {
        const application=await channel.claimApplication({jobId:claim.job_id});
        const envelope={jobId:claim.job_id,applicationId:application.application_id};
        await channel.beginApplication(envelope); await channel.recordApplicationApplied(envelope);
        await channel.finalizeApplication({...envelope,audit});
      }
    };
    await run({ channel, open, clock, receipt, finishModel });
  } finally { await rm(directory, { recursive: true, force: true }); }
}

test('zero-write lock failure persists a delayed continuation across restart', () => fixture(async ({channel,open,clock,receipt,finishModel}) => {
  await channel.recordToolReceipt(receipt);
  assert.equal((await channel.get('job-1')).registration_retry.state, 'pending');
  await finishModel();
  assert.equal(await channel.claimRegistrationRetry(), null);
  clock.now += 31_000;
  const restarted = open();
  const claim = await restarted.claimRegistrationRetry();
  assert.equal(claim.tool_operation.operation_id, receipt.operation_id);
  assert.equal(claim.tool_operation.request_digest, receipt.request_digest);
  assert.equal(await restarted.claimRegistrationRetry(), null);
}));

test('partial, uncertain, notification and malformed results never enter automatic retry', async () => {
  for (const edit of [r => r.applied_stages.push('write'), r => r.authoritative_result.applied_stages.push('write'),
    r => r.authoritative_result.customerNotificationAttempted = true, r => r.error.type = 'outcome_unknown',
    r => delete r.authoritative_result.replaced_request_ids]) {
    await fixture(async ({channel,receipt}) => { edit(receipt); await channel.recordToolReceipt(receipt);
      assert.equal((await channel.get('job-1')).registration_retry, undefined); });
  }
});

test('newer room revision cancels a pending continuation without mutation', () => fixture(async ({channel,clock,receipt,finishModel}) => {
  await channel.recordToolReceipt(receipt); await finishModel(); clock.now += 31_000;
  await channel.enqueue({ job_id: 'job-2', room_key: 'chat:123', room_revision: 2, detected_at: new Date(clock.now).toISOString() });
  assert.equal(await channel.claimRegistrationRetry(), null);
  assert.equal((await channel.get('job-1')).registration_retry.state, 'superseded');
}));

test('restart during capture retries, restart after mutation fence requires readback', async () => {
  for (const started of [false,true]) await fixture(async ({channel,open,clock,receipt,finishModel}) => {
    await channel.recordToolReceipt(receipt); await finishModel(); clock.now += 31_000;
    const claim = await channel.claimRegistrationRetry();
    if (started) await channel.startRegistrationRetry({jobId:'job-1',token:claim.registration_retry.token});
    const restarted = open();
    const next = await restarted.claimRegistrationRetry();
    assert.equal(Boolean(next), !started);
    if(started) assert.equal((await restarted.get('job-1')).registration_retry.state,'blocked');
  });
});

test('busy continuation preserves operation identity and backs off without losing work', () => fixture(async ({channel,clock,receipt,finishModel}) => {
  await channel.recordToolReceipt(receipt); await finishModel(); clock.now += 31_000;
  const claim = await channel.claimRegistrationRetry(); const token=claim.registration_retry.token;
  await channel.startRegistrationRetry({jobId:'job-1',token});
  await channel.finishRegistrationRetry({jobId:'job-1',token,receipt:{...receipt,receipt_id:'busy-2'}});
  const next = await channel.get('job-1');
  assert.equal(next.registration_retry.state,'pending');
  assert.equal(next.tool_operation.operation_id,receipt.operation_id);
  assert.equal(next.tool_receipts.length,1);
  assert.equal(next.registration_retry_history.length,1);
  assert.equal(await channel.claimRegistrationRetry(),null);
}));

test('coordinator rejects changed conversation, capture failures and unknown writes without replay', async () => {
  for (const mode of ['changed','capture','unknown','busy']) await fixture(async ({channel,clock,receipt,finishModel}) => {
    await channel.recordToolReceipt(receipt); await finishModel(); clock.now += 31_000;
    let calls=0;
    const output = await runRegistrationBusyRetry({channel, capture:async () => {
      if(mode==='capture') throw new Error('not connected'); return {snapshot:{}};
    }, isCurrent:() => mode!=='changed', execute:async (_request,{operationFence,assertCurrentClaim}) => {
      await assertCurrentClaim(); calls++; assert.equal(operationFence.operation_id,receipt.operation_id);
      if(mode==='unknown') throw new Error('timeout'); return {...receipt,receipt_id:'busy-next'};
    }});
    assert.equal(calls,['changed','capture'].includes(mode)?0:1);
    assert.equal(output.state,['capture','busy'].includes(mode)?'pending':'blocked');
  });
});

test('success is durably saved before downstream projection and cannot execute twice', () => fixture(async ({channel,open,clock,receipt,finishModel}) => {
  await channel.recordToolReceipt(receipt); await finishModel(); clock.now += 31_000;
  const success={...receipt,receipt_id:'success',status:'ok',error:null,attempted_stage:null,
    effective_request_id:'RQ-261021-001',trade_id:'261021-001',applied_stages:['registration','authoritative_readback']};
  let executions=0;
  await runRegistrationBusyRetry({channel,capture:async()=>({snapshot:{}}),isCurrent:()=>true,
    execute:async()=>{executions++;return success;},buildResult:async()=>({content:'{}'}),
    enqueue:async()=>{throw new Error('projection offline');}});
  const restarted=open(); const saved=await restarted.get('job-1');
  assert.equal(saved.registration_retry.state,'completed');
  assert.equal(saved.application.state,'pending');
  assert.equal(await restarted.claimRegistrationRetry(),null);
  assert.equal(executions,1);
}));

test('retry cannot race a pending original application', () => fixture(async ({channel,clock,receipt,finishModel}) => {
  await channel.recordToolReceipt(receipt); await finishModel({finalize:false}); clock.now+=31_000;
  assert.equal(await channel.claimRegistrationRetry(),null);
  const application=await channel.claimApplication({jobId:'job-1'});
  assert.equal(application.claimed,true);
  assert.equal(await channel.claimRegistrationRetry(),null);
}));

test('successful write with missing final projection retains explicit review and never replays', () => fixture(async ({channel,clock,receipt,finishModel}) => {
  await channel.recordToolReceipt(receipt); await finishModel(); clock.now+=31_000;
  const success={...receipt,receipt_id:'success',status:'ok',error:null,attempted_stage:null,
    effective_request_id:'RQ-261021-001',trade_id:'261021-001',applied_stages:['registration','authoritative_readback']};
  await runRegistrationBusyRetry({channel,capture:async()=>({}),isCurrent:()=>true,execute:async()=>success,
    buildResult:()=>{throw new Error('malformed final');}});
  const saved=await channel.get('job-1');
  assert.equal(saved.registration_retry.state,'completed');
  assert.equal(saved.human_review_required,true);
  assert.equal(saved.failure_notification.state,'pending');
  assert.equal(await channel.claimRegistrationRetry(),null);
}));

test('success preserves exact owner refs and audit evidence even when a newer room arrives during execution', async () => {
  for(const newer of [false,true]) await fixture(async ({channel,clock,receipt,finishModel}) => {
    const refs=[{id:'11111111-1111-4111-8111-111111111111',version:2}];
    await channel.recordToolReceipt(receipt); await finishModel({audit:{registration_retry_work_items:refs}});clock.now+=31_000;
    let projected=false;
    await runRegistrationBusyRetry({channel,capture:async()=>({}),isCurrent:()=>true,
      execute:async()=>{
        if(newer) await channel.enqueue({job_id:'job-2',room_key:'chat:123',room_revision:2,detected_at:new Date(clock.now).toISOString()});
        return {...receipt,receipt_id:'success',status:'ok',error:null,attempted_stage:null,
          effective_request_id:'RQ-261021-001',trade_id:'261021-001',applied_stages:['registration','authoritative_readback']};
      },buildResult:()=>({content:'{}'}),afterPersist:async()=>{projected=true;}});
    const saved=await channel.get('job-1');
    assert.deepEqual(saved.registration_retry_work_items,refs);
    assert.equal(saved.audit_projection,null);
    assert.equal(saved.application.state,newer?'finalized':'pending');
    assert.equal(saved.human_review_required,newer);
    assert.equal(projected,true);
    assert.equal(await channel.claimRegistrationRetry(),null);
  });
});
