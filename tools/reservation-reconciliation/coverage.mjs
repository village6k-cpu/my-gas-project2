import fs from 'node:fs';import path from 'node:path';import {createHash} from 'node:crypto';
// The ingress journal is independent of Supabase and worker success. Read appended bytes only.
export function readIngress({queueDir,previous={files:{},rooms:{}},cutoff}){
  const files={},rooms={...previous.rooms};let bytesRead=0;
  for(const name of fs.readdirSync(queueDir).filter(n=>/^(events|initial-scans|backstop-events)\.ndjson(?:\.|$)/.test(n))){
    const file=path.join(queueDir,name),stat=fs.statSync(file),old=previous.files[name];
    if(old?.ino===stat.ino&&old.size===stat.size){files[name]=old;continue;}
    const start=old?.ino===stat.ino&&old.offset<=stat.size?old.offset:0;
    const fd=fs.openSync(file,'r'),buffer=Buffer.alloc(stat.size-start);try{let n=0;while(n<buffer.length){const size=fs.readSync(fd,buffer,n,buffer.length-n,start+n);if(size<=0)throw Error('incomplete_ingress_read');n+=size;}}finally{fs.closeSync(fd);}
    bytesRead+=buffer.length;const end=buffer.lastIndexOf(10);files[name]={ino:stat.ino,size:stat.size,offset:end<0?start:start+end+1};
    if(end<0)continue;
    for(const line of buffer.subarray(0,end).toString('utf8').split('\n')){let e;try{e=JSON.parse(line);}catch{continue;}
      const room=e.roomKey||e.room_key,at=e.receivedAt||e.detectedAt||e.at;
      if(!/^chat:\d+$/.test(room||'')||!Number.isFinite(Date.parse(at))||Date.parse(at)<cutoff)continue;
      if(!rooms[room]||Date.parse(at)>Date.parse(rooms[room].at))rooms[room]={room,at,name:e.customerName||room,preview:e.previewText||'',reason:e.reason||'',file:name};
    }
  }
  return {files,rooms,bytesRead};
}
function inventoryMessageAt(row,capturedAt){
  const date=new Date(Date.parse(capturedAt)+9*3600000).toISOString().slice(0,10),year=Number(date.slice(0,4));
  const day=/^(\d+)월\s*(\d+)일$/.exec(row.displayDate||'');
  if(day){let at=Date.parse(`${year}-${day[1].padStart(2,'0')}-${day[2].padStart(2,'0')}T23:59:59+09:00`);if(at>Date.parse(capturedAt)+86400000)at=Date.parse(`${year-1}-${day[1].padStart(2,'0')}-${day[2].padStart(2,'0')}T23:59:59+09:00`);if(Number.isFinite(at))return new Date(at).toISOString();}
  const clock=/^(오전|오후)\s*(\d{1,2}):(\d{2})$/.exec(row.displayDate||'');
  if(clock){const hour=Number(clock[2])%12+(clock[1]==='오후'?12:0);return new Date(Date.parse(`${date}T${String(hour).padStart(2,'0')}:${clock[3]}:00+09:00`)).toISOString();}
  return capturedAt;
}
function previewIdentity(text,name,at){
  let body=String(text||'').replace(/\s+/g,' ').trim();
  const prefix='중요 '+String(name||'').replace(/\s+/g,' ').trim();
  if(!name||!body.startsWith(prefix+' '))return null;
  body=body.slice(prefix.length).trim();
  const label=body.match(/(?:\d+월\s*\d+일|(?:오전|오후)\s*\d{1,2}:\d{2})$/)?.[0];
  if(!label||!Number.isFinite(Date.parse(at)))return null;
  const messageAt=inventoryMessageAt({displayDate:label},at);
  return {body:body.slice(0,-label.length).trim(),day:new Date(Date.parse(messageAt)+9*3600000).toISOString().slice(0,10)};
}
export function captureGaps({ingress,jobs,inventory=null,manualCaptures=[],now}){
  const captured=new Map();
  for(const j of jobs){const snap=j.local_context?.turn_internal?.snapshot;if(!snap?.navigation?.conversation_evidence?.messages?.length||snap.navigation.conversation_evidence.capture_integrity?.ok===false)continue;const at=Date.parse(snap.capturedAt||j.created_at);if(!captured.has(j.room_key)||at>captured.get(j.room_key).at)captured.set(j.room_key,{at,name:j.local_context?.job?.customerName,preview:String(j.local_context?.job?.previewText||'').replace(/\s+/g,' ').trim()});}
  const manuallyCaptured=new Map(manualCaptures.filter(c=>c.sha256===createHash('sha256').update(c.snapshot||'').digest('hex')&&Number.isFinite(Date.parse(c.capturedAt))&&c.snapshot?.includes('- emphasis:')).map(c=>['chat:'+c.id,Date.parse(c.capturedAt)]));
  const observed=new Map(Object.values(ingress.rooms).map(r=>[r.room,r]));
  for(const r of inventory?.rooms||[])if(!observed.has(r.room))observed.set(r.room,{room:r.room,name:r.name,at:inventoryMessageAt(r,inventory.capturedAt),reason:'live_inventory'});
  function hasCapture(r){const c=captured.get(r.room);if(c?.at>=Date.parse(r.at)||manuallyCaptured.get(r.room)>=Date.parse(r.at))return true;
    // A repeated backstop observation of the exact same row is not a new message.
    const samePreview=c?.preview&&c.preview===String(r.preview||'').replace(/\s+/g,' ').trim();
    const sameDay=c&&new Date(c.at+9*3600000).toISOString().slice(0,10)===new Date(Date.parse(r.at)+9*3600000).toISOString().slice(0,10);
    const a=c&&previewIdentity(c.preview,c.name,new Date(c.at).toISOString()),b=previewIdentity(r.preview,r.name,r.at);
    const badgeOnly=a?.body&&b?.body&&/^\d+\s/.test(a.body)!==/^\d+\s/.test(b.body)&&a.body.replace(/^\d+\s+/,'')===b.body.replace(/^\d+\s+/,'');
    return Boolean(samePreview&&sameDay||a?.body&&a.day===b?.day&&(a.body===b.body||badgeOnly));}
  const verifiedKeys=[...observed.values()].filter(hasCapture).map(r=>'capture-reconciliation:'+r.room);
  const gaps=[...observed.values()].filter(r=>!hasCapture(r)).map(r=>({key:'capture-reconciliation:'+r.room,room:r.room,name:r.name,sourceAt:r.at,kind:'ingress_without_capture',priority:'normal',preview:r.preview||'',state:'open'}));
  const inventoryFresh=inventory?.reachedBeforeWindow===true&&Date.parse(now)-Date.parse(inventory.capturedAt)<86400000;
  return {gaps,verifiedKeys,coverage:{ingressRooms:Object.keys(ingress.rooms).length,listedRooms:inventory?.rooms?.length||0,inventoryFresh,
    missingCaptures:gaps.length,manualCaptures:manuallyCaptured.size,allKakaoRoomsVerified:false}};
}
