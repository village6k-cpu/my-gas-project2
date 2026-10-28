// Evaluated only by a separately reviewed source-bound controller. No process
// exit or HTTP shutdown: accepted work before installation remains unverified.
export function installCurrentBridgeProducerFence({server,token,entries,tracked,runtimes,immediatePollerEnabled}) {
  const producerNames=['runSupabaseRecoverySweep','runSlackActionPoll','runP0SlackEscalationSweep',
    'cleanupIdleKakaoConversationTabs','runRegistrationRetrySweep','recoverPendingApplications'];
  const exact=(rows,names)=>Array.isArray(rows) && rows.length===names.length
    && rows.every(r=>names.includes(r.name)) && new Set(rows.map(r=>r.name)).size===names.length;
  if(typeof token!=='string'||token.length<8 || !exact(entries,producerNames)
      || !exact(tracked,['flushRoom','dispatchAiJob']) || !exact(runtimes,['digest','notice_cleanup'])
      || entries.concat(tracked).some(r=>typeof r.get!=='function'||typeof r.set!=='function')
      || runtimes.some(r=>!Object.hasOwn(r,'timer') || (r.timer!==null && (typeof r.timer!=='object'
        || r.timer._destroyed!==false || !(r.timer._repeat>0)
        || typeof Object.getOwnPropertyDescriptor(r.timer,'_onTimeout')?.value!=='function'
        || Object.getOwnPropertyDescriptor(r.timer,'_onTimeout').writable!==true)))) throw Error('Invalid current producer contract');
  if(new Set(runtimes.map(r=>r.timer).filter(Boolean)).size!==runtimes.filter(r=>r.timer!==null).length)throw Error('Duplicate runtime timer contract');
  if(immediatePollerEnabled!==false) throw Error('Unobservable immediate poller must be disabled');
  const key=Symbol.for('village.currentMigrationProducerFence');
  const listeners=server.listeners('request');
  if(Object.hasOwn(server,key) || !server.listening || listeners.length!==1) throw Error('Server ownership or listener changed');
  const original=listeners[0], producerOriginals=entries.map(r=>r.get()), trackedOriginals=tracked.map(r=>r.get());
  if(producerOriginals.concat(trackedOriginals).some(fn=>typeof fn!=='function')) throw Error('Invalid producer function binding');
  let mode='running';
  const handlers=new Set(),producers=new Set(),work=new Set();
  const startedCalls=Object.fromEntries(producerNames.map(n=>[n,0]));
  const blockedCalls=Object.fromEntries(producerNames.map(n=>[n,0]));
  const priorRunning=Object.fromEntries(runtimes.map(r=>[r.name,r.timer!==null]));
  const runtimeCallbacks=runtimes.map(r=>r.timer?Object.getOwnPropertyDescriptor(r.timer,'_onTimeout').value:null);
  const runtimeRepeats=runtimes.map(r=>r.timer? r.timer._repeat:null);
  const blockedRuntimeCalls=Object.fromEntries(runtimes.map(r=>[r.name,0]));
  const runtimeWrappers=runtimeCallbacks.map((fn,i)=>fn?function(...args){
    if(mode==='fenced'){blockedRuntimeCalls[runtimes[i].name]+=1;return;}
    return fn.apply(this,args);
  }:null);
  const track=(set,value)=>{
    const pending=Promise.resolve(value);set.add(pending);
    pending.then(()=>set.delete(pending),()=>set.delete(pending));return pending;
  };
  const producerWrappers=producerOriginals.map((fn,i)=>function(...args) {
    if(mode==='fenced') {
      blockedCalls[entries[i].name]+=1;
      return Promise.resolve(entries[i].name==='recoverPendingApplications'?[]:{status:'migration_fenced'});
    }
    startedCalls[entries[i].name]+=1;
    return track(producers,fn.apply(this,args));
  });
  const trackedWrappers=trackedOriginals.map(fn=>function(...args){return track(work,fn.apply(this,args));});
  const gate=(req,res)=>{
    let pathname;
    try {pathname=new URL(req.url||'/','http://127.0.0.1').pathname;}
    catch {res.writeHead(400,{'Connection':'close'});res.end();return;}
    const probe=req.method==='GET' && /^\/migration-private-work\/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(pathname);
    const finishingProtocol=pathname.startsWith('/hermes/v1/') && pathname!=='/hermes/v1/events';
    if(mode==='running' || pathname==='/health' || probe || finishingProtocol) return track(handlers,original(req,res));
    res.writeHead(503,{'Content-Type':'application/json','Connection':'close','Retry-After':'60'});
    res.end(JSON.stringify({ok:false,error:'migration_ingress_fenced'}));
  };
  const owned=()=>server[key]===control && server.listeners('request').length===1
    && server.listeners('request')[0]===gate && entries.every((r,i)=>r.get()===producerWrappers[i])
    && tracked.every((r,i)=>r.get()===trackedWrappers[i])
    && runtimes.every((r,i)=>r.timer===null || (r.timer._onTimeout===runtimeWrappers[i]
      && r.timer._destroyed===false && r.timer._repeat===runtimeRepeats[i]));
  const assertOwner=value=>{if(value!==token)throw Error('Producer fence owner mismatch');};
  const snapshot=()=>({schema:'village-current-bridge-producer-fence/v1',mode,
    producers_owned:owned(),producer_names:[...producerNames],pending_handlers:handlers.size,
    pending_producers:producers.size,pending_tracked_work:work.size,runtime_error:null,
    started_calls:{...startedCalls},blocked_calls:{...blockedCalls},
    runtime_previous_running:{...priorRunning},
    runtime_blocked_calls:{...blockedRuntimeCalls},
    preexisting_work_verified:false,stop_authorized:false,http_closed:false,drained:false});
  const control={snapshot,
    fence(value) {
      assertOwner(value);
      if(mode!=='running'||!owned())throw Error('Producer fence state or binding changed');
      mode='fenced';
      return snapshot();
    },
    async resume(value) {
      assertOwner(value);
      if(!['running','fenced'].includes(mode)||!owned())throw Error('Producer resume state or binding ownership changed');
      mode='released';
      server.removeListener('request',gate);server.on('request',original);
      entries.forEach((r,i)=>r.set(producerOriginals[i]));tracked.forEach((r,i)=>r.set(trackedOriginals[i]));
      runtimes.forEach((r,i)=>{if(r.timer)r.timer._onTimeout=runtimeCallbacks[i];});
      delete server[key];
      return snapshot();
    },
    dispose(value) {
      assertOwner(value);
      if(mode!=='released'||Object.hasOwn(server,key)||server.listeners('request').length!==1
          ||server.listeners('request')[0]!==original||entries.some((r,i)=>r.get()!==producerOriginals[i])
          ||tracked.some((r,i)=>r.get()!==trackedOriginals[i])
          ||runtimes.some((r,i)=>r.timer!==null && (r.timer._onTimeout!==runtimeCallbacks[i]
            ||r.timer._destroyed!==false||r.timer._repeat!==runtimeRepeats[i])))throw Error('Original source bindings not restored');
      mode='disposed';return {disposed:true,original_bindings_restored:true,stop_authorized:false};
    }
  };
  try {
    Object.defineProperty(server,key,{value:control,configurable:true});
    entries.forEach((r,i)=>r.set(producerWrappers[i]));tracked.forEach((r,i)=>r.set(trackedWrappers[i]));
    runtimes.forEach((r,i)=>{if(r.timer)r.timer._onTimeout=runtimeWrappers[i];});
    server.removeListener('request',original);server.on('request',gate);
  } catch(error) {
    entries.forEach((r,i)=>{if(r.get()===producerWrappers[i])r.set(producerOriginals[i]);});
    tracked.forEach((r,i)=>{if(r.get()===trackedWrappers[i])r.set(trackedOriginals[i]);});
    runtimes.forEach((r,i)=>{if(r.timer?._onTimeout===runtimeWrappers[i])r.timer._onTimeout=runtimeCallbacks[i];});
    if(server.listeners('request').length===1 && server.listeners('request')[0]===gate) {
      server.removeListener('request',gate);server.on('request',original);
    }
    if(server[key]===control)delete server[key];throw error;
  }
  return control;
}
