'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  createConfirmationRequest,
  createConfirmationRequests,
  resolveEquipment,
  updateConfirmationRequest
} = require('./village-confirm-request.js');
const { changeTradeDates } = require('./village-trade-date-change.js');
const { lookupVillage } = require('./village-live-query.js');
const { DEFAULT_ENV_FILE, parseEnv } = require('./village-live-read.js');
const {
  confirmRegistration,
  promoteCandidate,
  validateCandidate
} = require('./village-capability-promote.js');

const POLICIES = Object.freeze({
  READ_ONLY: 'read_only',
  INTERNAL_WRITE: 'internal_write',
  CUSTOMER_SEND: 'customer_send',
  FINAL_REGISTRATION: 'final_registration',
  SYSTEM_ADMIN: 'system_admin'
});

function capability({ title, policy, required = [], optional = [], handler, apiAction, fixed = {}, verification }) {
  return Object.freeze({
    title,
    policy,
    required: Object.freeze([...required]),
    optional: Object.freeze([...optional]),
    handler: handler || 'api',
    apiAction: apiAction || null,
    fixed: Object.freeze({ ...fixed }),
    verification: verification || (policy === POLICIES.READ_ONLY ? 'authoritative_read' : 'unverified_server_result')
  });
}

const CAPABILITIES = Object.freeze({
  'inventory.lookup': capability({ title: 'Search authoritative equipment and set data', policy: POLICIES.READ_ONLY, required: ['query'], optional: ['column'], handler: 'lookup', fixed: { domain: 'inventory' } }),
  'schedule.lookup': capability({ title: 'Search authoritative schedule, request, and contract data', policy: POLICIES.READ_ONLY, required: ['query'], optional: ['column'], handler: 'lookup', fixed: { domain: 'schedule' } }),
  'customer.lookup': capability({ title: 'Search authoritative customer data', policy: POLICIES.READ_ONLY, required: ['query'], optional: ['column'], handler: 'lookup', fixed: { domain: 'customer' } }),
  'finance.lookup': capability({ title: 'Search authoritative transaction and issuer data', policy: POLICIES.READ_ONLY, required: ['query'], optional: ['column'], handler: 'lookup', fixed: { domain: 'finance' } }),
  'documents.lookup': capability({ title: 'Search authoritative contract and request data', policy: POLICIES.READ_ONLY, required: ['query'], optional: ['column'], handler: 'lookup', fixed: { domain: 'documents' } }),
  'schedule.timeline': capability({ title: 'Read the schedule timeline', policy: POLICIES.READ_ONLY, optional: ['from', 'to', 'compact', 'profile'], apiAction: 'timeline' }),
  'operations.daily': capability({ title: 'Read daily operations', policy: POLICIES.READ_ONLY, optional: ['date', 'nocache'], apiAction: 'operations' }),
  'dashboard.search': capability({ title: 'Search the operations dashboard', policy: POLICIES.READ_ONLY, required: ['query'], optional: ['limit', 'profile', 'summary', 'detailGroup'], apiAction: 'dashboardSearch' }),
  'contract.extras': capability({ title: 'Read contract details for trade IDs', policy: POLICIES.READ_ONLY, required: ['tids'], apiAction: 'dashboardContractExtras' }),
  'schedule.trade_candidates': capability({ title: 'Resolve matching trades by customer and date', policy: POLICIES.READ_ONLY, required: ['name', 'date'], apiAction: 'tradeCandidates' }),
  'payment.metadata': capability({ title: 'Read payment-column metadata', policy: POLICIES.READ_ONLY, apiAction: 'paymentMeta' }),
  'confirmation_request.list': capability({ title: 'List pending confirmation requests', policy: POLICIES.READ_ONLY, apiAction: 'list' }),
  'confirmation_request.scan': capability({ title: 'Scan unresolved confirmation requests', policy: POLICIES.READ_ONLY, apiAction: 'scan' }),
  'confirmation_request.resolve_equipment': capability({ title: 'Resolve equipment aliases against the authoritative catalog', policy: POLICIES.READ_ONLY, required: ['queries'], handler: 'resolve_equipment' }),

  'confirmation_request.create': capability({ title: 'Create one AI-planned confirmation request and verify readback', policy: POLICIES.INTERNAL_WRITE, required: ['request'], handler: 'confirmation_create', verification: 'authoritative_readback' }),
  'confirmation_request.create_batch': capability({ title: 'Create multiple AI-planned schedule groups and verify all readbacks', policy: POLICIES.INTERNAL_WRITE, required: ['requests'], handler: 'confirmation_create_batch', verification: 'authoritative_readback' }),
  'confirmation_request.update': capability({ title: 'Replace an existing partial confirmation request and verify readback', policy: POLICIES.INTERNAL_WRITE, required: ['reqID', 'request'], handler: 'confirmation_update', verification: 'authoritative_readback' }),
  'schedule.change_dates': capability({ title: 'Atomically change registered trade dates and verify contract, schedule, and ledger', policy: POLICIES.INTERNAL_WRITE, required: ['newStartDate', 'newEndDate'], optional: ['tradeId', 'name', 'currentDate', 'startTime', 'endTime', 'allowConflicts', 'dryRun'], handler: 'change_dates', verification: 'authoritative_readback' }),
  'schedule.update_time': capability({ title: 'Update schedule time', policy: POLICIES.INTERNAL_WRITE, required: ['row', 'start', 'end'], optional: ['rowIndices'], apiAction: 'updateTime' }),
  'schedule.update_status': capability({ title: 'Update schedule status', policy: POLICIES.INTERNAL_WRITE, required: ['row', 'status'], optional: ['rowIndices'], apiAction: 'updateStatus' }),
  'schedule.toggle_setup': capability({ title: 'Set setup completion state', policy: POLICIES.INTERNAL_WRITE, required: ['tid', 'done'], apiAction: 'toggleSetup' }),
  'schedule.toggle_return': capability({ title: 'Set return completion state', policy: POLICIES.INTERNAL_WRITE, required: ['tid', 'done'], apiAction: 'toggleReturn' }),
  'schedule.toggle_item': capability({ title: 'Set an individual checklist state', policy: POLICIES.INTERNAL_WRITE, required: ['scheduleId', 'phase', 'done'], apiAction: 'toggleItem' }),
  'equipment.check_update': capability({ title: 'Update an equipment check field', policy: POLICIES.INTERNAL_WRITE, required: ['scheduleId', 'field', 'value'], optional: ['tid', 'label'], apiAction: 'updateEquipmentCheck' }),
  'equipment.add': capability({ title: 'Add one equipment item to a trade', policy: POLICIES.INTERNAL_WRITE, required: ['tid', 'equipName'], optional: ['qty', 'dryRun', 'profile', 'directRegenerate'], apiAction: 'addEquip' }),
  'equipment.add_batch': capability({ title: 'Add multiple equipment items to a trade', policy: POLICIES.INTERNAL_WRITE, required: ['tid', 'entries'], optional: ['dryRun', 'profile', 'directRegenerate'], apiAction: 'addEquips' }),
  'equipment.record_onsite_addon': capability({ title: 'Record an on-site equipment addon', policy: POLICIES.INTERNAL_WRITE, required: ['tid', 'entries'], optional: ['dryRun', 'rawNames', 'settlementStatus', 'actorName', 'directRegenerate'], apiAction: 'recordOnsiteAddon' }),
  'equipment.remove': capability({ title: 'Remove equipment from a trade', policy: POLICIES.INTERNAL_WRITE, required: ['tid', 'equipName'], optional: ['scheduleId', 'directRegenerate'], apiAction: 'removeEquip' }),
  'equipment.update_quantity': capability({ title: 'Update equipment quantity', policy: POLICIES.INTERNAL_WRITE, required: ['tid', 'scheduleId', 'qty'], optional: ['dryRun'], apiAction: 'updateEquipQty' }),
  'equipment.update_name': capability({ title: 'Update equipment name', policy: POLICIES.INTERNAL_WRITE, required: ['tid', 'scheduleId', 'equipName'], optional: ['dryRun'], apiAction: 'updateEquipName' }),
  'contract.update_status': capability({ title: 'Update contract status', policy: POLICIES.INTERNAL_WRITE, required: ['tid', 'status'], apiAction: 'updateContractStatus' }),
  'contract.regenerate': capability({ title: 'Regenerate a contract', policy: POLICIES.INTERNAL_WRITE, required: ['tid'], optional: ['extraText'], apiAction: 'regenerateContract' }),
  'payment.update_method': capability({ title: 'Update payment method', policy: POLICIES.INTERNAL_WRITE, required: ['tid', 'method'], apiAction: 'updatePayment' }),
  'billing.update_company': capability({ title: 'Update billing company', policy: POLICIES.INTERNAL_WRITE, required: ['tid', 'billingCompany'], apiAction: 'updateBillingCompany' }),
  'proof.update_field': capability({ title: 'Update transaction proof metadata', policy: POLICIES.INTERNAL_WRITE, required: ['tid', 'field', 'value'], apiAction: 'updateTradeProof' }),
  'dashboard.save_notes': capability({ title: 'Save dashboard notes', policy: POLICIES.INTERNAL_WRITE, required: ['notes'], apiAction: 'saveDashboardNotes' }),
  'dashboard.upload_photo': capability({ title: 'Upload a trade photo', policy: POLICIES.INTERNAL_WRITE, required: ['tid', 'phase', 'fileName', 'mimeType', 'data'], optional: ['memo'], apiAction: 'uploadDashboardPhoto' }),

  'confirmation_request.confirm': capability({ title: 'Confirm a request', policy: POLICIES.INTERNAL_WRITE, required: ['reqID'], apiAction: '확인' }),
  'confirmation_request.hold': capability({ title: 'Hold a request', policy: POLICIES.INTERNAL_WRITE, required: ['reqID'], apiAction: '보류' }),
  'confirmation_request.reject': capability({ title: 'Reject a request', policy: POLICIES.INTERNAL_WRITE, required: ['reqID'], apiAction: '거절' }),
  'confirmation_request.register': capability({ title: 'Perform final reservation registration', policy: POLICIES.FINAL_REGISTRATION, required: ['reqID'], apiAction: '등록' }),
  'customer.send_estimate': capability({ title: 'Send a customer estimate', policy: POLICIES.CUSTOMER_SEND, required: ['tid'], apiAction: 'sendEstimate' }),
  'customer.send_statement': capability({ title: 'Send a customer statement', policy: POLICIES.CUSTOMER_SEND, required: ['tid'], apiAction: 'sendStatement' }),
  'customer.send_payment_link': capability({ title: 'Send a PayApp payment link', policy: POLICIES.CUSTOMER_SEND, required: ['tid'], apiAction: 'sendPayAppPaymentLink' }),
  'customer.issue_proof': capability({ title: 'Issue customer transaction proof', policy: POLICIES.CUSTOMER_SEND, required: ['tid'], apiAction: 'issueProof' }),
  'customer.send_equipment_risk_guidance': capability({ title: 'Send equipment risk guidance', policy: POLICIES.CUSTOMER_SEND, required: ['payload'], apiAction: 'equipmentRiskSend' })
});

