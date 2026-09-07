import test from 'node:test';
import assert from 'node:assert/strict';
import { executeConfirmationBatch } from './confirmation-batch.mjs';
import { reconcileConfirmationBatchReceipt } from './confirmation-batch-reconciliation.mjs';

const job = {jobId:'batch-job',roomKey:'batch-room',roomRevision:7};
const coordinates = {job_id:job.jobId,room_key:job.roomKey,room_revision:7};
const children = [1,2,3].map(day=>({should_write_to_sheet:true,sheet_row_candidate:{customer_name:'Synthetic renter',phone:'',start_date:`2026-10-0${day}`,pickup_time:'09:00',end_date:`2026-10-0${day}`,return_time:'18:00',equipment:[{item:'Synthetic camera',quantity:1}]}}));
const buildReceipt = ({status,authoritativeSheetResult=null,availabilityReport=[],error=null})=>({schema:'village-confirmation-receipt/v1',receipt_id:'receipt-aggregate',...coordinates,status,authoritative_sheet_result:authoritativeSheetResult,availability_report:availabilityReport,error,created_at:'2026-09-07T00:00:00.000Z'});
async function batch({count=2,failAt=-1,trades=false}={}) {
  return executeConfirmationBatch({decision:{confirmation_requests:children.slice(0,count)},validateDecision:()=>({valid:true}),preflightDecision:async decision=>({ok:true,decision}),buildReceipt,
    executeDecision:async(_child,index)=> index===failAt
      ? buildReceipt({status:'failed',error:{code:'gas_rejected'}})
      : {...buildReceipt({status:'ok',authoritativeSheetResult:trades?{success:true,alreadyRegistered:true,matchedRegisteredTradeId:`261001-00${index+1}`}:{success:true,reqID:`RQ-261001-00${index+1}`}}),receipt_id:`child-${index}`}
  });
}
test('all periods survive omitted final children, writes disabled and every RQ receives distinct open review',async()=>{
 const receipt=await batch(); const result=reconcileConfirmationBatchReceipt({receipt,decision:{should_write_to_sheet:true},job});
 assert.equal(result.valid,true);assert.equal(result.complete,true);
 assert.equal(result.decision.should_write_to_sheet,false);
 assert.deepEqual(result.decision.confirmation_requests.map(child=>child.should_write_to_sheet),[false,false]);
 assert.deepEqual(result.decision.follow_up_items.map(item=>item.confirmation_batch_result.request_ids[0]),['RQ-261001-001','RQ-261001-002']);
 assert.equal(new Set(result.decision.follow_up_items.map(item=>item.taskKey)).size,2);
 assert.deepEqual(result.decision.follow_up_items.map(item=>item.status),['open','open']);
});
test('partial batch cannot inherit complete final state or replay a successful first period',async()=>{
 const receipt=await batch({count:3,failAt:1});
 const result=reconcileConfirmationBatchReceipt({receipt,job,decision:{post_action_reconciled:true,should_write_to_sheet:true,reply_decision:{replyMode:'auto_send',text:'Everything complete'}}});
 assert.equal(result.complete,false);assert.equal(result.decision.owner_review_required,true);assert.equal(result.decision.post_action_reconciled,false);
 assert.equal(result.decision.reply_decision.replyMode,'no_reply');assert.equal(result.decision.reply_decision.text,'');
 assert.deepEqual(result.decision.confirmation_batch_results.map(row=>row.status),['ok','failed','unattempted']);
 assert.equal(result.decision.confirmation_batch_results[0].request_ids[0],'RQ-261001-001');
 assert.equal(result.decision.confirmation_requests.every(child=>child.should_write_to_sheet===false),true);
 assert.equal(result.decision.follow_up_items.length,3);
});
test('first-only final authority and mismatched child context cannot mark batch reconciled',async()=>{
 const receipt=await batch();
 const result=reconcileConfirmationBatchReceipt({receipt,job,decision:{authoritative_sheet_result:receipt.request_results[0].receipt.authoritative_sheet_result}});
 assert.equal(result.valid,false);assert.equal(result.complete,false);assert.equal(result.decision.owner_review_required,true);
 const wrong=structuredClone(receipt);wrong.request_results[1].receipt.room_revision=8;
 assert.equal(reconcileConfirmationBatchReceipt({receipt:wrong,job}).valid,false);
});
test('already registered groups retain real trade evidence without fictitious RQ reviews',async()=>{
 const receipt=await batch({trades:true});
 const result=reconcileConfirmationBatchReceipt({receipt,job,validateChildReadback:()=>true});
 assert.equal(result.complete,true);assert.equal(result.decision.owner_review_required,false);assert.deepEqual(result.decision.follow_up_items,[]);
 assert.deepEqual(result.decision.confirmation_batch_results.map(group=>group.trade_id),['261001-001','261001-002']);
 assert.deepEqual(result.decision.confirmation_batch_results.map(group=>group.request_ids),[[],[]]);
});
test('failed exact child readback keeps every group visible for review',async()=>{
 const receipt=await batch({trades:true});
 const result=reconcileConfirmationBatchReceipt({receipt,job,validateChildReadback:(_receipt,_decision,index)=>index===0});
 assert.equal(result.valid,false);assert.equal(result.complete,false);assert.equal(result.decision.owner_review_required,true);assert.equal(result.decision.confirmation_batch_results.length,2);
});
test('an ok child lacking any authoritative request or trade target cannot complete the batch',async()=>{
 const receipt=await batch();
 const child=receipt.request_results[1];child.receipt.authoritative_sheet_result={success:true};child.authoritative_sheet_result=child.receipt.authoritative_sheet_result;child.request_ids=[];
 receipt.request_ids=['RQ-261001-001'];receipt.authoritative_sheet_result.request_ids=receipt.request_ids;
 const result=reconcileConfirmationBatchReceipt({receipt,job});
 assert.equal(result.complete,false);assert.equal(result.valid,false);assert.equal(result.decision.owner_review_required,true);
});
