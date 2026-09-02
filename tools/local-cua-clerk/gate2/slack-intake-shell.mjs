import { createHash, randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import {
  runDesktopCuaBridge,
  validateBridgeRecord,
} from '../gate1/desktop-cua-bridge.mjs';

export const ENVELOPE_SCHEMA_VERSION = 'gate2-slack-envelope/v1';
export const RECEIPT_SCHEMA_VERSION = 'gate2-slack-receipt/v1';
export const LEDGER_SCHEMA_VERSION = 'gate2-slack-ledger/v1';
export const DELIVERY_SCHEMA_VERSION = 'gate2-slack-delivery/v1';
export const EMPLOYEE_ID = 'village-tax-document-clerk';
export const ALLOWED_ACTION = 'desktop_readiness';
export const SYNTHETIC_SLACK_SOURCE = 'synthetic_local';
export const SOCKET_SLACK_SOURCE = 'slack_socket_mode';

const EVIDENCE_KEYS = Object.freeze([
  'envelopeValidated',
  'routeAuthorized',
  'actionAllowed',
  'claimCreated',
  'executionStarted',
  'executionCompleted',
  'resultValidated',
  'deliveryAttempted',
  'resultPosted',
  'resumedDelivery',
  'duplicateSuppressed',
  'ledgerFinalized',
]);
const RECEIPT_STATUSES = new Set(['PASS', 'BLOCKED', 'REJECTED', 'DUPLICATE']);
const REJECTED_ERRORS = new Set(['invalid_envelope', 'unauthorized_route', 'action_not_allowed']);
const BLOCKED_ERRORS = new Set([
  'in_progress',
  'malformed_action_result',
  'action_blocked',
  'post_failed',
  'delivery_unknown',
  'envelope_mismatch',
  'ledger_failed',
]);
const OUTCOME_ERRORS = new Set(['malformed_action_result', 'action_blocked']);
const LEDGER_STATES = new Set(['claimed', 'result_ready', 'delivery_unknown', 'completed']);
const ENVELOPE_KEYS = Object.freeze([
  'schemaVersion',
  'source',
  'teamId',
  'channelId',
  'eventId',
  'threadTs',
  'action',
]);
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const REQUEST_ID = /^[a-f0-9]{16}$/;
const SLACKISH_ID = /^[A-Za-z0-9_]{2,64}$/;
const EVENT_ID = /^[A-Za-z0-9_-]{2,128}$/;
const THREAD_TS = /^\d{10,16}\.\d{6}$/;
const MAX_ENVELOPE_BYTES = 2 * 1024;
const MAX_LEDGER_BYTES = 4 * 1024;

function exactKeys(value, expected, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new TypeError(`${name} has unknown or missing keys`);
  }
}

function jsonByteLength(value) {
  try { return Buffer.byteLength(JSON.stringify(value)); }
  catch { return Number.POSITIVE_INFINITY; }
}

function baseEvidence(overrides = {}) {
  return Object.fromEntries(EVIDENCE_KEYS.map(key => [key, overrides[key] ?? false]));
}

