// Only an authoritative, explicitly zero-write lock rejection is replayable.
export function isZeroWriteRegistrationBusy(receipt) {
  const r = receipt?.authoritative_result;
  return receipt?.schema === 'village-confirmed-reservation-commit-receipt/v1'
    && receipt.status === 'blocked' && receipt.error?.type === 'registration_busy'
    && receipt.attempted_stage === 'preflight' && receipt.customer_reply === 'no_reply'
    && receipt.effective_request_id === null && receipt.trade_id === null
    && Array.isArray(receipt.applied_stages) && receipt.applied_stages.length === 0
    && r?.schema === 'village-confirmed-reservation-commit-result/v1'
    && r.success === false && r.status === 'blocked' && r.error?.type === 'registration_busy'
    && r.attempted_stage === 'preflight' && r.authoritative === null
    && r.request_id === null && r.effective_request_id === null && r.trade_id === null
    && Array.isArray(r.applied_stages) && r.applied_stages.length === 0
    && Array.isArray(r.replaced_request_ids) && r.replaced_request_ids.length === 0
    && r.customerNotificationAttempted === false && r.customerNotificationSent === false;
}

export function registrationRetryDelay(attempts = 0) {
  return Math.min(300_000, 30_000 * 2 ** Math.min(4, attempts));
}

export async function runRegistrationBusyRetry({ channel, capture, isCurrent, isUsable = () => true, execute, buildResult, enqueue, afterPersist }) {
  const job = await channel.claimRegistrationRetry();
  if (!job) return { state: 'idle' };
  const envelope = { jobId: job.job_id, token: job.registration_retry.token };
  const original = job.tool_receipts.find(r => r.receipt_id === job.tool_operation.receipt_id);
  let fresh;
  try { fresh = await capture(job); }
  catch { return (await channel.finishRegistrationRetry({...envelope,reason:'capture_unavailable'})).registration_retry; }
  if (!isUsable(fresh)) return (await channel.finishRegistrationRetry({...envelope,reason:'capture_unavailable'})).registration_retry;
  if (!isCurrent(job, fresh)) {
    return (await channel.finishRegistrationRetry({...envelope,reason:'conversation_changed'})).registration_retry;
  }
  let receipt;
  try {
    await channel.startRegistrationRetry(envelope);
    receipt = await execute({ job_id:job.job_id,room_key:job.room_key,room_revision:job.room_revision,
      lease_id:original.lease_id,registration:original.authorized_registration }, {
      operationFence:job.tool_operation, roomSnapshot:job.local_context?.turn_internal?.snapshot,
      assertCurrentClaim:() => channel.assertRegistrationRetry(envelope)
    });
  } catch {
    // A thrown/ambiguous execution must never be placed back on the retry queue.
    return (await channel.finishRegistrationRetry({...envelope,reason:'execution_outcome_unknown'})).registration_retry;
  }
  const fenced = { ...receipt,lease_id:original.lease_id,operation_id:original.operation_id,
    request_digest:original.request_digest,authorized_registration:original.authorized_registration };
  let result=null;
  if(receipt.status==='ok' && buildResult) {
    try { result=await buildResult(job,fenced); } catch { /* Persist actual receipt even if final projection fails. */ }
  }
  let saved;
  try { saved=await channel.finishRegistrationRetry({...envelope,receipt:fenced,result}); }
  catch {
    return (await channel.finishRegistrationRetry({...envelope,reason:'retry_receipt_unverified'})).registration_retry;
  }
  if(saved.registration_retry.state==='completed' && result && enqueue) {
    try { await enqueue(saved); } catch { /* The pending application survives restart; never repeat the mutation. */ }
  }
  if(saved.registration_retry.state==='completed' && afterPersist) {
    try { await afterPersist(saved); } catch { /* Durable receipt remains available to audit recovery. */ }
  }
  return saved.registration_retry;
}

export function registrationRetryWorkReferences(job, finalized) {
  if(job.registration_retry?.state!=='pending') return [];
  const receipt=job.tool_receipts?.find(r=>r.receipt_id===job.tool_operation?.receipt_id);
  if(!isZeroWriteRegistrationBusy(receipt) || !receipt.operation_id) return [];
  return (finalized.workOrchestratorResult?.rows || [])
    .filter(row=>['reservation_review','schedule_register','schedule_check'].includes(row.work_type)
      && row.payload?.business_key===`registration-lock:${receipt.operation_id}`
      && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(row.id)
      && Number.isSafeInteger(row.version) && row.version>0)
    .map(({id,version})=>({id,version}));
}

export function registrationRecoveryResult(job, receipt, parseDecision) {
  const decision=parseDecision(job.result?.content || '');
  if(!decision || typeof decision!=='object' || Array.isArray(decision)) return null;
  // Restore only the AI approval sealed before the original zero-write failure.
  // The normal result application still validates its exact authoritative readback.
  return { ...job.result, content:JSON.stringify({ ...decision,
    should_write_to_sheet:false, staff_confirmed_registration:receipt.authorized_registration,
    staff_confirmed_mutation:null, customer_requested_pending_revision:null,
    reply_decision:{...decision.reply_decision,replyMode:'no_reply',text:'',shouldCreateTask:false,
      safetyClass:'no_send',attachmentKeys:[]}
  }) };
}