function publicCapability(id, spec) {
  return {
    id,
    title: spec.title,
    policy: spec.policy,
    required: [...spec.required],
    optional: [...spec.optional],
    verification: spec.verification
  };
}

function catalog({ policy } = {}) {
  const capabilities = Object.entries(CAPABILITIES)
    .filter(([, spec]) => !policy || spec.policy === policy)
    .map(([id, spec]) => publicCapability(id, spec));
  return {
    ok: true,
    version: 1,
    aiRole: 'semantic_planner',
    executionRole: 'typed_capability_broker',
    liveSourceDiscoveryAllowed: false,
    developmentDiscoveryAllowed: true,
    capabilities
  };
}

function normalizeObject(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
  return value;
}

function hasValue(value) {
  return value !== undefined && value !== null && !(typeof value === 'string' && value.trim() === '');
}

function validateParameters(spec, parameters) {
  const input = normalizeObject(parameters || {}, 'parameters');
  const allowed = new Set([...spec.required, ...spec.optional]);
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) throw new Error(`Unsupported parameter for capability: ${key}`);
  }
  const missing = spec.required.filter((key) => !hasValue(input[key]));
  if (missing.length) throw new Error(`Missing required parameters: ${missing.join(', ')}`);

  if (spec.handler === 'change_dates') {
    const hasTradeId = hasValue(input.tradeId);
    const hasNameAndDate = hasValue(input.name) && hasValue(input.currentDate);
    if (!hasTradeId && !hasNameAndDate) {
      throw new Error('schedule.change_dates requires tradeId, or name and currentDate');
    }
  }
  return { ...input };
}