export function validateSlackReceipt(receipt) {
  const topKeys = [
    'schemaVersion',
    'status',
    'checkedAt',
    'employeeId',
    'requestId',
    'action',
    'evidence',
    ...(receipt?.errorClass === undefined ? [] : ['errorClass']),
  ];
  exactKeys(receipt, topKeys, 'Gate 2 receipt');
  if (
    receipt.schemaVersion !== RECEIPT_SCHEMA_VERSION
    || !RECEIPT_STATUSES.has(receipt.status)
    || receipt.employeeId !== EMPLOYEE_ID
    || receipt.action !== ALLOWED_ACTION
  ) throw new TypeError('invalid Gate 2 receipt header');
  if (!ISO.test(receipt.checkedAt)) throw new TypeError('invalid checkedAt');
  if (!REQUEST_ID.test(receipt.requestId)) throw new TypeError('invalid request identity');
  exactKeys(receipt.evidence, EVIDENCE_KEYS, 'Gate 2 evidence');
  for (const key of EVIDENCE_KEYS) {
    if (typeof receipt.evidence[key] !== 'boolean') throw new TypeError(`invalid Gate 2 boolean ${key}`);
  }

  const evidence = receipt.evidence;
  if (receipt.status === 'PASS') {
    if (receipt.errorClass !== undefined) throw new TypeError('PASS cannot include errorClass');
    for (const key of ['envelopeValidated', 'routeAuthorized', 'actionAllowed', 'resultValidated', 'deliveryAttempted', 'resultPosted', 'ledgerFinalized']) {
      if (!evidence[key]) throw new TypeError(`PASS requires true ${key}`);
    }
    if (evidence.duplicateSuppressed) throw new TypeError('PASS cannot be a duplicate');
    const firstExecution = evidence.claimCreated && evidence.executionStarted && evidence.executionCompleted && !evidence.resumedDelivery;
    const resumedDelivery = !evidence.claimCreated && !evidence.executionStarted && !evidence.executionCompleted && evidence.resumedDelivery;
    if (!firstExecution && !resumedDelivery) throw new TypeError('PASS requires one execution or one delivery resume');
  } else if (receipt.status === 'DUPLICATE') {
    if (receipt.errorClass !== undefined) throw new TypeError('DUPLICATE cannot include errorClass');
    for (const key of ['envelopeValidated', 'routeAuthorized', 'actionAllowed', 'duplicateSuppressed', 'ledgerFinalized']) {
      if (!evidence[key]) throw new TypeError(`DUPLICATE requires true ${key}`);
    }
    for (const key of ['claimCreated', 'executionStarted', 'executionCompleted', 'resultValidated', 'deliveryAttempted', 'resultPosted', 'resumedDelivery']) {
      if (evidence[key]) throw new TypeError(`DUPLICATE requires false ${key}`);
    }
  } else if (receipt.status === 'REJECTED') {
    if (!REJECTED_ERRORS.has(receipt.errorClass)) throw new TypeError('REJECTED requires a fixed errorClass');
    for (const key of ['claimCreated', 'executionStarted', 'executionCompleted', 'resultValidated', 'deliveryAttempted', 'resultPosted', 'resumedDelivery', 'duplicateSuppressed', 'ledgerFinalized']) {
      if (evidence[key]) throw new TypeError(`REJECTED requires false ${key}`);
    }
    if (receipt.errorClass === 'invalid_envelope' && (evidence.envelopeValidated || evidence.routeAuthorized || evidence.actionAllowed)) {
      throw new TypeError('invalid envelope cannot have validation progress');
    }
    if (receipt.errorClass === 'unauthorized_route' && (!evidence.envelopeValidated || evidence.routeAuthorized || evidence.actionAllowed)) {
      throw new TypeError('unauthorized route evidence is inconsistent');
    }
    if (receipt.errorClass === 'action_not_allowed' && (!evidence.envelopeValidated || !evidence.routeAuthorized || evidence.actionAllowed)) {
      throw new TypeError('disallowed action evidence is inconsistent');
    }
  } else {
    if (!BLOCKED_ERRORS.has(receipt.errorClass)) throw new TypeError('BLOCKED requires a fixed errorClass');
    if (!evidence.envelopeValidated || !evidence.routeAuthorized || !evidence.actionAllowed || evidence.duplicateSuppressed) {
      throw new TypeError('BLOCKED requires an authorized non-duplicate request');
    }
    if (receipt.errorClass === 'in_progress') {
      for (const key of ['claimCreated', 'executionStarted', 'executionCompleted', 'resultValidated', 'deliveryAttempted', 'resultPosted', 'resumedDelivery', 'ledgerFinalized']) {
        if (evidence[key]) throw new TypeError(`in_progress requires false ${key}`);
      }
    }
    if (OUTCOME_ERRORS.has(receipt.errorClass)) {
      if (!evidence.deliveryAttempted || !evidence.resultPosted || !evidence.ledgerFinalized) {
        throw new TypeError('delivered BLOCKED outcome requires finalized delivery');
      }
      const firstExecution = evidence.claimCreated && evidence.executionStarted && evidence.executionCompleted && !evidence.resumedDelivery;
      const resumedDelivery = !evidence.claimCreated && !evidence.executionStarted && !evidence.executionCompleted && evidence.resumedDelivery;
      if (!firstExecution && !resumedDelivery) throw new TypeError('delivered BLOCKED outcome requires one execution or one resume');
    }
    if (receipt.errorClass === 'post_failed' && (!evidence.deliveryAttempted || evidence.resultPosted || evidence.ledgerFinalized)) {
      throw new TypeError('post_failed evidence is inconsistent');
    }
    if (receipt.errorClass === 'delivery_unknown' && (evidence.resultPosted || evidence.ledgerFinalized)) {
      throw new TypeError('delivery_unknown evidence is inconsistent');
    }
    if (receipt.errorClass === 'envelope_mismatch') {
      for (const key of ['claimCreated', 'executionStarted', 'executionCompleted', 'resultValidated', 'deliveryAttempted', 'resultPosted', 'resumedDelivery', 'ledgerFinalized']) {
        if (evidence[key]) throw new TypeError(`envelope_mismatch requires false ${key}`);
      }
    }
  }

  if (evidence.executionCompleted && !evidence.executionStarted) throw new TypeError('execution cannot complete before it starts');
  if (evidence.resultPosted && !evidence.deliveryAttempted) throw new TypeError('posting requires a delivery attempt');
  if (
    evidence.resultPosted
    && !evidence.resultValidated
    && !(receipt.status === 'BLOCKED' && OUTCOME_ERRORS.has(receipt.errorClass))
  ) {
    throw new TypeError('unvalidated result cannot be posted');
  }
  return Object.freeze(receipt);
}

