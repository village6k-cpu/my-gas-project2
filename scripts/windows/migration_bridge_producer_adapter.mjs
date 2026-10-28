// A separately authorized adapter for the temporary current-source producer
// fence. Does not close HTTP, stop a process or issue source-closure authority.
import {createHash} from 'node:crypto';
import {atOwnedBridgeBoundary} from './migration_bridge_inspector_session.mjs';
import {installCurrentBridgeProducerFence} from './migration_bridge_producer_fence.mjs';
const key='__villageCurrentMigrationBridgeProducerFence';
const sha=value=>createHash('sha256').update(value).digest('hex');

function binding(expected,token) {
  if(typeof token!=='string'||token.length<8)throw Error('Private producer owner token required');
  return {pid:expected.pid,source_sha256:Object.fromEntries(['server','http','channel'].map(k=>[k,expected.modules[k].sha256])),
    fence_code_sha256:sha(installCurrentBridgeProducerFence.toString()),owner_token_sha256:sha(token)};
}

function checked(result) {
  if(result.exceptionDetails||!result.result)throw Error('Owned producer evaluation rejected');
  return result.result;
}

async function properties(client,value) {
  if(!value?.objectId)throw Error('Runtime timer binding unavailable');
  return client.command('Runtime.getProperties',{objectId:value.objectId,ownProperties:true,generatePreview:false});
}

async function timerRunning(client,fn) {
  const info=await properties(client,fn);
  const scopes=info.internalProperties?.find(p=>p.name==='[[Scopes]]')?.value;
  const list=await properties(client,scopes);
  for(const scope of list.result.filter(p=>/^\d+$/.test(p.name)).sort((a,b)=>Number(a.name)-Number(b.name))) {
    const vars=await properties(client,scope.value),timer=vars.result.find(p=>p.name==='timer');
    if(!timer)continue;
    if(timer.value?.subtype==='null')return {active:false,argument:{value:null}};
    if(timer.value?.type==='object' && timer.value.className==='Timeout') {
      const props=await properties(client,timer.value);
      if(props.result.find(p=>p.name==='_destroyed')?.value?.value!==false)throw Error('Current runtime interval is already destroyed');
      return {active:true,argument:{objectId:timer.value.objectId}};
    }
    throw Error('Unknown current runtime timer type');
  }
  throw Error('Current runtime private timer missing');
}

async function timerState(client,frame) {
  const refs=checked(await client.command('Debugger.evaluateOnCallFrame',{callFrameId:frame.callFrameId,
    expression:'({digest:workOrchestratorDigestRuntime.start,notice_cleanup:workOrchestratorNoticeCleanupRuntime.start,digestBusy:workOrchestratorDigestRuntime.state.digestRunning,noticeBusy:workOrchestratorNoticeCleanupRuntime.state.noticeCleanupRunning})',
    returnByValue:false,throwOnSideEffect:true}));
  const values=await properties(client,refs),result={},handles={};
  for(const name of ['digest','notice_cleanup']) {
    const timer=await timerRunning(client,values.result.find(p=>p.name===name)?.value);
    result[name]=timer.active;handles[name]=timer.argument;
  }
  for(const [name,field] of [['digest','digestBusy'],['notice_cleanup','noticeBusy']]) {
    const busy=values.result.find(p=>p.name===field)?.value?.value;
    if(typeof busy!=='boolean' || (!result[name] && busy))throw Error('Current runtime start or untimed sweep is pending');
  }
  return {state:result,handles};
}

export function observeCurrentBridgeRuntimeTimers(url,expected) {
  return atOwnedBridgeBoundary(url,expected,async({client,frame})=>(await timerState(client,frame)).state);
}

function lookup(bound) {
  return `(() => {const c=globalThis[${JSON.stringify(key)}];
    if(process.pid!==${bound.pid} || !c || JSON.stringify(c.binding)!==${JSON.stringify(JSON.stringify(bound))}) throw Error('Producer owner binding mismatch');
    return c;})()`;
}

