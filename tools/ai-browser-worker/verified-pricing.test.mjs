import test from 'node:test';import assert from 'node:assert/strict';import {createHash} from 'node:crypto';
const privatePdf=Buffer.from('%PDF-1.7\n'+'.'.repeat(60));
const privateAttachment={documentAccess:'private',mimeType:'application/pdf',ownerUrl:'https://docs.google.com/spreadsheets/d/statement-test/edit',pdfBase64:privatePdf.toString('base64'),pdfSha256:createHash('sha256').update(privatePdf).digest('hex')};
import {automaticQuoteRequest,automaticStatementRequest,verifiedPricingIssue,verifiedPricingFreshJob,sendAutomaticPricingDocument,verifiedPricingConfigured,completeVerifiedPricingWork} from './verified-pricing.mjs';
const quote={source:'catalog',customer_name:'테스트',phone:'01012345678',discount_type:'학생',start_date:'2026-11-03',start_time:'10:00',end_date:'2026-11-04',end_time:'10:00',items:[{name:'렌즈',quantity:1}]};
const decision={customer:{name:'테스트'},price_quote:quote,reply_decision:{safetyClass:'sensitive_commitment',grounding:'authoritative_sheet',requiresRag:false}};
const verification={complete:true,totalVatIncluded:7700,unresolved:[],calculations:[{discountType:'학생',customerDiscountSource:'conversation',pricedItems:[{name:'렌즈',price:10000,qty:1}],payment:{days:1}}]};
const job={jobId:'event-one',roomKey:'room-one',roomRevision:2};
const statementDecision={...decision,price_quote:{source:'trade',id:'261024-007'},statement_request:{trade_id:'261024-007',booking_customer_name:'테스트'}};
const statementVerification={...verification,calculations:[{...verification.calculations[0],tradeId:'261024-007',customer:'테스트',phone:'01012345678',period:'2026-11-03 10:00 ~ 2026-11-04 10:00'}]};
test('statements use the exact registered trade and reject an unauthorized delegate',()=>{
 const request=automaticStatementRequest({decision:statementDecision,verification:statementVerification,job});assert.equal(request.action,'prepareAutomaticStatement');assert.equal(request.expectedTotal,7700);
 const delegated={...statementDecision,customer:{name:'대리 요청자'}};
 assert.throws(()=>automaticStatementRequest({decision:delegated,verification:statementVerification,job}),/recipient_authorization/);
 const config={statementRecipientAuthorizations:[{tradeId:'261024-007',roomKey:'room-one',requesterName:'대리 요청자',bookingCustomerName:'테스트'}]};
 assert.equal(automaticStatementRequest({config,decision:delegated,verification:statementVerification,job}).id,'261024-007');
 assert.throws(()=>automaticStatementRequest({config,decision:delegated,verification:statementVerification,job:{...job,roomKey:'other-room'}}),/recipient_authorization/);
 assert.throws(()=>automaticStatementRequest({decision:statementDecision,verification:{...statementVerification,calculations:[{...statementVerification.calculations[0],tradeId:'261024-008'}]},job}),/trade_mismatch/);
});
test('a prepared statement PDF does not count as sent until Kakao readback',async()=>{
 const receipt=await sendAutomaticPricingDocument({config:{documentApiBaseUrl:'https://example.invalid',documentApiKey:'test'},decision:statementDecision,verification:statementVerification,job,fetchImpl:async()=>({ok:true,json:async()=>({status:'PREPARED',documentType:'statement',tradeID:'261024-007',...privateAttachment,totalVatIncluded:7700})})});
 assert.equal(receipt.documentType,'statement');assert.equal(receipt.deliveryConfirmed,false);
 const work={type:'contract_document',title:'거래명세서 발송',requiresHumanAction:true},other={type:'contract_document',title:'계약서 수정',requiresHumanAction:true};
 const prepared={decision:{...statementDecision,follow_up_items:[work,other]},availabilityAwareRows:[work,other]};
 assert.equal(completeVerifiedPricingWork(prepared,{verifiedPricing:true,pricingDocumentReceipt:receipt}),prepared);
 const completed=completeVerifiedPricingWork(prepared,{verifiedPricing:true,pricingDocumentReceipt:{...receipt,deliveryConfirmed:true}});
 assert.deepEqual(completed.decision.follow_up_items,[other]);assert.deepEqual(completed.availabilityAwareRows,[other]);
});
test('only explicitly enabled price answers can use scoped automatic delivery',()=>{
 assert.equal(verifiedPricingConfigured({verifiedPricingAutoSendEnabled:true},decision),true);
 assert.equal(verifiedPricingConfigured({},decision),false);
 assert.equal(verifiedPricingConfigured({verifiedPricingAutoSendEnabled:true},{...decision,price_quote:null}),false);
 assert.equal(verifiedPricingFreshJob({verifiedPricingEnabledAfter:'2026-11-02T00:00:00Z'},{detectedAt:'2026-11-01T23:00:00Z'}),false);
 assert.equal(verifiedPricingFreshJob({verifiedPricingEnabledAfter:'2026-11-02T00:00:00Z'},{detectedAt:'2026-11-02T00:00:01Z'}),true);
 assert.equal(verifiedPricingFreshJob({},{}),false);
});

