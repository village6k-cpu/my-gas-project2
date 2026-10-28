// Reversible HTTP-close observation session. Never stops the process or grants
// SourceStop authority. A failed/unfinished close retains the verification hold.
import {createHash} from 'node:crypto';
import {atOwnedBridgeBoundary,withVerifiedBridgeInspector} from './migration_bridge_inspector_session.mjs';
import {installCurrentBridgeProducerFence} from './migration_bridge_producer_fence.mjs';
import {installBridgeHttpClosure} from './migration_bridge_http_closure.mjs';
import {captureBridgePrivateWorkReader,readCapturedBridgePrivateWork} from './migration_bridge_work_probe.mjs';
import {censusPendingNativePromises} from './migration_bridge_promise_census.mjs';
const producerKey='__villageCurrentMigrationBridgeProducerFence';
const key='__villageCurrentMigrationBridgeHttpClosure';
const sha=raw=>createHash('sha256').update(raw).digest('hex');
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function checked(result) {
  if(result.exceptionDetails||!result.result)throw Error('Owned HTTP closure evaluation rejected');return result.result;
}

function ownerLookup(expected,token) {
  const producerBinding={pid:expected.pid,source_sha256:Object.fromEntries(['server','http','channel'].map(k=>[k,expected.modules[k].sha256])),
    fence_code_sha256:sha(installCurrentBridgeProducerFence.toString()),owner_token_sha256:sha(token)};
  const binding={...producerBinding,http_code_sha256:sha(installBridgeHttpClosure.toString())};
  const lookup=`(() => {const p=globalThis[${JSON.stringify(producerKey)}],c=globalThis[${JSON.stringify(key)}];
    if(process.pid!==${expected.pid} || !p || JSON.stringify(p.binding)!==${JSON.stringify(JSON.stringify(producerBinding))}
      || !c || JSON.stringify(c.binding)!==${JSON.stringify(JSON.stringify(binding))})throw Error('HTTP closure owner mismatch');return c;})()`;
  return {producerBinding,binding,lookup};
}

// This entry needs no HTTP request: it still verifies exact live PID/exe/cwd and
// disk/loaded modules before recovering only this token/code-bound controller.
export async function recoverCurrentBridgeHttpClosure(url,expected,token) {
  if(typeof token!=='string'||token.length<8)throw Error('Private HTTP closure owner required');
  const {lookup}=ownerLookup(expected,token);
  return withVerifiedBridgeInspector(url,expected,async({client})=>{
    const result=checked(await client.command('Runtime.evaluate',{expression:`(async()=>{const c=${lookup},s=c.snapshot();
      if(s.http_closed!==true || !['closed','reopen_failed'].includes(s.mode))throw Error('Owned HTTP close is not settled');
      await c.abort(${JSON.stringify(token)});const http=c.release(${JSON.stringify(token)});
      delete globalThis[${JSON.stringify(key)}];return {http,producer:globalThis[${JSON.stringify(producerKey)}].snapshot(),source_stopped:false};
    })()`,awaitPromise:true,returnByValue:true}));
    return result.value;
  });
}

export async function withCurrentBridgeHttpClosure(url,expected,token,callback,{closeWaitMs=10000}={}) {
  if(typeof token!=='string'||token.length<8||typeof callback!=='function'
      ||!Number.isSafeInteger(closeWaitMs)||closeWaitMs<1||closeWaitMs>60000)throw Error('Invalid HTTP observation session contract');
  const {producerBinding,binding,lookup}=ownerLookup(expected,token);
  let installed=false;
  return atOwnedBridgeBoundary(url,expected,async({client,frame,identity})=>{
    const reader=await captureBridgePrivateWorkReader(client,frame,expected);
    const options=checked(await client.command('Debugger.evaluateOnCallFrame',{callFrameId:frame.callFrameId,
      expression:`(() => {const p=globalThis[${JSON.stringify(producerKey)}];
        if(!p || JSON.stringify(p.binding)!==${JSON.stringify(JSON.stringify(producerBinding))}
          || p.snapshot().mode!=='fenced' || !p.snapshot().producers_owned
          || Object.hasOwn(globalThis,${JSON.stringify(key)}))throw Error('HTTP closure producer owner mismatch');
        return {server:req.socket.server,fence:p,token:${JSON.stringify(token)}};})()`,returnByValue:false}));
    checked(await client.command('Runtime.callFunctionOn',{objectId:options.objectId,
      functionDeclaration:`function(){const c=(${installBridgeHttpClosure.toString()})(this);
        Object.defineProperty(c,'binding',{value:${JSON.stringify(binding)}});
        Object.defineProperty(globalThis,${JSON.stringify(key)},{value:c,configurable:true});return c.snapshot();}`,returnByValue:true}));
    installed=true;
    checked(await client.command('Runtime.evaluate',{expression:`${lookup}.begin(${JSON.stringify(token)})`,returnByValue:true}));
    return {reader,identity};
  },{afterResume:async({reader,identity},client)=>{
    const evaluate=async expression=>checked(await client.command('Runtime.evaluate',{expression,returnByValue:true})).value;
    const httpSnapshot=()=>evaluate(`${lookup}.snapshot()`);
    try {
      const deadline=Date.now()+closeWaitMs;
      let http=await httpSnapshot();
      while(!http.http_closed && http.mode==='closing' && Date.now()<deadline) {await wait(20);http=await httpSnapshot();}
      if(!http.http_closed||http.mode!=='closed')throw Error('HTTP closure not settled; verification hold retained');
      const observe=async()=>{
        const http=await httpSnapshot();
        const producer=await evaluate(`globalThis[${JSON.stringify(producerKey)}].snapshot()`);
        const privateWork=await readCapturedBridgePrivateWork(client,reader,identity,expected);
        const nativePromises=await censusPendingNativePromises(client);
        return {schema:'village-current-closed-http-observation/v1',http,producer,private_work:privateWork,native_promises:nativePromises,
          idle:http.http_closed===true && http.producer_fence_owned===true && producer.producers_owned===true
            && producer.pending_handlers===0 && producer.pending_producers===0 && producer.pending_tracked_work===0
            && privateWork.idle===true && nativePromises.complete===true && nativePromises.idle===true,
          observation_only:true,stop_authorized:false};
      };
      return await callback({observe});
    } finally {
      if(installed) {
        const current=await httpSnapshot();
        if(current.http_closed!==true)throw Error('HTTP close unfinished; owned fence and verification hold retained');
        checked(await client.command('Runtime.evaluate',{expression:`(async()=>{const c=${lookup};
          await c.abort(${JSON.stringify(token)});const result=c.release(${JSON.stringify(token)});
          delete globalThis[${JSON.stringify(key)}];return result;})()`,awaitPromise:true,returnByValue:true}));
      }
    }
  }});
}
