import { parseVillageDocumentCommand } from './intent.mjs';
import {
  buildDocumentAction,
  buildTradeCandidatesUrl,
  selectUniqueTradeCandidate,
} from './resolver.mjs';

async function defaultFetchJson(url, options) {
  const response = await fetch(url, options);
  const text = await response.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch (error) {
    throw new Error(`Non-JSON response: ${text.slice(0, 200)}`);
  }
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${JSON.stringify(json).slice(0, 200)}`);
  }
  return json;
}

function requireOption(value, name) {
  if (!value) throw new Error(`${name} is required`);
  return value;
}

export async function planVillageDocumentCommand(input, options = {}) {
  const parsed = parseVillageDocumentCommand(input, { now: options.now });
  if (parsed.outOfScopePaymentUpdate) {
    return { ok: false, reason: 'payment_out_of_scope_for_document_channel', parsed };
  }
  if (!parsed.documentType && parsed.intent === 'unknown') {
    return { ok: false, reason: 'unknown_intent', parsed };
  }

  let tradeId = parsed.tradeId;
  let candidate = null;

  if (!tradeId) {
    if (parsed.resolver.strategy !== 'customer_date') {
      return { ok: false, reason: 'needs_customer_and_date', parsed };
    }

    const url = buildTradeCandidatesUrl({
      baseUrl: requireOption(options.scheduleApiBaseUrl, 'scheduleApiBaseUrl'),
      apiKey: requireOption(options.scheduleApiKey, 'scheduleApiKey'),
      resolver: parsed.resolver,
      redactKey: false,
    });
    const payload = await (options.fetchJson || defaultFetchJson)(url);
    const selected = selectUniqueTradeCandidate(payload);
    if (!selected.ok) {
      return { ok: false, reason: selected.reason, parsed, candidates: selected.candidates };
    }
    tradeId = selected.tradeId;
    candidate = selected.candidate;
  }

  if (!parsed.shouldSend && ['prepare_quote', 'prepare_statement', 'prepare_proof'].includes(parsed.intent)) {
    return { ok: false, reason: 'not_send_request', parsed, tradeId, candidate };
  }

  const actions = [];
  const documentAction = buildDocumentAction({ intent: parsed.intent, tradeId });
  if (documentAction) actions.push(documentAction);

  if (actions.length === 0) {
    return { ok: false, reason: 'unknown_intent', parsed, tradeId, candidate };
  }

  return { ok: true, parsed, tradeId, candidate, action: actions[0], actions };
}

function buildDocumentRequest({ documentApiBaseUrl, documentApiKey, action }) {
  const baseUrl = requireOption(documentApiBaseUrl, 'documentApiBaseUrl');
  const key = requireOption(documentApiKey, 'documentApiKey');

  if (action.method === 'POST') {
    return {
      url: baseUrl,
      options: {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...action.body, key }),
      },
    };
  }

  if (action.method === 'GET') {
    const url = new URL(baseUrl);
    Object.entries({ ...action.query, key }).forEach(([k, v]) => url.searchParams.set(k, v));
    return { url: String(url), options: { method: 'GET' } };
  }

  throw new Error(`Unsupported document method: ${action.method}`);
}

export async function executeVillageDocumentCommand(input, options = {}) {
  const plan = await planVillageDocumentCommand(input, options);
  if (!plan.ok) return plan;

  if (!plan.parsed.shouldSend && plan.actions.some((action) => action.method === 'POST')) {
    return { ok: false, reason: 'not_send_request', plan };
  }

  const responses = [];
  for (const action of plan.actions) {
    const request = buildDocumentRequest({
      documentApiBaseUrl: options.documentApiBaseUrl,
      documentApiKey: options.documentApiKey,
      action,
    });
    const response = await (options.fetchJson || defaultFetchJson)(request.url, request.options);
    responses.push({ action, response });
    const success = !response?.error && response?.status !== 'ERROR';
    if (!success) {
      return {
        ok: false,
        reason: 'document_api_error',
        parsed: plan.parsed,
        tradeId: plan.tradeId,
        candidate: plan.candidate,
        action,
        actions: plan.actions,
        response,
        responses,
      };
    }
  }

  return {
    ok: true,
    parsed: plan.parsed,
    tradeId: plan.tradeId,
    candidate: plan.candidate,
    action: plan.action,
    actions: plan.actions,
    response: responses[responses.length - 1]?.response,
    responses,
  };
}

function validateManualQuoteRequest(request = {}) {
  const mode = String(request.mode || '').trim();
  if (!['preview', 'send'].includes(mode)) {
    return { ok: false, reason: 'invalid_manual_quote_mode' };
  }

  const source = request.manual_data;
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    return { ok: false, reason: 'invalid_manual_quote_data' };
  }

  const customerName = String(source.고객명 || '').trim();
  if (!customerName) return { ok: false, reason: 'missing_manual_quote_customer' };

  const rentalPeriod = String(source.대여기간 || '').trim();
  if (!rentalPeriod) return { ok: false, reason: 'missing_manual_quote_period' };

  const items = Array.isArray(source.items) ? source.items : [];
  const validItems = items.length > 0 && items.every((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
    const name = String(item.품목 || '').trim();
    const quantity = Number(item.수량 ?? 1);
    const days = Number(item.일수 ?? 1);
    const unitPrice = Number(item.단가 ?? 0);
    return Boolean(name)
      && Number.isFinite(quantity) && quantity > 0
      && Number.isFinite(days) && days > 0
      && Number.isFinite(unitPrice) && unitPrice >= 0;
  });
  if (!validItems) return { ok: false, reason: 'invalid_manual_quote_items' };

  const phone = String(source.연락처 || '').trim();
  if (mode === 'send' && !phone) {
    return { ok: false, reason: 'missing_manual_quote_phone' };
  }

  return {
    ok: true,
    mode,
    manualData: {
      ...source,
      고객명: customerName,
      연락처: mode === 'preview' ? '' : phone,
      대여기간: rentalPeriod,
      items: items.map((item) => ({ ...item, 품목: String(item.품목).trim() }))
    }
  };
}

async function executeVillageManualQuoteRequest(request, options = {}) {
  const validated = validateManualQuoteRequest(request);
  if (!validated.ok) return validated;

  const action = {
    project: 'my-gas-project',
    method: 'POST',
    body: {
      action: 'sendEstimateManual',
      manualData: validated.manualData
    }
  };
  const outbound = buildDocumentRequest({
    documentApiBaseUrl: options.documentApiBaseUrl,
    documentApiKey: options.documentApiKey,
    action
  });
  const response = await (options.fetchJson || defaultFetchJson)(outbound.url, outbound.options);
  const preview = validated.mode === 'preview';
  const artifactCreated = Boolean(response?.fileId || response?.url);
  const success = preview
    ? artifactCreated
    : String(response?.status || '').toUpperCase() === 'OK';

  return success
    ? {
        ok: true,
        documentType: 'quote',
        manual: true,
        preview,
        sent: !preview,
        action,
        response
      }
    : {
        ok: false,
        reason: 'document_api_error',
        documentType: 'quote',
        manual: true,
        preview,
        sent: false,
        action,
        response
      };
}

export async function executeVillageDocumentRequest(request = {}, options = {}) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    return { ok: false, reason: 'invalid_document_request' };
  }
  const documentType = String(request.document_type || '').trim();
  if (documentType === 'quote' && request.manual_data !== undefined) {
    return executeVillageManualQuoteRequest(request, options);
  }
  const tradeId = String(request.trade_id || '').trim();
  const taxMode = String(request.tax_mode || 'vat_included').trim();
  if (documentType !== 'quote') return { ok: false, reason: 'unsupported_document_type' };
  if (!/^\d{6}-\d{3}$/.test(tradeId)) return { ok: false, reason: 'invalid_trade_id' };
  if (!['vat_included', 'supply_only'].includes(taxMode)) return { ok: false, reason: 'invalid_tax_mode' };

  const action = buildDocumentAction({ intent: 'send_quote', tradeId, taxMode });
  const outbound = buildDocumentRequest({
    documentApiBaseUrl: options.documentApiBaseUrl,
    documentApiKey: options.documentApiKey,
    action
  });
  const response = await (options.fetchJson || defaultFetchJson)(outbound.url, outbound.options);
  const success = !response?.error && response?.status !== 'ERROR';
  return success
    ? { ok: true, documentType, tradeId, taxMode, action, response }
    : { ok: false, reason: 'document_api_error', documentType, tradeId, taxMode, action, response };
}

function parseCliArgs(argv) {
  const requestIndex = argv.indexOf('--request-base64');
  if (requestIndex >= 0) {
    const encoded = String(argv[requestIndex + 1] || '').trim();
    if (!encoded) throw new Error('--request-base64 requires a base64url JSON payload');
    let request;
    try {
      request = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    } catch (error) {
      throw new Error(`Invalid --request-base64 payload: ${error.message}`);
    }
    return { execute: true, input: '', request };
  }
  const execute = argv.includes('--execute');
  const input = argv.filter((arg) => arg !== '--execute').join(' ').trim();
  return { execute, input, request: null };
}

export async function main(argv = process.argv.slice(2), env = process.env, runtime = {}) {
  const { execute, input, request } = parseCliArgs(argv);
  if (!input && !request) throw new Error('사용법: node tools/village-doc-send/runner.mjs "6월 1일 김태완 건 견적서 발송해줘" [--execute] | --request-base64 <base64url-json>');

  const options = {
    scheduleApiBaseUrl: env.VILLAGE_SCHEDULE_API_URL,
    scheduleApiKey: env.VILLAGE_SCHEDULE_API_KEY,
    documentApiBaseUrl: env.VILLAGE_DOCUMENT_API_URL,
    documentApiKey: env.VILLAGE_DOCUMENT_API_KEY || env.VILLAGE_OPS_KEY,
    ...(typeof runtime.fetchJson === 'function' ? { fetchJson: runtime.fetchJson } : {})
  };

  const result = request
    ? await executeVillageDocumentRequest(request, options)
    : (execute
        ? await executeVillageDocumentCommand(input, options)
        : await planVillageDocumentCommand(input, options));

  const log = typeof runtime.log === 'function' ? runtime.log : console.log;
  log(JSON.stringify(result, null, 2));
  return result;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error.stack || error.message || String(error));
    process.exit(1);
  });
}
