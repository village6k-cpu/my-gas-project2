// Exact-source, owned nonce breakpoint session shared by read-only observation
// and the separately authorized producer-fence adapter. No process-level inspector enable.
import fs from 'node:fs/promises';
import {createHash, randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';

const sha = raw => createHash('sha256').update(raw).digest('hex');
const normalize = value => process.platform === 'win32' ? value.replaceAll('\\','/').toLowerCase() : value;
class Inspector {
  constructor(socket) {
    this.socket=socket; this.next=0; this.pending=new Map(); this.scripts=[]; this.paused=null; this.contexts=new Map(); this.contextRevision=0;
    socket.addEventListener('message', event => {
      const message=JSON.parse(event.data);
      if (message.id) {
        const item=this.pending.get(message.id);
        if(item) {clearTimeout(item.timer);this.pending.delete(message.id);
          message.error ? item.reject(Error('Inspector command rejected: '+item.method)) : item.resolve(message.result);}
      } else if(message.method==='Debugger.scriptParsed') this.scripts.push(message.params);
      else if(message.method==='Debugger.paused') {this.paused=message.params;this.onPause?.(message.params);}
      else if(message.method==='Debugger.resumed') this.paused=null;
      else if(message.method==='Runtime.executionContextCreated') {this.contextRevision++;this.contexts.set(message.params.context.id,message.params.context);}
      else if(message.method==='Runtime.executionContextDestroyed') {this.contextRevision++;this.contexts.delete(message.params.executionContextId);}
      else if(message.method==='Runtime.executionContextsCleared') {this.contextRevision++;this.contexts.clear();}
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

export async function atOwnedBridgeBoundary(url,expected,callback,{afterResume}={}) {
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
    const result=await callback({client,frame,identity});
    await client.command('Debugger.removeBreakpoint',{breakpointId:breakpoint});breakpoint=null;
    await client.command('Debugger.resume');
    const requestStatus=await requestPromise;
    if(requestStatus!==404) throw Error('Observation request did not reach the reviewed final404 after resume');
    return afterResume ? await afterResume(result,client) : result;
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
