// Participant in a separate five-service stop controller. Never kills a process
// or authorizes a complete source stop. Parent owns OS birth checks and all other
// gateways, voice, Slack, watcher, scheduled writers and recovery obligations.
import {createHash} from 'node:crypto';
import {connectCurrentBridgeProducerFence,installCurrentBridgeFenceOnInspectedSource} from './migration_bridge_producer_adapter.mjs';
import {withCurrentBridgeHttpClosure} from './migration_bridge_http_adapter.mjs';
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const hash=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);

function exactCommand(value,intent,id) {
  if(!value || Object.keys(value).sort().join(',')!=='action,controller_id,intent_sha256,observation_sha256'
      ||!['abort','stop'].includes(value.action)||value.controller_id!==id||value.intent_sha256!==intent
      ||(value.observation_sha256!==null&&!hash(value.observation_sha256)))throw Error('Invalid owned parent command');
  return value;
}

function settled(report,expected,now) {
  const p=report?.producer,n=report?.native_promises,w=report?.private_work,h=report?.http;
  return report?.idle===true && h?.http_closed===true&&h.mode==='closed'&&h.producer_fence_owned===true
    &&p?.mode==='fenced'&&p.producers_owned===true
    &&['pending_handlers','pending_producers','pending_tracked_work'].every(k=>p[k]===0)
    &&w?.idle===true&&w.owner?.pid===expected.pid&&w.stop_authorized===false
    &&Number.isFinite(w.observed_unix_ms)&&now-w.observed_unix_ms>=0&&now-w.observed_unix_ms<=10000
    &&n?.complete===true&&n.idle===true&&n.counts?.pending===0&&n.stop_authorized===false
    &&report.stop_authorized===false;
}

export async function holdCurrentBridgeForStop({url,expected,token,intentSha256,controllerId,io,
  maxWaitMs=300000,pollMs=250,closeWaitMs=60000,producerMode='install'}) {
  if(!hash(intentSha256)||typeof controllerId!=='string'||controllerId.length<8
      ||!['publish','readCommand','sourceAlive','invalidateReady','acknowledgeStop'].every(k=>typeof io?.[k]==='function')
      ||!Number.isSafeInteger(maxWaitMs)||maxWaitMs<1||maxWaitMs>3600000
      ||!Number.isSafeInteger(pollMs)||pollMs<10||pollMs>5000
      ||!['install','connect'].includes(producerMode))throw Error('Invalid bridge handoff contract');
  if(await io.sourceAlive()!==true)throw Error('Expected source is not alive');
  const producer=await (producerMode==='connect'?connectCurrentBridgeProducerFence:installCurrentBridgeFenceOnInspectedSource)(url,expected,token);
  if(producerMode==='install')await producer.fence();
  else {
    const existing=await producer.snapshot();
    if(existing.mode!=='fenced'||existing.producers_owned!==true)throw Error('Existing parent producer fence is not engaged');
  }
  const deadline=Date.now()+maxWaitMs,recent=new Map();let acceptedStop=null,expectedExitObserved=false,participantError=null;
  try {
    return await withCurrentBridgeHttpClosure(url,expected,token,async control=>{
      try {while(Date.now()<deadline) {
        const report=await control.observe(),now=Date.now();
        for(const [pin,row] of recent)if(now-row.observed_unix_ms>10000)recent.delete(pin);
        if(settled(report,expected,now)) {
          const evidence={schema:'village-current-bridge-accepted-work-observation/v1',controller_id:controllerId,
            intent_sha256:intentSha256,observed_unix_ms:now,observation:report,full_source_stop_authorized:false};
          const pin=digest(evidence),published=await io.publish(evidence);
          if(published?.sha256!==pin)throw Error('Published observation hash differs');
          recent.set(pin,evidence);
        }else {
          recent.clear();
          await io.invalidateReady();
        }
        const supplied=await io.readCommand();
        if(supplied) {
          const command=exactCommand(supplied,intentSha256,controllerId);
          if(command.action==='abort')return {aborted:true,source_stopped:false,producer_still_fenced:true};
          const evidence=recent.get(command.observation_sha256);
          if(!evidence||Date.now()-evidence.observed_unix_ms>10000)throw Error('Parent stop observation is missing or stale');
          const ack={schema:'village-bridge-stop-observation-ack/v1',...command,source_pid:expected.pid,
            acknowledged_unix_ms:Date.now(),full_source_stop_authorized:false};
          if((await io.acknowledgeStop(ack))?.sha256!==digest(ack))throw Error('Parent stop acknowledgement hash differs');
          acceptedStop=command;
          while(Date.now()<deadline) {
            if(await io.sourceAlive()===false){expectedExitObserved=true;throw Error('Expected bridge exit observed');}
            const next=await io.readCommand();
            if(next) {
              const follow=exactCommand(next,intentSha256,controllerId);
              if(follow.action==='abort') {acceptedStop=null;return {aborted:true,source_stopped:false,producer_still_fenced:true};}
              if(['action','controller_id','intent_sha256','observation_sha256'].some(k=>follow[k]!==acceptedStop[k]))throw Error('Parent stop command observation changed after acknowledgement');
            }
            await sleep(pollMs);
          }
          throw Error('Parent stop did not close the source before timeout');
        }
        await sleep(pollMs);
      }
      throw Error('Bridge accepted work did not settle before timeout');
      }catch(error){participantError=error;throw error;}
    },{closeWaitMs});
  } catch(error) {
    // HTTP cleanup cannot reopen a process the parent has already closed.
    // The OS observation must confirm absence independently of CDP disconnect.
    if(expectedExitObserved&&acceptedStop&&await io.sourceAlive()===false) return {
      schema:'village-bridge-exit-observation/v1',bridge_exit_observed:true,
      pid:expected.pid,intent_sha256:intentSha256,controller_id:controllerId,
      accepted_observation_sha256:acceptedStop.observation_sha256,full_source_stop_authorized:false};
    throw participantError||error;
  }
}
