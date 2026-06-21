function encodeParams(params) {
  return new URLSearchParams(params).toString();
}

export function buildTradeCandidatesUrl({ baseUrl, apiKey, resolver, redactKey = true }) {
  if (!baseUrl) throw new Error('baseUrl is required');
  if (!apiKey) throw new Error('apiKey is required');
  if (!resolver || resolver.strategy !== 'customer_date') {
    throw new Error('customer_date resolver is required');
  }

  return `${baseUrl}?${encodeParams({
    key: redactKey ? '***' : apiKey,
    action: 'tradeCandidates',
    name: resolver.customerName,
    date: resolver.date,
  })}`;
}

export function selectUniqueTradeCandidate(payload = {}) {
  const candidates = Array.isArray(payload.candidates) ? payload.candidates : [];
  if (candidates.length === 1 && candidates[0]?.tradeId) {
    return { ok: true, tradeId: candidates[0].tradeId, candidate: candidates[0] };
  }
  if (candidates.length === 0) {
    return { ok: false, reason: 'not_found', candidates };
  }
  return { ok: false, reason: 'ambiguous', candidates };
}

export function buildDocumentAction({ intent, tradeId }) {
  if (!tradeId) throw new Error('tradeId is required');

  if (intent === 'send_quote') {
    return {
      project: 'my-gas-project',
      method: 'POST',
      body: { action: 'sendEstimate', id: tradeId },
    };
  }

  if (intent === 'send_statement') {
    return {
      project: 'my-gas-project',
      method: 'POST',
      body: { action: 'sendStatement', id: tradeId },
    };
  }

  if (intent === 'issue_proof') {
    return {
      project: 'my-gas-project',
      method: 'POST',
      body: { action: 'issueProof', id: tradeId },
    };
  }

  if (intent === 'contract_link' || intent === 'send_contract_link') {
    return {
      project: 'my-gas-project',
      method: 'GET',
      query: { action: 'info', id: tradeId },
    };
  }

  throw new Error(`Unsupported document intent: ${intent}`);
}