test('verified sends remove fulfilled pricing tasks and preserve independent human work',async()=>{
 const {deriveAutomationResolution}=await import('../work-orchestrator-v2/automation-resolution.mjs');
 const {buildAutoReplyReadbackReceipt}=await import('./worker.mjs');
 const follow_up_items=[{type:'price_review',requiresHumanAction:true},{type:'quote_send',requiresHumanAction:true}];
 const prepared={decision:{...decision,follow_up_items},availabilityAwareRows:follow_up_items};
 const result={verifiedPricing:true,sent:true,readbackReceipt:buildAutoReplyReadbackReceipt({sourceEventKey:'event',replyText:'가격 안내',observedReplyHash:(await import('node:crypto')).createHash('sha256').update('가격 안내').digest('hex'),confirmedAt:new Date()}),pricingDocumentReceipt:{deliveryConfirmed:true}};
 const completed=completeVerifiedPricingWork(prepared,result);
 assert.deepEqual(completed.decision.follow_up_items,[]);
 assert.equal(deriveAutomationResolution({decision:completed.decision,autoReplyResult:result}).state,'succeeded');
 const reservation={type:'reservation_review',requiresHumanAction:true};
 const partial=completeVerifiedPricingWork({...prepared,decision:{...prepared.decision,follow_up_items:[...follow_up_items,reservation]}},result);
 assert.deepEqual(partial.decision.follow_up_items,[reservation]);
 assert.equal(deriveAutomationResolution({decision:partial.decision,autoReplyResult:result}).state,'needs_human');
 assert.equal(completeVerifiedPricingWork(prepared,{...result,sent:false,pricingDocumentReceipt:null}),prepared);
});
test('missing prices and implicit default discounts never become automatic quotes',()=>{
 assert.equal(verifiedPricingIssue(verification,quote),null);
 for(const change of [{complete:false},{unresolved:['미등록품목']},{calculations:[{...verification.calculations[0],customerDiscountSource:'default'}]},{calculations:[{...verification.calculations[0],pricedItems:[{name:'렌즈',price:0,qty:1}]}]}])assert.ok(verifiedPricingIssue({...verification,...change},quote));
 assert.throws(()=>automaticQuoteRequest({decision:{...decision,price_quote:{...quote,phone:''}},verification,job}),/recipient/);
});
test('manual quote uses authoritative complete lines and stable operation identity',()=>{
 const request=automaticQuoteRequest({decision,verification,job});assert.equal(request.expectedTotal,7700);assert.equal(request.manualData.items[0].단가,10000);assert.equal(request.manualData.할인유형,'학생');
 assert.equal(request.operationId,automaticQuoteRequest({decision,verification,job}).operationId);
 assert.notEqual(request.operationId,automaticQuoteRequest({decision,verification,job:{...job,roomRevision:3}}).operationId);
});
test('registered and pending-request quotes use the verified record identity and period',()=>{
 for(const [source,id,reference] of [['trade','261024-007',{tradeId:'261024-007'}],['request','RQ-261024-007',{reqID:'RQ-261024-007'}]]){
  const currentDecision={...decision,price_quote:{source,id}};
  const currentVerification={...statementVerification,calculations:[{...statementVerification.calculations[0],...reference}]};
  const request=automaticQuoteRequest({decision:currentDecision,verification:currentVerification,job});
  assert.equal(request.action,'sendEstimateManual');
  assert.deepEqual(request.pricingSource,{source,id});
  assert.equal(request.manualData.고객명,'테스트');assert.equal(request.manualData.연락처,'01012345678');
  assert.equal(request.manualData.대여기간,'2026-11-03 10:00 ~ 2026-11-04 10:00');
  assert.deepEqual(request.manualData.items,[{품목:'렌즈',수량:1,일수:1,단가:10000}]);
  assert.throws(()=>automaticQuoteRequest({decision:{...currentDecision,price_quote:{source,id:id.replace('007','008')}},verification:currentVerification,job}),/reference_mismatch/);
  assert.throws(()=>automaticQuoteRequest({decision:{...currentDecision,customer:{name:'다른 고객'}},verification:currentVerification,job}),/customer_mismatch/);
  assert.throws(()=>automaticQuoteRequest({decision:currentDecision,verification:{...currentVerification,calculations:[{...currentVerification.calculations[0],period:''}]},job}),/period_invalid/);
 }
});
test('registered quote reaches the document API with an authoritative payload',async()=>{
 let calls=0;
 const receipt=await sendAutomaticPricingDocument({config:{documentApiBaseUrl:'https://example.invalid/exec',documentApiKey:'test'},
  decision:{...decision,price_quote:{source:'trade',id:'261024-007'}},verification:statementVerification,job,
  fetchImpl:async(url,request)=>{
   calls++;const body=JSON.parse(request.body);
   assert.equal(body.action,'sendEstimateManual');assert.equal(body.expectedTotal,7700);assert.equal(body.manualData.고객명,'테스트');
   assert.deepEqual(body.pricingSource,{source:'trade',id:'261024-007'});
   return {ok:true,json:async()=>({status:'OK',deliveryConfirmed:true,pdfUrl:'https://drive.google.com/file/d/test/view',totalVatIncluded:7700})};
  }});
 assert.equal(calls,1);assert.equal(receipt.deliveryConfirmed,true);
});
test('transport acceptance, a PDF alone and wrong totals never prove quotation delivery',async()=>{
 for(const payload of [{status:'OK',pdfUrl:'https://drive.google.com/file/d/test/view'},{status:'OK',deliveryConfirmed:true,pdfUrl:'https://drive.google.com/file/d/test/view',totalVatIncluded:1},{status:'QUEUED'}])await assert.rejects(sendAutomaticPricingDocument({config:{documentApiBaseUrl:'https://example.invalid',documentApiKey:'test'},decision,verification,job,fetchImpl:async()=>({ok:true,json:async()=>payload})}),/not_confirmed/);
 let checked=false;const receipt=await sendAutomaticPricingDocument({config:{documentApiBaseUrl:'https://example.invalid',documentApiKey:'test'},decision,verification,job,assertFresh:async()=>{checked=true},fetchImpl:async(_url,request)=>{assert.equal(checked,true);assert.equal(JSON.parse(request.body).automaticPricing,true);return{ok:true,json:async()=>({status:'OK',deliveryConfirmed:true,pdfUrl:'https://drive.google.com/file/d/test/view',totalVatIncluded:7700})}}});assert.equal(receipt.deliveryConfirmed,true);
});

