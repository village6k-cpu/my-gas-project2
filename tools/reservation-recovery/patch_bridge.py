"""Apply narrow integration against the deployed bridge; assert anchors before writes."""
from pathlib import Path
import difflib

def patch(source):
 if 'createIntakeCoordinator' in source:raise ValueError('Already patched')
 s="import {createDurableIntake} from './durable-intake.mjs';\nimport {createIntakeCoordinator} from './intake-coordinator.mjs';\n"+source
 anchor='function getAiJobDispatcher() {'
 assert s.count(anchor)==1
 s=s.replace(anchor,'''let durableIntakeCoordinator = null;
function getDurableIntakeCoordinator() {
  if (process.env.KAKAO_DOM_BRIDGE_NO_LISTEN === '1' || !gatewayChannel) return null;
  if (!durableIntakeCoordinator) durableIntakeCoordinator=createIntakeCoordinator({
    journal:createDurableIntake({directory:path.join(CONFIG.queueDir,'durable-intake')}),
    gateway:gatewayChannel,
    dispatch:(job,context)=>dispatchAiJob(job,context),
    schedule:scheduleDebouncedJob
  });
  return durableIntakeCoordinator;
}
''' +anchor)
 s=s.replace("      state: durableState\n    };","      state: durableState, durable: true\n    };")
 a=s.index('async function flushRoom(roomKey) {');b=s.index('\nfunction recoveryAttemptCount',a)
 s=s[:a]+'''async function flushRoom(roomKey) {
  const roomState = state.rooms.get(roomKey);
  if (!roomState) return;
  state.rooms.delete(roomKey);
  if (roomState.timer) clearTimeout(roomState.timer);
  if (roomState.maxTimer) clearTimeout(roomState.maxTimer);
  const job = buildAiFirstJob(roomKey, roomState);
  job.intakeIds=[...(roomState.intakeIds||[])];
  state.debouncedJobs += 1;
  appendNdjson('jobs.ndjson', job);
  const preflight=async()=>{
    let result=null;
    try {result=await writeSupabaseEvent(job,'job');}
    catch(error){state.failedSupabaseWrites++;appendNdjson('errors.ndjson',{at:nowIso(),type:'supabase_job',message:error.message,job});}
    return {blocked:result?.duplicate===true&&!shouldRunDuplicateJob(result.existing)};
  };
  try {
    const intake=getDurableIntakeCoordinator();
    if(intake)await intake.submit(job,{preflight,dispatchContext:{origin:'live_dom_event'}});
    else if(!(await preflight()).blocked)await dispatchAiJob(job,{origin:'live_dom_event'});
  }catch(error){appendNdjson('errors.ndjson',{at:nowIso(),type:'durable_intake',message:error.message,jobId:job.jobId});}
}
''' +s[b:]
 anchor="  roomState.lastAt = nowIso();\n  const eventIdentity"
 assert s.count(anchor)==1
 s=s.replace(anchor,"  roomState.intakeIds ||= new Set();\n  for(const id of event.intakeIds||[])roomState.intakeIds.add(id);\n"+anchor)
 anchor="  let immediateNotification = null;\n  if (immediateRuntime?.enabled === true)"
 assert s.count(anchor)==1
 s=s.replace(anchor,"  const intake = dependencies.durableIntake || getDurableIntakeCoordinator();\n  if(intake){const receipt=intake.accept(event);event.intakeIds=[receipt.id];}\n\n"+anchor)
 anchor="  ensureQueueDir();\n  server.listen"
 assert s.count(anchor)==1
 s=s.replace(anchor,"  ensureQueueDir();\n  getDurableIntakeCoordinator(); // validate durable storage before accepting any event\n  const replayIntake=()=>getDurableIntakeCoordinator()?.replay(3).then(result=>fs.writeFileSync(path.join(CONFIG.queueDir,'durable-intake-status.json'),JSON.stringify({...result,observedAt:nowIso()}))).catch(error=>{fs.writeFileSync(path.join(CONFIG.queueDir,'durable-intake-status.json'),JSON.stringify({error:error.message,observedAt:nowIso()}));appendNdjson('errors.ndjson',{at:nowIso(),type:'durable_intake_replay',message:error.message});});\n  setTimeout(replayIntake,1000).unref();\n  setInterval(replayIntake,60000).unref();\n  server.listen")
 anchor="        captureBacklog,\n        config:"
 assert s.count(anchor)==1
 s=s.replace(anchor,"        captureBacklog,\n        durableIntake:getDurableIntakeCoordinator()?.status()||null,\n        config:")

 old="    await writeEvent(event, 'event');"
 assert s.count(old)==1
 s=s.replace(old,"    if(intake)Promise.resolve().then(()=>writeEvent(event,'event')).catch(error=>{state.failedSupabaseWrites++;appendEvent('errors.ndjson',{at:nowIso(),type:'supabase_event',message:error.message,event});});else await writeEvent(event, 'event');")
 return s

if __name__=='__main__':
 import argparse
 p=argparse.ArgumentParser();p.add_argument('file',type=Path);p.add_argument('--out',type=Path,required=True);a=p.parse_args();a.out.write_text(patch(a.file.read_text()))