export function serializeSlackReceipt(receipt) {
  return `${JSON.stringify(validateSlackReceipt(receipt), null, 2)}\n`;
}

function validateEnvelope(envelope, expectedSource) {
  if (jsonByteLength(envelope) > MAX_ENVELOPE_BYTES) return false;
  try { exactKeys(envelope, ENVELOPE_KEYS, 'Gate 2 envelope'); }
  catch { return false; }
  return Boolean(
    envelope.schemaVersion === ENVELOPE_SCHEMA_VERSION
    && envelope.source === expectedSource
    && typeof envelope.teamId === 'string'
    && SLACKISH_ID.test(envelope.teamId)
    && typeof envelope.channelId === 'string'
    && SLACKISH_ID.test(envelope.channelId)
    && typeof envelope.eventId === 'string'
    && EVENT_ID.test(envelope.eventId)
    && typeof envelope.threadTs === 'string'
    && THREAD_TS.test(envelope.threadTs)
    && typeof envelope.action === 'string'
    && envelope.action.length > 0
    && envelope.action.length <= 64
  );
}

function validateAllowedRoute(route) {
  exactKeys(route, ['teamId', 'channelId'], 'allowed route');
  if (
    typeof route.teamId !== 'string'
    || !SLACKISH_ID.test(route.teamId)
    || typeof route.channelId !== 'string'
    || !SLACKISH_ID.test(route.channelId)
  ) {
    throw new TypeError('invalid allowed route');
  }
}

function checkedAt(now) {
  const value = now();
  if (typeof value !== 'string' || !ISO.test(value)) throw new TypeError('now must return an ISO timestamp');
  return value;
}

function requestIdFor(envelope) {
  return createHash('sha256')
    .update(`${envelope.teamId}\0${envelope.eventId}`)
    .digest('hex')
    .slice(0, 16);
}

function envelopeDigestFor(envelope) {
  return createHash('sha256').update(JSON.stringify([
    envelope.schemaVersion,
    envelope.source,
    envelope.teamId,
    envelope.channelId,
    envelope.eventId,
    envelope.threadTs,
    envelope.action,
  ])).digest('hex');
}

function receipt({ status, errorClass, checkedAt: timestamp, requestId, evidence }) {
  return validateSlackReceipt({
    schemaVersion: RECEIPT_SCHEMA_VERSION,
    status,
    checkedAt: timestamp,
    employeeId: EMPLOYEE_ID,
    requestId,
    action: ALLOWED_ACTION,
    evidence: baseEvidence(evidence),
    ...(errorClass === undefined ? {} : { errorClass }),
  });
}

