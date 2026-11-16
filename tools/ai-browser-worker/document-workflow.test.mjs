import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {documentWorkflowErrors, verifyDocumentPlan} from './document-workflow.mjs';
import {automaticDocumentPlan, sendAutomaticPricingDocuments, completeVerifiedPricingWork, verifiedPricingIssue,deliverStatementOnce,deliverStatementsOnce} from './verified-pricing.mjs';
import {maybeAutoSendReply, autoReplyTextHash, prepareKakaoGatewayDecision, createImmutableKakaoRoomSnapshot,canExecuteCustomerReply,canAutoSendCustomerAnswer} from './worker.mjs';

const id1='261105-008',id2='261106-003';
const request=(id,type='quote')=>({document_type:type,task_key:`${type}:${id}`,price_quote:{source:'trade',id},...(type==='statement'?{booking_customer_name:'테스트'}:{})});
const verification=id=>({complete:true,totalVatIncluded:id===id1?7700:15400,unresolved:[],calculations:[{
  kind:'contract',tradeId:id,customer:'테스트',phone:1012345678,discountType:'학생',customerDiscountSource:'contract',
  period:'2026-11-13 13:00 ~ 2026-11-14 13:00',pricedItems:[{name:'렌즈',qty:id===id1?1:2,price:10000}],payment:{days:1}}]});
const task=(id,type='quote')=>({type:type==='quote'?'quote_send':'contract_document',route:'document',
  taskKey:`${type}:${id}`,businessKey:id,actionFamily:'document_approval',requiresHumanAction:true,priority:'high',status:'open',
  title:type==='quote'?'테스트 견적서':'테스트 거래명세서',customer_name:'테스트',summary:'고객이 요청한 서류 발송'});
const safety={kakao_conversation_opened:true,did_not_classify_from_preview_only:true,latest_customer_message_after_last_staff_reply:true};
const reply={replyMode:'auto_send',confidence:'high',text:'요청하신 두 일정의 견적은 부가세 포함 총 23,100원입니다.',
  safetyClass:'sensitive_commitment',grounding:'authoritative_sheet',requiresRag:false};
const decision={classification:'price',customer:{name:'테스트'},should_write_to_sheet:false,owner_review_required:false,
  document_requests:[request(id1),request(id2)],follow_up_items:[task(id1),task(id2)],safety_checks:safety,reply_decision:reply};
const pdf=Buffer.from('%PDF-1.7\n'+'.'.repeat(60));
const privatePdf={documentAccess:'private',mimeType:'application/pdf',ownerUrl:'https://docs.google.com/spreadsheets/d/test-statement/edit',
  pdfBase64:pdf.toString('base64'),pdfSha256:createHash('sha256').update(pdf).digest('hex')};
