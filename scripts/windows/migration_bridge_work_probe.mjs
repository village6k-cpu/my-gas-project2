// Read-only observation; never installs a fence, awaits business work or authorizes stop.
import {atOwnedBridgeBoundary} from './migration_bridge_inspector_session.mjs';
const mapNames = ['confirmationInFlight','documentInFlight','registeredReservationChangeInFlight','confirmedReservationCommitInFlight'];

function checked(result) {
  if(result.exceptionDetails || !result.result) throw Error('Read-only inspector evaluation rejected: '+(result.exceptionDetails?.exception?.className || 'unavailable'));
  return result.result;
}

async function properties(client,object) {
  if(!object?.objectId) throw Error('Required private object unavailable');
  return client.command('Runtime.getProperties',{objectId:object.objectId,ownProperties:true,generatePreview:false});
}

// Scopes and promise internals are inspected as remote handles. Scope values,
// customer records, credentials and PromiseResult are never serialized or logged.
async function binding(client,fn,name) {
  const details=await properties(client,fn);
  const scopes=details.internalProperties?.find(p=>p.name==='[[Scopes]]')?.value;
  const list=await properties(client,scopes);
  for(const scope of list.result.filter(p=>/^\d+$/.test(p.name)).sort((a,b)=>Number(a.name)-Number(b.name))) {
    const values=await properties(client,scope.value);
    const found=values.result.find(p=>p.name===name);
    if(found) {
      if(!found.value) throw Error('Required private binding unavailable: '+name);
      return found.value;
    }
  }
  throw Error('Required private binding missing: '+name);
}

async function mapSize(client,map) {
  if(map?.subtype!=='map') throw Error('Required private Map unavailable');
  const result=checked(await client.command('Runtime.callFunctionOn',{objectId:map.objectId,
    functionDeclaration:"function(){return Object.getOwnPropertyDescriptor(Map.prototype,'size').get.call(this);}",
    returnByValue:true,throwOnSideEffect:true})).value;
  if(!Number.isSafeInteger(result) || result<0) throw Error('Invalid private map size');
  return result;
}

async function promiseState(client,fn,name) {
  if(fn?.subtype==='null') return 'absent';
  if(fn?.type!=='function') throw Error('Required coordinator function unavailable');
  return directPromiseState(client,await binding(client,fn,name),name);
}

async function directPromiseState(client,value,name) {
  if(value.subtype==='null') return 'absent';
  if(value.subtype!=='promise') throw Error('Required private promise unavailable: '+name);
  const details=await properties(client,value);
  const state=details.internalProperties?.find(p=>p.name==='[[PromiseState]]')?.value?.value;
  if(!['pending','fulfilled','rejected'].includes(state)) throw Error('Private promise state unavailable: '+name);
  return state;
}

export async function observeBridgePrivateWork(url,expected) {
  return atOwnedBridgeBoundary(url,expected,async ({client,frame,identity}) => {
    const refs=checked(await client.command('Debugger.evaluateOnCallFrame',{callFrameId:frame.callFrameId,
      expression:`(() => {
        if(CONFIG.port!==${expected.port}) throw Error('Request owner mismatch');
        return {http:gatewayHttpHandler, app:gatewayResultApplicationCoordinator?.idle ?? null,
          audit:kakaoAutomationAuditCoordinator?.projectPending ?? null,channel:gatewayChannel?.status ?? null,
          manual:manualSendInFlight,slots:queuedWorkerSlotsByRoom,workerChain,
          recovery:gatewayFailureNotificationCoordinator?.recover ?? null,
          flags:{workerRunning:state.workerRunning,slackActionPollRunning:state.slackActionPollRunning,
            p0SlackEscalationRunning:state.p0SlackEscalationRunning,recoverySweepRunning:state.recoverySweepRunning,
            tabCleanupRunning:state.tabCleanupRunning,noticeCleanupRunning:state.workOrchestrator.noticeCleanupRunning,
            digestRunning:state.workOrchestrator.digestRunning,workActionPollRunning:state.workOrchestrator.workActionPollRunning,
            workActionPollEnabled:workOrchestratorActionPoller.enabled,registrationRetryRunning,
            activeWorkerRuns:state.activeWorkerRuns,workerQueueLength:state.workerQueueLength,
            rooms:state.rooms.size,activeWorkerJobIds:state.activeWorkerJobIds.size}};
      })()`,returnByValue:false,throwOnSideEffect:true}));
    const values=await properties(client,refs);
    const get=name=>values.result.find(p=>p.name===name)?.value;
    const http={};
    for(const name of mapNames) http[name]=await mapSize(client,await binding(client,get('http'),name));
    const promises={applicationTail:await promiseState(client,get('app'),'applicationTail'),
      projectionInFlight:await promiseState(client,get('audit'),'projectionInFlight'),
      mutationTail:await promiseState(client,get('channel'),'mutationTail'),
      recoveryTail:await promiseState(client,get('recovery'),'recoveryTail'),
      workerChain:await directPromiseState(client,get('workerChain'),'workerChain')};
    const manual=await mapSize(client,get('manual')), slots=await mapSize(client,get('slots'));
    const flagDetails=await properties(client,get('flags'));
    const flags=Object.fromEntries(flagDetails.result.map(p=>[p.name,p.value?.value]));
    const booleanFlags=['workerRunning','slackActionPollRunning','p0SlackEscalationRunning','recoverySweepRunning',
      'tabCleanupRunning','noticeCleanupRunning','digestRunning','registrationRetryRunning'];
    const countFlags=['activeWorkerRuns','workerQueueLength','rooms','activeWorkerJobIds'];
    const idle=booleanFlags.every(k=>flags[k]===false) && countFlags.every(k=>flags[k]===0)
      && (flags.workActionPollEnabled===false || (flags.workActionPollEnabled===true && flags.workActionPollRunning===false))
      && Object.values(http).every(n=>n===0) && manual===0 && slots===0
      && Object.values(promises).every(s=>s==='absent'||s==='fulfilled');
    const report={schema:'village-bridge-private-work-observation/v1',observed_unix_ms:Date.now(),
      owner:identity,source_sha256:Object.fromEntries(Object.entries(expected.modules).map(([k,v])=>[k,v.sha256])),
      http_in_flight:http,promises,manual_in_flight:manual,queued_room_slots:slots,flags,idle,
      observation_only:true,stop_authorized:false};
    return report;
  });
}