test('first AI response sends a verified quotation and price with general automatic replies held',async()=>{
 const fs=await import('node:fs/promises'),os=await import('node:os'),path=await import('node:path');
 const {maybeAutoSendReply,autoReplyTextHash}=await import('./worker.mjs');
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'verified-price-auto-'));
 try{
 const now=new Date(), clock=new Intl.DateTimeFormat('ko-KR',{timeZone:'Asia/Seoul',hour:'numeric',minute:'2-digit',hour12:true}).format(now);
 const currentJob={...job,detectedAt:now.toISOString(),previewText:`테스트 1 가격 알려주세요 ${clock}`,unreadCount:1,events:[{reason:'top_row_changed',unreadCount:1,detectedAt:now.toISOString()}]};
 const currentDecision={...decision,classification:'price',confidence:'high',follow_up_items:[{type:'quote_send'}],
  safety_checks:{kakao_conversation_opened:true,did_not_classify_from_preview_only:true,latest_customer_message_after_last_staff_reply:true},
  reply_decision:{...decision.reply_decision,replyMode:'auto_send',confidence:'high',text:'학생 할인 적용 금액은 부가세 포함 7,700원입니다.'}};
 const config={autoSendEnabled:false,verifiedPricingAutoSendEnabled:true,verifiedPricingEnabledAfter:new Date(now-60000).toISOString(),autoSendLogPath:path.join(dir,'log.ndjson'),gasApiUrl:'https://script.google.com/macros/s/test/exec',sheetApiKey:'test',fetchImpl:async()=>({ok:true,text:async()=>JSON.stringify({data:[['active']]})})};
 const calls=[];
 const result=await maybeAutoSendReply({config,decision:currentDecision,job:currentJob,dependencies:{
  buildAuthoritativePriceVerification:async()=>{calls.push('fresh-price');return verification},
  assertFreshBeforeSend:async()=>calls.push('fresh-room'),
  sendAutomaticPricingDocument:async()=>{calls.push('pdf');return{schema:'village-auto-pricing-document-receipt/v1',deliveryConfirmed:true,status:'sent'}},
  sendKakaoMessage:async text=>{calls.push('answer');return{sent:true,readback_confirmed:true,observed_reply_hash:autoReplyTextHash(text)}}
 }});
 assert.equal(result.sent,true,JSON.stringify(result));assert.equal(result.pricingDocumentReceipt.deliveryConfirmed,true);assert.ok(result.readbackReceipt);assert.ok(calls.indexOf('fresh-price')<calls.indexOf('pdf'));assert.ok(calls.indexOf('pdf')<calls.indexOf('answer'));
 const statement=await maybeAutoSendReply({config,decision:{...currentDecision,...statementDecision,reply_decision:currentDecision.reply_decision},job:{...currentJob,jobId:'statement-job'},dependencies:{
  buildAuthoritativePriceVerification:async()=>statementVerification,assertFreshBeforeSend:async()=>{},
  sendAutomaticPricingDocument:async()=>({schema:'village-auto-pricing-document-receipt/v1',documentType:'statement',status:'prepared',deliveryConfirmed:false,attachmentPaths:['/tmp/test-statement.pdf']}),
  sendKakaoMessage:async (text,_context,options)=>{assert.match(text,/261024-007/);assert.doesNotMatch(text,/https:\/\//);assert.deepEqual(options.attachmentPaths,['/tmp/test-statement.pdf']);return{sent:true,readback_confirmed:true,observed_reply_hash:autoReplyTextHash(text),attachments:{attached:true}}}
 }});
 assert.equal(statement.sent,true);assert.equal(statement.pricingDocumentReceipt.deliveryConfirmed,true);assert.equal(statement.pricingDocumentReceipt.deliveryChannel,'kakao_attachment');
 const stale=await maybeAutoSendReply({config:{...config,verifiedPricingEnabledAfter:new Date(now.getTime()+60000).toISOString()},decision:currentDecision,job:currentJob});assert.equal(stale.sent,false);assert.equal(stale.gate.reason,'pricing_before_activation_cutoff');
 }finally{await fs.rm(dir,{recursive:true,force:true})}
});

test('accepted quotation polls the same persisted operation until provider delivery is confirmed',async()=>{
 const operations=[];
 const receipt=await sendAutomaticPricingDocument({config:{documentApiBaseUrl:'https://example.invalid/exec',documentApiKey:'test'},decision,verification,job,waitImpl:async()=>{},
  fetchImpl:async(_url,request)=>{const body=JSON.parse(request.body);operations.push(body.operationId);return{ok:true,json:async()=>({status:operations.length<3?'QUEUED':'OK',operationId:body.operationId,deliveryConfirmed:operations.length>=3,totalVatIncluded:7700,pdfUrl:'https://drive.google.com/file/d/test/view'})}}});
 assert.equal(receipt.deliveryConfirmed,true);assert.equal(operations.length,3);assert.equal(new Set(operations).size,1);
});
