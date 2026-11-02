import { createHash } from 'node:crypto';

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
  return (decision.follow_up_items || []).some(item => item.type === 'quote_send');
}

export function automaticQuoteRequest({ decision, verification, job }) {
  const quote = decision.price_quote;
  const issue = verifiedPricingIssue(verification, quote);
  if (issue) throw new Error(issue);
  if (quote.source !== 'catalog') throw new Error('quote_document_context_required');
  const phone = String(quote.phone || '').replace(/[^0-9]/g, '');
  if (!/^01[016789]\d{7,8}$/.test(phone)) throw new Error('quote_recipient_required');
  if (!quote.customer_name || quote.customer_name.trim() !== decision.customer?.name?.trim()) throw new Error('quote_customer_mismatch');
  const calculation = verification.calculations[0], days = calculation.payment.days;
  if (!Number.isFinite(days) || days <= 0 || days > 366) throw new Error('quote_days_invalid');
  const manualData = {
    고객명: quote.customer_name, 연락처: phone, 할인유형: calculation.discountType,
    대여기간: `${quote.start_date} ${quote.start_time} ~ ${quote.end_date} ${quote.end_time}`,
    items: calculation.pricedItems.map(item => ({품목:item.name, 수량:item.qty, 일수:days, 단가:item.price}))
  };
  const operationId = createHash('sha256').update(JSON.stringify({
    event:job.sourceEventKey || job.eventHash || job.jobId || job.id,
    room:job.roomKey || job.room_key, revision:job.roomRevision || job.room_revision,
    manualData, total:verification.totalVatIncluded
  })).digest('hex');
  return {action:'sendEstimateManual', automaticPricing:true, operationId,
    expectedTotal:verification.totalVatIncluded, manualData};
}

export async function sendAutomaticPricingDocument({ config, decision, verification, job, assertFresh, fetchImpl = fetch }) {
  const body = automaticQuoteRequest({ decision, verification, job });
  if (!config.documentApiBaseUrl || !config.documentApiKey) throw new Error('quote_delivery_not_configured');
  await assertFresh?.();
  const response = await fetchImpl(config.documentApiBaseUrl, {method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify({...body,key:config.documentApiKey}),signal:AbortSignal.timeout(240000)});
  const result = await response.json();
  if (!response.ok || result.status !== 'OK' || result.deliveryConfirmed !== true
    || result.totalVatIncluded !== verification.totalVatIncluded || !result.pdfUrl) {
    const error = new Error('quote_delivery_not_confirmed'); error.result = result; throw error;
  }
  return {schema:'village-auto-pricing-document-receipt/v1',operationId:body.operationId,
    status:'sent',deliveryConfirmed:true,pdfUrl:result.pdfUrl,fileId:result.fileId,
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
  if (result.pricingDocumentReceipt?.deliveryConfirmed === true) completed.add('quote_send');
  if (!completed.size) return prepared;
  const remaining=(prepared.decision.follow_up_items || []).filter(item=>!completed.has(item.type));
  return {...prepared,decision:{...prepared.decision,follow_up_items:remaining,
    reply_decision:{...prepared.decision.reply_decision,shouldCreateTask:remaining.some(item=>item.requiresHumanAction===true)}},
    availabilityAwareRows:(prepared.availabilityAwareRows || []).filter(row=>!completed.has(row.type))};
}
