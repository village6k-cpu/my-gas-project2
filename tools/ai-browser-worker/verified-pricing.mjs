import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export function isVerifiedPricingReply(decision = {}) {
  const reply = decision.reply_decision || {};
  return Boolean(decision.price_quote) && reply.safetyClass === 'sensitive_commitment'
    && reply.grounding === 'authoritative_sheet' && reply.requiresRag === false;
}

export function verifiedPricingConfigured(config = {}, decision = {}) {
  return config.verifiedPricingAutoSendEnabled === true && isVerifiedPricingReply(decision);
}

export function verifiedPricingFreshJob(config = {}, job = {}) {
  const cutoff = Date.parse(config.verifiedPricingEnabledAfter || '');
  const detected = Date.parse(job.detectedAt || job.detected_at || job.payload?.detectedAt || '');
  return Number.isFinite(cutoff) && Number.isFinite(detected) && detected >= cutoff;
}

export function verifiedPricingIssue(verification = {}, quote = {}) {
  if (verification.complete !== true || !Number.isSafeInteger(verification.totalVatIncluded) || verification.totalVatIncluded <= 0) return 'price_incomplete';
  if (verification.unresolved?.length || verification.calculations?.length !== 1) return 'price_incomplete';
  const calculation = verification.calculations[0];
  if (!calculation.payment || !calculation.pricedItems?.length || calculation.unresolvedItems?.length
    || calculation.pricedItems.some(item => !Number.isSafeInteger(item.price) || item.price <= 0 || !Number.isSafeInteger(item.qty) || item.qty < 1)) return 'price_incomplete';
  if (calculation.customerDiscountSource === 'default' || !calculation.discountType) return 'discount_unconfirmed';
  if (quote.source === 'catalog' && (!quote.discount_type && calculation.customerDiscountSource !== 'customer_db')) return 'discount_unconfirmed';
  return null;
}

export function pricingDocumentRequested(decision = {}) {
  return Boolean(decision.statement_request) || (decision.follow_up_items || []).some(item => item.type === 'quote_send');
}

export function automaticStatementRequest({config = {}, decision, verification, job}) {
  const quote=decision.price_quote, request=decision.statement_request;
  if(verifiedPricingIssue(verification,quote))throw new Error('statement_price_incomplete');
  const calculation=verification.calculations[0];
  if(quote.source!=='trade' || !/^\d{6}-\d{3}$/.test(request?.trade_id || '') || quote.id!==request.trade_id
    || calculation.tradeId!==request.trade_id || request.booking_customer_name!==calculation.customer)throw new Error('statement_trade_mismatch');
  const requester=decision.customer?.name, room=job.roomKey || job.room_key;
  const delegated=(config.statementRecipientAuthorizations || []).some(entry=>entry.tradeId===request.trade_id
    && entry.roomKey===room && entry.requesterName===requester && entry.bookingCustomerName===calculation.customer);
  if(requester!==calculation.customer && !delegated)throw new Error('statement_recipient_authorization_required');
  const phone=String(calculation.phone || '').replace(/\D/g,'');
  if(!/^01[016789]\d{7,8}$/.test(phone) || !calculation.period)throw new Error('statement_identity_incomplete');
  const body={action:'prepareAutomaticStatement',id:request.trade_id,expectedTotal:verification.totalVatIncluded,
    expectedCustomerName:calculation.customer,expectedPhone:phone,expectedPeriod:calculation.period,
    expectedDiscountType:calculation.discountType,expectedItems:calculation.pricedItems.map(item=>({품목:item.name,수량:item.qty,일수:calculation.payment.days,단가:item.price}))};
  return {...body,operationId:createHash('sha256').update(JSON.stringify({event:job.sourceEventKey || job.eventHash || job.jobId || job.id,room,revision:job.roomRevision || job.room_revision,body})).digest('hex')};
}

