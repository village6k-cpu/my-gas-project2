import 'server-only';
import {randomUUID} from 'node:crypto';
import {getInventoryAuditServiceClient} from './inventoryAuditDb';
import {prepareInventoryInvestigations,reviewCatalogHash,validateInventoryReview} from './inventoryReviewCore.mjs';
import {stockNameKey,stockQuestionBatch} from './slackStockCore.mjs';
type Obj=Record<string,any>;
export async function enrichInventoryReviewContext(c:Obj):Promise<Obj>{
 const db=getInventoryAuditServiceClient();
 const results=await Promise.all([db.from('inventory_identity_reviews').select('*').limit(1000),db.from('equipment_ledger').select('equipment_id,name,updated_at').limit(1000)]);
 if(results.some(r=>r.error||!Array.isArray(r.data)||r.data.length>=1000))throw Error('AI 재고 판단 원장 조회 실패');
 const reviews=results[0].data as Obj[],ledger=results[1].data as Obj[];
 const equipment=c.equipment||[],sets=[...(c.sets||[])],reports=[...(c.reports||[])];
 for(const row of reviews){
  const exists=equipment.some((e:Obj)=>[e.name,...(e.aliases||[])].some(n=>stockNameKey(n)===stockNameKey(row.source_name)));
  if(row.action==='ask_owner'&&row.posted_at&&row.question_ts&&!exists){
   reports.push({id:row.id,channel:row.question_channel,ts:row.question_ts,names:[row.source_name],question:row.question_text,review:row.evidence});
   if(!sets.some((s:Obj)=>s.name===row.source_name))sets.push({name:row.source_name,price:null,components:[],source:'reported_equipment'});
  }
 }
 const catalog={equipment,sets},sources=prepareInventoryInvestigations(c.investigations||[]);
 const investigations=sources.filter((s:Obj)=>s.kinds.includes('model_selection')||!reviews.some(r=>r.source_key===s.id&&r.action==='ask_owner'&&!r.cancelled_at)).map((s:Obj)=>{const question=reviews.find(r=>r.source_key===s.id&&r.action==='ask_owner'&&!r.cancelled_at);return question?{...s,status:'waiting_model_choice',question:{text:question.question_text,channel:question.question_channel,ts:question.question_ts}}:s;});
 return {...c,reports:[...new Map(reports.map((r:Obj)=>[r.id,r])).values()],sets,ledger,reviews,catalog,catalogHash:reviewCatalogHash(catalog),sources,investigations:stockQuestionBatch(investigations)};
}
export async function applyInventoryReview(c:Obj,input:unknown,execute:boolean):Promise<Obj>{
 const raw=input as Obj,prior=c.reviews.find((r:Obj)=>r.source_key===raw?.sourceId&&r.action==='link_existing');
 if(prior){
  const keys=['sourceId','sourceHash','catalogHash','action','equipmentId','equipmentName','reason'];
  if(!raw||Object.keys(raw).length!==keys.length||keys.some(k=>raw[k]!==prior.evidence[k]))throw Error('이미 저장한 장비 연결 근거와 다릅니다. 다시 조회해 주세요');
  const db=getInventoryAuditServiceClient();const {data:alias,error}=await db.from('inventory_identity_aliases').select('*').eq('name_key',stockNameKey(prior.source_name)).single();
  if(error||alias?.equipment_id!==raw.equipmentId||alias?.equipment_name!==raw.equipmentName||!c.ledger.some((e:Obj)=>e.equipment_id===raw.equipmentId&&e.name===raw.equipmentName))throw Error('기존 장비 연결 영수증 대조 필요');
  return {ok:true,id:prior.id,action:'link_existing',equipmentId:raw.equipmentId,equipmentName:raw.equipmentName,sourceName:prior.source_name,verified:true,duplicate:true,...(!execute?{dryRun:true}:{})};
 }
 const plan:Obj=validateInventoryReview(input,{sources:c.sources,catalog:c.catalog,catalogHash:c.catalogHash,ledger:c.ledger});
 if(c.sourceIssues?.length)throw Error('원장 전체 조회를 확인한 뒤 장비를 판단해 주세요');
 if(!execute)return {ok:true,dryRun:true,decision:plan};
 const db=getInventoryAuditServiceClient(),decision={...plan,channel:c.channel};
 const {data,error}=await db.rpc('record_inventory_identity_review',{p_decision:decision});
 if(error||!data?.ok)throw Error('장비 연결 근거가 바뀌었거나 저장하지 못했습니다. 다시 조회해 주세요');
 if(data.action==='link_existing'){
  const {data:alias,error:readError}=await db.from('inventory_identity_aliases').select('*').eq('name_key',stockNameKey(plan.sourceName)).single();
  if(readError||alias?.equipment_id!==plan.equipmentId||alias?.equipment_name!==plan.equipmentName)throw Error('저장된 장비 연결 대조 필요');
  return {...data,verified:true,equipmentName:alias.equipment_name};
 }
 return {...data,deliveryPending:true};
}
function uuid(value:unknown){if(typeof value!=='string'||!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(value))throw Error('재고 질문 영수증 형식 오류');return value;}
export async function inventoryQuestionDelivery(body:Obj,loadCurrent:()=>Promise<Obj>){
 const db=getInventoryAuditServiceClient();
 if(body.operation==='claim'){
  const owner=randomUUID();const {data,error}=await db.rpc('claim_inventory_identity_question',{p_owner:owner,p_id:body.id?uuid(body.id):null});
  if(error)throw Error('재고 질문 전송 대기 조회 실패');return {ok:true,question:data?{...data,owner}:null};
 }
 const id=uuid(body.id),owner=uuid(body.owner);
 if(body.operation==='attempt'){
  const current=await loadCurrent(),row=current.reviews.find((r:Obj)=>r.id===id);
  if(current.sourceIssues?.length)throw Error('질문 전 현재 예약·재고 조회 확인 필요');
  const source=current.sources.find((s:Obj)=>s.id===row?.source_key&&s.sourceHash===row?.source_hash);
  if(!source){
   const {error}=await db.from('inventory_identity_reviews').update({cancelled_at:new Date().toISOString(),lease_owner:null,lease_until:null}).eq('id',id).eq('lease_owner',owner).eq('action','ask_owner').is('posted_at',null);
   if(error)throw Error('해결된 재고 질문 취소 확인 필요');return {ok:true,allowed:false,stale:true};
  }
  const {data,error}=await db.rpc('mark_inventory_identity_question_attempt',{p_id:id,p_owner:owner});if(error)throw Error('재고 질문 전송 권한 확인 실패');return {ok:true,allowed:data===true};
 }
 if(body.operation!=='receipt')throw Error('재고 질문 처리 형식 오류');
 const {data:row,error}=await db.from('inventory_identity_reviews').select('*').eq('id',id).single();
 const receipt=body.receipt,root=receipt?.messages?.[0];
 if(error||!row||row.action!=='ask_owner'||receipt?.complete!==true||receipt.channel!==row.question_channel||receipt.reportId!==id||root?.ts!==receipt.ts||!root?.bot_id||root.text!==row.question_text||root.metadata?.event_type!=='inventory_risk_alert'||root.metadata?.event_payload?.id!==id)throw Error('재고 질문의 실제 Slack 원문 확인 필요');
 const {data:done,error:saveError}=await db.rpc('complete_inventory_identity_question',{p_id:id,p_owner:owner,p_ts:root.ts});
 if(saveError||done!==true)throw Error('재고 질문 전송 영수증 저장 재시도 필요');return {ok:true,posted:true,id,ts:root.ts};
}