function assertAuthorization(spec, authorization = {}) {
  const auth = authorization && typeof authorization === 'object' ? authorization : {};
  if (spec.policy !== POLICIES.READ_ONLY && auth.ownerApproved !== true) {
    throw new Error(`${spec.policy} requires authorization.ownerApproved=true from the current request`);
  }
  if (spec.policy === POLICIES.CUSTOMER_SEND && auth.customerSendApproved !== true) {
    throw new Error('customer_send requires authorization.customerSendApproved=true from the current request');
  }
  if (spec.policy === POLICIES.FINAL_REGISTRATION && auth.finalRegistrationApproved !== true) {
    throw new Error('final_registration requires authorization.finalRegistrationApproved=true from the current request');
  }
  if (spec.policy === POLICIES.SYSTEM_ADMIN && auth.systemAdminApproved !== true) {
    throw new Error('system_admin requires authorization.systemAdminApproved=true from the current request');
  }
}

async function prepareOperation({ capability: id, parameters = {}, authorization = {} } = {}) {
  const capabilityId = String(id || '').trim();
  const spec = CAPABILITIES[capabilityId];
  if (!spec) {
    return {
      ok: false,
      ready: false,
      status: 'CAPABILITY_GAP',
      capability: capabilityId,
      liveSourceDiscoveryAllowed: false,
      developmentDiscoveryAllowed: true,
      mustResumeOriginalRequest: true,
      next: 'discover_validate_promote_confirm_resume',
      recordLearning: true
    };
  }
  const normalized = validateParameters(spec, parameters);
  assertAuthorization(spec, authorization);
  return {
    ok: true,
    ready: true,
    capability: capabilityId,
    policy: spec.policy,
    parameters: normalized,
    verification: spec.verification,
    next: 'execute'
  };
}

