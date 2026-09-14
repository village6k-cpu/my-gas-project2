import 'server-only';
import {getInventoryAuditServiceClient} from './inventoryAuditDb';
import {getInventoryAuditMirrorConfig} from './inventoryAuditMirrorCore.mjs';
import {validateStockConfirmation,stockThreadHash,stockNameKey,stockGasRequest,stockQuestionBatch} from './slackStockCore.mjs';
import {validateInventoryReview} from './inventoryReviewCore.mjs';
import {enrichInventoryReviewContext,applyInventoryReview,inventoryQuestionDelivery} from './inventoryReview';
type Obj=Record<string,any>;
async function gas(action:string,body:Obj={},timeoutMs=30000) {
 const {gasUrl,gasKey}=getInventoryAuditMirrorConfig();
 const request=stockGasRequest(gasUrl,gasKey,action,body);
 const response=await fetch(request.url,{...request.options,signal:AbortSignal.timeout(timeoutMs)});
 const data=await response.json();if(!response.ok || data.success===false || data.error)throw Error('재고 원장 연결 확인 필요');return data;
}
async function context(){const data=await gas('run',{func:'getInventoryStockQuestions',args:[{refresh:true}]});if(!data.result?.reports)throw Error('재고 보고 조회 실패');return enrichInventoryReviewContext(data.result);}
export async function processInventoryQuestionDelivery(body:Obj){return inventoryQuestionDelivery(body,context);}
export async function reviewStock(input:unknown,execute:boolean){const c=await context();
 if((input as Obj)?.action==='classify_component'){
  if(c.sourceIssues?.length)throw Error('전체 재고 자료 확인 필요');
  const plan=validateInventoryReview(input,{catalog:c.catalog});
  const data=await gas('run',{func:'applyInventorySemanticReview',args:[{reason:plan.reason,resolutions:plan.resolutions,execute}]});
  return {ok:true,...data.result};
 }
 const result=await applyInventoryReview(c,input,execute);if(execute&&result.action==='link_existing'){const fresh=await context();result.effective=fresh.equipment.some((e:Obj)=>e.id===result.equipmentId&&(e.aliases||[]).includes(result.sourceName));if(!result.effective)throw Error('장비 연결 저장 완료; 실제 재고 계산 반영 확인 재시도 필요');}return result;}