export function automaticQuoteRequest({ decision, verification, job }) {
  const quote = decision.price_quote;
  const issue = verifiedPricingIssue(verification, quote);
  if (issue) throw new Error(issue);
  const calculation = verification.calculations[0], days = calculation.payment.days;
  let customerName, recipientPhone, period;
  if (quote.source === 'catalog') {
    customerName = quote.customer_name;
    recipientPhone = quote.phone;
    period = `${quote.start_date} ${quote.start_time} ~ ${quote.end_date} ${quote.end_time}`;
  } else if (quote.source === 'trade' || quote.source === 'request') {
    const pattern = quote.source === 'trade' ? /^\d{6}-\d{3}$/ : /^RQ-\d{6}-\d{3}$/;
    const verifiedId = quote.source === 'trade' ? calculation.tradeId : calculation.reqID;
    if (!pattern.test(quote.id || '') || verifiedId !== quote.id) throw new Error('quote_reference_mismatch');
    customerName = calculation.customer;
    recipientPhone = calculation.phone;
    period = calculation.period;
  } else throw new Error('quote_document_context_required');
  const phone = String(recipientPhone || '').replace(/[^0-9]/g, '');
  if (!/^01[016789]\d{7,8}$/.test(phone)) throw new Error('quote_recipient_required');
  if (!customerName || customerName.trim() !== decision.customer?.name?.trim()) throw new Error('quote_customer_mismatch');
  if (!/^\d{4}-\d{2}-\d{2} (?:[01]\d|2[0-3]):[0-5]\d ~ \d{4}-\d{2}-\d{2} (?:[01]\d|2[0-3]):[0-5]\d$/.test(period || '')) throw new Error('quote_period_invalid');
  if (!Number.isFinite(days) || days <= 0 || days > 366) throw new Error('quote_days_invalid');
  const manualData = {
    고객명: customerName.trim(), 연락처: phone, 할인유형: calculation.discountType,
    대여기간: period,
    items: calculation.pricedItems.map(item => ({품목:item.name, 수량:item.qty, 일수:days, 단가:item.price}))
  };
  const pricingSource = {source:quote.source, ...(quote.id ? {id:quote.id} : {})};
  const operationId = createHash('sha256').update(JSON.stringify({
    event:job.sourceEventKey || job.eventHash || job.jobId || job.id,
    room:job.roomKey || job.room_key, revision:job.roomRevision || job.room_revision,
    manualData, total:verification.totalVatIncluded, pricingSource
  })).digest('hex');
  return {action:'sendEstimateManual', automaticPricing:true, operationId,
    expectedTotal:verification.totalVatIncluded, manualData, pricingSource};
}

export async function sendAutomaticPricingDocument({ config, decision, verification, job, assertFresh, fetchImpl = fetch,
  waitImpl = ms => new Promise(resolve => setTimeout(resolve,ms)) }) {
  const statement=Boolean(decision.statement_request);
  const body = statement ? automaticStatementRequest({config,decision,verification,job}) : automaticQuoteRequest({ decision, verification, job });
  if (!config.documentApiBaseUrl || !config.documentApiKey) throw new Error('quote_delivery_not_configured');
  await assertFresh?.();
  const request = () => fetchImpl(config.documentApiBaseUrl, {method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify({...body,key:config.documentApiKey}),signal:AbortSignal.timeout(240000)});
  let response = await request(), result = await response.json();
  // The server persists an accepted operation before returning QUEUED. Reusing
  // that exact operation only reads its provider outcome and cannot resend it.
  for (let attempt=0; !statement && response.ok && result.status==='QUEUED'
    && result.operationId===body.operationId && result.totalVatIncluded===verification.totalVatIncluded && attempt<3; attempt++) {
    await waitImpl(1000 * 2**attempt);
    response=await request();result=await response.json();
  }
  if (!response.ok || (statement ? result.status!=='PREPARED' || result.documentType!=='statement' || result.tradeID!==body.id
      : result.status !== 'OK' || result.deliveryConfirmed !== true)
    || result.totalVatIncluded !== verification.totalVatIncluded || (statement
      ? result.documentAccess!=='private' || result.mimeType!=='application/pdf' || !pricingDocumentUrl(result.ownerUrl)
      : !pricingDocumentUrl(result.pdfUrl))) {
    const error = new Error('quote_delivery_not_confirmed'); error.result = result; throw error;
  }
  let attachment={};
  if(statement){
    const bytes=Buffer.from(String(result.pdfBase64 || ''),'base64');
    if(bytes.length<30 || bytes.length>10*1024*1024 || bytes.subarray(0,5).toString()!=='%PDF-' || createHash('sha256').update(bytes).digest('hex')!==result.pdfSha256)throw new Error('statement_pdf_integrity_failed');
    const directory=path.join(config.privateStatementDirectory || path.join(os.tmpdir(),'village-private-statements'),body.operationId);
    fs.mkdirSync(directory,{recursive:true,mode:0o700});
    const fileName=body.id+'_거래명세서.pdf',attachmentPath=path.join(directory,fileName);
    fs.writeFileSync(attachmentPath,bytes,{mode:0o600});
    attachment={privateFile:true,fileName,attachmentPaths:[attachmentPath],ownerDocumentUrl:result.ownerUrl,pdfSha256:result.pdfSha256};
  }
  return {schema:'village-auto-pricing-document-receipt/v1',operationId:body.operationId,
    documentType:statement?'statement':'quote',...(statement?{tradeId:body.id}:{}),
    status:statement?'prepared':'sent',deliveryConfirmed:!statement,...(!statement?{pdfUrl:result.pdfUrl}:attachment),fileId:result.fileId,
    totalVatIncluded:result.totalVatIncluded,discountType:verification.calculations[0].discountType,
    occurredAt:new Date().toISOString()};
}

