import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import * as pricing from './verified-pricing.mjs';
import * as worker from './worker.mjs';

const quote = {source:'catalog',customer_name:'검증고객',phone:'01012345678',discount_type:'학생',
  start_date:'2026-11-10',start_time:'09:00',end_date:'2026-11-11',end_time:'09:00'};
const decision = {customer:{name:'검증고객'},price_quote:quote};
const verification = {complete:true,totalVatIncluded:7700,unresolved:[],calculations:[{
  discountType:'학생',customerDiscountSource:'conversation',payment:{days:1},pricedItems:[{name:'렌즈',price:10000,qty:1}]}]};
const job = {jobId:'stress-event',roomKey:'room-one',roomRevision:1};
const statement = {...decision,price_quote:{source:'trade',id:'261110-001'},
  statement_request:{trade_id:'261110-001',booking_customer_name:'검증고객'}};
const registered = {...verification,calculations:[{...verification.calculations[0],tradeId:'261110-001',
  customer:'검증고객',phone:'01012345678',period:'2026-11-10 09:00 ~ 2026-11-11 09:00'}]};
const bytes = Buffer.from('%PDF-1.7\n'+'.'.repeat(80));
const attachment = {documentAccess:'private',mimeType:'application/pdf',ownerUrl:'https://docs.google.com/spreadsheets/d/test/edit',
  pdfBase64:bytes.toString('base64'),pdfSha256:createHash('sha256').update(bytes).digest('hex')};
const config = {documentApiBaseUrl:'https://example.invalid',documentApiKey:'test'};

test('success from another operation must never become this document receipt',async()=>{
  for(const kind of ['quote','statement']) for(const operationId of [undefined,'f'.repeat(64)]) {
    const payload = kind==='quote'
      ? {status:'OK',deliveryConfirmed:true,pdfUrl:'https://drive.google.com/file/d/test/view'}
      : {status:'PREPARED',documentType:'statement',tradeID:'261110-001',...attachment};
    await assert.rejects(pricing.sendAutomaticPricingDocument({config,job,
      decision:kind==='quote'?decision:statement,verification:kind==='quote'?verification:registered,
      fetchImpl:async()=>({ok:true,json:async()=>({...payload,totalVatIncluded:7700,operationId})})}),/not_confirmed/);
  }
});

test('one statement completes only its exact trade, preserving other and combined work',()=>{
  const matching={type:'contract_document',title:'거래명세서 발송',taskKey:'statement:261110-001',requiresHumanAction:true};
  const other={...matching,taskKey:'statement:261110-002'};
  const combined={...matching,taskKey:'statement:261110-001:261110-002'};
  const items=[matching,other,combined];
  const prepared={decision:{...statement,follow_up_items:items},availabilityAwareRows:items};
  const done=pricing.completeVerifiedPricingWork(prepared,{verifiedPricing:true,
    pricingDocumentReceipt:{deliveryConfirmed:true,documentType:'statement',tradeId:'261110-001'}});
  assert.deepEqual(done.decision.follow_up_items,[other,combined]);
  assert.deepEqual(done.availabilityAwareRows,[other,combined]);
  assert.equal(done.decision.reply_decision.shouldCreateTask,true);
  const wrong=pricing.completeVerifiedPricingWork(prepared,{verifiedPricing:true,
    pricingDocumentReceipt:{deliveryConfirmed:true,documentType:'statement',tradeId:'261110-002'}});
  assert.deepEqual(wrong.decision.follow_up_items,items);
});

test('a catalog quote cannot resolve a keyed registered booking task',()=>{
  const current={type:'quote_send',requiresHumanAction:true};
  const other={...current,taskKey:'quote-send:261110-002'};
  const done=pricing.completeVerifiedPricingWork({decision:{...decision,follow_up_items:[current,other]}},
    {verifiedPricing:true,pricingDocumentReceipt:{deliveryConfirmed:true,documentType:'quote'}});
  assert.deepEqual(done.decision.follow_up_items,[other]);
});

test('selected files and a clicked button are not proof of attachment delivery',async(t)=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'attachment-stress-'));
  t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  const file=path.join(directory,'261110-001_거래명세서.pdf');fs.writeFileSync(file,bytes);
  const result=await worker.attachKakaoFilesViaDevtools({webSocketDebuggerUrl:'ws://test'},[file],{
    evidencePollMs:0,evidenceMaxAttempts:1,
    evaluateImpl:async()=>({href:'https://business.kakao.com/chats/1',messages:[],sendClicked:true,selectedFileCount:1}),
    cdpCallImpl:async(_target,method)=>method==='DOM.getDocument'?{root:{nodeId:1}}:method==='DOM.querySelector'?{nodeId:2}:{}
  });
  assert.equal(result.attached,false);
});