function validateOutcome(outcome) {
  const expected = ['status', ...(outcome?.errorClass === undefined ? [] : ['errorClass'])];
  exactKeys(outcome, expected, 'Gate 2 action outcome');
  if (outcome.status === 'PASS') {
    if (outcome.errorClass !== undefined) throw new TypeError('PASS outcome cannot have errorClass');
  } else if (outcome.status !== 'BLOCKED' || !OUTCOME_ERRORS.has(outcome.errorClass)) {
    throw new TypeError('invalid Gate 2 action outcome');
  }
  return outcome;
}

function validateLedgerRecord(record) {
  exactKeys(record, [
    'schemaVersion',
    'state',
    'employeeId',
    'requestId',
    'envelopeDigest',
    'action',
    'createdAt',
    'updatedAt',
    'resultValidated',
    'outcome',
  ], 'Gate 2 ledger record');
  if (
    record.schemaVersion !== LEDGER_SCHEMA_VERSION
    || !LEDGER_STATES.has(record.state)
    || record.employeeId !== EMPLOYEE_ID
    || !REQUEST_ID.test(record.requestId)
    || !/^[a-f0-9]{64}$/.test(record.envelopeDigest)
    || record.action !== ALLOWED_ACTION
    || !ISO.test(record.createdAt)
    || !ISO.test(record.updatedAt)
    || typeof record.resultValidated !== 'boolean'
  ) throw new TypeError('invalid Gate 2 ledger header');
  if (record.state === 'claimed') {
    if (record.outcome !== null || record.resultValidated) throw new TypeError('claimed ledger cannot have a result');
  } else {
    validateOutcome(record.outcome);
    if (record.outcome.status === 'PASS' && !record.resultValidated) {
      throw new TypeError('PASS ledger outcome requires a validated action result');
    }
    if (record.outcome.errorClass === 'malformed_action_result' && record.resultValidated) {
      throw new TypeError('malformed action result cannot be validated');
    }
  }
  return record;
}

function serializeLedgerRecord(record) {
  const serialized = `${JSON.stringify(validateLedgerRecord(record), null, 2)}\n`;
  if (Buffer.byteLength(serialized) > MAX_LEDGER_BYTES) throw new TypeError('Gate 2 ledger record is too large');
  return serialized;
}

async function ensureLedgerDirectory(ledgerDir) {
  if (typeof ledgerDir !== 'string' || !isAbsolute(ledgerDir)) throw new TypeError('ledgerDir must be absolute');
  const created = await mkdir(ledgerDir, { recursive: true, mode: 0o700 });
  const info = await lstat(ledgerDir);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new TypeError('ledgerDir must be a real directory');
  if (created === undefined) {
    if ((info.mode & 0o077) !== 0) throw new TypeError('existing ledgerDir must already be private');
  } else {
    await chmod(ledgerDir, 0o700);
  }
}

async function createExclusiveRecord(path, record) {
  let handle;
  try {
    handle = await open(path, 'wx', 0o600);
    await handle.writeFile(serializeLedgerRecord(record), 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    return true;
  } catch (error) {
    try { await handle?.close(); } catch {}
    if (error?.code === 'EEXIST') return false;
    try { await unlink(path); } catch {}
    throw error;
  }
}

async function readLedgerRecord(path) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_LEDGER_BYTES) {
    throw new TypeError('invalid ledger file');
  }
  return validateLedgerRecord(JSON.parse(await readFile(path, 'utf8')));
}

async function atomicWriteRecord(path, record) {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(serializeLedgerRecord(record), 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, path);
  } catch (error) {
    try { await handle?.close(); } catch {}
    try { await unlink(temporary); } catch {}
    throw error;
  }
}

