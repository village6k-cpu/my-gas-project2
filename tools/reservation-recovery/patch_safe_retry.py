"""Retry only proved zero-effect failures; persist attempts in source events."""
def server(source):
    if 'zero-write-recovery' not in source:
        anchor="  if (observed && sameDay && semanticRoomEventIdentity(observed) === semanticRoomEventIdentity(event)) {\n"
        assert source.count(anchor)==1
        source=source.replace(anchor,anchor+"    if(latest.retrySafe===true){const bucket=Math.floor(now.getTime()/3600000);return {action:'queue',event:{...event,eventHash:sha256(event.eventHash+'|zero-write-recovery|'+bucket),reason:'startup_catchup',originalReason:'read_room_catchup',recoveryOnly:true,recoveryOf:latest.jobId}};}\n")
    if 'recoveryAttempt:Number(latest.retryAttempt' not in source:
        source=source.replace('if(latest.retrySafe===true){const bucket=',"if(latest.retrySafe===true&&(!latest.retryAfter||now.getTime()>=Date.parse(latest.retryAfter))){const bucket=")
        source=source.replace('recoveryOnly:true,recoveryOf:latest.jobId','recoveryOnly:true,recoveryOf:latest.jobId,recoveryAttempt:Number(latest.retryAttempt||0)+1')
    source=source.replace("event.eventHash+'|zero-write-recovery|'+bucket", "event.eventHash+'|zero-write-recovery|'+latest.jobId+'|'+Number(latest.retryAttempt||0)+'|'+bucket")
    if 'forceNewTurn = false' not in source:
        source=source.replace("  eventHash = ''\n)","  eventHash = '',\n  { forceNewTurn = false } = {}\n)")
        source=source.replace('  if (previous.semanticIdentity === identity) {','  if (previous.semanticIdentity === identity && !forceNewTurn) {')
        source=source.replace('    event.eventHash\n  );','    event.eventHash,\n    { forceNewTurn: Boolean(event.recoveryOf) }\n  );')
    old="    const latest = pending ? { event: pending } : await eventGateway.latestRoomObservation(key);"
    new="    const durable = await eventGateway.latestRoomObservation(key);\n    const latest = pending && (!durable || semanticRoomEventIdentity(pending)!==semanticRoomEventIdentity(durable.event)) ? {event:pending} : durable;"
    source=source.replace(old,new)
    if 'pendingDurableRoomObservation' not in source:
        anchor="    const latest = pending && (!durable || semanticRoomEventIdentity(pending)!==semanticRoomEventIdentity(durable.event)) ? {event:pending} : durable;"
        assert source.count(anchor)==1
        source=source.replace(anchor,"    const queued = dependencies.pendingDurableRoomObservation?.(key) || getDurableIntakeCoordinator()?.pendingRoomObservation(key);\n    const latest = queued && (!durable || queued.roomRevision>=durable.roomRevision) ? queued : pending && (!durable || semanticRoomEventIdentity(pending)!==semanticRoomEventIdentity(durable.event)) ? {event:pending} : durable;")
    return source

def channel(source):
    if 'export function safeRecaptureState' not in source:
        source='''// Only failures before any tool or application effect qualify for recapture.
export function safeRecaptureState(job,held=false) {
  const app=job.application;
  const invalidFinal=job.state==='completed'&&app?.state==='failed'
    &&String(app.error?.message||'').startsWith('gateway_invalid_model_result:')
    &&!app.applying_at&&!app.applied_at&&!app.applied_audit&&!app.final_audit;
  const failedTurn=job.state==='failed'&&!app;
  const retryAttempt=Math.max(0,...(job.local_context?.job?.events||[]).map(e=>Number(e.recoveryAttempt||0)));
  const failedAt=Date.parse(app?.failed_at||job.updated_at||'');
  return {retrySafe:!held&&(invalidFinal||failedTurn)&&!job.tool_operation
    &&!(job.tool_receipts||[]).length&&Number.isInteger(retryAttempt)&&retryAttempt<2,
    retryAttempt,retryAfter:Number.isFinite(failedAt)?new Date(failedAt+60000*2**Math.min(retryAttempt,2)).toISOString():null};
}
'''+source
    original='return clone({ roomRevision: job.room_revision, state: job.state, event: observation });'
    if original in source:
        source=source.replace(original,"return clone({roomRevision:job.room_revision,state:job.state,event:observation,jobId:job.job_id,...safeRecaptureState(job,isHeldJob(job))});")
    else:
        start=source.index('return clone({roomRevision:job.room_revision,state:job.state,event:observation,jobId:job.job_id,')
        end=source.index(';',start)+1
        source=source[:start]+"return clone({roomRevision:job.room_revision,state:job.state,event:observation,jobId:job.job_id,...safeRecaptureState(job,isHeldJob(job))});"+source[end:]
    return source