test('attachment evidence rejects old bubbles, incoming files, errors and another room',()=>{
  const file='/tmp/261110-001_거래명세서.pdf';
  const message={role:'staff',text:'261110-001_거래명세서.pdf\n12 KB'};
  const before={href:'https://business.kakao.com/chats/1',messages:[message]};
  for(const after of [before,{...before,href:'https://business.kakao.com/chats/2',messages:[message,message]},
    {...before,messages:[message,{...message,role:'customer'}]},
    {...before,messages:[message,{...message,text:message.text+' 전송 실패'}]},
    {...before,messages:[message,{...message,text:message.text+' 전송 중'}]}]) {
    assert.equal(worker.kakaoAttachmentReadback(before,after,[file]),false);
  }
  assert.equal(worker.kakaoAttachmentReadback(before,{...before,messages:[message,message]},[file]),true);
  for(const layout of [{left:940,right:1180,viewport_width:1200},{left:160,right:400,viewport_width:420}]) {
    const observed={role:'unknown',layout,text:'261110-001_거래명세서.pdf유효기간~2029/11/10용량76.03 KB'};
    assert.equal(worker.kakaoAttachmentReadback({...before,messages:[]},{...before,messages:[observed]},[file]),true);
    assert.equal(worker.kakaoAttachmentReadback({...before,messages:[]},{...before,messages:[{...observed,role:'customer'}]},[file]),false);
    assert.equal(worker.kakaoAttachmentReadback({...before,messages:[]},{...before,messages:[{...observed,layout:{left:55,right:295,viewport_width:420}}]},[file]),false);
  }
});

test('200 concurrent statement attempts and a fresh module replay send one attachment',async(t)=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'statement-claim-'));
  t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  const cfg={statementDeliveryDirectory:directory};
  const receipt={operationId:'a'.repeat(64),pdfSha256:'verified-pdf'};
  const replyText='거래명세서 전달드립니다.';
  let sends=0;
  const send=async()=>{
    sends++;await new Promise(resolve=>setTimeout(resolve,5));
    return {sent:true,readback_confirmed:true,observed_reply_hash:worker.autoReplyTextHash(replyText),
      attachments:{attached:true,readbackConfirmed:true}};
  };
  const attempts=await Promise.all(Array.from({length:200},()=>pricing.deliverStatementOnce({config:cfg,receipt,replyText,send})));
  assert.equal(sends,1);assert.equal(attempts.filter(x=>x.sent).length,1);
  const restarted=await import(`./verified-pricing.mjs?restart=${Date.now()}`);
  const replay=await restarted.deliverStatementOnce({config:cfg,receipt,replyText,send});
  assert.equal(replay.sent,true);assert.equal(replay.documentDeliveryReplayed,true);assert.equal(sends,1);
  assert.equal((await restarted.deliverStatementOnce({config:cfg,receipt,replyText:'다른 안내',send})).sent,false);
  assert.equal(sends,1);
});

test('response loss and process interruption retain an uncertain statement without resending',async(t)=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'statement-loss-'));
  t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  const cfg={statementDeliveryDirectory:directory};
  for(const mode of ['throw','unverified','wrong_hash','partial_claim']) {
    const receipt={operationId:createHash('sha256').update(mode).digest('hex'),pdfSha256:'pdf'};
    let sends=0;
    const send=async()=>{sends++;if(mode==='throw')throw Error('response lost');
      return {sent:true,readback_confirmed:true,observed_reply_hash:mode==='wrong_hash'?'wrong':worker.autoReplyTextHash('안내'),
        attachments:{attached:true,readbackConfirmed:mode==='wrong_hash'}};};
    if(mode==='partial_claim')fs.writeFileSync(path.join(directory,receipt.operationId+'.json'),'{');
    try {await pricing.deliverStatementOnce({config:cfg,receipt,replyText:'안내',send});}catch(error){assert.match(error.message,/response lost/);}
    for(let retry=0;retry<20;retry++){
      const result=await pricing.deliverStatementOnce({config:cfg,receipt,replyText:'안내',send});
      assert.equal(result.sent,false);assert.equal(result.reason,'statement_delivery_outcome_unknown');
    }
    assert.equal(sends,mode==='partial_claim'?0:1);
  }
});

