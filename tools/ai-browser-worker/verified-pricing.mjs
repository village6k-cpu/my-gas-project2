import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {documentDecisions, documentWorkflowErrors, priceSourceKey} from './document-workflow.mjs';

export function isVerifiedPricingReply(decision = {}) {
  const reply = decision.reply_decision || {};
  return (Boolean(decision.price_quote) || Array.isArray(decision.document_requests)) && reply.safetyClass === 'sensitive_commitment'
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
  if (Array.isArray(quote)) {
    if (documentWorkflowErrors({document_requests:quote}).length || !Array.isArray(verification.documents)
      || verification.documents.length !== quote.length) return 'invalid_document_plan';
    const totals = new Map();
    for (const [index, request] of quote.entries()) {
      const item = verification.documents[index];
      if (priceSourceKey(item.request) !== priceSourceKey(request)) return 'document_verification_mismatch';
      const issue = verifiedPricingIssue(item.verification, request.price_quote);
      if (issue) return issue;
      const key = priceSourceKey(request.price_quote), total = item.verification.totalVatIncluded;
      if (totals.has(key) && totals.get(key) !== total) return 'document_verification_mismatch';
      totals.set(key, total);
    }
    return verification.complete === true && verification.totalVatIncluded === [...totals.values()].reduce((a,b) => a+b, 0)
      ? null : 'price_incomplete';
  }
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
  return Boolean(decision.statement_request) || Array.isArray(decision.document_requests)
    || (decision.follow_up_items || []).some(item => item.type === 'quote_send');
}

// A single price source cannot authorize or close a request for several quotes.
export function quoteNeedsSeparateVerification(decision = {}) {
  if (decision.document_requests != null) return documentWorkflowErrors(decision).length > 0;
  const tasks = (decision.follow_up_items || []).filter(item => item.type === 'quote_send');
  if (!tasks.length) return false;
  if (tasks.length > 1) return true;
  const [task] = tasks;
  const scope = [task.title, task.summary, task.recommended_action, ...(task.evidence || [])].join(' ');
  const refs = new Set(scope.match(/\b(?:RQ-)?\d{6}-\d{3}\b/g) || []);
  if (refs.size > 1) return true;
  const request = [task.title, decision.latest_customer_message_cluster, task.suggested_reply_draft,
    ...(task.evidence || []).filter(value => typeof value === 'string' && value.startsWith('customer_request:'))].join(' ');
  const day = String.raw`\d{1,2}(?:\s*[/.\-]\s*|\s*월\s*)\d{1,2}(?:\s*일)?`;
  return /(?:두|2|여러)\s*건(?:의)?\s*견적서|견적서.{0,24}(?:두|2|여러)\s*건/.test(request)
    || new RegExp(day + String.raw`(?:\s*(?:건|꺼))?\s*(?:[·ㆍ,]|과|와|하고|이랑|랑|및)\s*` + day).test(request)
    || new RegExp(String.raw`(?:오늘|어제)\s*(?:건|꺼|거)?\s*(?:과|와|하고|이랑|랑|및)\s*` + day).test(request);
}

function normalizeDocumentRecipientPhone(value) {
  const digits = String(value ?? '').replace(/\D/g, '');
  // Numeric Sheets cells lose the initial zero. Restore only the exact
  // remaining Korean mobile-number shape; other incomplete numbers still fail.
  return /^1[016789]\d{7,8}$/.test(digits) ? `0${digits}` : digits;
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
  const phone=normalizeDocumentRecipientPhone(calculation.phone);
  if(!/^01[016789]\d{7,8}$/.test(phone) || !calculation.period)throw new Error('statement_identity_incomplete');
  const body={action:'prepareAutomaticStatement',id:request.trade_id,expectedTotal:verification.totalVatIncluded,
    expectedCustomerName:calculation.customer,expectedPhone:phone,expectedPeriod:calculation.period,
    expectedDiscountType:calculation.discountType,expectedItems:calculation.pricedItems.map(item=>({품목:item.name,수량:item.qty,일수:calculation.payment.days,단가:item.price}))};
  return {...body,operationId:createHash('sha256').update(JSON.stringify({event:job.sourceEventKey || job.eventHash || job.jobId || job.id,room,revision:job.roomRevision || job.room_revision,body})).digest('hex')};
}

