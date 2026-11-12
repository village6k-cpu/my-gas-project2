import 'server-only';
import {verifyOwnerCorrection} from '../../../../tools/master-correction/owner-proof.mjs';
import {registerCatalogInventory} from '../../../../tools/master-correction/catalog-stock.mjs';
import {getInventoryAuditServiceClient} from './inventoryAuditDb';
import {getInventoryAuditMirrorConfig} from './inventoryAuditMirrorCore.mjs';
import {mirrorConfirmedStock} from './slackStock';

type Obj=Record<string,any>;
export function catalogStockReady(){
 return ['SLACK_OPS_SYNC_SECRET','SLACK_BOT_TOKEN','SLACK_INVENTORY_OWNER_IDS','NEXT_PUBLIC_SUPABASE_URL','SUPABASE_SERVICE_ROLE_KEY'].every(k=>Boolean(process.env[k]?.trim()));
}
export async function catalogStockIdentity(){
 if(!catalogStockReady())return null;
 const response=await fetch('https://slack.com/api/auth.test',{headers:{Authorization:'Bearer '+process.env.SLACK_BOT_TOKEN},signal:AbortSignal.timeout(15000)});
 const data=await response.json();if(!response.ok||!data.ok)throw Error('서버 Slack 계정 확인 실패');
 return {teamId:data.team_id,botId:data.bot_id,questionBotId:process.env.MASTER_CORRECTION_QUESTION_BOT_ID||data.bot_id};
}
export async function createCatalogStock(request:Obj){
 if(!catalogStockReady())throw Error('신규 장비 등록 서버 설정 확인 필요');
 const owners=(process.env.SLACK_INVENTORY_OWNER_IDS||'').split(',').map(x=>x.trim());
 const owner=request.source?.ownerId;
 if(!owner||!owners.includes(owner))throw Error('등록된 대표님 원문이 필요합니다');
 const db=getInventoryAuditServiceClient();
 return registerCatalogInventory(request,{
  verify:(r:Obj)=>verifyOwnerCorrection({request:r,config:{ownerId:owner,teamId:r.source.teamId,questionBotId:process.env.MASTER_CORRECTION_QUESTION_BOT_ID,slackToken:process.env.SLACK_BOT_TOKEN}}),
  preview:async(r:Obj)=>{
   const {gasUrl,gasKey}=getInventoryAuditMirrorConfig();
   const response=await fetch(gasUrl,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({...r,key:gasKey,action:'masterCorrection',mode:'preview'}),signal:AbortSignal.timeout(30000)});
   const data=await response.json();if(!response.ok||!data.success)throw Error(data.error||'세트마스터 미리보기 실패');return data;
  },
  confirmation:async(key:string)=>{
   const {data,error}=await db.from('inventory_stock_confirmations').select('equipment_id').eq('source_key',key).maybeSingle();
   if(error)throw Error('신규 장비 등록 이력 조회 실패');return data;
  },
  confirm:async(key:string,item:Obj,evidence:Obj)=>{
   const {data,error}=await db.rpc('confirm_missing_inventory_stock',{p_source_key:key,p_item:item,p_evidence:evidence});
   if(error)throw Error('재고 원장 등록 미완료: 같은 답변으로 재조회가 필요합니다');return data;
  },
  mirror:mirrorConfirmedStock
 });
}