function ownerIds(){const ids=(process.env.SLACK_INVENTORY_OWNER_IDS || '').split(',').map(s=>s.trim()).filter(Boolean);if(!ids.length || ids.some(s=>!/^U[A-Z0-9]+$/.test(s)))throw Error('재고 확인 소유자 설정 필요');return ids;}
// The authenticated local collector owns Slack credentials and fetches the complete
// thread again immediately before apply, just as the existing SlackOps collector.
async function thread(report:Obj,evidence:Obj){
 if(evidence?.reportId!==report.id || evidence.channel!==report.channel || evidence.ts!==report.ts || evidence.complete!==true || !Array.isArray(evidence.messages) || !evidence.messages.length || evidence.messages.length>500)throw Error('최신 Slack 원문 수집 결과가 필요합니다');
 const messages=evidence.messages;
 if(messages.some((m:Obj,i:number)=>!/^\d+\.\d+$/.test(m.ts || '') || (i>0 && Number(m.ts)<=Number(messages[i-1].ts))))throw Error('Slack 원문 순서 확인 필요');
 const root=messages[0];if(!root?.bot_id || root.ts!==report.ts || !['preregistration_stock_alert','inventory_risk_alert'].includes(root.metadata?.event_type) || root.metadata?.event_payload?.id!==report.id)throw Error('검증된 재고 보고 스레드가 아닙니다');
 return messages;
}
export async function getStockReports(reportId?:unknown){
 const c=await context();if(reportId!==undefined && (typeof reportId!=='string'||!c.reports.some((r:Obj)=>r.id===reportId)))throw Error('현재 미해결 재고 보고가 아닙니다');
 const reports=reportId?c.reports.filter((r:Obj)=>r.id===reportId):stockQuestionBatch(c.reports);
 return {ok:true,reports,deferred:reportId?0:Math.max(0,c.reports.length-reports.length),investigations:c.investigations,catalog:c.catalog,catalogHash:c.catalogHash,sourceIssues:c.sourceIssues||[]};
}
async function mirrorOne(equipmentId:string) {
 const db=getInventoryAuditServiceClient();const {data:row,error}=await db.from('equipment_ledger').select('*').eq('equipment_id',equipmentId).single();if(error || !row)throw Error('생성한 재고 원장 조회 실패');
 async function read(){const data=await gas('read',{sheet:'장비마스터',range:'A:L'},10000);if(!Array.isArray(data.headers)||!Array.isArray(data.data))throw Error('장비마스터 형식 오류');return data;}
 let sheet=await read();
 function find(data:Obj){return data.data.filter((r:any[])=>String(r[data.headers.indexOf('장비ID')])===row.equipment_id);}
 let matches=find(sheet);
 if(!matches.length){
  const sameName=sheet.data.some((r:any[])=>stockNameKey(r[sheet.headers.indexOf('장비명')])===stockNameKey(row.name));
  if(sameName)throw Error('같은 장비명의 다른 ID가 생겼습니다. 대조 필요');
  await gas('equipmentMasterSync',{rows:[],append:[{id:row.equipment_id,name:row.name,total:row.stock_total,maint:row.stock_maint,state:row.state,major:row.major,category:row.category,price:row.price,note:row.note,expectedNameAbsent:true}]},10000);
  sheet=await read();matches=find(sheet);
 }
 const current=matches[0],get=(name:string)=>current?.[sheet.headers.indexOf(name)];
 if(matches.length!==1 || get('장비명')!==row.name || Number(get('총보유수량'))!==row.stock_total || Number(get('정비중수량'))!==row.stock_maint || get('상태')!==row.state)throw Error('장비마스터 반영값 대조 필요');
 const {data:after,error:readError}=await db.from('equipment_ledger').select('updated_at').eq('equipment_id',equipmentId).single();if(readError || after?.updated_at!==row.updated_at)throw Error('반영 중 재고 원장이 변경됐습니다');
 const {error:saveError}=await db.from('inventory_stock_confirmations').update({synced_at:new Date().toISOString(),last_error:null}).eq('equipment_id',equipmentId).is('synced_at',null);if(saveError)throw Error('재고 반영 확인 저장 실패');
 return {ok:true,equipmentId,name:row.name,stockTotal:row.stock_total,stockMaintenance:row.stock_maint,verified:true};
}
export async function retryConfirmedStockMirrors(){
 const db=getInventoryAuditServiceClient();const {data,error}=await db.from('inventory_stock_confirmations').select('equipment_id').is('synced_at',null).order('last_attempted_at',{nullsFirst:true}).limit(1);if(error)throw Error('재고 반영 대기 조회 실패');const results=[];
 for(const id of [...new Set((data || []).map(r=>r.equipment_id))]){await db.from('inventory_stock_confirmations').update({last_attempted_at:new Date().toISOString()}).eq('equipment_id',id).is('synced_at',null);try{results.push(await mirrorOne(id));}catch(e){const message=e instanceof Error?e.message:'재고 반영 재시도 필요';await db.from('inventory_stock_confirmations').update({last_error:message}).eq('equipment_id',id).is('synced_at',null);results.push({equipmentId:id,pending:true,message});}}
 return results;
}
export async function scanStockQuestions(evidence:unknown){
 const c=await context(),owners=ownerIds(),questions:Obj[]=[],errors:Obj[]=[];
 if(!Array.isArray(evidence)||evidence.length>8||new Set(evidence.map(e=>e?.reportId)).size!==evidence.length)throw Error('인증된 로컬 수집기의 Slack 원문이 필요합니다');
 const batch=c.reports.filter((r:Obj)=>evidence.some(e=>e?.reportId===r.id));
 if(batch.length!==evidence.length)throw Error('재고 보고가 바뀌었습니다. 다시 조회해 주세요');
 await Promise.all(batch.map(async (report:Obj)=>{try{const messages=await thread(report,evidence.find(e=>e.reportId===report.id));const replies=messages.filter(m=>!m.bot_id && owners.includes(m.user) && m.ts!==report.ts);
 if(replies.length)questions.push({report,sourceHash:stockThreadHash(messages),messages,ownerReplies:replies,catalog:c.sets.filter((s:Obj)=>report.names.includes(s.name)),equipment:c.equipment});
 }catch(e){errors.push({reportId:report.id,error:e instanceof Error?e.message:'재고 답변 조회 실패'});}}));
 return {ok:true,questions,errors,deferred:Math.max(0,c.reports.length-batch.length)};
}
export async function confirmStockQuestion(input:unknown,execute:boolean){
 const raw=(input || {}) as Obj,c=await context(),report=c.reports.find((r:Obj)=>r.id===raw.reportId);if(!report)throw Error('현재 미해결 재고 보고가 아닙니다');
 const messages=await thread(report,raw.threadEvidence),plan=validateStockConfirmation(raw.confirmation,{report,messages,ownerIds:ownerIds(),catalog:c.sets,equipment:c.equipment});
 const set=c.sets.find((s:Obj)=>s.name===plan.catalogName),price=set?.price==null||String(set.price).trim()===''?null:Number(String(set.price).replace(/,/g,''));
 const item={name:plan.catalogName,major:plan.major,category:plan.category,stock_total:plan.stockTotal,stock_maint:plan.stockMaintenance,price:price!==null&&Number.isInteger(price)&&price>=0?price:null};
 const evidence={ownerId:plan.ownerId,channel:report.channel,threadTs:report.ts,reportId:report.id,sourceMessageTs:plan.sourceMessageTs,sourceHash:plan.sourceHash,quote:plan.quote};
 if(!execute)return {ok:true,dryRun:true,item,evidence,sourceKey:plan.sourceKey};
 const db=getInventoryAuditServiceClient();const {data,error}=await db.rpc('confirm_missing_inventory_stock',{p_source_key:plan.sourceKey,p_item:item,p_evidence:evidence});if(error)throw Error('재고 원장이 바뀌었거나 등록을 완료하지 못했습니다. 다시 조회해 주세요');
 return {...data,mirror:{pending:true,message:'원장 등록 완료. 별도 stock_sync에서 장비마스터 반영을 확인합니다'}};
}
