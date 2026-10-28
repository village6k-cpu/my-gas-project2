// Read-only observation of existing private work. This never authorizes stop,
// installs a fence, starts an inspector, awaits application work or replays it.
import fs from 'node:fs/promises';
import {createHash, randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';

const sha = raw => createHash('sha256').update(raw).digest('hex');
const normalize = value => process.platform === 'win32' ? value.replaceAll('\\','/').toLowerCase() : value;
const mapNames = ['confirmationInFlight','documentInFlight','registeredReservationChangeInFlight','confirmedReservationCommitInFlight'];

class Inspector {
  constructor(socket) {
    this.socket=socket; this.next=0; this.pending=new Map(); this.scripts=[]; this.paused=null;
    socket.addEventListener('message', event => {
      const message=JSON.parse(event.data);
      if (message.id) {
        const item=this.pending.get(message.id);
        if(item) {clearTimeout(item.timer);this.pending.delete(message.id);
          message.error ? item.reject(Error('Inspector command rejected: '+item.method)) : item.resolve(message.result);}
      } else if(message.method==='Debugger.scriptParsed') this.scripts.push(message.params);
      else if(message.method==='Debugger.paused') {this.paused=message.params;this.onPause?.(message.params);}
      else if(message.method==='Debugger.resumed') this.paused=null;
    });
    socket.addEventListener('close', () => {
      for(const item of this.pending.values()) {clearTimeout(item.timer);item.reject(Error('Inspector disconnected'));}
      this.pending.clear();
    });
  }
  command(method,params={}) {
    const id=++this.next;
    return new Promise((resolve,reject) => {
      const timer=setTimeout(()=>{this.pending.delete(id);reject(Error('Inspector timeout: '+method));},4000);
      this.pending.set(id,{resolve,reject,timer,method});this.socket.send(JSON.stringify({id,method,params}));
    });
  }
  async evaluate(expression) {
    return checked(await this.command('Runtime.evaluate',{expression,returnByValue:true,throwOnSideEffect:true})).value;
  }
}

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
  const endpoint=new URL(url);
  if(endpoint.protocol!=='ws:' || endpoint.hostname!=='127.0.0.1' || endpoint.username || endpoint.password) throw Error('Loopback inspector required');
  if(!Number.isSafeInteger(expected?.pid) || expected.pid<=0 || !Number.isSafeInteger(expected.port)
      || expected.port<1 || expected.port>65535 || typeof expected.exe!=='string' || typeof expected.cwd!=='string'
      || Object.keys(expected.modules||{}).sort().join(',')!=='channel,http,server') throw Error('Invalid observation ownership contract');
  const sources={};
  for(const [name,row] of Object.entries(expected.modules)) {
    if(typeof row.path!=='string' || !/^[a-f0-9]{64}$/.test(row.sha256)) throw Error('Invalid reviewed source binding');
    sources[name]=await fs.readFile(row.path,'utf8');
    if(sha(sources[name])!==row.sha256) throw Error('Reviewed source file hash changed: '+name);
  }
  const socket=new WebSocket(url);
  await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{socket.close();reject(Error('Inspector connection timeout'));},4000);
    socket.addEventListener('open',()=>{clearTimeout(timer);resolve();},{once:true});
    socket.addEventListener('error',()=>{clearTimeout(timer);reject(Error('Inspector connection failed'));},{once:true});
  });
  const client=new Inspector(socket);
  let breakpoint,requestPromise,pauseTimer,ownedPause;
  try {
    const identity=await client.evaluate('({pid:process.pid,exe:process.execPath,cwd:process.cwd()})');
    if(identity.pid!==expected.pid || normalize(identity.exe)!==normalize(expected.exe)
        || normalize(identity.cwd)!==normalize(expected.cwd)) throw Error('Inspector process ownership mismatch');
    await client.command('Debugger.enable');
    if(client.paused) throw Error('Unowned debugger pause already present');
    const scripts={};
    for(const [name,row] of Object.entries(expected.modules)) {
      const matches=client.scripts.filter(s=>normalize(s.url)===normalize(pathToFileURL(row.path).href));
      if(matches.length!==1) throw Error('Exact running module unavailable: '+name);
      scripts[name]=matches[0];
      const loaded=await client.command('Debugger.getScriptSource',{scriptId:matches[0].scriptId});
      if(sha(loaded.scriptSource)!==row.sha256) throw Error('Loaded source hash differs: '+name);
    }
    const lines=sources.server.split('\n').map((line,i)=>line.includes("const url = new URL(req.url || '/',")?i:-1).filter(i=>i>=0);
    if(lines.length!==1) throw Error('Reviewed request boundary unavailable');
    // /health queues gatewayChannel.status() behind mutationTail. An unknown
    // GET instead reaches the reviewed final404 without joining business work.
    const requestPath='/migration-private-work/'+randomUUID();
    const placed=await client.command('Debugger.setBreakpoint',{location:{scriptId:scripts.server.scriptId,lineNumber:lines[0]},
      condition:`req.method==='GET' && req.url===${JSON.stringify(requestPath)}`});
    breakpoint=placed.breakpointId;
    const pausePromise=new Promise((resolve,reject)=>{
      pauseTimer=setTimeout(()=>reject(Error('Owned observation request not reached')),6000);
      client.onPause=value=>{clearTimeout(pauseTimer);resolve(value);};
    });
    if(client.paused) throw Error('Unowned debugger pause before observation request');
    requestPromise=fetch(`http://127.0.0.1:${expected.port}${requestPath}`,{signal:AbortSignal.timeout(12000)})
      .then(async r=>{await r.arrayBuffer();return r.status;}).catch(()=>null);
    const paused=await pausePromise;
    const frame=paused.callFrames.find(f=>f.location.scriptId===scripts.server.scriptId);
    if(!frame || !paused.hitBreakpoints?.includes(breakpoint)) throw Error('Unowned debugger pause');
    ownedPause=paused;
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
    await client.command('Debugger.removeBreakpoint',{breakpointId:breakpoint});breakpoint=null;
    await client.command('Debugger.resume');
    const requestStatus=await requestPromise;
    if(requestStatus!==404) throw Error('Observation request did not reach the reviewed final404 after resume');
    return report;
  } finally {
    clearTimeout(pauseTimer);
    if(breakpoint) await client.command('Debugger.removeBreakpoint',{breakpointId:breakpoint}).catch(()=>{});
    if(client.paused && client.paused===ownedPause) await client.command('Debugger.resume').catch(()=>{});
    // A different debugger's pause must be left to that debugger.
    if(!client.paused) await client.command('Debugger.disable').catch(()=>{});
    socket.close();
    if(requestPromise) await requestPromise;
  }
}
