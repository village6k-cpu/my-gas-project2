'use strict';

const crypto = require('node:crypto');
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
  rollbackPromotion,
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
    verification: verification || (policy === POLICIES.READ_ONLY ? 'authoritative_read' : 'authoritative_server_ack')
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
  'operation.receipt': capability({ title: 'Read the durable receipt for one Hermes mutation', policy: POLICIES.READ_ONLY, required: ['operationId'], apiAction: 'operationReceipt' }),

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

// Only routes with an automatic target-and-outcome verifier belong here. A
// merely successful read is never enough to authorize retrying or completing
// an uncertain write.
const RECONCILIATION_ROUTES = Object.freeze({
  'payment.update_method': Object.freeze({
    readers: Object.freeze(['finance.lookup']),
    sheets: Object.freeze(['거래내역']),
    target: Object.freeze({ source: 'tid', aliases: Object.freeze(['tid', 'tradeId', '거래ID']) }),
    expected: Object.freeze([
      Object.freeze({ source: 'method', aliases: Object.freeze(['method', 'paymentMethod', '결제방법', '결제수단']), normalizer: 'payment_method' })
    ])
  }),
  'contract.update_status': Object.freeze({
    readers: Object.freeze(['schedule.lookup']),
    sheets: Object.freeze(['계약마스터']),
    target: Object.freeze({ source: 'tid', aliases: Object.freeze(['tid', 'tradeId', '거래ID']) }),
    expected: Object.freeze([
      Object.freeze({ source: 'status', aliases: Object.freeze(['status', 'contractStatus', '계약상태', '상태']) })
    ])
  }),
  'billing.update_company': Object.freeze({
    readers: Object.freeze(['finance.lookup']),
    sheets: Object.freeze(['거래내역']),
    target: Object.freeze({ source: 'tid', aliases: Object.freeze(['tid', 'tradeId', '거래ID']) }),
    expected: Object.freeze([
      Object.freeze({ source: 'billingCompany', aliases: Object.freeze(['billingCompany', '청구업체', '청구회사']) })
    ])
  })
});