export function verifiedPricingAudit(result = {}) {
  const verification=result.priceVerification, calculation=verification?.calculations?.[0];
  if (!result.verifiedPricing || verifiedPricingIssue(verification || {}, {source:'trade'})) return null;
  return {schema:'village-verified-pricing-audit/v1',totalVatIncluded:verification.totalVatIncluded,
    discountType:calculation.discountType,days:calculation.payment.days,
    items:calculation.pricedItems.map(item=>({name:item.name,qty:item.qty,price:item.price}))};
}

export function pricingDocumentUrl(value) {
  try {const url=new URL(value);return url.protocol==='https:' && ['drive.google.com','docs.google.com'].includes(url.hostname)
    && /^\/(?:file\/d|spreadsheets\/d)\/[a-zA-Z0-9_-]+/.test(url.pathname) ? url.origin+url.pathname : null;} catch{return null;}
}

export function completeVerifiedPricingWork(prepared, result) {
  if (!result?.verifiedPricing) return prepared;
  const completed = new Set();
  if (result.sent === true && result.readbackReceipt) {completed.add('reply_needed');completed.add('price_review');}
  if (result.pricingDocumentReceipt?.deliveryConfirmed === true && result.pricingDocumentReceipt.documentType!=='statement') completed.add('quote_send');
  const statementDone=result.pricingDocumentReceipt?.deliveryConfirmed===true && result.pricingDocumentReceipt.documentType==='statement';
  if (!completed.size && !statementDone) return prepared;
  const reference=prepared.decision.price_quote?.id;
  const sameQuote=item=>{
    const keys=[item.businessKey,item.business_key,item.taskKey,item.task_key].filter(Boolean);
    // Older single-quote intents have no keys. Keyed work must name the exact
    // verified reference; a combined/mismatched case is still outstanding.
    return !reference || !keys.length || keys.some(key=>String(key).split(':').includes(reference));
  };
  const fulfilled=item=>(completed.has(item.type)
    && (!['quote_send','price_review'].includes(item.type) || sameQuote(item))) || (statementDone && item.type==='contract_document'
    && /거래명세|statement/i.test([item.title,item.summary,item.taskKey,item.task_key,item.payload?.task_key].join(' ')));
  const remaining=(prepared.decision.follow_up_items || []).filter(item=>!fulfilled(item));
  return {...prepared,decision:{...prepared.decision,follow_up_items:remaining,
    reply_decision:{...prepared.decision.reply_decision,shouldCreateTask:remaining.some(item=>item.requiresHumanAction===true)}},
    availabilityAwareRows:(prepared.availabilityAwareRows || []).filter(row=>!fulfilled(row))};
}