function apiBase(config) {
  const apiUrl = config?.VILLAGE2_API_URL;
  const apiKey = config?.VILLAGE2_API_KEY;
  if (!apiUrl || !apiKey) throw new Error('Village operation configuration is incomplete');
  const url = new URL(apiUrl);
  if (url.protocol !== 'https:' || url.hostname !== 'script.google.com') {
    throw new Error('Village operation endpoint must use https://script.google.com');
  }
  return { url, apiKey };
}

function buildApiRequest(config, spec, parameters) {
  const { url, apiKey } = apiBase(config);
  return {
    method: 'POST',
    url: url.toString(),
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ key: apiKey, action: spec.apiAction, ...spec.fixed, ...parameters })
  };
}

async function callApi({ config, spec, parameters, fetchImpl, timeoutMs }) {
  if (typeof fetchImpl !== 'function') throw new Error('fetch is unavailable');
  const request = buildApiRequest(config, spec, parameters);
  const response = await fetchImpl(request.url, {
    method: request.method,
    headers: request.headers,
    body: request.body,
    redirect: 'follow',
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!response?.ok) throw new Error(`Village capability failed with HTTP ${response?.status ?? 'unknown'}`);
  const payload = await response.json();
  if (!payload || payload.error || payload.success === false || payload.status === 'ERROR') {
    throw new Error(`Village capability failed: ${String(payload?.error || payload?.message || payload?.status || 'empty response')}`);
  }
  return payload;
}

function compactValue(value, depth = 0) {
  if (depth >= 5) return '[depth-limited]';
  if (typeof value === 'string') return value.length > 600 ? `${value.slice(0, 600)}…` : value;
  if (Array.isArray(value)) {
    const items = value.slice(0, 20).map((item) => compactValue(item, depth + 1));
    if (value.length > items.length) items.push({ omittedItems: value.length - items.length });
    return items;
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).slice(0, 60).map(([key, item]) => [key, compactValue(item, depth + 1)]));
  }
  return value;
}

function boundPayload(payload) {
  const serialized = JSON.stringify(payload);
  if (serialized.length <= 18_000) return payload;
  const preview = compactValue(payload);
  const compact = JSON.stringify(preview);
  return {
    truncated: true,
    originalCharacters: serialized.length,
    preview: compact.length <= 18_000 ? preview : compact.slice(0, 17_000)
  };
}

function defaultHandlers() {
  return {
    changeTradeDates,
    createConfirmationRequest,
    createConfirmationRequests,
    lookupVillage,
    resolveEquipment,
    updateConfirmationRequest
  };
}

async function executeSpecialized({ spec, parameters, config, handlers }) {
  switch (spec.handler) {
    case 'lookup':
      return handlers.lookupVillage({ config, ...spec.fixed, ...parameters });
    case 'resolve_equipment':
      return handlers.resolveEquipment({ config, queries: parameters.queries });
    case 'confirmation_create':
      return handlers.createConfirmationRequest({ config, request: parameters.request });
    case 'confirmation_create_batch':
      return handlers.createConfirmationRequests({ config, requests: parameters.requests });
    case 'confirmation_update':
      return handlers.updateConfirmationRequest({ config, reqID: parameters.reqID, request: parameters.request });
    case 'change_dates':
      return handlers.changeTradeDates({ config, input: parameters });
    default:
      throw new Error(`Unknown specialized Village capability handler: ${spec.handler}`);
  }
}

