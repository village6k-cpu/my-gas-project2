// Private file transport for the bridge participant. The parent alone owns
// five-service stop authorization and OS termination. No changes on import.
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {fileURLToPath,pathToFileURL} from 'node:url';
const BASE='C:/Village/migration-staging/studio-20260930/resume-20261027';
const digest=b=>createHash('sha256').update(b).digest('hex');
const names=['migration_bridge_stop_cli.mjs','migration_bridge_stop_handoff.mjs',
  'migration_bridge_inspector_session.mjs','migration_bridge_producer_adapter.mjs',
  'migration_bridge_producer_fence.mjs','migration_bridge_http_adapter.mjs',
  'migration_bridge_http_closure.mjs','migration_bridge_work_probe.mjs','migration_bridge_promise_census.mjs'];
const same=(a,b)=>process.platform==='win32'?a.toLowerCase()===b.toLowerCase():a===b;
const within=(p,b)=>{const r=path.relative(path.resolve(b),path.resolve(p));return r!==''&&!r.startsWith('..'+path.sep)&&r!=='..'&&!path.isAbsolute(r);};
async function checkedPath(p,base){
  if(!within(p,base)||!same(await fs.realpath(p),path.resolve(p)))throw Error('Reference outside private base or through a symlink');
  return p;
}
async function readJson(p){try{return JSON.parse(await fs.readFile(p,'utf8'));}catch(e){if(e.code==='ENOENT')return null;throw e;}}
export async function readBoundPrivate(ref,base){
  if(!ref||!/^[a-f0-9]{64}$/.test(ref.sha256))throw Error('Invalid private reference');
  await checkedPath(ref.path,base);const raw=await fs.readFile(ref.path);
  if(digest(raw)!==ref.sha256)throw Error('Private reference changed');return JSON.parse(raw);
}
async function persisted(p,raw){
  const temp=p+'.'+randomUUID()+'.writing';let handle;
  try{
    handle=await fs.open(temp,'wx',0o600);await handle.writeFile(raw);await handle.sync();await handle.close();handle=null;
    // A hard link installs the fully synced inode without replacing a prior
    // record. In particular STOP-ACK must not become visible before fsync.
    try{await fs.link(temp,p);}catch(e){
      if(e.code!=='EEXIST')throw e;
      if(!Buffer.from(await fs.readFile(p)).equals(Buffer.from(raw)))throw Error('Existing persisted record changed');
    }
  }finally{if(handle)await handle.close();await fs.unlink(temp).catch(e=>{if(e.code!=='ENOENT')throw e;});}
}
async function atomic(p,value){
  const temp=p+'.'+randomUUID()+'.tmp';await persisted(temp,JSON.stringify(value));
  try{await fs.rename(temp,p);}catch(e){await fs.unlink(temp);throw e;}
}
export function createParticipantIo({directory,intentSha256,controllerId,pid,gate=async()=>{}}){
  const owner=value=>{if(value?.controller_id!==controllerId||value?.intent_sha256!==intentSha256)throw Error('Private record owner differs');};
  const ready=path.join(directory,'READY.json'),acks=path.join(directory,'STOP-ACK.json');
  async function checkReady(){const prior=await readJson(ready);if(prior)owner(prior);}
  return {
    async publish(evidence){
      await gate();owner(evidence);await checkReady();const raw=JSON.stringify(evidence),pin=digest(raw);
      const out=path.join(directory,'observations');await fs.mkdir(out,{mode:0o700,recursive:true});
      if(!same(await fs.realpath(out),path.resolve(out)))throw Error('Observation directory symlink');
      await persisted(path.join(out,pin+'.json'),raw);
      await atomic(ready,{controller_id:controllerId,intent_sha256:intentSha256,sha256:pin});return {sha256:pin};
    },
    async readCommand(){await gate();return readJson(path.join(directory,'COMMAND.json'));},
    async invalidateReady(){await gate();await checkReady();try{await fs.unlink(ready);}catch(e){if(e.code!=='ENOENT')throw e;}},
    async acknowledgeStop(ack){await gate();owner(ack);const raw=JSON.stringify(ack);await persisted(acks,raw);return {sha256:digest(raw)};},
    async sourceAlive(){
      await gate();try{process.kill(pid,0);return true;}catch(e){if(e.code==='ESRCH')return false;throw e;}
    }
  };
}
export async function loadParticipantConfiguration(configPath,pin,base=BASE){
  const config=await readBoundPrivate({path:configPath,sha256:pin},base),directory=path.dirname(path.resolve(configPath));
  if(config?.schema!=='village-current-bridge-stop-participant/v1'||config.producer_mode!=='connect'
      ||typeof config.controller_id!=='string'||config.controller_id.length<8
      ||typeof config.token!=='string'||config.token.length<16
      ||config.dependencies?.length!==names.length)throw Error('Invalid participant configuration');
  const intent=await readBoundPrivate(config.intent,base),expected=await readBoundPrivate(config.expected,base);
  const row=intent.profiles?.filter(r=>r.role==='bridge');
  if(row?.length!==1||row[0].pid!==expected.pid||typeof row[0].started!=='number'
      ||!same(path.resolve(row[0].exe),path.resolve(expected.exe))
      ||!same(path.resolve(row[0].cwd),path.resolve(expected.cwd)))throw Error('Participant source differs from parent intent');
  const seen=new Set();
  for(const ref of config.dependencies){
    const name=path.basename(ref.path);if(!names.includes(name)||seen.has(name)||!same(path.dirname(path.resolve(ref.path)),directory))throw Error('Participant dependency inventory differs');
    seen.add(name);await checkedPath(ref.path,base);
    if(digest(await fs.readFile(ref.path))!==ref.sha256)throw Error('Participant dependency changed');
  }
  if(!same(path.resolve(fileURLToPath(import.meta.url)),path.join(directory,'migration_bridge_stop_cli.mjs')))throw Error('Executing participant is outside pinned private directory');
  const inspector=await readBoundPrivate(config.inspector,base);
  if(inspector.pid!==expected.pid||Math.abs(inspector.started-row[0].started)>=.01)throw Error('Inspector source birth differs');
  return {config,directory,expected,url:inspector.url};
}
export async function recoverOwnedHttpSession({config,expected,url}){
  const {withVerifiedBridgeInspector}=await import('./migration_bridge_inspector_session.mjs');
  const present=await withVerifiedBridgeInspector(url,expected,async({client})=>{
    const r=await client.command('Runtime.evaluate',{expression:'Object.hasOwn(globalThis,"__villageCurrentMigrationBridgeHttpClosure")',returnByValue:true,throwOnSideEffect:true});
    if(r.exceptionDetails||typeof r.result?.value!=='boolean')throw Error('HTTP recovery controller state unavailable');return r.result.value;
  });
  if(present){const {recoverCurrentBridgeHttpClosure}=await import('./migration_bridge_http_adapter.mjs');await recoverCurrentBridgeHttpClosure(url,expected,config.token);}
  const {connectCurrentBridgeProducerFence}=await import('./migration_bridge_producer_adapter.mjs');
  const producer=await connectCurrentBridgeProducerFence(url,expected,config.token),state=await producer.snapshot();
  if(state.mode!=='fenced'||state.producers_owned!==true)throw Error('Recovered HTTP lost its producer fence');
  return {http_recovered:true,producer_still_fenced:true,source_stopped:false};
}
async function main(){
  const args=process.argv.slice(2);
  if(args.length!==5||args[0]!=='--config'||args[2]!=='--config-sha'||!['--verify-only','--run','--recover-http'].includes(args[4]))throw Error('Use --config PATH --config-sha SHA (--verify-only|--run|--recover-http)');
  const [configPath,pin]=[args[1],args[3]],loaded=await loadParticipantConfiguration(configPath,pin);
  if(args[4]==='--verify-only'){console.log(JSON.stringify({verified:true,source_changed:false,source_stop_authorized:false}));return;}
  if(args[4]==='--recover-http'){console.log(JSON.stringify(await recoverOwnedHttpSession(loaded)));return;}
  const {config,directory,expected,url}=loaded;
  // A previous attempt is never restarted: it may already have acknowledged a stop.
  await persisted(path.join(directory,'STARTED.json'),JSON.stringify({controller_id:config.controller_id,intent_sha256:config.intent.sha256,started_unix_ms:Date.now(),pid:process.pid}));
  const gate=()=>loadParticipantConfiguration(configPath,pin);
  const io=createParticipantIo({directory,controllerId:config.controller_id,intentSha256:config.intent.sha256,pid:expected.pid,gate});
  const {holdCurrentBridgeForStop}=await import('./migration_bridge_stop_handoff.mjs');
  try{
    const result=await holdCurrentBridgeForStop({url,expected,token:config.token,controllerId:config.controller_id,
      intentSha256:config.intent.sha256,producerMode:'connect',io});
    await persisted(path.join(directory,'RESULT.json'),JSON.stringify(result));console.log(JSON.stringify(result));
  }catch(error){
    await persisted(path.join(directory,'FAILED.json'),JSON.stringify({error:String(error.message),source_stop_authorized:false}));throw error;
  }
}
if(process.argv[1]&&same(pathToFileURL(path.resolve(process.argv[1])).href,import.meta.url))main().catch(e=>{console.error(e.message);process.exitCode=1;});
