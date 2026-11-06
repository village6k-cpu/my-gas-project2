import {createHash} from 'node:crypto';
// Observation clocks and journal references are not new customer instructions.
// Retain the complete original envelope; use this key only to link equal work.
function workKey(job){
 const clean=JSON.parse(JSON.stringify(job));
 for(const key of ['detectedAt','firstEventAt','lastEventAt','intakeIds'])delete clean[key];
 for(const event of clean.events||[]){
  for(const key of ['detectedAt','receivedAt','intakeIds'])delete event[key];
  if(event.raw){delete event.raw.detectedAt;delete event.raw.receivedAt;}
 }
 const ordered=value=>Array.isArray(value)?value.map(ordered):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(k=>[k,ordered(value[k])])):value;
 return createHash('sha256').update(JSON.stringify(ordered(clean))).digest('hex');
}
// This queue hands off data, never guesses whether a financial/reservation write succeeded.
export function createIntakeCoordinator({journal,gateway,dispatch,schedule,now=Date.now,canDispatch=()=>true,maxConcurrentDispatches=1,sameSource=null}={}){
 const running=new Set(),next=new Map(),attempted=new Map();let sequence=0,replaying=null,activeDispatches=0,reviewCursor=0;
 const canonical=new Map(),roomPending=new Map();let seeded=false;
 function remember(row){
  const key=workKey(row.event.job),leader=canonical.get(key);
  if(leader)return leader;
  canonical.set(key,row.id);
  const job=row.event.job,previous=roomPending.get(job.roomKey);
  if(!previous||job.roomRevision>=previous.revision)roomPending.set(job.roomKey,{id:row.id,revision:job.roomRevision});
  return row.id;
 }
 function seed(rows){if(seeded)return;for(const row of rows||journal.pending())if(row.event.kind==='job')remember(row);seeded=true;}
 function pendingRoomObservation(roomKey){
  seed();const entry=roomPending.get(roomKey),row=entry&&journal.read(entry.id);
  if(!row||row.handedOff)return null;
  const job=row.event.job,event=job.events?.at(-1);
  return event?{event,roomRevision:job.roomRevision,state:'locally_queued'}:null;
 }
 const eventRecord=event=>journal.accept({kind:'event',event});
 function jobRecord(job){
  const clean={...job};delete clean.intakeIds;
  const ids=job.intakeIds||[];
  const row=journal.accept({kind:'job',job:clean,...(ids.length?{sourceIds:ids}:{})});
  for(const id of job.intakeIds||[])journal.mark(id,{durable:true,destination:'local_job',job_id:row.id});
  seed();const leader=remember({id:row.id,event:{job:clean}});
  if(leader!==row.id){
   if(!row.handedOff)journal.mark(row.id,{durable:true,destination:'local_job',job_id:leader});
   return journal.read(leader);
  }
  return row;
 }
 async function submit(job,{blocked=false,preflight=null,dispatchContext={},allowDispatch=true}={}){
  const row=jobRecord(job);if(row.handedOff||running.has(row.id))return {durable:!!row.handedOff};
  running.add(row.id);let ownsSlot=false;
  try{
   const clean=journal.read(row.id).event.job;
   let existing=await gateway.get(clean.jobId);
   if(!existing&&!allowDispatch)return {deferred:true};
   if(!existing){
    if(activeDispatches>=maxConcurrentDispatches||!canDispatch(clean))return {deferred:true};
    activeDispatches++;ownsSlot=true;
   }
   if(!existing&&preflight){blocked=(await preflight(clean))?.blocked===true;if(blocked)existing=await gateway.get(clean.jobId);}
   const hold=reason=>{const pending=journal.accept({kind:'review_required',reason,job:clean});journal.mark(row.id,{durable:true,destination:'review_required',record_id:pending.id});return {blocked:true};};
   let result;
   if(existing){
    if(existing.room_key!==clean.roomKey)return hold('durable_intake_correlation_conflict');
    if(existing.room_revision!==clean.roomRevision){
     const original=existing.local_context?.job;
     const ids=j=>Array.isArray(j?.events)&&j.events.length?j.events.map(e=>e.eventHash).sort():null;
     const exact=original?.previewText===clean.previewText&&ids(original)&&JSON.stringify(ids(original))===JSON.stringify(ids(clean));
     if(existing.job_id!==clean.jobId||!(exact||(sameSource&&sameSource(original,clean))))return hold('durable_intake_revision_needs_reconciliation');
    }
    result={durable:true,job_id:existing.job_id};
   }else if(blocked){
    return hold('supabase_duplicate_without_gateway_receipt');
   }else result=await dispatch(clean,dispatchContext);
   if(result?.durable===true){journal.mark(row.id,{durable:true,destination:'gateway',job_id:clean.jobId});return result;}
   next.set(row.id,now()+60000);return result;
  }finally{running.delete(row.id);if(ownsSlot)activeDispatches--;}
 }
 async function replayOnce(limit){
  let replayed=0,reconciled=0;
  const pending=journal.pending();
  seed(pending);
  // Existing duplicate observations are receipt-linked, never deleted. Yield
  // between small batches so the receiver can keep acknowledging live requests.
  let linked=0;
  for(const row of pending){
   if(row.event.kind!=='job')continue;
   const leader=remember(row);
   if(leader===row.id)continue;
   if(!journal.read(row.id).handedOff){journal.mark(row.id,{durable:true,destination:'local_job',job_id:leader});reconciled++;}
   if(++linked%10===0)await new Promise(resolve=>setImmediate(resolve));
  }
  const owned=new Set(pending.filter(r=>r.event.kind==='job').flatMap(r=>r.event.sourceIds||[]));
  // A failing capture must not starve events accepted during an outage.
  const events=pending.filter(r=>r.event.kind==='event'&&!owned.has(r.id));
  // Previously held intake may be closed only by passive exact gateway proof.
  // Its failed business result remains owned by that gateway job.
  const reviews=pending.filter(r=>r.event.kind==='review_required');
  const reviewBatch=Array.from({length:Math.min(20,reviews.length)},(_,i)=>reviews[(reviewCursor+i)%reviews.length]);
  reviewCursor=reviews.length?(reviewCursor+reviewBatch.length)%reviews.length:0;
  for(const row of reviewBatch){
   const clean=row.event.job,existing=await gateway.get(clean.jobId);
   if(existing?.job_id===clean.jobId&&existing.room_key===clean.roomKey&&sameSource?.(existing.local_context?.job,clean)){
    journal.mark(row.id,{durable:true,destination:'gateway',job_id:clean.jobId});reconciled++;
   }
  }
  // Rotate failures behind never-attempted jobs. Reusing an existing durable
  // gateway receipt needs no browser capture and does not spend the retry budget.
  const jobs=pending.filter(r=>r.event.kind==='job'&&canonical.get(workKey(r.event.job))===r.id&&!running.has(r.id)&&(next.get(r.id)||0)<=now())
   .sort((a,b)=>{const recovery=r=>{const e=r.event.job.events;return Array.isArray(e)&&e.length>0&&e.every(x=>x.recoveryOnly===true)?(e.some(x=>x.recoveryOf)?1:2):0;};return recovery(a)-recovery(b)||(attempted.get(a.id)||0)-(attempted.get(b.id)||0);});
  let dispatched=0;
  for(const row of jobs.slice(0,100)){
   try{
    const receipt=await submit({...row.event.job,intakeIds:row.event.sourceIds||[]},{allowDispatch:false});
    if(!receipt.deferred){reconciled++;continue;}
    if(dispatched>=limit)continue;
    const result=await submit({...row.event.job,intakeIds:row.event.sourceIds||[]},{dispatchContext:{origin:'durable_intake_replay'}});
    if(result?.deferred)continue;
    attempted.set(row.id,++sequence);dispatched++;replayed++;
   }catch{attempted.set(row.id,++sequence);next.set(row.id,now()+60000);dispatched++;replayed++;}
  }
  // Starting a new raw backfill capture before pending jobs can occupy the sole
  // slot on every sweep. Drain admitted jobs first, then reserve raw-event slots.
  for(const row of events.slice(0,Math.max(1,Math.ceil(limit/2)))){
   if(!journal.read(row.id).handedOff){schedule({...row.event.event,intakeIds:[row.id]});replayed++;}
  }
  return {replayed,reconciled,...status()};
 }
 function replay(limit=3){if(replaying)return replaying;replaying=replayOnce(limit).finally(()=>{replaying=null;});return replaying;}
 function status(){const pending=journal.pending(),reviews=pending.filter(r=>r.event.kind==='review_required');return {...journal.status(),activeDispatches,actionablePending:pending.length-reviews.length,reviewRequiredCount:reviews.length,oldestPendingAt:pending[0]?.acceptedAt||null,reviewRequired:reviews.slice(0,20).map(r=>({record_id:r.id,job_id:r.event.job?.jobId,room_key:r.event.job?.roomKey,customer_name:r.event.job?.customerName||'',reason:r.event.reason}))};}
 return {accept:eventRecord,submit,replay,status,pendingRoomObservation};
}
