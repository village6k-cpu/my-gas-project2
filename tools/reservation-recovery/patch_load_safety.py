"""Bound recovery load and route system failures through the group incident."""

def patch(source):
 s=source
 if 'recoveryDispatchAllowed' not in s:
  anchor='let durableIntakeCoordinator = null;'
  assert s.count(anchor)==1
  s=s.replace(anchor,"""function recoveryDispatchAllowed(job) {
  const backfill=Array.isArray(job.events)&&job.events.length>0&&job.events.every(e=>e.recoveryOnly===true);
  const file=path.resolve(CONFIG.queueDir,'../../../../control/reservation-recovery-control.json');
  try { const control=JSON.parse(fs.readFileSync(file,'utf8')); return !(control.pauseBackfill&&backfill); }
  catch(error){return error.code==='ENOENT';}
}
"""+anchor)
  s=s.replace('    gateway:gatewayChannel,\n    dispatch:', '    gateway:gatewayChannel,\n    canDispatch:recoveryDispatchAllowed,\n    maxConcurrentDispatches:1,\n    dispatch:')
 if 'System failures are aggregated by the independent recovery supervisor' not in s:
  start=s.index('      const failures=[];',s.index('let pricingNoticeFlushRunning'))
  end=s.index('\n    }\n    catch',start)
  s=s[:start]+'''      // System failures are aggregated by the independent recovery supervisor.
      // Do not hydrate every failed conversation and DM a burst every 30 seconds.
      // Per-job failure obligations stay pending with their original evidence.
      await flushPricingOwnerNotices(directory,{token:process.env.SLACK_BOT_TOKEN});'''+s[end:]
 if 'sameIntakeSource' not in s:
  anchor='function recoveryDispatchAllowed(job) {'
  s=s.replace(anchor,"""function sameIntakeSource(original, current) {
  if(!original||!current)return false;
  const day=j=>{const d=new Date(j.detectedAt||j.detected_at||'');return Number.isFinite(d.getTime())?JSON.stringify(kstDateParts(d)):'';};
  const ids=j=>[...new Set((j.events||[]).map(semanticRoomEventIdentity).filter(Boolean))].sort();
  return Boolean(day(original))&&day(original)===day(current)&&ids(original).length>0&&JSON.stringify(ids(original))===JSON.stringify(ids(current));
}
"""+anchor)
  s=s.replace('    canDispatch:recoveryDispatchAllowed,','    canDispatch:recoveryDispatchAllowed,\n    sameSource:sameIntakeSource,')
 if 'zero-write retry identity' not in s:
  anchor="  return `dom-${sha256(`${roomKey}:${identities.join('|')}`).slice(0, 16)}`;"
  assert s.count(anchor)==1
  s=s.replace(anchor,"""  // A proven zero-write retry identity must differ from its failed predecessor.
  const retry=events.filter(e=>e.recoveryOf).map(e=>e.recoveryOf+':'+e.eventHash).sort().join('|');
  return `dom-${sha256(`${roomKey}:${identities.join('|')}${retry?'|zero-write:'+retry:''}`).slice(0, 16)}`;""")
 if 'native_read_diagnostic' not in s:
  anchor='  executeRead: request => executeVillageReadOnlyLookup(getKakaoWorkerRuntimeConfigForTransport(),request),'
  assert s.count(anchor)==1
  s=s.replace(anchor,"""  executeRead: async request => {
    try{return await executeVillageReadOnlyLookup(getKakaoWorkerRuntimeConfigForTransport(),request);}
    catch(error){const message=String(error?.message||'');const type=/invalid_read_result/.test(message)?'invalid_read_result':/timeout|aborted/i.test(message)?'upstream_timeout':/HTTP (\\d+)/.exec(message)?.[0]||(/invalid_|unsupported/.test(message)?'invalid_request':'upstream_read_failed');
      appendNdjson('errors.ndjson',{at:nowIso(),type:'native_read_diagnostic',kind:['trade','request','reservations','catalog','customer','knowledge','quote'].includes(request?.kind)?request.kind:'unknown',error_type:type});throw error;}
  },""")
 s=s.replace("||/invalid_|unsupported/.test(message)?'invalid_request':'upstream_read_failed'","||(/invalid_|unsupported/.test(message)?'invalid_request':'upstream_read_failed')")
 return s

def notices(source):
 if 'aggregated_recovery_failure_notice' in source:return source
 anchor="    if(notice.state==='sent' || Number(notice.nextAttemptAt || 0)>now)continue;"
 assert source.count(anchor)==1
 return source.replace(anchor,anchor+"\n    // aggregated_recovery_failure_notice: retain pending originals; group alert owns delivery.\n    if(String(notice.text||'').startsWith('상담 자동처리 확인 필요'))continue;")