async function createDeliveryClaim(path, requestId, timestamp) {
  let handle;
  try {
    handle = await open(path, 'wx', 0o600);
    const value = `${JSON.stringify({
      schemaVersion: 'gate2-slack-delivery-claim/v1',
      requestId,
      claimedAt: timestamp,
    })}\n`;
    await handle.writeFile(value, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    return true;
  } catch (error) {
    try { await handle?.close(); } catch {}
    if (error?.code === 'EEXIST') return false;
    try { await unlink(path); } catch {}
    throw error;
  }
}

async function removeOwnedClaim(path) {
  try { await unlink(path); return true; }
  catch (error) { return error?.code === 'ENOENT'; }
}

function safeDeliveryPayload(envelope, requestId, outcome) {
  return Object.freeze({
    route: Object.freeze({
      teamId: envelope.teamId,
      channelId: envelope.channelId,
      threadTs: envelope.threadTs,
    }),
    result: Object.freeze({
      schemaVersion: DELIVERY_SCHEMA_VERSION,
      employeeId: EMPLOYEE_ID,
      requestId,
      action: ALLOWED_ACTION,
      status: outcome.status,
      ...(outcome.errorClass === undefined ? {} : { errorClass: outcome.errorClass }),
    }),
  });
}

async function deliverResult({
  envelope,
  requestId,
  ledgerPath,
  deliveryClaimPath,
  record,
  outcome,
  resultValidated,
  resultSink,
  deliveryTimeoutMs,
  timestamp,
  claimCreated,
  executionStarted,
  executionCompleted,
  resumedDelivery,
}) {
  const commonEvidence = {
    envelopeValidated: true,
    routeAuthorized: true,
    actionAllowed: true,
    claimCreated,
    executionStarted,
    executionCompleted,
    resultValidated,
    resumedDelivery,
  };
  let deliveryClaimCreated;
  try { deliveryClaimCreated = await createDeliveryClaim(deliveryClaimPath, requestId, timestamp); }
  catch {
    return receipt({
      status: 'BLOCKED', errorClass: 'ledger_failed', checkedAt: timestamp, requestId,
      evidence: commonEvidence,
    });
  }
  if (!deliveryClaimCreated) {
    return receipt({
      status: 'BLOCKED', errorClass: 'delivery_unknown', checkedAt: timestamp, requestId,
      evidence: commonEvidence,
    });
  }

  let sinkResult;
  let timer;
  try {
    sinkResult = await Promise.race([
      Promise.resolve().then(() => resultSink(safeDeliveryPayload(envelope, requestId, outcome))),
      new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(new Error('delivery timeout')), deliveryTimeoutMs);
      }),
    ]);
    exactKeys(sinkResult, ['delivered'], 'result sink response');
    if (typeof sinkResult.delivered !== 'boolean') throw new TypeError('result sink delivered must be boolean');
  } catch {
    try {
      await atomicWriteRecord(ledgerPath, { ...record, state: 'delivery_unknown', updatedAt: timestamp, outcome });
    } catch {}
    return receipt({
      status: 'BLOCKED', errorClass: 'delivery_unknown', checkedAt: timestamp, requestId,
      evidence: { ...commonEvidence, deliveryAttempted: true },
    });
  } finally {
    clearTimeout(timer);
  }

  if (!sinkResult.delivered) {
    const claimRemoved = await removeOwnedClaim(deliveryClaimPath);
    if (!claimRemoved) {
      try {
        await atomicWriteRecord(ledgerPath, { ...record, state: 'delivery_unknown', updatedAt: timestamp, outcome });
      } catch {}
      return receipt({
        status: 'BLOCKED', errorClass: 'delivery_unknown', checkedAt: timestamp, requestId,
        evidence: { ...commonEvidence, deliveryAttempted: true },
      });
    }
    return receipt({
      status: 'BLOCKED', errorClass: 'post_failed', checkedAt: timestamp, requestId,
      evidence: { ...commonEvidence, deliveryAttempted: true },
    });
  }

  try {
    await atomicWriteRecord(ledgerPath, { ...record, state: 'completed', updatedAt: timestamp, outcome });
  } catch {
    return receipt({
      status: 'BLOCKED', errorClass: 'ledger_failed', checkedAt: timestamp, requestId,
      evidence: { ...commonEvidence, deliveryAttempted: true, resultPosted: true },
    });
  }
  const claimRemoved = await removeOwnedClaim(deliveryClaimPath);
  if (!claimRemoved) {
    return receipt({
      status: 'BLOCKED', errorClass: 'ledger_failed', checkedAt: timestamp, requestId,
      evidence: { ...commonEvidence, deliveryAttempted: true, resultPosted: true },
    });
  }
  return receipt({
    status: outcome.status,
    errorClass: outcome.errorClass,
    checkedAt: timestamp,
    requestId,
    evidence: {
      ...commonEvidence,
      deliveryAttempted: true,
      resultPosted: true,
      ledgerFinalized: true,
    },
  });
}

