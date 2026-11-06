import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {pricingOwnerNotice,queuePricingOwnerNotice,flushPricingOwnerNotices} from './pricing-owner-notices.mjs';

const config={verifiedPricingAutoSendEnabled:true,verifiedPricingEnabledAfter:'2026-11-02T00:00:00Z',pricingOwnerSlackUserId:'UOWNER'};
const job={jobId:'new-price',detectedAt:'2026-11-02T01:00:00Z'};
const finalized={decision:{customer:{name:'검증 고객'},classification:'price'},autoReplyResult:{verifiedPricing:true,sent:true,readbackReceipt:{id:'proof'},text:'학생 할인 7,700원입니다.',priceVerification:{complete:true,totalVatIncluded:7700,unresolved:[],calculations:[{discountType:'학생',customerDiscountSource:'conversation',payment:{days:1},pricedItems:[{name:'렌즈',qty:1,price:10000}]}]}}};
test('successful prices and documents stay silent; partial failures still request owner action',()=>{
 const notice=pricingOwnerNotice(config,job,finalized);
 assert.equal(notice,null);
 assert.equal(pricingOwnerNotice(config,{...job,detectedAt:'2026-11-01T00:00:00Z'},finalized),null);
 assert.equal(pricingOwnerNotice({...config,verifiedPricingAutoSendEnabled:false},job,finalized),null);
 const statement=pricingOwnerNotice(config,job,{...finalized,autoReplyResult:{...finalized.autoReplyResult,pricingDocumentReceipt:{documentType:'statement',deliveryConfirmed:true,tradeId:'261024-007',pdfUrl:'https://drive.google.com/file/d/statement-test/view'}}});
 assert.equal(statement,null);
 const uncertain=pricingOwnerNotice(config,job,{...finalized,decision:{...finalized.decision,owner_review_required:true},autoReplyResult:{sent:false,gate:{reason:'discount_unconfirmed'}}});
 assert.match(uncertain.text,/확인 필요/);assert.match(uncertain.text,/discount_unconfirmed/);assert.doesNotMatch(uncertain.text,/7,700/);
 const partial=pricingOwnerNotice(config,job,{...finalized,autoReplyResult:{...finalized.autoReplyResult,pricingDocumentFailure:{reason:'document_delivery_failed'}}});
 assert.equal(partial.requiresHumanAction,true);assert.match(partial.text,/document_delivery_failed/);
 assert.match(partial.text,/7,700원/);assert.match(partial.text,/학생/);
 const unconfirmed=pricingOwnerNotice(config,job,{...finalized,autoReplyResult:{...finalized.autoReplyResult,readbackReceipt:null}});
 assert.equal(unconfirmed.requiresHumanAction,true);
 const stalePriceTrace=pricingOwnerNotice(config,job,{decision:{classification:'price',owner_review_required:false,follow_up_items:[]},autoReplyResult:{sent:false,priceVerification:{complete:true},gate:{reason:'replyMode_no_reply'}}});
 assert.equal(stalePriceTrace,null);
 const priceBlocked=pricingOwnerNotice(config,job,{...finalized,autoReplyResult:{sent:false,gate:{allowed:false,reason:'authoritative_price_verification_incomplete'},priceVerification:{complete:false,unresolved:['unknown item']}}});
 assert.equal(priceBlocked.requiresHumanAction,true);assert.match(priceBlocked.text,/authoritative_price_verification_incomplete/);
 const sendFailed=pricingOwnerNotice(config,job,{...finalized,autoReplyResult:{attempted:true,sent:false,gate:{allowed:true,reason:'verified_price'},priceVerification:finalized.autoReplyResult.priceVerification}});
 assert.equal(sendFailed.requiresHumanAction,true);
});
test('already answered statements and customer thanks do not create owner review notifications',()=>{
 for(const classification of ['ignore','already_answered','price']){
  assert.equal(pricingOwnerNotice(config,job,{decision:{classification,customer:{name:'검증 고객'},statement_request:{trade_id:'261024-007'},follow_up_items:[],owner_review_required:false},autoReplyResult:{attempted:false,sent:false,gate:{reason:'replyMode_no_reply'}}}),null);
 }
});
test('persisted owner notifications survive Slack failure and retry without resending completed notices',async()=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'pricing-notice-'));
 try{
 const notice=pricingOwnerNotice(config,job,{...finalized,decision:{...finalized.decision,owner_review_required:true},autoReplyResult:{sent:false,gate:{reason:'discount_unconfirmed'}}});await queuePricingOwnerNotice(directory,notice);await queuePricingOwnerNotice(directory,notice);
 assert.equal((await fs.readdir(directory)).length,1);
 let calls=0;
 const failed=await flushPricingOwnerNotices(directory,{token:'test',now:1,fetchImpl:async()=>{calls++;throw Error('offline')}});assert.equal(failed.pending,1);
 const fetchImpl=async(_url,request)=>{calls++;const body=JSON.parse(request.body);assert.equal(body.channel,'UOWNER');assert.equal(body.client_msg_id,notice.clientMsgId);return{ok:true,json:async()=>({ok:true,ts:'1.2'})}};
 assert.equal((await flushPricingOwnerNotices(directory,{token:'test',now:2,fetchImpl})).sent,0);
 assert.equal((await flushPricingOwnerNotices(directory,{token:'test',now:3600001,fetchImpl})).sent,1);
 assert.equal((await flushPricingOwnerNotices(directory,{token:'test',now:7200001,fetchImpl})).sent,0);assert.equal(calls,2);
 }finally{await fs.rm(directory,{recursive:true,force:true})}
});

test('a queued legacy success is suppressed without losing its stored audit',async()=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'pricing-legacy-'));
 try{
  const notice={schema:'village-pricing-owner-notice/v1',key:'a'.repeat(64),channel:'UOWNER',state:'pending',text:'자동 가격·서류 처리 알림\n견적서: 발송 확인'};
  await queuePricingOwnerNotice(directory,notice);
  const result=await flushPricingOwnerNotices(directory,{token:'test',fetchImpl:()=>{throw Error('must not call Slack')}});
  assert.equal(result.sent,0);assert.equal(result.pending,0);
  const stored=JSON.parse(await fs.readFile(path.join(directory,notice.key+'.json'),'utf8'));
  assert.equal(stored.state,'suppressed');assert.equal(stored.text,notice.text);
 }finally{await fs.rm(directory,{recursive:true,force:true})}
});
