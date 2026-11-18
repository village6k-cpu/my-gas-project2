// The AI chooses the requested document, trade and missing customer facts.
// These helpers validate that typed plan and reuse the existing document APIs.
const record = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const documentTypes = new Set(['quote', 'statement']);
const customerFields = new Set(['customer_name', 'phone', 'rental_period', 'equipment', 'discount_type',
  'document_type', 'trade_selection', 'recipient_authority']);
export const priceSourceKey = value => JSON.stringify(value, (_key, item) => record(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);

export function documentWorkflowErrors(decision = {}, {roomSnapshot} = {}) {
  const errors = [];
  if (decision.document_requests != null) {
    const requests = decision.document_requests;
    if (!Array.isArray(requests) || !requests.length || requests.length > 8) {
      errors.push('document_requests must contain 1 to 8 independently verified documents');
    } else {
      const seen = new Set(), taskKeys = new Set();
      for (const request of requests) {
        if (!record(request) || !documentTypes.has(request.document_type)
          || Object.keys(request).some(key => !['document_type', 'price_quote', 'booking_customer_name', 'task_key'].includes(key))
          || typeof request.task_key !== 'string' || !request.task_key.trim() || request.task_key.length > 240
          || !record(request.price_quote) || !['trade', 'request', 'catalog'].includes(request.price_quote.source)) {
          errors.push('invalid typed document request'); continue;
        }
        const quote = request.price_quote;
        if (quote.source !== 'catalog' && (Object.keys(quote).some(key => !['source', 'id'].includes(key))
          || !(quote.source === 'trade' ? /^\d{6}-\d{3}$/ : /^RQ-\d{6}-\d{3}$/).test(quote.id || ''))) {
          errors.push('document request requires an exact live reference');
        }
        if (request.document_type === 'statement' && (quote.source !== 'trade'
          || typeof request.booking_customer_name !== 'string' || !request.booking_customer_name.trim())) {
          errors.push('statement request requires a registered trade and booking customer');
        }
        const key = request.document_type + ':' + priceSourceKey(quote);
        if (seen.has(key)) errors.push('duplicate document request');
        seen.add(key);
        if (taskKeys.has(request.task_key)) errors.push('each document needs a distinct follow-up task_key');
        taskKeys.add(request.task_key);
        if (Array.isArray(decision.follow_up_items)) {
          const tasks = decision.follow_up_items.filter(item => (item.taskKey || item.task_key) === request.task_key);
          if (tasks.length !== 1 || tasks[0].type !== (request.document_type === 'quote' ? 'quote_send' : 'contract_document')) {
            errors.push('each document request must name its exact document follow-up task_key');
          }
        }
      }
    }
    if (decision.price_quote != null || decision.statement_request != null) {
      errors.push('document_requests replaces the single price_quote and statement_request fields');
    }
  }
  if (decision.document_clarification != null) {
    const clarification = decision.document_clarification;
    if (!record(clarification) || !documentTypes.has(clarification.document_type)
      || Object.keys(clarification).some(key => !['document_type', 'missing_fields', 'customer_message_ids'].includes(key))
      || !Array.isArray(clarification.missing_fields) || !clarification.missing_fields.length
      || clarification.missing_fields.some(field => !customerFields.has(field))
      || !Array.isArray(clarification.customer_message_ids) || !clarification.customer_message_ids.length
      || clarification.customer_message_ids.some(id => typeof id !== 'string' || !id.trim())) {
      errors.push('document_clarification requires explicit missing customer facts and message IDs');
    } else if (roomSnapshot) {
      const messages = roomSnapshot.navigation?.conversation_evidence?.messages || [];
      for (const id of clarification.customer_message_ids) {
        const message = messages.find(item => item.message_id === id);
        // Unknown sender metadata is interpreted by the AI from the supplied
        // full conversation. Known opposing roles must never be contradicted.
        if (!message || !['customer', 'unknown'].includes(message.role)) {
          errors.push('document clarification must cite this room customer request');
        }
      }
    }
    if (decision.price_quote != null || decision.statement_request != null || decision.document_requests != null) {
      errors.push('ask for missing document facts before planning delivery');
    }
  }
  return errors;
}

export function documentClarificationConfigured(config, decision) {
  const reply = decision.reply_decision || {};
  return config.verifiedPricingAutoSendEnabled === true
    && decision.document_clarification != null && !documentWorkflowErrors(decision).length
    && reply.safetyClass === 'contact_request' && reply.grounding === 'visible_conversation'
    && reply.requiresRag === false;
}

export function documentDecisions(decision) {
  const errors = documentWorkflowErrors(decision);
  if (errors.length) throw new Error('invalid_document_plan');
  return decision.document_requests.map(request => ({
    customer: decision.customer,
    price_quote: request.price_quote,
    ...(request.document_type === 'statement' ? {statement_request: {
      trade_id: request.price_quote.id, booking_customer_name: request.booking_customer_name
    }} : {})
  }));
}

export async function verifyDocumentPlan(decision, lookup) {
  documentDecisions(decision);
  const distinct = new Map();
  for (const request of decision.document_requests) {
    const key = priceSourceKey(request.price_quote);
    if (!distinct.has(key)) distinct.set(key, lookup(request.price_quote));
  }
  const values = new Map(await Promise.all([...distinct].map(async ([key, result]) => [key, await result])));
  const verifications = [...values.values()];
  return {required: true, complete: verifications.every(value => value.complete === true),
    totalVatIncluded: verifications.reduce((total, value) => total + (value.totalVatIncluded || 0), 0),
    calculations: verifications.flatMap(value => value.calculations || []),
    unresolved: verifications.flatMap(value => value.unresolved || []),
    documents: decision.document_requests.map(request => ({request, verification: values.get(priceSourceKey(request.price_quote))}))};
}

export const DOCUMENT_WORKFLOW_PROMPT = `CUSTOMER-REQUESTED AUTOMATIC DOCUMENT WORKFLOW:
- A customer's current request for an official quotation or transaction statement authorizes this automatic workflow when exact identity, all billable items, period, discount and VAT total are verified. Do not ask the owner to approve an unchanged, fully verified document again. The staff manual-preview workflow does not override this host-verified customer-request workflow. Custom billing edits, unknown shop prices, discount exceptions and genuine conflicting authority still require specific owner review.
- Read the entire current customer turn and existing open document context. If a customer fact is genuinely missing, look in this conversation, room memo, exact registered records and customer DB first. Then ask ONE focused customer question now: document_clarification={document_type:"quote"|"statement",missing_fields:["customer_name"|"phone"|"rental_period"|"equipment"|"discount_type"|"document_type"|"trade_selection"|"recipient_authority"],customer_message_ids:[exact snapshot IDs]}; classification="document_request", replyMode="auto_send", confidence="high", safetyClass="contact_request", grounding="visible_conversation", requiresRag=false, owner_review_required=false. Request only facts still missing from those sources, and include each requested fact in missing_fields. Never ask again for a known name, contact, equipment, date or discount. Keep the same document task open, with its exact customer request and missing fact; a question is not document delivery. Do not leave a routine question in a draft or only tell the owner to check it. Do not ask customers for internal trade IDs, catalog prices, staff approvals or matters already answered.
- On the customer's answer, resolve the SAME document request from the full conversation and current records. Do not treat a name/date/yes/thank-you as erasing an unfinished document request. Do not re-ask known facts or regenerate already delivered documents. A meaningful customer amendment takes precedence over older requests.
- Multiple rental periods, or quote AND statement: resolve and read kind=quote for EVERY exact source, then set document_requests=[{document_type:"quote"|"statement",task_key:the exact corresponding follow_up_items.taskKey,price_quote:{source:"trade"|"request",id:exact ID} OR the complete source:"catalog" quote object,booking_customer_name:exact booker for statements}]. Omit top-level price_quote and statement_request for this array. Include every requested document, at most 8, and one exact document follow-up per source/type. Independently verify all periods; do not abandon a complete multi-period request merely because the single-price path cannot handle it. Host preflights ALL recipients/amounts before sending any document, then sends each with its own durable operation/receipt. If quote and statement share one trade, its monetary total is counted once, not twice.
- For a single document the existing price_quote/statement_request protocol remains valid. For either protocol, use sensitive_commitment + authoritative_sheet + requiresRag=false + auto_send and state the verified VAT-inclusive total (for several periods include the distinct-trade combined total as well as each period); retain requested document tasks as host execution intent. No village_document_send call and no delivery claim before host confirmation. A calculated total or prepared PDF is not a delivery receipt.
- Apply referral only from exact request/trade payment.referralRate. Keep a requested referral quote open until that discount is verified. Never invent discounts or omit billable items. Record the exact unresolved fact and source, not '전체 확인 필요'.`;