function publicCapability(id, spec) {
  const result = {
    id,
    title: spec.title,
    policy: spec.policy,
    required: [...spec.required],
    optional: [...spec.optional],
    verification: spec.verification
  };
  const reconciliation = RECONCILIATION_ROUTES[id];
  const reconciliationCapabilities = [
    ...(reconciliation?.readers || []),
    ...(spec.verification === 'authoritative_server_ack' ? ['operation.receipt'] : [])
  ];
  if (reconciliationCapabilities.length) {
    result.reconciliationCapabilities = [...new Set(reconciliationCapabilities)];
  }
  return result;
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

function buildApiRequest(config, spec, parameters, { operationId = '', capabilityId = '' } = {}) {
  const { url, apiKey } = apiBase(config);
  const operation = String(operationId || '').trim();
  return {
    method: 'POST',
    url: url.toString(),
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify({
      key: apiKey,
      action: spec.apiAction,
      ...spec.fixed,
      ...parameters,
      ...(operation ? { operationId: operation, capability: capabilityId } : {})
    })
  };
}

function stableJson(value) {
  if (value === null || value === undefined) return JSON.stringify(value === undefined ? null : value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function operationRequestDigest(capabilityId, spec, parameters) {
  return crypto.createHash('sha256').update(stableJson({
    capability: capabilityId,
    action: spec.apiAction,
    parameters: { ...spec.fixed, ...(parameters || {}) }
  })).digest('hex');
}

async function callApi({ config, spec, parameters, fetchImpl, timeoutMs, operationId, capabilityId }) {
  if (typeof fetchImpl !== 'function') throw new Error('fetch is unavailable');
  let networkStarted = false;
  try {
    const request = buildApiRequest(config, spec, parameters, { operationId, capabilityId });
    networkStarted = true;
    const response = await fetchImpl(request.url, {
      method: request.method,
      headers: request.headers,
      body: request.body,
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs)
    });
    if (!response?.ok) throw new Error(`Village capability failed with HTTP ${response?.status ?? 'unknown'}`);
    const payload = await response.json();
    if (!payload || payload.error || payload.ok === false || payload.success === false || payload.status === 'ERROR') {
      throw new Error(`Village capability failed: ${String(payload?.error || payload?.message || payload?.status || 'empty response')}`);
    }
    return payload;
  } catch (error) {
    if (error && typeof error === 'object') {
      error.mutationMayHaveOccurred = networkStarted && spec.policy !== POLICIES.READ_ONLY;
      if (operationId) error.operationId = operationId;
    }
    throw error;
  }
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
  operationId = '',
  handlers = {}
} = {}) {
  const prepared = await prepareOperation({ capability: id, parameters, authorization });
  if (!prepared.ok) return prepared;
  const spec = CAPABILITIES[prepared.capability];
  const availableHandlers = { ...defaultHandlers(), ...handlers };
  const effectiveOperationId = spec.policy !== POLICIES.READ_ONLY && spec.verification === 'authoritative_server_ack'
    ? String(operationId || `${Math.floor(Date.now() / 1000)}-${crypto.randomUUID()}`)
    : '';
  let payload;
  try {
    payload = spec.handler === 'api'
      ? await callApi({
        config,
        spec,
        parameters: prepared.parameters,
        fetchImpl,
        timeoutMs,
        operationId: effectiveOperationId,
        capabilityId: prepared.capability
      })
      : await executeSpecialized({ spec, parameters: prepared.parameters, config, handlers: availableHandlers });
  } catch (error) {
    if (error && typeof error === 'object' && error.mutationMayHaveOccurred === undefined) {
      error.mutationMayHaveOccurred = spec.policy !== POLICIES.READ_ONLY && spec.handler !== 'api';
      if (effectiveOperationId) error.operationId = effectiveOperationId;
    }
    throw error;
  }

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
    verified: payload?.ok !== false,
    readback: spec.verification === 'authoritative_readback',
    writeAcknowledged: spec.verification === 'authoritative_server_ack',
    ...(effectiveOperationId ? { operationId: effectiveOperationId } : {}),
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

function comparable(value, normalizer = '') {
  let text = String(value ?? '').trim().toLowerCase().replace(/[\s_-]+/g, '');
  if (normalizer === 'payment_method') {
    const methods = new Map([
      ['card', 'card'], ['creditcard', 'card'], ['카드', 'card'], ['카드결제', 'card'], ['신용카드', 'card'],
      ['cash', 'cash'], ['현금', 'cash'],
      ['transfer', 'transfer'], ['banktransfer', 'transfer'], ['계좌이체', 'transfer'], ['이체', 'transfer']
    ]);
    text = methods.get(text) || text;
  }
  return text;
}

function collectRows(value, output = [], depth = 0, inheritedSheet = '') {
  if (depth > 8 || value === null || value === undefined) return output;
  if (Array.isArray(value)) {
    for (const item of value) collectRows(item, output, depth + 1, inheritedSheet);
    return output;
  }
  if (typeof value !== 'object') return output;
  const sheet = String(value.sheet || inheritedSheet || '');
  if (Array.isArray(value.headers) && Array.isArray(value.results)) {
    for (const row of value.results) {
      if (!Array.isArray(row)) continue;
      output.push({
        sheet,
        row: Object.fromEntries(value.headers.map((header, index) => [String(header), row[index]]))
      });
    }
  } else if (sheet) {
    output.push({ sheet, row: value });
  }
  for (const item of Object.values(value)) collectRows(item, output, depth + 1, sheet);
  return output;
}

function fieldFromAliases(row, aliases) {
  const wanted = new Set(aliases.map((alias) => comparable(alias)));
  for (const [key, value] of Object.entries(row || {})) {
    if (wanted.has(comparable(key))) return { present: true, value };
  }
  return { present: false, value: undefined };
}

function evaluateReconciliation(route, originalParameters, readParameters, result) {
  const original = normalizeObject(originalParameters, 'originalParameters');
  const read = normalizeObject(readParameters, 'parameters');
  const target = original[route.target.source];
  if (!hasValue(target)) throw new Error(`Reconciliation requires original parameter: ${route.target.source}`);
  if (comparable(read.query) !== comparable(target)) {
    throw new Error('Reconciliation query must exactly match the original write target');
  }
  const expected = route.expected.map((field) => {
    if (!hasValue(original[field.source])) {
      throw new Error(`Reconciliation requires original parameter: ${field.source}`);
    }
    return { ...field, value: original[field.source] };
  });
  const authoritativeSheets = new Set(route.sheets || []);
  const matchingRows = collectRows(result).filter((entry) => {
    if (!authoritativeSheets.has(entry.sheet)) return false;
    const observed = fieldFromAliases(entry.row, route.target.aliases);
    return observed.present && comparable(observed.value) === comparable(target);
  });
  if (!matchingRows.length) {
    return { outcome: 'indeterminate', reason: 'target_not_returned', matchingRows: 0 };
  }
  const observations = matchingRows.map((entry) => expected.map((field) => {
    const observed = fieldFromAliases(entry.row, field.aliases);
    return {
      present: observed.present,
      matches: observed.present && comparable(observed.value, field.normalizer) === comparable(field.value, field.normalizer)
    };
  }));
  if (observations.some((row) => row.every((field) => field.present && field.matches))) {
    return { outcome: 'already_applied', reason: 'target_and_expected_values_match', matchingRows: matchingRows.length };
  }
  if (observations.some((row) => row.every((field) => field.present))) {
    return { outcome: 'not_applied', reason: 'target_found_with_different_expected_values', matchingRows: matchingRows.length };
  }
  return { outcome: 'indeterminate', reason: 'expected_fields_not_returned', matchingRows: matchingRows.length };
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
  if (phase === 'rollback_promotion') {
    assertAuthorization({ policy: POLICIES.SYSTEM_ADMIN }, request.authorization);
    return (promotionHandlers.rollbackPromotion || rollbackPromotion)(request);
  }
  if (phase === 'reconcile') {
    const originalCapability = String(request.originalCapability || '').trim();
    const readCapability = String(request.capability || '').trim();
    const originalSpec = CAPABILITIES[originalCapability];
    const spec = CAPABILITIES[readCapability];
    const route = RECONCILIATION_ROUTES[originalCapability];
    const receiptReconciliation = (
      originalSpec?.verification === 'authoritative_server_ack' &&
      readCapability === 'operation.receipt'
    );
    if (!originalSpec || originalSpec.policy === POLICIES.READ_ONLY) {
      throw new Error('phase=reconcile requires the original registered write capability');
    }
    if (
      !spec ||
      spec.policy !== POLICIES.READ_ONLY ||
      (!receiptReconciliation && !route?.readers.includes(readCapability))
    ) {
      throw new Error(`${readCapability || '[missing]'} is not an authoritative reconciliation path for ${originalCapability}`);
    }
    const runtimeConfig = config || parseEnv(fs.readFileSync(request.envFile || DEFAULT_ENV_FILE, 'utf8'));
    if (receiptReconciliation) {
      const operationId = String(request.originalOperationId || '').trim();
      if (!operationId || String(request.parameters?.operationId || '').trim() !== operationId) {
        throw new Error('Operation-receipt reconciliation requires the exact original operationId');
      }
      const result = await executeOperation({
        ...request,
        parameters: { operationId },
        config: runtimeConfig,
        authorization: {},
        fetchImpl,
        handlers
      });
      const receipt = result.result && typeof result.result === 'object' ? result.result : {};
      if (
        String(receipt.operationId || '') !== operationId ||
        (receipt.found !== false && (
          String(receipt.capability || '') !== originalCapability ||
          String(receipt.requestDigest || '') !== operationRequestDigest(originalCapability, originalSpec, request.originalParameters)
        ))
      ) {
        return {
          ...result,
          ok: false,
          status: 'RECONCILIATION_INDETERMINATE',
          reconciliation: false,
          originalCapability,
          reconciliationCapability: readCapability,
          reconciliationOutcome: 'indeterminate',
          reconciliationReason: 'receipt_identity_mismatch'
        };
      }
      const outcome = receipt.found === false && receipt.status === 'not_found' && receipt.retrySafe === true
        ? 'not_applied'
        : receipt.status === 'applied'
          ? 'already_applied'
          : 'indeterminate';
      if (outcome === 'indeterminate') {
        return {
          ...result,
          ok: false,
          status: 'RECONCILIATION_INDETERMINATE',
          reconciliation: false,
          originalCapability,
          reconciliationCapability: readCapability,
          reconciliationOutcome: outcome,
          reconciliationReason: `operation_receipt_${String(receipt.status || 'unknown')}`
        };
      }
      return {
        ...result,
        reconciliation: true,
        originalCapability,
        reconciliationCapability: readCapability,
        reconciliationOutcome: outcome,
        reconciliationReason: `operation_receipt_${String(receipt.status || 'unknown')}`
      };
    }
    const result = await executeOperation({ ...request, config: runtimeConfig, authorization: {}, fetchImpl, handlers });
    const evaluation = evaluateReconciliation(
      route,
      request.originalParameters,
      request.parameters || {},
      result.result
    );
    if (evaluation.outcome === 'indeterminate') {
      return {
        ...result,
        ok: false,
        status: 'RECONCILIATION_INDETERMINATE',
        reconciliation: false,
        originalCapability,
        reconciliationCapability: readCapability,
        reconciliationOutcome: evaluation.outcome,
        reconciliationReason: evaluation.reason
      };
    }
    return {
      ...result,
      reconciliation: true,
      originalCapability,
      reconciliationCapability: readCapability,
      reconciliationOutcome: evaluation.outcome,
      reconciliationReason: evaluation.reason,
      matchingRows: evaluation.matchingRows
    };
  }
  if (phase === 'record_learning') return recordLearning(request);
  if (phase === 'complete') return { ok: true, completed: true, capability: String(request.capability || '') };
  if (phase !== 'execute') {
    throw new Error('phase must be catalog, prepare, validate_candidate, promote, confirm_registration, rollback_promotion, reconcile, execute, record_learning, or complete');
  }
  let runtimeConfig;
  try {
    runtimeConfig = config || parseEnv(fs.readFileSync(request.envFile || DEFAULT_ENV_FILE, 'utf8'));
    const prepared = await prepareOperation(request);
    if (!prepared.ok) return prepared;
  } catch (error) {
    return {
      ok: false,
      status: 'REQUEST_REJECTED',
      capability: String(request.capability || '').trim(),
      mutationMayHaveOccurred: false,
      retrySafe: true,
      retryAllowed: true,
      error: String(error?.message || error).slice(0, 2000)
    };
  }
  try {
    return await executeOperation({ ...request, config: runtimeConfig, fetchImpl, handlers });
  } catch (error) {
    const capabilityId = String(request.capability || '').trim();
    const spec = CAPABILITIES[capabilityId];
    const readOnly = spec?.policy === POLICIES.READ_ONLY;
    const mutationMayHaveOccurred = error?.mutationMayHaveOccurred === true;
    const rejectedBeforeMutation = !readOnly && !mutationMayHaveOccurred;
    return {
      ok: false,
      status: readOnly ? 'READ_FAILED' : rejectedBeforeMutation ? 'REQUEST_REJECTED' : 'WRITE_OUTCOME_UNCERTAIN',
      capability: capabilityId,
      policy: spec?.policy || 'unknown',
      mutationMayHaveOccurred,
      retrySafe: readOnly || rejectedBeforeMutation,
      retryAllowed: readOnly || rejectedBeforeMutation,
      ...(error?.operationId || request.operationId ? { operationId: String(error?.operationId || request.operationId) } : {}),
      ...(!readOnly && !rejectedBeforeMutation ? {
        reconciliationCapabilities: RECONCILIATION_ROUTES[capabilityId]?.readers || ['operation.receipt']
      } : {}),
      error: String(error?.message || error).slice(0, 2000)
    };
  }
}

async function main() {
  const input = parseInput(fs.readFileSync(0, 'utf8'));
  if (String(input.phase || '') === 'execute') {
    const policy = CAPABILITIES[String(input.capability || '')]?.policy || 'unknown';
    process.stderr.write(`VILLAGE_EXECUTION_POLICY:${policy}\n`);
  }
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
  operationRequestDigest,
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
