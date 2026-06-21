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

function parseCliArgs(argv) {
  const execute = argv.includes('--execute');
  const input = argv.filter((arg) => arg !== '--execute').join(' ').trim();
  return { execute, input };
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const { execute, input } = parseCliArgs(argv);
  if (!input) throw new Error('사용법: node tools/village-doc-send/runner.mjs "6월 1일 김태완 건 견적서 발송해줘" [--execute]');

  const options = {
    scheduleApiBaseUrl: env.VILLAGE_SCHEDULE_API_URL,
    scheduleApiKey: env.VILLAGE_SCHEDULE_API_KEY,
    documentApiBaseUrl: env.VILLAGE_DOCUMENT_API_URL,
    documentApiKey: env.VILLAGE_DOCUMENT_API_KEY || env.VILLAGE_OPS_KEY,
  };

  const result = execute
    ? await executeVillageDocumentCommand(input, options)
    : await planVillageDocumentCommand(input, options);

  console.log(JSON.stringify(result, null, 2));
  return result;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error.stack || error.message || String(error));
    process.exit(1);
  });
}
