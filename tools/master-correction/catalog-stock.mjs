import {createHash} from 'node:crypto';

// Runs only on demand. Reuses the existing transactional stock-confirmation RPC
// and its source receipt; the sheet is a verified mirror, never the stock origin.
export async function registerCatalogInventory(request,{verify,preview,confirmation,confirm,mirror}) {
 const verified=await verify(request);
 if(verified.kind!=='create'||!Array.isArray(verified.newEquipment)||!verified.newEquipment.length)throw Error('new catalog inventory required');
 const plan=await preview({...verified,mode:'preview'});
 if(plan.success!==true||plan.status!=='preview')throw Error('catalog preview required before stock creation');
 const entries=await Promise.all(verified.newEquipment.map(async e=>{
  const key='catalog:'+verified.correctionId+':'+createHash('sha256').update(e.name).digest('hex').slice(0,16);
  const existing=plan.inventory?.find(x=>x.name===e.name);
  if(!existing||!Array.isArray(existing.matches))throw Error('catalog inventory identity preview required');
  const prior=await confirmation(key);
  if(existing.matches.length&&!(existing.matches.length===1&&existing.matches[0].name===e.name&&existing.matches[0].id===prior?.equipment_id))throw Error('existing sheet inventory identity requires reconciliation before new stock');
  return {e,key};
 }));
 const source=verified.source;
 const evidence={ownerId:source.ownerId,teamId:source.teamId,channel:source.channel,threadTs:source.threadTs,sourceMessageTs:source.ts,questionTs:source.questionTs,quote:source.quote,question:source.contextQuestion.text,catalog:{name:verified.target,price:verified.price,components:verified.components,newEquipment:verified.newEquipment}};
 const results=[];
 try {
  for(const {e,key} of entries){
   const item={name:e.name,major:e.major,category:e.category,stock_total:e.stockTotal,stock_maint:e.stockMaintenance,price:e.name===verified.target?verified.price:null};
   const saved=await confirm(key,item,evidence);
   if(!saved?.ok||!saved.equipmentId)throw Error('stock registration receipt missing');
   const readback=await mirror(saved.equipmentId);
   if(readback?.verified!==true||readback.equipmentId!==saved.equipmentId)throw Error('stock mirror readback missing');
   results.push(readback);
  }
  return {success:true,status:'inventory_verified',correctionId:verified.correctionId,equipment:results};
 }catch(error){
  return {success:false,status:'inventory_saved_catalog_pending',correctionId:verified.correctionId,retrySameSource:true,error:String(error.message||error),equipment:results};
 }
}