test('100 independent quotes poll stable operations; corrupted successes remain unconfirmed',async()=>{
  const operations=new Map();
  const results=await Promise.all(Array.from({length:100},async(_,index)=>{
    const currentJob={...job,jobId:`stress-${index}`};
    return pricing.sendAutomaticPricingDocument({config,decision,verification,job:currentJob,waitImpl:async()=>{},
      fetchImpl:async(_url,request)=>{
        const body=JSON.parse(request.body),calls=(operations.get(body.operationId)||0)+1;
        operations.set(body.operationId,calls);
        return {ok:true,json:async()=>({status:calls<4?'QUEUED':'OK',operationId:body.operationId,
          deliveryConfirmed:calls===4,totalVatIncluded:7700,pdfUrl:'https://drive.google.com/file/d/test/view'})};
      }});
  }));
  assert.equal(results.filter(x=>x.deliveryConfirmed).length,100);
  assert.equal(operations.size,100);assert.ok([...operations.values()].every(count=>count===4));
  for(const mutation of [{operationId:'wrong'},{totalVatIncluded:7701},{deliveryConfirmed:false},{status:'QUEUED'},
    {pdfUrl:'https://drive.google.com.evil.test/file/d/test'},{pdfUrl:'http://drive.google.com/file/d/test'}]) {
    await assert.rejects(pricing.sendAutomaticPricingDocument({config,decision,verification,job,waitImpl:async()=>{},
      fetchImpl:async(_url,request)=>({ok:true,json:async()=>({status:'OK',deliveryConfirmed:true,
        operationId:JSON.parse(request.body).operationId,totalVatIncluded:7700,pdfUrl:'https://drive.google.com/file/d/test/view',...mutation})})}),/not_confirmed/);
  }
});

test('prior price-only reply does not suppress a later explicit quote with the same text',async(t)=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'price-document-dedupe-'));
  t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  const now=new Date(),replyText='학생 할인 적용 금액은 부가세 포함 7,700원입니다.';
  const currentJob={...job,detectedAt:now.toISOString(),unreadCount:1,events:[{reason:'top_row_changed',unreadCount:1,detectedAt:now.toISOString()}]};
  const currentDecision={...decision,classification:'price',follow_up_items:[{type:'quote_send'}],
    safety_checks:{kakao_conversation_opened:true,did_not_classify_from_preview_only:true,latest_customer_message_after_last_staff_reply:true},
    reply_decision:{replyMode:'auto_send',confidence:'high',text:replyText,safetyClass:'sensitive_commitment',grounding:'authoritative_sheet',requiresRag:false}};
  const cfg={autoSendEnabled:false,verifiedPricingAutoSendEnabled:true,verifiedPricingEnabledAfter:new Date(now-60000).toISOString(),
    autoSendLogPath:path.join(directory,'auto.ndjson'),fetchImpl:async()=>({ok:true,text:async()=>JSON.stringify({data:[['active']]})})};
  fs.writeFileSync(cfg.autoSendLogPath,JSON.stringify({at:now.toISOString(),result:{sent:true},
    dedupeKey:worker.buildAutoReplyDedupeKey({decision:currentDecision,job:currentJob,replyText}),
    roomReplyKey:worker.buildRoomReplyDedupeKey({decision:currentDecision,job:currentJob,replyText})})+'\n');
  let documents=0;
  const dependencies={assertFreshBeforeSend:async()=>{},buildAuthoritativePriceVerification:async()=>verification,
    sendAutomaticPricingDocument:async()=>{documents++;return {documentType:'quote',deliveryConfirmed:true};},
    sendKakaoMessage:async text=>({sent:true,readback_confirmed:true,observed_reply_hash:worker.autoReplyTextHash(text)})};
  const result=await worker.maybeAutoSendReply({config:cfg,decision:currentDecision,job:currentJob,dependencies});
  assert.equal(result.sent,true,JSON.stringify(result));assert.equal(documents,1);
  const replay=await worker.maybeAutoSendReply({config:cfg,decision:currentDecision,job:currentJob,dependencies});
  assert.equal(replay.sent,false);assert.equal(documents,1);
});