async function processSlackEnvelopeForSource({
  envelope,
  allowedRoute,
  ledgerDir,
  resultSink,
  actionRunner = runDesktopCuaBridge,
  allowTestOverrides = false,
  now = () => new Date().toISOString(),
  deliveryTimeoutMs = 10_000,
} = {}, expectedSource) {
  validateAllowedRoute(allowedRoute);
  if (typeof resultSink !== 'function') throw new TypeError('resultSink is required');
  if (typeof actionRunner !== 'function') throw new TypeError('actionRunner must be a function');
  if (actionRunner !== runDesktopCuaBridge && !allowTestOverrides) {
    throw new TypeError('custom actionRunner requires the explicit test override');
  }
  if (typeof now !== 'function') throw new TypeError('now must be a function');
  if (!Number.isInteger(deliveryTimeoutMs) || deliveryTimeoutMs < 1 || deliveryTimeoutMs > 60_000) {
    throw new TypeError('deliveryTimeoutMs must be between 1 and 60000');
  }
  if (typeof ledgerDir !== 'string' || !isAbsolute(ledgerDir)) throw new TypeError('ledgerDir must be absolute');
  const timestamp = checkedAt(now);
  const zeroRequestId = '0000000000000000';

  if (!validateEnvelope(envelope, expectedSource)) {
    return receipt({
      status: 'REJECTED', errorClass: 'invalid_envelope', checkedAt: timestamp,
      requestId: zeroRequestId,
      evidence: {},
    });
  }
  const requestId = requestIdFor(envelope);
  const envelopeDigest = envelopeDigestFor(envelope);
  if (envelope.teamId !== allowedRoute.teamId || envelope.channelId !== allowedRoute.channelId) {
    return receipt({
      status: 'REJECTED', errorClass: 'unauthorized_route', checkedAt: timestamp, requestId,
      evidence: { envelopeValidated: true },
    });
  }
  if (envelope.action !== ALLOWED_ACTION) {
    return receipt({
      status: 'REJECTED', errorClass: 'action_not_allowed', checkedAt: timestamp, requestId,
      evidence: { envelopeValidated: true, routeAuthorized: true },
    });
  }

  try { await ensureLedgerDirectory(ledgerDir); }
  catch {
    return receipt({
      status: 'BLOCKED', errorClass: 'ledger_failed', checkedAt: timestamp, requestId,
      evidence: { envelopeValidated: true, routeAuthorized: true, actionAllowed: true },
    });
  }
  const ledgerPath = `${ledgerDir}/${requestId}.json`;
  const deliveryClaimPath = `${ledgerDir}/${requestId}.delivery.claim`;
  const claimedRecord = {
    schemaVersion: LEDGER_SCHEMA_VERSION,
    state: 'claimed',
    employeeId: EMPLOYEE_ID,
    requestId,
    envelopeDigest,
    action: ALLOWED_ACTION,
    createdAt: timestamp,
    updatedAt: timestamp,
    resultValidated: false,
    outcome: null,
  };

  let claimCreated;
  try { claimCreated = await createExclusiveRecord(ledgerPath, claimedRecord); }
  catch {
    return receipt({
      status: 'BLOCKED', errorClass: 'ledger_failed', checkedAt: timestamp, requestId,
      evidence: { envelopeValidated: true, routeAuthorized: true, actionAllowed: true },
    });
  }

  if (!claimCreated) {
    let existing;
    try { existing = await readLedgerRecord(ledgerPath); }
    catch {
      return receipt({
        status: 'BLOCKED', errorClass: 'ledger_failed', checkedAt: timestamp, requestId,
        evidence: { envelopeValidated: true, routeAuthorized: true, actionAllowed: true },
      });
    }
    if (existing.requestId !== requestId || existing.action !== ALLOWED_ACTION) {
      return receipt({
        status: 'BLOCKED', errorClass: 'ledger_failed', checkedAt: timestamp, requestId,
        evidence: { envelopeValidated: true, routeAuthorized: true, actionAllowed: true },
      });
    }
    if (existing.envelopeDigest !== envelopeDigest) {
      return receipt({
        status: 'BLOCKED', errorClass: 'envelope_mismatch', checkedAt: timestamp, requestId,
        evidence: { envelopeValidated: true, routeAuthorized: true, actionAllowed: true },
      });
    }
    if (existing.state === 'completed') {
      return receipt({
        status: 'DUPLICATE', checkedAt: timestamp, requestId,
        evidence: {
          envelopeValidated: true,
          routeAuthorized: true,
          actionAllowed: true,
          duplicateSuppressed: true,
          ledgerFinalized: true,
        },
      });
    }
    if (existing.state === 'claimed') {
      return receipt({
        status: 'BLOCKED', errorClass: 'in_progress', checkedAt: timestamp, requestId,
        evidence: { envelopeValidated: true, routeAuthorized: true, actionAllowed: true },
      });
    }
    if (existing.state === 'delivery_unknown') {
      return receipt({
        status: 'BLOCKED', errorClass: 'delivery_unknown', checkedAt: timestamp, requestId,
        evidence: {
          envelopeValidated: true,
          routeAuthorized: true,
          actionAllowed: true,
          resultValidated: existing.resultValidated,
        },
      });
    }
    return deliverResult({
      envelope,
      requestId,
      ledgerPath,
      deliveryClaimPath,
      record: existing,
      outcome: existing.outcome,
      resultValidated: existing.resultValidated,
      resultSink,
      deliveryTimeoutMs,
      timestamp,
      claimCreated: false,
      executionStarted: false,
      executionCompleted: false,
      resumedDelivery: true,
    });
  }

  let actionResult;
  let executionCompleted = false;
  let resultValidated = false;
  let outcome;
  try {
    actionResult = await actionRunner();
    executionCompleted = true;
  } catch {
    executionCompleted = true;
    outcome = { status: 'BLOCKED', errorClass: 'action_blocked' };
  }
  if (!outcome) {
    try {
      const validated = validateBridgeRecord(actionResult);
      resultValidated = true;
      outcome = validated.status === 'PASS'
        ? { status: 'PASS' }
        : { status: 'BLOCKED', errorClass: 'action_blocked' };
    } catch {
      outcome = { status: 'BLOCKED', errorClass: 'malformed_action_result' };
    }
  }
  const readyRecord = {
    ...claimedRecord,
    state: 'result_ready',
    updatedAt: timestamp,
    resultValidated,
    outcome,
  };
  try { await atomicWriteRecord(ledgerPath, readyRecord); }
  catch {
    return receipt({
      status: 'BLOCKED', errorClass: 'ledger_failed', checkedAt: timestamp, requestId,
      evidence: {
        envelopeValidated: true,
        routeAuthorized: true,
        actionAllowed: true,
        claimCreated: true,
        executionStarted: true,
        executionCompleted,
        resultValidated,
      },
    });
  }
  return deliverResult({
    envelope,
    requestId,
    ledgerPath,
    deliveryClaimPath,
    record: readyRecord,
    outcome,
    resultValidated,
    resultSink,
    deliveryTimeoutMs,
    timestamp,
    claimCreated: true,
    executionStarted: true,
    executionCompleted,
    resumedDelivery: false,
  });
}

export function processSyntheticSlackEnvelope(options) {
  return processSlackEnvelopeForSource(options, SYNTHETIC_SLACK_SOURCE);
}

export function processSocketSlackEnvelope(options) {
  return processSlackEnvelopeForSource(options, SOCKET_SLACK_SOURCE);
}
