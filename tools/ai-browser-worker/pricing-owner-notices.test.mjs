import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {pricingOwnerNotice,queuePricingOwnerNotice,flushPricingOwnerNotices} from './pricing-owner-notices.mjs';

const config={verifiedPricingAutoSendEnabled:true,verifiedPricingEnabledAfter:'2026-11-02T00:00:00Z',pricingOwnerSlackUserId:'UOWNER'};
const job={jobId:'new-price',detectedAt:'2026-11-02T01:00:00Z'};
const finalized={decision:{customer:{name:'검증 고객'},classification:'price'},autoReplyResult:{verifiedPricing:true,sent:true,readbackReceipt:{id:'proof'},text:'학생 할인 7,700원입니다.',priceVerification:{complete:true,totalVatIncluded:7700,unresolved:[],calculations:[{discountType:'학생',customerDiscountSource:'conversation',payment:{days:1},pricedItems:[{name:'렌즈',qty:1,price:10000}]}]}}};
test('owner notice reports verified amount and discount without creating approval work or exposing recipient phone',()=>{
 const notice=pricingOwnerNotice(config,job,finalized);
 assert.equal(notice.channel,'UOWNER');assert.match(notice.text,/7,700원/);assert.match(notice.text,/학생/);assert.match(notice.text,/전송 확인/);
 assert.equal(notice.key,pricingOwnerNotice(config,job,finalized).key);
 assert.equal(pricingOwnerNotice(config,{...job,detectedAt:'2026-11-01T00:00:00Z'},finalized),null);
 assert.equal(pricingOwnerNotice({...config,verifiedPricingAutoSendEnabled:false},job,finalized),null);
 const statement=pricingOwnerNotice(config,job,{...finalized,autoReplyResult:{...finalized.autoReplyResult,pricingDocumentReceipt:{documentType:'statement',deliveryConfirmed:true,tradeId:'261024-007',pdfUrl:'https://drive.google.com/file/d/statement-test/view'}}});
 assert.match(statement.text,/거래명세서: 발송 확인/);assert.match(statement.text,/261024-007/);
 const uncertain=pricingOwnerNotice(config,job,{...finalized,decision:{...finalized.decision,owner_review_required:true},autoReplyResult:{sent:false,gate:{reason:'discount_unconfirmed'}}});
 assert.match(uncertain.text,/확인 필요/);assert.match(uncertain.text,/discount_unconfirmed/);assert.doesNotMatch(uncertain.text,/7,700/);
});
test('already answered statements and customer thanks do not create owner review notifications',()=>{
 for(const classification of ['ignore','already_answered','price']){
  assert.equal(pricingOwnerNotice(config,job,{decision:{classification,customer:{name:'검증 고객'},statement_request:{trade_id:'261024-007'},follow_up_items:[],owner_review_required:false},autoReplyResult:{attempted:false,sent:false,gate:{reason:'replyMode_no_reply'}}}),null);
 }
});
test('persisted owner notifications survive Slack failure and retry without resending completed notices',async()=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'pricing-notice-'));
 try{
 const notice=pricingOwnerNotice(config,job,finalized);await queuePricingOwnerNotice(directory,notice);await queuePricingOwnerNotice(directory,notice);
 assert.equal((await fs.readdir(directory)).length,1);
 let calls=0;
 const failed=await flushPricingOwnerNotices(directory,{token:'test',now:1,fetchImpl:async()=>{calls++;throw Error('offline')}});assert.equal(failed.pending,1);
 const fetchImpl=async(_url,request)=>{calls++;const body=JSON.parse(request.body);assert.equal(body.channel,'UOWNER');assert.equal(body.client_msg_id,notice.clientMsgId);return{ok:true,json:async()=>({ok:true,ts:'1.2'})}};
 assert.equal((await flushPricingOwnerNotices(directory,{token:'test',now:2,fetchImpl})).sent,0);
 assert.equal((await flushPricingOwnerNotices(directory,{token:'test',now:3600001,fetchImpl})).sent,1);
 assert.equal((await flushPricingOwnerNotices(directory,{token:'test',now:7200001,fetchImpl})).sent,0);assert.equal(calls,2);
 }finally{await fs.rm(directory,{recursive:true,force:true})}
});

test('fresh malformed decisions produce an actionable notice without replaying old inquiries', async () => {
 const {liveReplyFailureNotice} = await import('./pricing-owner-notices.mjs');
 const now=Date.parse('2026-11-10T10:40:00Z');
 const config={pricingOwnerSlackUserId:'UOWNER',recoveryLiveAutoSendEnabled:true,recoveryFreezeBefore:'2026-11-06T00:00:00Z'};
 const job={job_id:'real-job',event:{detected_at:'2026-11-10T10:20:00Z'},
   local_context:{job:{customerName:'검증',events:[{reason:'top_row_changed'}]}},
   application:{state:'failed',application_id:'apply',failure_notification:{state:'pending'},
     error:{message:'gateway_invalid_model_result: no valid final decision was produced'}}};
 assert.equal(liveReplyFailureNotice(config,job,now)?.kind,'decision_failure');
 assert.equal(liveReplyFailureNotice(config,{...job,event:{detected_at:'2026-11-10T05:20:00Z'}},now),null);
});