const runtime=async fn=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'document-workflow-'));
  try {
    const now=new Date(),clock=new Intl.DateTimeFormat('ko-KR',{timeZone:'Asia/Seoul',hour:'numeric',minute:'2-digit',hour12:true}).format(now);
    const job={jobId:'customer-document-request',roomKey:'chat:test',roomRevision:4,detectedAt:now.toISOString(),
      previewText:`테스트 1 견적서 보내주세요 ${clock}`,unreadCount:1,events:[{reason:'top_row_changed',unreadCount:1,detectedAt:now.toISOString()}]};
    const config={autoSendEnabled:false,verifiedPricingAutoSendEnabled:true,verifiedPricingEnabledAfter:new Date(now-60000).toISOString(),
      autoSendLogPath:path.join(directory,'auto.ndjson'),documentApiBaseUrl:'https://document.invalid',documentApiKey:'test',
      privateStatementDirectory:directory,gasApiUrl:'https://gas.invalid',sheetApiKey:'test',
      fetchImpl:async()=>({ok:true,text:async()=>JSON.stringify({data:[['active']]})})};
    await fn({directory,job,config});
  } finally {await fs.rm(directory,{recursive:true,force:true});}
};
test('an incomplete customer document request asks one question with the general reply hold retained',()=>runtime(async({config,job})=>{
  const current={...decision,classification:'document_request',document_requests:null,
    document_clarification:{document_type:'quote',missing_fields:['rental_period'],customer_message_ids:['dom-4']},
    reply_decision:{...reply,text:'어느 날짜 대여 건의 견적서가 필요하신가요?',safetyClass:'contact_request',grounding:'visible_conversation'}};
  let questions=0,documents=0;
  const dependencies={assertFreshBeforeSend:async()=>{},sendKakaoMessage:async text=>{
    questions++;return {sent:true,readback_confirmed:true,observed_reply_hash:autoReplyTextHash(text)};
  },sendAutomaticPricingDocuments:async()=>{documents++;throw Error('no document before clarification');}};
  const result=await maybeAutoSendReply({config,decision:current,job,dependencies});
  assert.equal(result.sent,true,JSON.stringify(result));assert.equal(questions,1);assert.equal(documents,0);
  assert.equal(completeVerifiedPricingWork({decision:current},result).decision.follow_up_items.length,2,'asking is not document completion');
  const again=await maybeAutoSendReply({config,decision:current,job,dependencies});
  assert.equal(again.sent,false);assert.equal(questions,1,'do not repeat an unanswered question');
  const paused={...config,autoSendLogPath:path.join(path.dirname(config.autoSendLogPath),'paused.ndjson'),
    fetchImpl:async()=>({ok:true,text:async()=>JSON.stringify({data:[['paused']]})})};
  assert.equal((await maybeAutoSendReply({config:paused,decision:current,job,dependencies})).gate.reason,'kill_switch_paused');
}));
test('clarification cannot invent a source, ask for shop prices or contradict a known staff sender',()=>{
  const current={document_clarification:{document_type:'quote',missing_fields:['phone'],customer_message_ids:['dom-1']}};
  const snapshot=role=>({navigation:{conversation_evidence:{messages:[{message_id:'dom-1',role,text:'견적서 주세요'}]}}});
  assert.deepEqual(documentWorkflowErrors(current,{roomSnapshot:snapshot('customer')}),[]);
  assert.deepEqual(documentWorkflowErrors(current,{roomSnapshot:snapshot('unknown')}),[]);
  assert.ok(documentWorkflowErrors(current,{roomSnapshot:snapshot('staff')}).length);
  assert.ok(documentWorkflowErrors(current,{roomSnapshot:{}}).length);
  assert.ok(documentWorkflowErrors({document_clarification:{...current.document_clarification,missing_fields:['daily_price']}}).length);
  assert.ok(documentWorkflowErrors({...current,document_requests:[request(id1)]}).length);
  assert.deepEqual(documentWorkflowErrors({document_clarification:{...current.document_clarification,missing_fields:['discount_type']}},{roomSnapshot:snapshot('customer')}),[]);
});
test('a batch reply can give every verified period separately and rejects partial or invented totals',async()=>{
  const checked=await verifyDocumentPlan(decision,async quote=>verification(quote.id));
  const gate=text=>canAutoSendCustomerAnswer({...decision,reply_decision:{...reply,text}},
    {verifiedPricingAutoSendEnabled:true},{priceVerification:checked});
  assert.equal(gate('13일 건은 부가세 포함 7,700원, 15일 건은 부가세 포함 15,400원입니다.').allowed,true);
  assert.equal(gate('두 건 합계는 부가세 포함 23,100원입니다.').allowed,true);
  assert.equal(gate('13일 건은 부가세 포함 7,700원입니다.').allowed,false);
  assert.equal(gate('13일 건은 부가세 포함 7,700원, 15일 건은 15,300원입니다.').allowed,false);
  assert.equal(gate('합계는 23,100원이며 15일 건은 15,300원입니다.').allowed,false);
  assert.equal(gate('첫 일정은 7,700원, 둘째 일정은 15,400원이며 최종 결제금액은 0원입니다.').allowed,false);
  assert.equal(gate('합계는 23,100원이며 추가 할인은 -7,700원입니다.').allowed,false);
  assert.equal(gate('합계는 23,100원이며 별도 정산액은 7,700.5원입니다.').allowed,false);
});
test('native gateway accepts automatic document execution and evidence-bound questions without a prior send receipt',()=>runtime(async({config,job})=>{
  const snapshot=createImmutableKakaoRoomSnapshot({job,navigationContext:{status:'opened_target_chat',
    conversation_evidence:{title:'테스트',hint_matched:true,messages:[{message_id:'dom-4',role:'customer',text:'두 날짜 견적서 부탁드립니다.'}]}}});
  const turn={event:{schema:'village-kakao-gateway-event/v1',job_id:job.jobId,room_key:job.roomKey,room_revision:job.roomRevision},internal:{snapshot}};
  for(const current of [decision,{...decision,classification:'reservation'}, {...decision,classification:'document_request',document_requests:null,
    document_clarification:{document_type:'quote',missing_fields:['rental_period'],customer_message_ids:['dom-4']},
    reply_decision:{...reply,text:'어느 날짜 대여 건의 견적서가 필요하신가요?',safetyClass:'contact_request',grounding:'visible_conversation'}}]){
    const prepared=await prepareKakaoGatewayDecision({config,job,turn,finalText:JSON.stringify(current)});
    assert.deepEqual(prepared.gatewaySafetyFailures,[]);
    assert.equal(prepared.decision.owner_review_required,false);
    assert.equal(prepared.decision.reply_decision.replyMode,'auto_send');
  }
  assert.equal(canExecuteCustomerReply({...decision,classification:'reservation'},{status:'price_paused'}).allowed,false);
  const extra={...task('261110-099'),type:'price_review',taskKey:'price:261110-099',route:'settlement'};
  const current={...decision,follow_up_items:[...decision.follow_up_items,extra]};
  const prepared=await prepareKakaoGatewayDecision({config,job,turn,finalText:JSON.stringify(current)});
  const result={verifiedPricing:true,sent:true,readbackReceipt:{},pricingDocumentReceipts:current.document_requests.map(request=>({
    documentType:request.document_type,pricingSource:request.price_quote,deliveryConfirmed:true}))};
  const completed=completeVerifiedPricingWork(prepared,result);
  assert.deepEqual(completed.decision.follow_up_items,[extra]);
  assert.equal(completed.availabilityAwareRows.length,1,'real projected completed document rows are removed');
  assert.equal(completed.availabilityAwareRows[0].payload.taskKey,extra.taskKey);
}));
test('every requested period is verified, while quote plus statement for the same trade does not double its total',async()=>{
  const current={...decision,document_requests:[request(id1),request(id1,'statement'),request(id2)],follow_up_items:[task(id1),task(id1,'statement'),task(id2)]};
  const reads=[];const checked=await verifyDocumentPlan(current,async quote=>{reads.push(quote.id);return verification(quote.id);});
  assert.deepEqual(reads,[id1,id2]);assert.equal(checked.documents.length,3);assert.equal(checked.totalVatIncluded,23100);
  assert.equal(verifiedPricingIssue(checked,current.document_requests),null);
  const changed=structuredClone(checked);changed.documents[1].request.price_quote.id=id2;
  assert.equal(verifiedPricingIssue(changed,current.document_requests),'document_verification_mismatch');
});
test('all document recipients, complete prices and duplicates are checked before the first send',async()=>{
  const checked=await verifyDocumentPlan(decision,async quote=>verification(quote.id));
  const valid={config:{},decision,verification:checked,job:{jobId:'audit',roomKey:'room',roomRevision:1}};
  assert.equal(automaticDocumentPlan(valid).length,2);
  const bad=structuredClone(checked);bad.documents[1].verification.calculations[0].customer='다른 고객';
  let calls=0;
  await assert.rejects(sendAutomaticPricingDocuments({...valid,config:{documentApiBaseUrl:'https://invalid',documentApiKey:'test'},verification:bad,
    fetchImpl:async()=>{calls++;throw Error('must never send');}}),/quote_customer_mismatch/);
  assert.equal(calls,0);
  const incomplete=structuredClone(checked);incomplete.documents[1].verification.complete=false;
  assert.throws(()=>automaticDocumentPlan({...valid,verification:incomplete}),/price_incomplete/);
  assert.ok(documentWorkflowErrors({...decision,document_requests:[request(id1),request(id1)]}).length);
  assert.ok(documentWorkflowErrors({...decision,document_requests:[request(id1),{...request(id2),task_key:request(id1).task_key}]}).length);
});
test('a customer reply identifying two periods proceeds to independently verified document delivery without owner approval',()=>runtime(async({config,job})=>{
  const checked=await verifyDocumentPlan(decision,async quote=>verification(quote.id));
  const operations=[];let answers=0;
  const docFetch=async(_url,options)=>{
    const body=JSON.parse(options.body);operations.push(body);
    return {ok:true,json:async()=>({status:'OK',operationId:body.operationId,deliveryConfirmed:true,
      totalVatIncluded:body.expectedTotal,pdfUrl:'https://drive.google.com/file/d/quote-test/view'})};
  };
  const result=await maybeAutoSendReply({config,decision,job,dependencies:{
    buildAuthoritativePriceVerification:async()=>checked,assertFreshBeforeSend:async()=>{},
    sendAutomaticPricingDocuments:options=>sendAutomaticPricingDocuments({...options,fetchImpl:docFetch}),
    sendKakaoMessage:async text=>{answers++;return {sent:true,readback_confirmed:true,observed_reply_hash:autoReplyTextHash(text)};}}});
  assert.equal(result.sent,true,JSON.stringify(result));assert.equal(operations.length,2);assert.equal(answers,1);
  assert.equal(new Set(operations.map(item=>item.operationId)).size,2);
  assert.deepEqual(result.pricingDocumentReceipts.map(item=>item.tradeId),[id1,id2]);
  const prepared={decision,availabilityAwareRows:decision.follow_up_items};
  assert.equal(completeVerifiedPricingWork(prepared,result).decision.follow_up_items.length,0);
}));
test('quote and private statement are different documents and statement completion requires a new file-card readback',()=>runtime(async({config,job,directory})=>{
  const current={...decision,document_requests:[request(id1),request(id1,'statement')],follow_up_items:[task(id1),task(id1,'statement')],
    reply_decision:{...reply,text:'요청하신 견적서와 거래명세서 기준 금액은 부가세 포함 7,700원입니다.'}};
  const checked=await verifyDocumentPlan(current,async quote=>verification(quote.id));
  const docFetch=async(_url,options)=>{
    const body=JSON.parse(options.body);return {ok:true,json:async()=>body.action==='prepareAutomaticStatement'
      ? {status:'PREPARED',operationId:body.operationId,documentType:'statement',tradeID:id1,totalVatIncluded:7700,...privatePdf}
      : {status:'OK',operationId:body.operationId,deliveryConfirmed:true,totalVatIncluded:7700,pdfUrl:'https://drive.google.com/file/d/quote-test/view'}};
  };
  const dependencies={buildAuthoritativePriceVerification:async()=>checked,assertFreshBeforeSend:async()=>{},
    sendAutomaticPricingDocuments:options=>sendAutomaticPricingDocuments({...options,fetchImpl:docFetch}),
    sendKakaoMessage:async(text,_context,options)=>{
      assert.equal(options.attachmentPaths.length,1);assert.match(options.attachmentPaths[0],/거래명세서.pdf$/);
      return {sent:true,readback_confirmed:true,observed_reply_hash:autoReplyTextHash(text),attachments:{attached:true,readbackConfirmed:true}};
    }};
  const result=await maybeAutoSendReply({config,decision:current,job,dependencies});
  assert.equal(result.pricingDocumentReceipts[1].deliveryConfirmed,true);
  assert.equal(completeVerifiedPricingWork({decision:current},result).decision.follow_up_items.length,0);
  const unverified=await maybeAutoSendReply({config:{...config,autoSendLogPath:path.join(directory,'unknown.ndjson')},decision:current,job:{...job,jobId:'other-request'},
    dependencies:{...dependencies,sendKakaoMessage:async text=>({sent:true,readback_confirmed:true,observed_reply_hash:autoReplyTextHash(text),attachments:{attached:true,readbackConfirmed:false}})}});
  assert.equal(unverified.pricingDocumentReceipts[1].deliveryConfirmed,false);
  assert.deepEqual(completeVerifiedPricingWork({decision:current},unverified).decision.follow_up_items,[task(id1,'statement')]);
}));
test('a failed later document preserves the successful earlier receipt and closes only that exact work',async()=>{
  const checked=await verifyDocumentPlan(decision,async quote=>verification(quote.id));
  let calls=0;
  try {
    await sendAutomaticPricingDocuments({config:{documentApiBaseUrl:'https://invalid',documentApiKey:'test'},decision,verification:checked,job:{jobId:'job'},
      fetchImpl:async(_url,options)=>{
        const body=JSON.parse(options.body);calls++;
        return {ok:true,json:async()=>calls===1?{status:'OK',operationId:body.operationId,deliveryConfirmed:true,totalVatIncluded:7700,pdfUrl:'https://drive.google.com/file/d/quote-test/view'}:{status:'ERROR'}};
      }});
    assert.fail('second document must remain incomplete');
  } catch(error) {
    assert.equal(calls,2);assert.equal(error.pricingDocumentReceipts.length,1);assert.ok(error.operationId);
    const result={verifiedPricing:true,pricingDocumentReceipts:error.pricingDocumentReceipts};
    assert.deepEqual(completeVerifiedPricingWork({decision},result).decision.follow_up_items,[task(id2)]);
  }
});
test('uncertain statement delivery cannot be replayed by reordering, overlapping, subsetting or changing protocol',()=>runtime(async({config})=>{
  const receipts=['a','b','c'].map(char=>({operationId:char.repeat(64),pdfSha256:char.repeat(64)}));
  let sends=0;const send=async()=>{sends++;throw Error('transport response lost after delivery');};
  await assert.rejects(deliverStatementsOnce({config,receipts:receipts.slice(0,2),replyText:'거래명세서 전달드립니다.',send}),/response lost/);
  for(const selection of [[receipts[1],receipts[0]],[receipts[0]],[receipts[1],receipts[2]]]){
    assert.equal((await deliverStatementsOnce({config,receipts:selection,replyText:'거래명세서 전달드립니다.',send})).sent,false);
  }
  assert.equal((await deliverStatementOnce({config,receipt:receipts[0],replyText:'거래명세서 전달드립니다.',send})).sent,false);
  assert.equal(sends,1);
}));
test('concurrent overlapping statement batches have only one transport effect',()=>runtime(async({config})=>{
  const receipts=['d','e'].map(char=>({operationId:char.repeat(64),pdfSha256:char.repeat(64)}));
  let sends=0;const replyText='두 건 거래명세서 전달드립니다.';
  const send=async()=>{sends++;await new Promise(resolve=>setTimeout(resolve,5));return {sent:true,readback_confirmed:true,
    observed_reply_hash:autoReplyTextHash(replyText),attachments:{attached:true,readbackConfirmed:true}};};
  const results=await Promise.all(Array.from({length:40},(_,i)=>deliverStatementsOnce({config,
    receipts:i%2?[...receipts].reverse():receipts,replyText,send})));
  assert.equal(sends,1);assert.equal(results.filter(item=>item.sent).length,1);
  assert.equal((await deliverStatementsOnce({config,receipts:[...receipts].reverse(),replyText,send})).documentDeliveryReplayed,true);
  assert.equal(sends,1);
}));
