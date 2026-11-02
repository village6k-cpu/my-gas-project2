// Read-only business reconciliation. A model/worker/card status never proves a booking.
import { createHash } from 'node:crypto';
const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const phone=x=>{let p=String(x||'').replace(/\D/g,'');if(p.startsWith('82'))p='0'+p.slice(2);if(/^10[0-9]{8}$/.test(p))p='0'+p;return p;};
const key=x=>String(x||'').normalize('NFKC').trim().toLowerCase().replace(/\s+/g,'');
const epoch=x=>Date.parse(x||'');
const active=t=>!['취소','거절'].includes(t.contract_status);
export function parseDecision(content) {
  if(typeof content!=='string')return null;
  const input=content.includes('FINAL_JSON')?content.slice(content.lastIndexOf('FINAL_JSON')+10).trim():content;
  try{return JSON.parse(input);}catch{}
  const m=/```(?:json)?\s*([\s\S]*?)```/.exec(input);
  try{return m?JSON.parse(m[1]):null;}catch{return null;}
}
function period(c) {
  const a=`${c.start_date}T${c.pickup_time}:00+09:00`,b=`${c.end_date}T${c.return_time}:00+09:00`;
  return {start:a,end:b,startMs:epoch(a),endMs:epoch(b)};
}
function validPeriod(p){return Number.isFinite(p.startMs)&&Number.isFinite(p.endMs)&&p.endMs>p.startMs;}
export function reconcileReservations({jobs,trades,items,aliases=[],now=new Date().toISOString(),windowStart=null}) {
  if(!Array.isArray(jobs)||!Array.isArray(trades)||!Array.isArray(items))throw Error('complete canonical snapshot required');
  if(!Number.isFinite(epoch(now)))throw Error('invalid audit clock');
  const byRoom=new Map(), byPlan=new Map();
  for(const j of jobs){
    if(!j.room_key)continue;const old=byRoom.get(j.room_key);
    if(!old||epoch(j.created_at)>epoch(old.created_at))byRoom.set(j.room_key,j);
    const d=parseDecision(j.result?.content),c=d?.sheet_row_candidate;
    if(c?.start_date){
      const k=j.room_key+'|'+hash([phone(c.phone)||key(c.customer_name),c.start_date,c.end_date,c.pickup_time,c.return_time]);
      const previous=byPlan.get(k);if(!previous||epoch(j.created_at)>epoch(previous.created_at))byPlan.set(k,j);
    }
  }
  // An unrelated later thank-you, separate booking, or failed capture cannot erase an earlier obligation.
  for(const j of byRoom.values())byPlan.set(j.room_key+'|latest',j);
  const uniqueJobs=new Map([...byPlan.values()].map(j=>[j.job_id,j]));
  const links=new Map();
  for(const [a,b]of aliases){if(!links.has(key(a)))links.set(key(a),new Set());links.get(key(a)).add(key(b));}
  const canonical=n=>{const l=links.get(key(n));return l?.size===1?[...l][0]:key(n);};
  const findings=[],rooms=[],verifiedKeys=[];
  for(const j of uniqueJobs.values()){
    const room=j.room_key;
    const d=parseDecision(j.result?.content),c=d?.sheet_row_candidate;
    const capture=j.local_context?.turn_internal?.snapshot?.navigation?.conversation_evidence;
    const base={room,name:c?.customer_name||j.local_context?.job?.customerName||room,jobId:j.job_id,sourceAt:j.created_at};
    const roomKey=`reservation-reconciliation:${room}:${c?.start_date?hash([phone(c.phone)||key(c.customer_name),c.start_date,c.end_date,c.pickup_time,c.return_time]).slice(0,20):'capture'}`;
    function add(kind,extra={}){const f={...base,key:roomKey,kind,...extra};findings.push(f);rooms.push({...base,status:kind});}
    if(!d||!capture?.messages?.length||capture.capture_integrity?.ok===false){add('capture_or_decision_missing',{priority:'normal'});continue;}
    if(d.inquiry_disposition==='declined'){rooms.push({...base,status:'declined_requires_no_registration'});continue;}
    if(!c||!c.start_date){rooms.push({...base,status:'no_structured_plan'});continue;}
    const p=period(c),confirmed=d.reservation_inquiry?.confirmed===true;
    if(c.plan_complete!==true||(c.equipment||[]).some(i=>!(i.item||i.name)||!Number.isInteger(Number(i.quantity))||Number(i.quantity)<=0)){add('incomplete_plan',{priority:'normal',confirmed,plan:c});continue;}
    const identity=trades.filter(t=>phone(c.phone)?phone(t.customer_phone)===phone(c.phone):key(t.customer_name)===key(c.customer_name));
    if(!validPeriod(p)){add('incomplete_period',{priority:'normal',confirmed,plan:c});continue;}
    // Past records remain in the report. They are never automatically re-registered.
    const future=p.endMs>=epoch(now),priority=confirmed&&future?'urgent':'normal';
    const same=identity.filter(t=>active(t)&&epoch(t.checkout_at)===p.startMs&&epoch(t.return_at)===p.endMs);
    const near=identity.filter(t=>active(t)&&epoch(t.checkout_at)<p.endMs&&epoch(t.return_at)>p.startMs);
    const expected=new Map();for(const i of c.equipment||[]){const n=i.item||i.name;const q=Number(i.quantity);if(n&&Number.isInteger(q)&&q>0)expected.set(canonical(n),(expected.get(canonical(n))||0)+q);}
    if(same.length>1){add('duplicate_candidate',{priority:future?'urgent':'normal',confirmed,future,plan:c,tradeIds:same.map(t=>t.trade_id)});continue;}
    if(!same.length){add(confirmed?(near.length?'approved_period_mismatch':'approved_booking_missing'):'inquiry_not_registered',
      {priority,confirmed,future,plan:c,tradeIds:near.map(t=>t.trade_id),desiredPeriod:{start:p.start,end:p.end}});continue;}
    const trade=same[0],actual=new Map();
    for(const i of items.filter(i=>i.trade_id===trade.trade_id&&!i.removed_at&&!i.is_component&&i.checkout_state!=='excluded')){
      const n=canonical(i.name),q=Number(i.qty);if(Number.isInteger(q)&&q>=0)actual.set(n,(actual.get(n)||0)+q);
    }
    const missing=[...new Set([...expected.keys(),...actual.keys()])].filter(n=>(actual.get(n)||0)!==(expected.get(n)||0)).map(name=>({name,expected:expected.get(name)||0,actual:actual.get(name)||0}));
    if(missing.length){add(confirmed?'approved_equipment_mismatch':'equipment_review',{priority,confirmed,future,plan:c,tradeIds:[trade.trade_id],missing});continue;}
    // Empty plans, name-only identity, and projections with no schedule rows cannot certify completion.
    if(!expected.size||!phone(c.phone)||!items.some(i=>i.trade_id===trade.trade_id&&!i.removed_at)){
      add('insufficient_readback',{priority:'normal',confirmed,future,tradeIds:[trade.trade_id]});continue;
    }
    rooms.push({...base,status:'verified',tradeId:trade.trade_id});verifiedKeys.push(roomKey);
  }
  return {schema:'reservation-reconciliation/v1',generatedAt:now,coverage:{windowStart,capturedRooms:byRoom.size,
    canonicalTrades:trades.length,canonicalItems:items.length,allKakaoRoomsVerified:false},rooms,findings,verifiedKeys,
    fingerprint:hash([jobs.map(j=>[j.job_id,j.updated_at]),trades,items,aliases])};
}
export function reconcileObligations({previous=[],findings=[],verifiedKeys=[],now}) {
  const next=new Map(findings.map(f=>[f.key,{...f,state:'open',firstSeen:now,lastSeen:now}]));
  const verified=new Set(verifiedKeys);
  for(const old of previous){
    if(next.has(old.key)){next.get(old.key).firstSeen=old.firstSeen;continue;}
    if(verified.has(old.key)){next.set(old.key,{...old,state:'resolved',resolvedAt:now});continue;}
    if(old.state==='resolved'){next.set(old.key,old);continue;}
    next.set(old.key,{...old,previousKind:old.previousKind||old.kind,kind:'source_no_longer_current',state:'open',lastCheckedAt:now});
  }
  return [...next.values()];
}