function proxy(url,expected,token,bound) {
  const invoke=async method=>atOwnedBridgeBoundary(url,expected,async({client,frame})=>{
    const expression=method==='resume'
      ? `(() => {const c=${lookup(bound)};return c.snapshot().mode==='released'?Promise.resolve(c.snapshot()):c.resume(${JSON.stringify(token)});})()`
      : `${lookup(bound)}.${method}(${JSON.stringify(token)})`;
    const result=checked(await client.command('Debugger.evaluateOnCallFrame',{
      callFrameId:frame.callFrameId,expression,returnByValue:method!=='resume'}));
    return method==='resume'?result:result.value;
  },{afterResume:async(result,client)=>{
    if(method==='resume') {
      if(result.subtype!=='promise'||!result.objectId)throw Error('Owned producer resume promise unavailable');
      return checked(await client.command('Runtime.awaitPromise',{promiseObjectId:result.objectId,returnByValue:true})).value;
    }
    return checked(await client.command('Runtime.evaluate',{expression:`${lookup(bound)}.snapshot()`,returnByValue:true})).value;
  }});
  return {fence:()=>invoke('fence'),resume:async()=>{
    const result=await invoke('resume');
    const timers=await observeCurrentBridgeRuntimeTimers(url,expected);
    if(JSON.stringify(timers)!==JSON.stringify(result.runtime_previous_running))throw Error('Original runtime timer state not restored');
    await atOwnedBridgeBoundary(url,expected,async({client,frame})=>checked(await client.command('Debugger.evaluateOnCallFrame',{
      callFrameId:frame.callFrameId,expression:`(() => {const c=${lookup(bound)};
        const restored=c.dispose(${JSON.stringify(token)});delete globalThis[${JSON.stringify(key)}];return restored;})()`,returnByValue:true})).value);
    return result;
  },snapshot:()=>invoke('snapshot')};
}

export async function installCurrentBridgeFenceOnInspectedSource(url,expected,token) {
  const bound=binding(expected,token);
  await atOwnedBridgeBoundary(url,expected,async({client,frame})=>{
    const prior=await timerState(client,frame);
    const expression=`(() => {
      if(Object.hasOwn(globalThis,${JSON.stringify(key)}))throw Error('Current producer controller already exists');
      if(!gatewayTransportEnabled || !gatewayResultApplicationCoordinator
          || typeof gatewayResultApplicationCoordinator.recoverPendingApplications!=='function')throw Error('Existing coordinator required');
      return {server:req.socket.server,token:${JSON.stringify(token)},
        immediatePollerEnabled:workOrchestratorImmediateNoticeUpdatePoller.enabled,
        entries:[
          {name:'runSupabaseRecoverySweep',get:()=>runSupabaseRecoverySweep,set:v=>runSupabaseRecoverySweep=v},
          {name:'runSlackActionPoll',get:()=>runSlackActionPoll,set:v=>runSlackActionPoll=v},
          {name:'runP0SlackEscalationSweep',get:()=>runP0SlackEscalationSweep,set:v=>runP0SlackEscalationSweep=v},
          {name:'cleanupIdleKakaoConversationTabs',get:()=>cleanupIdleKakaoConversationTabs,set:v=>cleanupIdleKakaoConversationTabs=v},
          {name:'runRegistrationRetrySweep',get:()=>runRegistrationRetrySweep,set:v=>runRegistrationRetrySweep=v},
          {name:'recoverPendingApplications',get:()=>gatewayResultApplicationCoordinator.recoverPendingApplications,
            set:v=>gatewayResultApplicationCoordinator.recoverPendingApplications=v}],
        tracked:[{name:'flushRoom',get:()=>flushRoom,set:v=>flushRoom=v},{name:'dispatchAiJob',get:()=>dispatchAiJob,set:v=>dispatchAiJob=v}]};
    })()`;
    const options=checked(await client.command('Debugger.evaluateOnCallFrame',{callFrameId:frame.callFrameId,expression,returnByValue:false}));
    return checked(await client.command('Runtime.callFunctionOn',{objectId:options.objectId,
      functionDeclaration:`function(digest,cleanup){
        this.runtimes=[{name:'digest',timer:digest},{name:'notice_cleanup',timer:cleanup}];
        const c=(${installCurrentBridgeProducerFence.toString()})(this);
        Object.defineProperty(c,'binding',{value:${JSON.stringify(bound)}});
        Object.defineProperty(globalThis,${JSON.stringify(key)},{value:c,configurable:true});
        return c.snapshot();}`,arguments:[prior.handles.digest,prior.handles.notice_cleanup],returnByValue:true})).value;
  });
  return proxy(url,expected,token,bound);
}

export async function connectCurrentBridgeProducerFence(url,expected,token) {
  const bound=binding(expected,token),control=proxy(url,expected,token,bound);
  await control.snapshot();return control;
}