export function automaticQuoteRequest({ decision, verification, job }) {
  if (quoteNeedsSeparateVerification(decision)) throw new Error('quote_scope_requires_separate_verification');
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
  const phone = normalizeDocumentRecipientPhone(recipientPhone);
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
  try {
  if (!config.documentApiBaseUrl || !config.documentApiKey) throw new Error('quote_delivery_not_configured');
  await assertFresh?.();
  const request = () => fetchImpl(config.documentApiBaseUrl, {method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify({...body,key:config.documentApiKey}),signal:AbortSignal.timeout(240000)});
  let response = await request(), result = await response.json();
  // The server persists an accepted operation before returning QUEUED. Reusing
  // that exact operation only reads its provider outcome and cannot resend it.
  for (let attempt=0; !statement && response.ok && result.status==='QUEUED'
    && result.operationId===body.operationId && result.totalVatIncluded===verification.totalVatIncluded && attempt<5; attempt++) {
    await waitImpl(1000 * 2**attempt);
    response=await request();result=await response.json();
  }
  if (!response.ok || result.operationId !== body.operationId || (statement ? result.status!=='PREPARED' || result.documentType!=='statement' || result.tradeID!==body.id
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
    documentType:statement?'statement':'quote',pricingSource:decision.price_quote,
    ...((body.id || decision.price_quote?.source === 'trade')?{tradeId:body.id || decision.price_quote.id}:{}),
    status:statement?'prepared':'sent',deliveryConfirmed:!statement,...(!statement?{pdfUrl:result.pdfUrl}:attachment),fileId:result.fileId,
    totalVatIncluded:result.totalVatIncluded,discountType:verification.calculations[0].discountType,
    occurredAt:new Date().toISOString()};
  } catch (error) { error.operationId = body.operationId; throw error; }
}

export function automaticDocumentPlan({config, decision, verification, job}) {
  const issue = verifiedPricingIssue(verification, decision.document_requests);
  if (issue) throw new Error(issue);
  return documentDecisions(decision).map((child, index) => {
    const verified = verification.documents[index].verification;
    // Construct EVERY request before the first effect: an invalid second
    // recipient must not leave the first customer's document already sent.
    const body = child.statement_request
      ? automaticStatementRequest({config, decision:child, verification:verified, job})
      : automaticQuoteRequest({decision:child, verification:verified, job});
    return {decision:child, verification:verified, body};
  });
}

export async function sendAutomaticPricingDocuments(options) {
  const plans = automaticDocumentPlan(options), receipts = [];
  for (const plan of plans) {
    try {
      receipts.push(await sendAutomaticPricingDocument({...options, decision:plan.decision, verification:plan.verification}));
    } catch (error) {
      error.pricingDocumentReceipts = receipts;
      error.operationId ||= plan.body.operationId;
      throw error;
    }
  }
  return receipts;
}

export function verifiedPricingAudit(result = {}) {
  const verification=result.priceVerification, calculation=verification?.calculations?.[0];
  if (result.verifiedPricing && verification?.documents) {
    const requests = verification.documents.map(item => item.request);
    if (verifiedPricingIssue(verification, requests)) return null;
    return {schema:'village-verified-pricing-audit/v1',totalVatIncluded:verification.totalVatIncluded,
      discountType:[...new Set(verification.calculations.map(item => item.discountType))].join(' / '),
      days:verification.calculations.map(item => item.payment.days),
      items:verification.calculations.flatMap(item => item.pricedItems.map(line => ({name:line.name,qty:line.qty,price:line.price})))};
  }
  if (!result.verifiedPricing || verifiedPricingIssue(verification || {}, {source:'trade'})) return null;
  return {schema:'village-verified-pricing-audit/v1',totalVatIncluded:verification.totalVatIncluded,
    discountType:calculation.discountType,days:calculation.payment.days,
    items:calculation.pricedItems.map(item=>({name:item.name,qty:item.qty,price:item.price}))};
}

export function pricingDocumentUrl(value) {
  try {const url=new URL(value);return url.protocol==='https:' && ['drive.google.com','docs.google.com'].includes(url.hostname)
    && /^\/(?:file\/d|spreadsheets\/d)\/[a-zA-Z0-9_-]+/.test(url.pathname) ? url.origin+url.pathname : null;} catch{return null;}
}

// A prepared PDF can be fetched repeatedly, but a customer attachment must not
// be resent after a process crash or lost UI response. Keep the claim on disk;
// only a verified send can be replayed as complete. Unknown outcomes stay open.
export async function deliverStatementOnce({config, receipt, replyText, send}) {
  return deliverStatementsOnce({config, receipts:[receipt], replyText, send});
}

export async function deliverStatementsOnce({config, receipts, replyText, send}) {
  if (!Array.isArray(receipts) || !receipts.length || receipts.some(receipt => !/^[a-f0-9]{64}$/.test(receipt.operationId || ''))
    || new Set(receipts.map(item => item.operationId)).size !== receipts.length) throw new Error('statement_operation_required');
  const directory = config.statementDeliveryDirectory || `${config.autoSendLogPath}.documents`;
  fs.mkdirSync(directory, {recursive:true, mode:0o700});
  const replyHash = createHash('sha256').update(String(replyText).replace(/\s+/g,' ').trim()).digest('hex');
  const entries = receipts.map(receipt => ({receipt,file:path.join(directory,`${receipt.operationId}.json`)}));
  const unknown = () => ({sent:false,reason:'statement_delivery_outcome_unknown'});
  const prior = entries.map(({file}) => {
    if (!fs.existsSync(file)) return null;
    try { return JSON.parse(fs.readFileSync(file,'utf8')); } catch { return {}; }
  });
  if (prior.some(Boolean)) {
    if (prior.every((value,index) => value?.status === 'confirmed' && value.operationId === entries[index].receipt.operationId
      && value.replyHash === replyHash && value.pdfSha256 === entries[index].receipt.pdfSha256)) {
      return {...prior[0].sendResult,documentDeliveryReplayed:true};
    }
    // A reordered, overlapping, subset or legacy-to-batch replay must not
    // bypass a constituent's started/uncertain delivery claim.
    return unknown();
  }
  const claimId = randomUUID(), claimed = [];
  const payload = ({receipt},status) => ({operationId:receipt.operationId,status,claimId,replyHash,
    pdfSha256:receipt.pdfSha256,at:new Date().toISOString()});
  try {
    for (const entry of entries) {
      const fd = fs.openSync(entry.file,'wx',0o600);
      claimed.push(entry);
      try { fs.writeFileSync(fd,JSON.stringify(payload(entry,'reserved')));fs.fsyncSync(fd); }
      finally { fs.closeSync(fd); }
    }
  } catch (error) {
    // No transport ran. Release only this invocation's own reservations.
    for (const entry of claimed) {
      try {const saved=JSON.parse(fs.readFileSync(entry.file,'utf8'));
        if(saved.claimId===claimId && saved.status==='reserved')fs.unlinkSync(entry.file);
      } catch { /* incomplete claims remain blocked for independent review */ }
    }
    if(error.code==='EEXIST')return unknown();
    throw error;
  }
  const put = (entry,value) => {
    const temporary = `${entry.file}.${claimId}.tmp`, out = fs.openSync(temporary,'wx',0o600);
    try {fs.writeFileSync(out,JSON.stringify(value));fs.fsyncSync(out);} finally {fs.closeSync(out);}
    fs.renameSync(temporary,entry.file);
  };
  for(const entry of entries)put(entry,payload(entry,'started'));
  const result = await send();
  if (result.sent === true && result.readback_confirmed === true && result.observed_reply_hash === replyHash
    && result.attachments?.attached === true && result.attachments?.readbackConfirmed === true) {
    for(const entry of entries)put(entry,{...payload(entry,'confirmed'),sendResult:{sent:true,
      readback_confirmed:true,observed_reply_hash:replyHash,attachments:{attached:true,readbackConfirmed:true},reason:'statement_delivery_verified'}});
  }
  return result;
}

export function completeVerifiedPricingWork(prepared, result) {
  if (!result?.verifiedPricing) return prepared;
  if (Array.isArray(prepared.decision.document_requests)) {
    const receipts = result.pricingDocumentReceipts || [];
    const delivered = request => receipts.some(receipt => receipt.deliveryConfirmed === true
      && receipt.documentType === request.document_type
      && priceSourceKey(receipt.pricingSource) === priceSourceKey(request.price_quote));
    const requests = prepared.decision.document_requests;
    const allDelivered = requests.length > 0 && requests.every(delivered);
    const fulfilled = item => {
      if (item.type === 'reply_needed') return allDelivered && result.sent === true && Boolean(result.readbackReceipt);
      if (item.type === 'price_review') {
        const references = [item.businessKey,item.business_key,item.taskKey,item.task_key,
          item.payload?.business_key,item.payload?.follow_up_task_key].filter(Boolean)
          .flatMap(key => String(key).match(/(?:RQ-)?\d{6}-\d{3}/g) || []);
        return references.length > 0 && references.every(id => requests.some(request => request.price_quote.id === id))
          && allDelivered && result.sent === true && Boolean(result.readbackReceipt);
      }
      const type = item.type === 'quote_send' ? 'quote'
        : item.type === 'contract_document' && /거래명세|statement/i.test([item.title,item.summary,item.taskKey].join(' ')) ? 'statement' : null;
      if (!type) return false;
      const scoped = requests.filter(request => request.document_type === type
        && request.task_key === (item.taskKey || item.task_key || item.payload?.follow_up_task_key));
      return scoped.length === 1 && scoped.every(delivered);
    };
    const remaining = (prepared.decision.follow_up_items || []).filter(item => !fulfilled(item));
    return {...prepared,decision:{...prepared.decision,follow_up_items:remaining,
      reply_decision:{...prepared.decision.reply_decision,shouldCreateTask:remaining.some(item => item.requiresHumanAction === true)}},
      availabilityAwareRows:(prepared.availabilityAwareRows || []).filter(item => !fulfilled(item))};
  }
  const completed = new Set();
  if (result.sent === true && result.readbackReceipt) {completed.add('reply_needed');completed.add('price_review');}
  if (result.pricingDocumentReceipt?.deliveryConfirmed === true && result.pricingDocumentReceipt.documentType!=='statement') completed.add('quote_send');
  const statementDone=result.pricingDocumentReceipt?.deliveryConfirmed===true && result.pricingDocumentReceipt.documentType==='statement'
    && result.pricingDocumentReceipt.tradeId===prepared.decision.statement_request?.trade_id
    && result.pricingDocumentReceipt.tradeId===prepared.decision.price_quote?.id;
  if (!completed.size && !statementDone) return prepared;
  const reference=prepared.decision.price_quote?.id;
  const sameQuote=item=>{
    const keys=[item.businessKey,item.business_key,item.taskKey,item.task_key,
      item.payload?.taskKey,item.payload?.task_key,item.payload?.business_key,item.payload?.follow_up_task_key].filter(Boolean);
    // Older single-quote intents have no keys. Keyed work must name the exact
    // verified reference; a combined/mismatched case is still outstanding.
    if (!keys.length) return true;
    if (!reference) return false;
    const references=keys.flatMap(key=>String(key).match(/(?:RQ-)?\d{6}-\d{3}/g) || []);
    return references.length > 0 && references.every(value=>value===reference);
  };
  const fulfilled=item=>(completed.has(item.type)
    && (!['quote_send','price_review'].includes(item.type) || sameQuote(item))
    && (item.type !== 'quote_send' || !quoteNeedsSeparateVerification({
      ...prepared.decision, follow_up_items: [item]
    }))) || (statementDone && item.type==='contract_document'
    && sameQuote(item) && /거래명세|statement/i.test([item.title,item.summary,item.taskKey,item.task_key,
      item.payload?.task_key,item.payload?.follow_up_task_key].join(' ')));
  const remaining=(prepared.decision.follow_up_items || []).filter(item=>!fulfilled(item));
  return {...prepared,decision:{...prepared.decision,follow_up_items:remaining,
    reply_decision:{...prepared.decision.reply_decision,shouldCreateTask:remaining.some(item=>item.requiresHumanAction===true)}},
    availabilityAwareRows:(prepared.availabilityAwareRows || []).filter(row=>!fulfilled(row))};
}
