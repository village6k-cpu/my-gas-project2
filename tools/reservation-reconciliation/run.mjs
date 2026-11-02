// Cost-bounded local auditor: reuses saved captures, performs no customer sends or reservation writes.
import fs from 'node:fs';import path from 'node:path';import {createHash} from 'node:crypto';import {fileURLToPath} from 'node:url';
import {parseDecision,reconcileReservations,reconcileObligations} from './reconcile.mjs';
import {publishReview} from './publish.mjs';
import {readIngress,captureGaps} from './coverage.mjs';
const digest=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const atomic=(file,data)=>{const temp=file+'.'+process.pid+'.tmp';fs.writeFileSync(temp,JSON.stringify(data),{mode:0o600});fs.renameSync(temp,file);};
const read=(file,fallback)=>fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):fallback;
export async function fetchRows(env,schema,table,select,order,fetchImpl=fetch){
  const rows=[];for(let offset=0;offset<100000;offset+=1000){
    const u=new URL(env.SUPABASE_URL+'/rest/v1/'+table);u.searchParams.set('select',select);u.searchParams.set('order',order);u.searchParams.set('limit','1000');u.searchParams.set('offset',String(offset));
    const r=await fetchImpl(u,{headers:{apikey:env.SUPABASE_SERVICE_ROLE_KEY,Authorization:'Bearer '+env.SUPABASE_SERVICE_ROLE_KEY,'Accept-Profile':schema},signal:AbortSignal.timeout(30000)});
    if(!r.ok)throw Error('canonical_read_failed:'+table+':'+r.status);const page=await r.json();if(!Array.isArray(page))throw Error('invalid_canonical_page');rows.push(...page);if(page.length<1000)return rows;
  }throw Error('canonical_snapshot_limit');
}
function compactJob(j,file,sha256){const d=parseDecision(j.result?.content),e=j.local_context?.turn_internal?.snapshot?.navigation?.conversation_evidence;
  return {job_id:j.job_id,room_key:j.room_key,created_at:j.created_at,updated_at:j.updated_at,state:j.state,application:j.application,
    result:d?{content:JSON.stringify({inquiry_disposition:d.inquiry_disposition,reservation_inquiry:d.reservation_inquiry,sheet_row_candidate:d.sheet_row_candidate})}:null,
    local_context:{job:{customerName:j.local_context?.job?.customerName},turn_internal:{snapshot:{capturedAt:j.local_context?.turn_internal?.snapshot?.capturedAt,navigation:{conversation_evidence:e?{capture_integrity:e.capture_integrity,messages:(e.messages||[]).slice(0,1)}:null}}}},source:{file,sha256}};
}
export async function runAudit({envFile,queueDir,outputDir,now=new Date().toISOString(),lookbackDays=14,publish=false,fetchImpl=fetch}){
  if(![envFile,queueDir,outputDir].every(x=>path.isAbsolute(x)))throw Error('absolute configured paths required');
  const env=read(envFile,{});if(!env.SUPABASE_URL||!env.SUPABASE_SERVICE_ROLE_KEY)throw Error('server credential configuration missing');
  fs.mkdirSync(outputDir,{recursive:true,mode:0o700});
  const lock=path.join(outputDir,'run.lock');let fd;
  try{fd=fs.openSync(lock,'wx',0o600);}catch(e){
    if(e.code!=='EEXIST')throw e;
    const owner=read(lock,null);let dead=false;
    if(Number.isSafeInteger(owner?.pid)&&owner.pid>0){try{process.kill(owner.pid,0);}catch(error){dead=error.code==='ESRCH';}}
    if(!dead)return {status:'already_running_or_interrupted',requiresReview:true};
    // A confirmed dead local owner cannot hold a live audit. Preserve its receipt before reclaiming.
    fs.renameSync(lock,lock+'.interrupted.'+Date.now());fd=fs.openSync(lock,'wx',0o600);
  }
  fs.writeFileSync(fd,JSON.stringify({pid:process.pid,startedAt:now}));
  try{
    const stateFile=path.join(outputDir,'state.json'),previous=read(stateFile,{index:{},obligations:[]});
    const cutoff=Date.parse(new Date(Date.parse(now)+9*3600000-lookbackDays*86400000).toISOString().slice(0,10)+'T00:00:00+09:00'),retainedRooms=new Set(previous.obligations.filter(o=>o.state==='open').map(o=>o.room));
    const index={},jobs=[],dir=path.join(queueDir,'hermes-gateway');let readFiles=0;
    for(const name of fs.readdirSync(dir).filter(n=>/^[a-f0-9]{64}\.json$/.test(n))){
      const file=path.join(dir,name),s=fs.statSync(file),old=previous.cacheVersion===3?previous.index[name]:null;let entry;
      if(old?.mtime===s.mtimeMs&&old.size===s.size&&(old.job || !(Date.parse(old.createdAt)>=cutoff||retainedRooms.has(old.room))))entry=old;
      else{const raw=fs.readFileSync(file,'utf8'),j=JSON.parse(raw);readFiles++;entry={mtime:s.mtimeMs,size:s.size,createdAt:j.created_at,room:j.room_key};
        if(Date.parse(j.created_at)>=cutoff||retainedRooms.has(j.room_key))entry.job=compactJob(j,file,createHash('sha256').update(raw).digest('hex'));
      }
      index[name]=entry;if(entry.job&&(Date.parse(entry.createdAt)>=cutoff||retainedRooms.has(entry.room)))jobs.push(entry.job);
    }
    // Fetch all pages; an interrupted read writes a failure heartbeat and never resolves old findings.
    const trades=await fetchRows(env,'village','trades','trade_id,customer_name,customer_phone,checkout_at,return_at,contract_status,updated_at','trade_id',fetchImpl);
    const items=await fetchRows(env,'village','schedule_items','schedule_id,trade_id,name,qty,is_component,removed_at,checkout_state,updated_at','schedule_id',fetchImpl);
    const ledger=await fetchRows(env,'village','equipment_ledger','equipment_id,name,aliases','equipment_id',fetchImpl);
    const links=await fetchRows(env,'village','inventory_identity_aliases','source_name,equipment_id,equipment_name','name_key',fetchImpl);
    const aliases=ledger.flatMap(r=>(Array.isArray(r.aliases)?r.aliases:[]).map(a=>[a,r.name]));
    for(const l of links){if(ledger.some(e=>e.equipment_id===l.equipment_id&&e.name===l.equipment_name))aliases.push([l.source_name,l.equipment_name]);}
    const report=reconcileReservations({jobs,trades,items,aliases,now,windowStart:new Date(cutoff).toISOString()});
    const ingress=readIngress({queueDir,previous:previous.ingress,cutoff});
    const capture=captureGaps({ingress,jobs,inventory:read(path.join(outputDir,'room-inventory.json'),null),manualCaptures:read(path.join(outputDir,'manual-live-captures.json'),[]),now});
    report.coverage={...report.coverage,...capture.coverage};report.findings.push(...capture.gaps);
    const obligations=reconcileObligations({previous:previous.obligations,findings:report.findings,verifiedKeys:report.verifiedKeys,now});
    const result={...report,obligations,io:{storedJobs:Object.keys(index).length,readFiles,ingressBytesRead:ingress.bytesRead},status:'review_required'};
    atomic(path.join(outputDir,'report.json'),result);
    const publication=publish?await publishReview({report:result,env,now,lastFingerprint:previous.publishedFingerprint,fetchImpl}):{status:'disabled',fingerprint:previous.publishedFingerprint};
    atomic(stateFile,{cacheVersion:3,index,obligations,ingress,publishedFingerprint:publication.fingerprint});
    const heartbeat={status:'ok',checkedAt:now,capturedRooms:report.coverage.capturedRooms,reviewCandidates:report.findings.length,
      openObligations:obligations.filter(o=>o.state==='open').length,allKakaoRoomsVerified:false,publication};
    atomic(path.join(outputDir,'health.json'),heartbeat);return heartbeat;
  }catch(error){atomic(path.join(outputDir,'health.json'),{status:'failed',checkedAt:now,error:String(error.message),allKakaoRoomsVerified:false});throw error;}
  finally{fs.closeSync(fd);fs.unlinkSync(lock);}
}
if(process.argv[1]&&fileURLToPath(import.meta.url)===path.resolve(process.argv[1])){
  const [envFile,queueDir,outputDir]=process.argv.slice(2);
  runAudit({envFile,queueDir,outputDir,publish:process.argv.includes('--publish')}).then(r=>console.log(JSON.stringify(r))).catch(e=>{console.error(e.message);process.exitCode=1;});
}