async function executeOperation({
  config,
  capability: id,
  parameters = {},
  authorization = {},
  fetchImpl = globalThis.fetch,
  timeoutMs = 240_000,
  handlers = {}
} = {}) {
  const prepared = await prepareOperation({ capability: id, parameters, authorization });
  if (!prepared.ok) return prepared;
  const spec = CAPABILITIES[prepared.capability];
  const availableHandlers = { ...defaultHandlers(), ...handlers };
  const payload = spec.handler === 'api'
    ? await callApi({ config, spec, parameters: prepared.parameters, fetchImpl, timeoutMs })
    : await executeSpecialized({ spec, parameters: prepared.parameters, config, handlers: availableHandlers });

  if (spec.verification === 'unverified_server_result') {
    return {
      ok: false,
      status: 'UNVERIFIED_WRITE',
      capability: prepared.capability,
      policy: spec.policy,
      executionCount: 1,
      verification: spec.verification,
      verified: false,
      mutationMayHaveOccurred: true,
      retryAllowed: false,
      next: 'reconcile_authoritative_state',
      result: boundPayload(payload)
    };
  }

  return {
    ok: payload?.ok !== false,
    capability: prepared.capability,
    policy: spec.policy,
    executionCount: 1,
    verification: spec.verification,
    result: boundPayload(payload)
  };
}

function recordLearning({ capability: id, summary, evidence = {}, hermesHome = process.env.HERMES_HOME } = {}) {
  const capabilityId = String(id || '').trim();
  const text = String(summary || '').trim();
  if (!capabilityId || !text || text.length > 2_000) throw new Error('record_learning requires capability and a 1-2000 character summary');
  if (!hermesHome) throw new Error('HERMES_HOME is required to record Village learning');
  const learningDir = path.join(hermesHome, 'learning');
  const learningPath = path.join(learningDir, 'village-capability-learning.ndjson');
  fs.mkdirSync(learningDir, { recursive: true });
  fs.appendFileSync(learningPath, `${JSON.stringify({
    recordedAt: new Date().toISOString(),
    capability: capabilityId,
    summary: text,
    evidence: compactValue(evidence)
  })}\n`, 'utf8');
  return { ok: true, recorded: true, capability: capabilityId, queue: 'village-capability-learning' };
}

function parseInput(text) {
  return JSON.parse(String(text || '').replace(/^\uFEFF/, ''));
}

async function runBroker(input, { config, promotionHandlers = {}, fetchImpl = globalThis.fetch, handlers = {} } = {}) {
  const request = normalizeObject(input, 'input');
  const phase = String(request.phase || '').trim();
  if (phase === 'catalog') return catalog({ policy: request.policy });
  if (phase === 'prepare') return prepareOperation(request);
  if (phase === 'validate_candidate') {
    return (promotionHandlers.validateCandidate || validateCandidate)(request);
  }
  if (phase === 'promote') {
    assertAuthorization({ policy: POLICIES.SYSTEM_ADMIN }, request.authorization);
    return (promotionHandlers.promoteCandidate || promoteCandidate)(request);
  }
  if (phase === 'confirm_registration') {
    return (promotionHandlers.confirmRegistration || confirmRegistration)(request);
  }
  if (phase === 'reconcile') {
    const spec = CAPABILITIES[String(request.capability || '').trim()];
    if (!spec || spec.policy !== POLICIES.READ_ONLY) {
      throw new Error('phase=reconcile accepts only a registered read_only capability');
    }
    const runtimeConfig = config || parseEnv(fs.readFileSync(request.envFile || DEFAULT_ENV_FILE, 'utf8'));
    const result = await executeOperation({ ...request, config: runtimeConfig, authorization: {}, fetchImpl, handlers });
    return { ...result, reconciliation: true };
  }
  if (phase === 'record_learning') return recordLearning(request);
  if (phase === 'complete') return { ok: true, completed: true, capability: String(request.capability || '') };
  if (phase !== 'execute') {
    throw new Error('phase must be catalog, prepare, validate_candidate, promote, confirm_registration, reconcile, execute, record_learning, or complete');
  }
  const runtimeConfig = config || parseEnv(fs.readFileSync(request.envFile || DEFAULT_ENV_FILE, 'utf8'));
  return executeOperation({ ...request, config: runtimeConfig, fetchImpl, handlers });
}

async function main() {
  const input = parseInput(fs.readFileSync(0, 'utf8'));
  const result = await runBroker(input);
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (result?.ok === false && result?.status !== 'CAPABILITY_GAP') process.exitCode = 2;
}

module.exports = {
  CAPABILITIES,
  POLICIES,
  boundPayload,
  buildApiRequest,
  catalog,
  executeOperation,
  prepareOperation,
  recordLearning,
  runBroker,
  validateParameters
};

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${JSON.stringify({ ok: false, error: error.message, code: error.code || 'BROKER_ERROR' })}\n`);
    process.exitCode = 1;
  });
}
