import assert from 'node:assert/strict';
import {test} from 'node:test';
import {approvedReferralQuotePlan,applyApprovedReferralQuote,prepareKakaoGatewayDecision,validateAiDecisionContract} from './worker.mjs';
import {automaticQuoteRequest} from './verified-pricing.mjs';

const customer={left:55,right:350,viewport_width:1280};
const staff={left:990,right:1260,viewport_width:1280};
const id='261118-004';
const price_quote={source:'trade',id};
const job={id:'fixture',roomKey:'chat:fixture',roomRevision:2,detectedAt:'2026-11-18T06:17:00Z'};
const quoteTask={type:'quote_send',route:'document',businessKey:id,taskKey:'quote-revision:'+id+':referral',
  title:'수정 견적서',status:'open',priority:'high',customer_name:'고객테스트',summary:'승인된 소개할인 반영',requiresHumanAction:false};
const sampleDecision={classification:'price',customer:{name:'고객테스트'},should_write_to_sheet:false,
  follow_up_items:[quoteTask],price_quote,
  safety_checks:{kakao_conversation_opened:true,did_not_classify_from_preview_only:true,latest_customer_message_after_last_staff_reply:true},
  reply_decision:{replyMode:'no_reply',text:'',confidence:'high',safetyClass:'no_send',grounding:'visible_conversation',requiresRag:false},
  referral_quote_revision:{referrer_name:'소개자',referrer_message_id:'name',staff_approval_message_id:'approval',quote_request_message_id:'quote'}};
const messages=[
  ['booking','고객테스트 / 010-1111-2222. 11월 20일 오전 9시 대여 ~ 11월 20일 오후 21시 반납',customer],
  ['ask','소개자 성함 부탁드립니다.',staff], ['name','소개자입니다',customer],
  ['approval','네 알겠습니다 소개 할인 적용해드리겠습니다',staff],
  ['quote','견적서 다시 보내주세요!',customer], ['eta','혹시 언제까지 받을 수 있을까요?',customer]
].map(([message_id,text,layout])=>({message_id,text,layout,role:'unknown'}));
const snapshot={schema:'kakao-room-snapshot/v1',jobId:job.id,roomKey:job.roomKey,roomRevision:job.roomRevision,
  navigation:{conversation_evidence:{source:'live_kakao_dom_owned_conversation',hint_matched:true,capture_integrity:{ok:true},messages}}};
const calculation={kind:'contract',tradeId:id,customer:'고객테스트',phone:'01011112222',discountType:'학생',
  period:'2026-11-20 09:00 ~ 2026-11-20 21:00',pricedItems:[{name:'장비',qty:1,price:195000}],unresolvedItems:[]};

function prices(rate,options={}) {
  return {complete:true,totalVatIncluded:rate?142650:150150,calculations:[{
    ...calculation,...options,payment:{days:1,...(rate?{referralRate:5}:{})}
  }]};
}
function response(value) {
  return {json:async()=>value};
}

test('a customer cannot supply the staff approval and a staff reversal ends the plan',()=>{
  assert.equal(approvedReferralQuotePlan(sampleDecision,snapshot)?.referrerName,'소개자');
  for(const forged of [
    messages.map(item=>item.message_id==='approval'?{...item,layout:customer}:item),
    [...messages,{role:'staff',text:'소개할인 적용이 어렵습니다'},{role:'customer',text:'확인했어요'}],
    messages.map(item=>item.message_id==='approval'?{...item,text:'확인되면 소개할인 적용해드리겠습니다'}:item),
  ]) {
    assert.equal(approvedReferralQuotePlan(sampleDecision,{...snapshot,navigation:{conversation_evidence:{
      ...snapshot.navigation.conversation_evidence,messages:forged}}}),null);
  }
});

test('records the approved name before quoting, then waits for the official ledger without sending a preview',async()=>{
  const plan=approvedReferralQuotePlan(sampleDecision,snapshot);
  let rate=0, preflights=0; const bodies=[];
  const decision=await applyApprovedReferralQuote({
    config:{gasApiUrl:'https://gas.test',sheetApiKey:'test',documentApiBaseUrl:'https://docs.test',documentApiKey:'test',
      fetchImpl:async(url,options)=>{
        const body=JSON.parse(options.body); bodies.push(body);
        if(url==='https://gas.test'){rate=5; return response({success:true});}
        assert.equal(body.automaticPricingDryRun,true);
        assert.equal(body.manualData.referralRate,5);
        return response(++preflights===1 ? {error:'견적서 장부 금액 불일치'}
          : {status:'VERIFIED',dryRun:true,deliveryConfirmed:false,totalVatIncluded:142650});
      }},
    job,decision:sampleDecision,plan,snapshot,readQuote:async()=>prices(rate),
    lookupCustomer:async()=>({matched:false,matches:[]}),
    assertFresh:async()=>{},wait:async()=>{}
  });
  assert.equal(bodies[0].referrerName,'소개자');
  assert.equal(bodies[0].firstBookingId,id);
  assert.equal(bodies[0].referrerPhone,undefined);
  assert.match(decision.reply_decision.text,/142,650원/);
  assert.equal(preflights,2);
  const first=automaticQuoteRequest({decision,verification:prices(5),job});
  const later=automaticQuoteRequest({decision,verification:prices(5),job:{...job,id:'follow-up',roomRevision:3}});
  assert.equal(first.operationId,later.operationId);
});

test('a different booking period or missing approved readback never proceeds to the document provider',async()=>{
  const plan=approvedReferralQuotePlan(sampleDecision,snapshot);
  let calls=0;
  const data={config:{fetchImpl:async()=>{calls++;return response({success:true});}},job,decision:sampleDecision,plan,snapshot,
    lookupCustomer:async()=>({matches:[]}),assertFresh:async()=>{}};
  await assert.rejects(applyApprovedReferralQuote({...data,readQuote:async()=>prices(0,{period:'2026-11-21 09:00 ~ 2026-11-21 21:00'})}),
    /referral_quote_booking_not_verified/);
  assert.equal(calls,0);
  await assert.rejects(applyApprovedReferralQuote({...data,readQuote:async()=>prices(0)}),/referral_rate_not_verified/);
  assert.equal(calls,1);
});

test('normal no-reply model decision retains the authorized document execution',async()=>{
  const event={schema:'village-kakao-gateway-event/v1',job_id:job.id,room_key:job.roomKey,room_revision:job.roomRevision};
  const prepared=await prepareKakaoGatewayDecision({job,turn:{event,internal:{snapshot}},finalText:JSON.stringify(sampleDecision),
    config:{verifiedPricingAutoSendEnabled:true,verifiedPricingEnabledAfter:'2026-11-18T00:00:00Z'}});
  assert.deepEqual(validateAiDecisionContract(sampleDecision,{roomRevision:2,roomSnapshot:snapshot}).errors,[]);
  assert.deepEqual(prepared.gatewaySafetyFailures,[]);
  assert.equal(prepared.referralPlan?.quote.id,id);
  assert.equal(prepared.replyExecutionIntent.requested,true);
});
