import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {lookupVillage}=require('../../scripts/windows/village-live-query.js');
const {CorrectionStageError}=require('../../scripts/windows/village-registered-trade-correction.js');
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const period=m=>`${m.expected_period.start_date} ${m.expected_period.start_time} ~ ${m.expected_period.end_date} ${m.expected_period.end_time}`;
const target=m=>m.expected_before[0];
function allocations(m){
  const row=target(m),s=m.external_supply,parts=[],seen=new Set();
  for(const line of s.expected_note.split(/\r?\n/)){
    if(!/^\[(외부조달|상위대체)\]/.test(line))continue;
    const match=/^\[외부조달\] (.+?) \| (.+?) \| ([1-9]\d*)대 \| (.+)$/.exec(line);
    if(!match || match[2]!==row.name || match[4]!==period(m) || seen.has(match[1]))throw Error('existing supply allocation needs reconciliation');
    seen.add(match[1]);parts.push({source:'external',supplier:match[1],name:row.name,qty:Number(match[3])});
  }
  const existing=parts.find(a=>a.supplier===s.supplier);
  if(existing)existing.qty=s.quantity;
  else parts.push({source:'external',supplier:s.supplier,name:row.name,qty:s.quantity});
  if(parts.reduce((n,a)=>n+a.qty,0)>row.quantity)throw Error('combined external allocation exceeds demand');
  return parts;
}
function supplyNote(m){
  const previous=m.external_supply.expected_note.split(/\r?\n/).filter(l=>!/^\[(외부조달|상위대체)\]/.test(l)).join('\n').trim();
  return [previous,...allocations(m).map(a=>`[외부조달] ${a.supplier} | ${a.name} | ${a.qty}대 | ${period(m)}`)].filter(Boolean).join('\n');
}
function sheetRows(sources,name){const rows=Array.isArray(sources)?sources.find(s=>s?.sheet===name)?.results:null;return Array.isArray(rows)?rows:[];}
function scheduleRows(sources){return sheetRows(sources,'스케줄상세');}
function currentTarget(sources,m){const matches=scheduleRows(sources).filter(r=>Array.isArray(r?.data)&&r.data[0]===target(m).schedule_id);return matches.length===1?matches[0].data:null;}
function baselineMatches(sources,m){
  const r=currentTarget(sources,m),t=target(m);
  const contracts=sheetRows(sources,'계약마스터').filter(x=>Array.isArray(x?.data)&&x.data[0]===m.trade_id);
  return contracts.length===1 && !!r && r[1]===m.trade_id && r[3]===t.name && Number(r[4])===t.quantity
    && `${r[5]} ${r[6]} ~ ${r[7]} ${r[8]}`===period(m)
    && !/^\[상위대체\]/m.test(m.external_supply.expected_note) && !['취소','반납완료'].includes(r[9]) && r[10]===m.external_supply.expected_note;
}
export function exactExternalSupplyReadback(authoritative,m){
  try {
  if(!baselineMatches(authoritative?.before?.sources,m)||!Array.isArray(authoritative?.after?.sources))return false;
  const expected=structuredClone(authoritative.before.sources);
  currentTarget(expected,m)[10]=supplyNote(m);
  return same(expected,authoritative.after.sources);
  } catch {return false;}
}
export async function runExternalSupplyAllocation({config,mutation:m,fetchImpl=globalThis.fetch,assertCurrentClaim=async()=>{}}){
  // Called only after the native strict validator; never changes demand, prices or handover state.
  const before=await lookupVillage({config,domain:'schedule',query:m.trade_id,fetchImpl});
  if(!baselineMatches(before.sheets,m))throw new Error('external supply baseline changed; read again');
  if(currentTarget(before.sheets,m)[10]===supplyNote(m)){
    const authoritativeReadback={before:{sources:before.sheets},after:{sources:structuredClone(before.sheets)}};
    return {ok:true,verified:true,tradeId:m.trade_id,appliedStages:[],readback:authoritativeReadback.after,authoritativeReadback};
  }
  const t=target(m),args={scheduleId:t.schedule_id,expected:{tradeId:m.trade_id,name:t.name,qty:t.quantity,period:period(m),note:m.external_supply.expected_note},allocations:allocations(m)};
  await assertCurrentClaim();
  let result;
  try{
    const response=await fetchImpl(config.VILLAGE2_API_URL,{method:'POST',redirect:'follow',headers:{'content-type':'text/plain;charset=utf-8'},body:JSON.stringify({key:config.VILLAGE2_API_KEY,action:'run',func:'setScheduleSupplyAllocation',args:[args]}),signal:AbortSignal.timeout(90000)});
    if(!response.ok)throw Error('allocation HTTP failed');
    result=await response.json();
    if(result.success!==true || result.result?.success!==true || result.result.scheduleId!==t.schedule_id || result.result.tradeId!==m.trade_id || result.result.quantity!==t.quantity || result.result.note!==supplyNote(m))throw Error('allocation result not verified');
    const after=await lookupVillage({config,domain:'schedule',query:m.trade_id,fetchImpl});
    const authoritativeReadback={before:{sources:before.sheets},after:{sources:after.sheets}};
    if(!exactExternalSupplyReadback(authoritativeReadback,m))throw Error('allocation full readback mismatch');
    return {ok:true,verified:true,tradeId:m.trade_id,appliedStages:['setScheduleSupplyAllocation'],readback:authoritativeReadback.after,authoritativeReadback};
  }catch(error){
    // A transport/readback failure after POST is uncertain. The durable native lease must never replay it.
    throw new CorrectionStageError('setScheduleSupplyAllocation',error.message,{outcomeUnknown:true,appliedStages:result?.result?.success===true?['setScheduleSupplyAllocation']:[]});
  }
}
