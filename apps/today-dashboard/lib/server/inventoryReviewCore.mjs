import {createHash} from 'node:crypto';
import {stockNameKey} from './slackStockCore.mjs';
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const reviewSourceId=name=>hash(stockNameKey(name));
export function reviewCatalogHash(catalog){return hash({equipment:[...(catalog.equipment||[])].map(e=>({id:e.id,name:e.name,category:e.category,aliases:e.aliases||[]})).sort((a,b)=>a.id.localeCompare(b.id)),sets:catalog.sets||[]});}
export function prepareInventoryInvestigations(sources){return (sources||[]).map(source=>{const bookings=[...(source.bookings||[])].map(b=>({scheduleId:b.scheduleId,tradeId:b.tradeId,name:b.name,quantity:b.quantity,start:b.start,end:b.end})).sort((a,b)=>String(a.scheduleId).localeCompare(String(b.scheduleId)));return {...source,id:reviewSourceId(source.name),sourceHash:hash({name:source.name,kinds:[...source.kinds].sort(),setNames:[...(source.setNames||[])].sort(),bookings})};});}
export function validateInventoryReview(plan,context){
 const allowed=['sourceId','sourceHash','catalogHash','action','equipmentId','equipmentName','reason','question'];
 if(!plan||Object.keys(plan).some(k=>!allowed.includes(k)))throw Error('재고 판단 형식 오류');
 const source=context.sources.find(s=>s.id===plan.sourceId);if(!source||source.sourceHash!==plan.sourceHash||context.catalogHash!==plan.catalogHash)throw Error('원문 또는 장비 목록이 바뀌었습니다. 다시 조회해 주세요');
 if(typeof plan.reason!=='string'||!plan.reason.trim()||plan.reason.length>2000)throw Error('장비를 대조한 판단 근거가 필요합니다');
 const result={sourceId:source.id,sourceName:source.name,sourceHash:source.sourceHash,catalogHash:context.catalogHash,action:plan.action,reason:plan.reason,source};
 if(plan.action==='link_existing'){
  if(source.kinds.includes('model_selection') || context.catalog.equipment.some(e=>stockNameKey(e.category)===stockNameKey(source.name)))throw Error('모델 선택은 전역 별칭으로 저장할 수 없습니다');
  const equipment=context.catalog.equipment.find(e=>e.id===plan.equipmentId && e.name===plan.equipmentName),ledger=context.ledger.find(e=>e.equipment_id===plan.equipmentId && e.name===plan.equipmentName);
  if(!equipment||!ledger||plan.question!==undefined)throw Error('선택한 실제 장비를 다시 확인해 주세요');
  if(context.catalog.equipment.some(e=>e.id!==equipment.id && [e.name,...(e.aliases||[])].some(n=>stockNameKey(n)===stockNameKey(source.name))))throw Error('다른 장비가 이미 사용하는 이름입니다');
  return {...result,equipmentId:equipment.id,equipmentName:equipment.name,expectedUpdatedAt:ledger.updated_at};
 }
 if(plan.action!=='ask_owner'||plan.equipmentId!==undefined||plan.equipmentName!==undefined||typeof plan.question!=='string'||!plan.question.trim()||plan.question.length>1500)throw Error('대표님이 답할 수 있는 구체적인 질문이 필요합니다');
 return {...result,question:plan.question.trim()};
}