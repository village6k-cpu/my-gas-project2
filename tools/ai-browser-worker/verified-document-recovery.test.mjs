import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {maybeAutoSendReply, autoReplyTextHash} from './worker.mjs';
import {completeVerifiedPricingWork} from './verified-pricing.mjs';

test('one sent quotation cannot resolve another rental or a combined unpriced case',()=>{
  const matching={type:'quote_send',taskKey:'quote-send:RQ-261104-001',requiresHumanAction:true};
  const other={type:'quote_send',businessKey:'261029-006',requiresHumanAction:true};
  const combined={type:'quote_send',businessKey:'quote:customer:20261031:20261102',requiresHumanAction:true};
  const unknownPrice={type:'price_review',taskKey:'price-review:261029-006',requiresHumanAction:true};
  const items=[matching,other,combined,unknownPrice];
  const prepared={decision:{price_quote:{source:'request',id:'RQ-261104-001'},follow_up_items:items},availabilityAwareRows:items};
  const result=completeVerifiedPricingWork(prepared,{verifiedPricing:true,sent:true,readbackReceipt:{},pricingDocumentReceipt:{deliveryConfirmed:true}});
  assert.deepEqual(result.decision.follow_up_items,[other,combined,unknownPrice]);
  assert.deepEqual(result.availabilityAwareRows,[other,combined,unknownPrice]);
});

test('a recovered explicit document request is delivered after current-room and price revalidation', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'quote-recovery-'));
  const now = new Date();
  const config = {autoSendEnabled:false, verifiedPricingAutoSendEnabled:true,
    verifiedPricingEnabledAfter:new Date(now.getTime()-60000).toISOString(),
    autoSendLogPath:path.join(directory,'auto.ndjson'),gasApiUrl:'https://example.invalid',sheetApiKey:'test',
    fetchImpl:async()=>({ok:true,text:async()=>JSON.stringify({data:[['active']]})})};
  const job = {jobId:'recovered-quote',roomKey:'chat:123',roomRevision:8,
    detectedAt:now.toISOString(),events:[{reason:'startup_catchup'}]};
  const snapshot = {schema:'kakao-room-snapshot/v1',jobId:job.jobId,roomKey:job.roomKey,
    roomRevision:job.roomRevision,capturedAt:now.toISOString(),navigation:{conversation_evidence:{
      hint_matched:true,capture_integrity:{ok:true},messages:[{role:'customer',text:'견적서 언제 받을 수 있을까요?'}]}}};
  const decision = {classification:'price',customer:{name:'테스트'},price_quote:{source:'request',id:'RQ-261104-001'},
    follow_up_items:[{type:'quote_send',route:'document'}],safety_checks:{kakao_conversation_opened:true,
      did_not_classify_from_preview_only:true,latest_customer_message_after_last_staff_reply:true},
    reply_decision:{replyMode:'auto_send',confidence:'high',text:'요청하신 견적은 부가세 포함 7,700원입니다.',
      safetyClass:'sensitive_commitment',grounding:'authoritative_sheet',requiresRag:false}};
  const verification = {complete:true,totalVatIncluded:7700,unresolved:[],calculations:[{reqID:'RQ-261104-001',
    discountType:'학생',customerDiscountSource:'request',pricedItems:[{name:'렌즈',qty:1,price:10000}],payment:{days:1}}]};
  let sends=0;
  const dependencies = {revalidatedSnapshot:snapshot,assertFreshBeforeSend:async()=>{},
    buildAuthoritativePriceVerification:async()=>verification,
    sendAutomaticPricingDocument:async()=>{sends++;return{documentType:'quote',status:'sent',deliveryConfirmed:true}},
    sendKakaoMessage:async text=>({sent:true,readback_confirmed:true,observed_reply_hash:autoReplyTextHash(text)})};
  try {
    const result = await maybeAutoSendReply({config,decision,job,dependencies});
    assert.equal(result.sent,true,JSON.stringify(result));
    assert.equal(result.pricingDocumentReceipt.deliveryConfirmed,true);
    assert.equal(sends,1);

    // Each negative case has its own reply log, so a duplicate-text guard cannot
    // mask an unsafe recovery gate. Ordinary recovered answers remain held.
    const cases = [
      {dependencies:{...dependencies,revalidatedSnapshot:null}},
      {dependencies:{...dependencies,assertFreshBeforeSend:null}},
      {dependencies:{...dependencies,revalidatedSnapshot:{...snapshot,roomKey:'chat:other'}}},
      {dependencies:{...dependencies,revalidatedSnapshot:{...snapshot,roomRevision:7}}},
      {dependencies:{...dependencies,revalidatedSnapshot:{...snapshot,jobId:'other-job'}}},
      {dependencies:{...dependencies,revalidatedSnapshot:{...snapshot,capturedAt:new Date(now-120000).toISOString()}}},
      {dependencies:{...dependencies,revalidatedSnapshot:{...snapshot,navigation:{conversation_evidence:{
        hint_matched:true,capture_integrity:{ok:true},messages:[{role:'staff',text:'견적서 전달드립니다.'}]}}}}},
      {decision:{...decision,follow_up_items:[]}},
      {decision:{...decision,price_quote:null}},
      {decision:{...decision,owner_review_required:true}},
      {decision:{...decision,reply_decision:{...decision.reply_decision,alreadyDelivered:true}}},
      {job:{...job,detectedAt:new Date(now-120000).toISOString()}},
      {dependencies:{...dependencies,buildAuthoritativePriceVerification:async()=>({...verification,complete:false})}}
    ];
    for (const [index,change] of cases.entries()) {
      const before=sends;
      const blocked=await maybeAutoSendReply({config:{...config,autoSendLogPath:path.join(directory,`${index}.ndjson`)},
        decision,job,dependencies,...change});
      assert.equal(blocked.sent,false,`negative case ${index}`);
      assert.equal(sends,before,`negative case ${index} must not send a PDF`);
    }
    const recovered=await maybeAutoSendReply({config:{...config,autoSendLogPath:path.join(directory,'replay.ndjson')},
      decision,job:{...job,replayedFromSupabase:true},dependencies});
    assert.equal(recovered.sent,true,JSON.stringify(recovered));
    const before=sends;
    await assert.rejects(maybeAutoSendReply({config:{...config,autoSendLogPath:path.join(directory,'superseded.ndjson')},
      decision,job,dependencies:{...dependencies,assertFreshBeforeSend:async()=>{throw Error('superseded_by_newer_room_event')}}}),/superseded/);
    assert.equal(sends,before,'a newer customer/staff turn must prevent delivery');
  } finally {await fs.rm(directory,{recursive:true,force:true});}
});
