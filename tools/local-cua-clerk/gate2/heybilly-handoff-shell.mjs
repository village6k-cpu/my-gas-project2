import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { chmod, link, lstat, mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import {
  runStudioMacGeneralWorker,
  runStudioMacCodexWorker,
  validateStudioMacGeneralResult,
  validateStudioMacGeneralTask,
  validateStudioMacResult,
} from '../gate1/studio-mac-codex-worker.mjs';

const ENVELOPE_SCHEMA = 'gate2-heybilly-envelope/v1';
const TASK_SCHEMA = 'gate1-studio-mac-task/v1';
const RESULT_SCHEMA = 'studio-mac-cua-result/v1';
const RECEIPT_SCHEMA = 'gate2-studio-mac-receipt/v1';
const LEDGER_SCHEMA = 'gate2-studio-mac-ledger/v1';
const ACTION = 'studio_mac_cua_handoff';
const TASK_TYPE = 'hometax_cash_receipt_issue';
const SOURCE = 'slack_socket_mode';
const STATES = new Set([
  'claimed',
  'ack_ready',
  'acknowledged',
  'running',
  'result_ready',
  'ack_delivery_unknown',
  'final_delivery_unknown',
  'completed',
]);
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const REQUEST_ID = /^[a-f0-9]{16}$/;
const THREAD_TS = /^\d{10,16}\.\d{6}$/;
const SLACK_ID = /^[A-Za-z0-9_]{2,64}$/;
const EVENT_ID = /^[A-Za-z0-9_-]{2,128}$/;
const HANDOFF_ID = /^hb-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAX_LEDGER_BYTES = 4 * 1024;
const TASK_DIGEST_KEY_FILE = '.studio-mac-task-digest.key';
const TASK_DIGEST_KEY_BYTES = 32;
const GENERAL_ENVELOPE_SCHEMA = 'gate2-heybilly-general-envelope/v1';
const GENERAL_RECEIPT_SCHEMA = 'gate2-studio-mac-general-receipt/v1';
const GENERAL_LEDGER_SCHEMA = 'gate2-studio-mac-general-ledger/v1';
const GENERAL_ACTION = 'studio_mac_general_handoff';
const GENERAL_TASK_TYPE = 'general_local_cua';
const GENERAL_TASK_KEYS = Object.freeze([
  'schemaVersion', 'action', 'handoffId', 'authorization', 'instruction',
]);
const GENERAL_ENVELOPE_KEYS = Object.freeze([
  'schemaVersion', 'source', 'teamId', 'channelId', 'eventId', 'threadTs',
  'action', 'handoffId',
]);
const GENERAL_STATES = new Set([
  'claimed', 'ack_ready', 'acknowledged', 'running', 'ack_delivery_unknown',
  'final_delivery_unknown', 'completed',
]);
const TASK_KEYS = Object.freeze([
  'schemaVersion', 'action', 'handoffId', 'authorization', 'customerName',
  'transactionId', 'transactionDate', 'amountKrw', 'purpose', 'phone', 'item',
]);
const ENVELOPE_KEYS = Object.freeze([
  'schemaVersion', 'source', 'teamId', 'channelId', 'eventId', 'threadTs',
  'action', 'taskType', 'handoffId',
]);

let studioMacQueue = Promise.resolve();

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

function validateRoute(route) {
  exactKeys(route, ['teamId', 'channelId'], 'allowed route');
  if (!SLACK_ID.test(route.teamId) || !SLACK_ID.test(route.channelId)) {
    throw new TypeError('invalid allowed route');
  }
}

function validateEnvelope(envelope) {
  exactKeys(envelope, ENVELOPE_KEYS, 'handoff envelope');
  if (
    envelope.schemaVersion !== ENVELOPE_SCHEMA
    || envelope.source !== SOURCE
    || !SLACK_ID.test(envelope.teamId)
    || !SLACK_ID.test(envelope.channelId)
    || !EVENT_ID.test(envelope.eventId)
    || !THREAD_TS.test(envelope.threadTs)
    || envelope.action !== ACTION
    || envelope.taskType !== TASK_TYPE
    || !HANDOFF_ID.test(envelope.handoffId)
  ) throw new TypeError('invalid handoff envelope');
  return envelope;
}

function validateTask(task, envelope) {
  exactKeys(task, TASK_KEYS, 'Studio Mac task');
  const date = new Date(`${task.transactionDate}T00:00:00.000Z`);
  if (
    task.schemaVersion !== TASK_SCHEMA
    || task.action !== TASK_TYPE
    || task.handoffId !== envelope.handoffId
    || task.authorization !== 'owner_explicit'
    || !/^[가-힣A-Za-z0-9 .()_-]{2,40}$/u.test(task.customerName)
    || !/^\d{6}-\d{3}$/.test(task.transactionId)
    || !/^\d{4}-\d{2}-\d{2}$/.test(task.transactionDate)
    || Number.isNaN(date.getTime())
    || date.toISOString().slice(0, 10) !== task.transactionDate
    || !Number.isSafeInteger(task.amountKrw)
    || task.amountKrw < 1
    || task.amountKrw > 100_000_000
    || task.purpose !== 'income_deduction'
    || !/^01[016789]-\d{3,4}-\d{4}$/.test(task.phone)
    || typeof task.item !== 'string'
    || Buffer.byteLength(task.item, 'utf8') > 180
  ) throw new TypeError('invalid Studio Mac task');
  return task;
}

function validateGeneralEnvelope(envelope) {
  exactKeys(envelope, GENERAL_ENVELOPE_KEYS, 'general handoff envelope');
  if (
    envelope.schemaVersion !== GENERAL_ENVELOPE_SCHEMA
    || envelope.source !== SOURCE
    || !SLACK_ID.test(envelope.teamId)
    || !SLACK_ID.test(envelope.channelId)
    || !EVENT_ID.test(envelope.eventId)
    || !THREAD_TS.test(envelope.threadTs)
    || envelope.action !== GENERAL_ACTION
    || !HANDOFF_ID.test(envelope.handoffId)
  ) throw new TypeError('invalid general handoff envelope');
  return envelope;
}

function validateGeneralTask(task, envelope) {
  validateStudioMacGeneralTask(task);
  if (task.handoffId !== envelope.handoffId) throw new TypeError('invalid general Studio Mac task');
  return task;
}

function validateResult(result) {
  return validateStudioMacResult(result);
}

function requestIdFor(envelope) {
  return createHash('sha256')
    .update(`${envelope.teamId}\0heybilly\0${envelope.handoffId}`)
    .digest('hex')
    .slice(0, 16);
}

function envelopeDigestFor(envelope) {
  return createHash('sha256').update(JSON.stringify([
    envelope.schemaVersion, envelope.source, envelope.teamId, envelope.channelId,
    envelope.eventId, envelope.threadTs, envelope.action, envelope.taskType,
    envelope.handoffId,
  ])).digest('hex');
}

function taskDigestFor(task, key) {
  return createHmac('sha256', key)
    .update(JSON.stringify(TASK_KEYS.map(field => task[field])))
    .digest('hex');
}

function generalTaskDigestFor(task, key) {
  return createHmac('sha256', key)
    .update(JSON.stringify(GENERAL_TASK_KEYS.map(field => task[field])))
    .digest('hex');
}

function generalRequestIdFor(envelope) {
  return createHash('sha256')
    .update(`${envelope.teamId}\0heybilly-general\0${envelope.handoffId}`)
    .digest('hex')
    .slice(0, 16);
}

function generalEnvelopeDigestFor(envelope) {
  return createHash('sha256').update(JSON.stringify([
    envelope.schemaVersion, envelope.source, envelope.teamId, envelope.channelId,
    envelope.eventId, envelope.threadTs, envelope.action, envelope.handoffId,
  ])).digest('hex');
}

function receipt(status, requestId, errorClass) {
  return Object.freeze({
    schemaVersion: RECEIPT_SCHEMA,
    status,
    requestId,
    ...(errorClass === undefined ? {} : { errorClass }),
  });
}

function terminalReceipt(result, requestId) {
  if (result.status === 'COMPLETED') return receipt('PASS', requestId);
  if (result.status === 'NEEDS_USER') return receipt('BLOCKED', requestId, 'user_action_required');
  return receipt('BLOCKED', requestId, result.errorClass);
}

function generalReceipt(status, requestId, errorClass) {
  return Object.freeze({
    schemaVersion: GENERAL_RECEIPT_SCHEMA,
    status,
    requestId,
    ...(errorClass === undefined ? {} : { errorClass }),
  });
}

function generalTerminalReceipt(result, requestId) {
  if (result.status === 'COMPLETED') return generalReceipt('PASS', requestId);
  if (result.status === 'NEEDS_USER') return generalReceipt('BLOCKED', requestId, 'user_action_required');
  return generalReceipt('BLOCKED', requestId, result.errorClass);
}

async function ensureLedgerDirectory(ledgerDir) {
  if (typeof ledgerDir !== 'string' || !isAbsolute(ledgerDir)) {
    throw new TypeError('ledgerDir must be absolute');
  }
  const created = await mkdir(ledgerDir, { recursive: true, mode: 0o700 });
  const info = await lstat(ledgerDir);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new TypeError('invalid ledgerDir');
  if (created === undefined) {
    if ((info.mode & 0o077) !== 0) throw new TypeError('existing ledgerDir must already be private');
  } else {
    await chmod(ledgerDir, 0o700);
  }
}

function validateRecord(record) {
  exactKeys(record, [
    'schemaVersion', 'state', 'requestId', 'envelopeDigest', 'taskDigest', 'handoffId', 'taskType',
    'createdAt', 'updatedAt', 'result',
  ], 'Studio Mac ledger');
  if (
    record.schemaVersion !== LEDGER_SCHEMA
    || !STATES.has(record.state)
    || !REQUEST_ID.test(record.requestId)
    || !/^[a-f0-9]{64}$/.test(record.envelopeDigest)
    || !/^[a-f0-9]{64}$/.test(record.taskDigest)
    || !HANDOFF_ID.test(record.handoffId)
    || record.taskType !== TASK_TYPE
    || !ISO.test(record.createdAt)
    || !ISO.test(record.updatedAt)
  ) throw new TypeError('invalid Studio Mac ledger');
  if (['result_ready', 'final_delivery_unknown', 'completed'].includes(record.state)) {
    validateResult({ schemaVersion: RESULT_SCHEMA, ...record.result });
  } else if (record.result !== null) {
    throw new TypeError('pre-result ledger cannot contain a result');
  }
  return record;
}

function validateGeneralRecord(record) {
  exactKeys(record, [
    'schemaVersion', 'state', 'requestId', 'envelopeDigest', 'taskDigest', 'handoffId',
    'taskType', 'createdAt', 'updatedAt', 'result',
  ], 'Studio Mac general ledger');
  if (
    record.schemaVersion !== GENERAL_LEDGER_SCHEMA
    || !GENERAL_STATES.has(record.state)
    || !REQUEST_ID.test(record.requestId)
    || !/^[a-f0-9]{64}$/.test(record.envelopeDigest)
    || !/^[a-f0-9]{64}$/.test(record.taskDigest)
    || !HANDOFF_ID.test(record.handoffId)
    || record.taskType !== GENERAL_TASK_TYPE
    || !ISO.test(record.createdAt)
    || !ISO.test(record.updatedAt)
  ) throw new TypeError('invalid Studio Mac general ledger');
  if (['final_delivery_unknown', 'completed'].includes(record.state)) {
    exactKeys(record.result, ['status', 'mutationObserved', 'readbackVerified', 'need', 'errorClass'], 'redacted general result');
    if (
      !['COMPLETED', 'NEEDS_USER', 'BLOCKED'].includes(record.result.status)
      || typeof record.result.mutationObserved !== 'boolean'
      || typeof record.result.readbackVerified !== 'boolean'
      || !(record.result.need === null || ['studio_mac_locked', 'login_required', 'captcha_required', 'user_decision_required'].includes(record.result.need))
      || !(record.result.errorClass === null || ['command_failed', 'timeout', 'malformed_result', 'cleanup_incomplete', 'outcome_unknown'].includes(record.result.errorClass))
    ) throw new TypeError('invalid redacted general result');
    const completed = record.result.status === 'COMPLETED'
      && record.result.readbackVerified === true
      && record.result.need === null
      && record.result.errorClass === null;
    const needsUser = record.result.status === 'NEEDS_USER'
      && record.result.mutationObserved === false
      && record.result.readbackVerified === false
      && record.result.need !== null
      && record.result.errorClass === null;
    const blocked = record.result.status === 'BLOCKED'
      && record.result.mutationObserved === false
      && record.result.readbackVerified === false
      && record.result.need === null
      && record.result.errorClass !== null;
    if (!completed && !needsUser && !blocked) throw new TypeError('inconsistent redacted general result');
  } else if (record.result !== null) {
    throw new TypeError('pre-result general ledger cannot contain a result');
  }
  return record;
}

function serializeRecord(record) {
  const value = `${JSON.stringify(validateRecord(record), null, 2)}\n`;
  if (Buffer.byteLength(value) > MAX_LEDGER_BYTES) throw new TypeError('ledger too large');
  return value;
}

function serializeGeneralRecord(record) {
  const value = `${JSON.stringify(validateGeneralRecord(record), null, 2)}\n`;
  if (Buffer.byteLength(value) > MAX_LEDGER_BYTES) throw new TypeError('general ledger too large');
  return value;
}

async function createRecord(path, record, serializer = serializeRecord) {
  let handle;
  try {
    handle = await open(path, 'wx', 0o600);
    await handle.writeFile(serializer(record), 'utf8');
    await handle.sync();
    await handle.close();
    return true;
  } catch (error) {
    try { await handle?.close(); } catch {}
    if (error?.code === 'EEXIST') return false;
    try { await unlink(path); } catch {}
    throw error;
  }
}

async function readRecord(path, validator = validateRecord) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_LEDGER_BYTES) {
    throw new TypeError('invalid ledger file');
  }
  return validator(JSON.parse(await readFile(path, 'utf8')));
}

async function writeRecord(path, record, serializer = serializeRecord) {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(serializer(record), 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, path);
  } finally {
    try { await handle?.close(); } catch {}
    try { await unlink(temporary); } catch {}
  }
}

async function readTaskDigestKey(path) {
  const info = await lstat(path);
  if (
    !info.isFile()
    || info.isSymbolicLink()
    || info.size !== TASK_DIGEST_KEY_BYTES
    || (info.mode & 0o077) !== 0
  ) throw new TypeError('invalid task digest key');
  const key = await readFile(path);
  if (key.length !== TASK_DIGEST_KEY_BYTES) throw new TypeError('invalid task digest key');
  return key;
}

async function ensureTaskDigestKey(ledgerDir) {
  const path = `${ledgerDir}/${TASK_DIGEST_KEY_FILE}`;
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(randomBytes(TASK_DIGEST_KEY_BYTES));
    await handle.sync();
    await handle.close();
    handle = undefined;
    try { await link(temporary, path); }
    catch (error) { if (error?.code !== 'EEXIST') throw error; }
  } finally {
    try { await handle?.close(); } catch {}
    try { await unlink(temporary); } catch {}
  }
  return readTaskDigestKey(path);
}

async function createDeliveryClaim(path, requestId, phase) {
  if (!['ACK', 'FINAL'].includes(phase)) throw new TypeError('invalid delivery claim phase');
  let handle;
  try {
    handle = await open(path, 'wx', 0o600);
    await handle.writeFile(`${JSON.stringify({
      schemaVersion: 'gate2-studio-mac-delivery-claim/v1',
      requestId,
      phase,
    })}\n`, 'utf8');
    await handle.sync();
    await handle.close();
    return true;
  } catch (error) {
    try { await handle?.close(); } catch {}
    if (error?.code === 'EEXIST') return false;
    try { await unlink(path); } catch {}
    throw error;
  }
}

async function removeDeliveryClaim(path) {
  try { await unlink(path); return true; }
  catch (error) { return error?.code === 'ENOENT'; }
}

function enqueueStudioMac(work) {
  const running = studioMacQueue.then(work, work);
  studioMacQueue = running.catch(() => {});
  return running;
}

function statusPayload(envelope, requestId, phase, result) {
  return Object.freeze({
    schemaVersion: 'gate2-studio-mac-status/v1',
    phase,
    requestId,
    route: Object.freeze({
      teamId: envelope.teamId,
      channelId: envelope.channelId,
      threadTs: envelope.threadTs,
    }),
    ...(result === undefined ? {} : { result: Object.freeze(
      result.status === 'COMPLETED'
        ? {
          status: result.status,
          resultCode: result.resultCode,
          authorizationNumber: result.authorizationNumber,
        }
        : result.status === 'NEEDS_USER'
          ? { status: result.status, resultCode: result.resultCode, need: result.need }
          : { status: result.status, resultCode: result.resultCode, errorClass: result.errorClass },
    ) }),
  });
}

function generalStatusPayload(envelope, requestId, phase, result) {
  return Object.freeze({
    schemaVersion: 'gate2-studio-mac-general-status/v1',
    phase,
    requestId,
    route: Object.freeze({
      teamId: envelope.teamId,
      channelId: envelope.channelId,
      threadTs: envelope.threadTs,
    }),
    ...(result === undefined ? {} : { result: Object.freeze({ ...result }) }),
  });
}

async function deliver(statusSink, payload, timeoutMs) {
  let timer;
  try {
    const response = await Promise.race([
      Promise.resolve().then(() => statusSink(payload)),
      new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(new Error('delivery timeout')), timeoutMs);
      }),
    ]);
    exactKeys(response, ['delivered'], 'status sink result');
    if (typeof response.delivered !== 'boolean') throw new TypeError('invalid status sink result');
    return response.delivered;
  } finally {
    clearTimeout(timer);
  }
}

async function deliverFinal({
  envelope,
  requestId,
  result,
  record,
  ledgerPath,
  finalClaimPath,
  statusSink,
  deliveryTimeoutMs,
  timestamp,
}) {
  let claimCreated;
  try { claimCreated = await createDeliveryClaim(finalClaimPath, requestId, 'FINAL'); }
  catch { return receipt('BLOCKED', requestId, 'ledger_failed'); }
  if (!claimCreated) return receipt('BLOCKED', requestId, 'in_progress');

  let delivered;
  try {
    delivered = await deliver(
      statusSink,
      statusPayload(envelope, requestId, 'FINAL', result),
      deliveryTimeoutMs,
    );
  } catch {
    await writeRecord(ledgerPath, { ...record, state: 'final_delivery_unknown', updatedAt: timestamp }).catch(() => {});
    return receipt('BLOCKED', requestId, 'delivery_unknown');
  }
  if (!delivered) {
    if (!await removeDeliveryClaim(finalClaimPath)) {
      await writeRecord(ledgerPath, { ...record, state: 'final_delivery_unknown', updatedAt: timestamp }).catch(() => {});
      return receipt('BLOCKED', requestId, 'delivery_unknown');
    }
    return receipt('BLOCKED', requestId, 'post_failed');
  }
  try { await writeRecord(ledgerPath, { ...record, state: 'completed', updatedAt: timestamp }); }
  catch { return receipt('BLOCKED', requestId, 'ledger_failed'); }
  if (!await removeDeliveryClaim(finalClaimPath)) return receipt('BLOCKED', requestId, 'ledger_failed');
  return terminalReceipt(result, requestId);
}

export async function processHeyBillyHandoff({
  envelope,
  task,
  allowedRoute,
  ledgerDir,
  actionRunner = runStudioMacCodexWorker,
  statusSink,
  allowTestOverrides = false,
  now = () => new Date().toISOString(),
  deliveryTimeoutMs = 10_000,
} = {}) {
  validateRoute(allowedRoute);
  if (typeof actionRunner !== 'function' || typeof statusSink !== 'function') {
    throw new TypeError('actionRunner and statusSink are required');
  }
  if (actionRunner !== runStudioMacCodexWorker && !allowTestOverrides) {
    throw new TypeError('custom actionRunner requires the explicit test override');
  }
  if (typeof now !== 'function') throw new TypeError('now must be a function');
  if (!Number.isInteger(deliveryTimeoutMs) || deliveryTimeoutMs < 1 || deliveryTimeoutMs > 60_000) {
    throw new TypeError('invalid delivery timeout');
  }

  let validatedEnvelope;
  try {
    validatedEnvelope = validateEnvelope(envelope);
    validateTask(task, validatedEnvelope);
  } catch {
    return receipt('REJECTED', '0000000000000000', 'invalid_handoff');
  }
  const requestId = requestIdFor(validatedEnvelope);
  if (
    validatedEnvelope.teamId !== allowedRoute.teamId
    || validatedEnvelope.channelId !== allowedRoute.channelId
  ) return receipt('REJECTED', requestId, 'unauthorized_route');

  const timestamp = now();
  if (typeof timestamp !== 'string' || !ISO.test(timestamp)) throw new TypeError('invalid current time');
  try { await ensureLedgerDirectory(ledgerDir); }
  catch { return receipt('BLOCKED', requestId, 'ledger_failed'); }

  let taskDigest;
  try { taskDigest = taskDigestFor(task, await ensureTaskDigestKey(ledgerDir)); }
  catch { return receipt('BLOCKED', requestId, 'ledger_failed'); }

  const ledgerPath = `${ledgerDir}/${requestId}.studio-mac.json`;
  const ackClaimPath = `${ledgerDir}/${requestId}.studio-mac.ack.claim`;
  const finalClaimPath = `${ledgerDir}/${requestId}.studio-mac.final.claim`;
  const claimed = {
    schemaVersion: LEDGER_SCHEMA,
    state: 'claimed',
    requestId,
    envelopeDigest: envelopeDigestFor(validatedEnvelope),
    taskDigest,
    handoffId: validatedEnvelope.handoffId,
    taskType: validatedEnvelope.taskType,
    createdAt: timestamp,
    updatedAt: timestamp,
    result: null,
  };
  let created;
  try { created = await createRecord(ledgerPath, claimed); }
  catch { return receipt('BLOCKED', requestId, 'ledger_failed'); }
  let resumingAck = false;
  if (!created) {
    let existing;
    try { existing = await readRecord(ledgerPath); }
    catch { return receipt('BLOCKED', requestId, 'ledger_failed'); }
    if (existing.envelopeDigest !== claimed.envelopeDigest) {
      return receipt('BLOCKED', requestId, 'envelope_mismatch');
    }
    if (existing.taskDigest !== claimed.taskDigest) {
      return receipt('BLOCKED', requestId, 'task_mismatch');
    }
    if (existing.state === 'completed') return receipt('DUPLICATE', requestId);
    if (existing.state === 'result_ready') {
      const restoredResult = validateResult({ schemaVersion: RESULT_SCHEMA, ...existing.result });
      return deliverFinal({
        envelope: validatedEnvelope,
        requestId,
        result: restoredResult,
        record: existing,
        ledgerPath,
        finalClaimPath,
        statusSink,
        deliveryTimeoutMs,
        timestamp,
      });
    }
    if (existing.state !== 'ack_ready') {
      const errorClass = existing.state.includes('unknown')
        ? 'delivery_unknown'
        : existing.state === 'running'
          ? 'needs_review'
          : 'in_progress';
      return receipt('BLOCKED', requestId, errorClass);
    }
    Object.assign(claimed, existing);
    resumingAck = true;
  }

  if (resumingAck) {
    let ackClaimCreated;
    try { ackClaimCreated = await createDeliveryClaim(ackClaimPath, requestId, 'ACK'); }
    catch { return receipt('BLOCKED', requestId, 'ledger_failed'); }
    if (!ackClaimCreated) return receipt('BLOCKED', requestId, 'in_progress');
  }

  let ackDelivered;
  try {
    ackDelivered = await deliver(statusSink, statusPayload(validatedEnvelope, requestId, 'ACK'), deliveryTimeoutMs);
  } catch {
    await writeRecord(ledgerPath, { ...claimed, state: 'ack_delivery_unknown', updatedAt: timestamp }).catch(() => {});
    return receipt('BLOCKED', requestId, 'delivery_unknown');
  }
  if (!ackDelivered) {
    try { await writeRecord(ledgerPath, { ...claimed, state: 'ack_ready', updatedAt: timestamp }); }
    catch { return receipt('BLOCKED', requestId, 'ledger_failed'); }
    if (resumingAck && !await removeDeliveryClaim(ackClaimPath)) {
      return receipt('BLOCKED', requestId, 'ledger_failed');
    }
    return receipt('BLOCKED', requestId, 'post_failed');
  }
  const acknowledged = { ...claimed, state: 'acknowledged', updatedAt: timestamp };
  try { await writeRecord(ledgerPath, acknowledged); }
  catch { return receipt('BLOCKED', requestId, 'ledger_failed'); }
  if (resumingAck && !await removeDeliveryClaim(ackClaimPath)) {
    return receipt('BLOCKED', requestId, 'ledger_failed');
  }

  return enqueueStudioMac(async () => {
    const running = { ...acknowledged, state: 'running', updatedAt: timestamp };
    try { await writeRecord(ledgerPath, running); }
    catch { return receipt('BLOCKED', requestId, 'ledger_failed'); }

    let result;
    try {
      result = validateResult(await actionRunner({ requestId, task }));
    } catch {
      result = validateResult({
        schemaVersion: RESULT_SCHEMA,
        status: 'BLOCKED',
        resultCode: 'execution_blocked',
        authorizationNumber: null,
        duplicateFound: false,
        readbackVerified: false,
        mutationObserved: false,
        need: null,
        errorClass: 'outcome_unknown',
      });
    }
    const redactedResult = {
      status: result.status,
      resultCode: result.resultCode,
      authorizationNumber: result.authorizationNumber,
      duplicateFound: result.duplicateFound,
      readbackVerified: result.readbackVerified,
      mutationObserved: result.mutationObserved,
      need: result.need,
      errorClass: result.errorClass,
    };
    const ready = { ...running, state: 'result_ready', updatedAt: timestamp, result: redactedResult };
    try { await writeRecord(ledgerPath, ready); }
    catch { return receipt('BLOCKED', requestId, 'ledger_failed'); }

    return deliverFinal({
      envelope: validatedEnvelope,
      requestId,
      result,
      record: ready,
      ledgerPath,
      finalClaimPath,
      statusSink,
      deliveryTimeoutMs,
      timestamp,
    });
  });
}

export async function processGeneralHeyBillyHandoff({
  envelope,
  task,
  allowedRoute,
  ledgerDir,
  actionRunner = runStudioMacGeneralWorker,
  statusSink,
  allowTestOverrides = false,
  now = () => new Date().toISOString(),
  deliveryTimeoutMs = 10_000,
} = {}) {
  validateRoute(allowedRoute);
  if (typeof actionRunner !== 'function' || typeof statusSink !== 'function') {
    throw new TypeError('actionRunner and statusSink are required');
  }
  if (actionRunner !== runStudioMacGeneralWorker && !allowTestOverrides) {
    throw new TypeError('custom actionRunner requires the explicit test override');
  }
  if (typeof now !== 'function') throw new TypeError('now must be a function');
  if (!Number.isInteger(deliveryTimeoutMs) || deliveryTimeoutMs < 1 || deliveryTimeoutMs > 60_000) {
    throw new TypeError('invalid delivery timeout');
  }

  let validatedEnvelope;
  try {
    validatedEnvelope = validateGeneralEnvelope(envelope);
    validateGeneralTask(task, validatedEnvelope);
  } catch {
    return generalReceipt('REJECTED', '0000000000000000', 'invalid_handoff');
  }
  const requestId = generalRequestIdFor(validatedEnvelope);
  if (
    validatedEnvelope.teamId !== allowedRoute.teamId
    || validatedEnvelope.channelId !== allowedRoute.channelId
  ) return generalReceipt('REJECTED', requestId, 'unauthorized_route');

  const timestamp = now();
  if (typeof timestamp !== 'string' || !ISO.test(timestamp)) throw new TypeError('invalid current time');
  try { await ensureLedgerDirectory(ledgerDir); }
  catch { return generalReceipt('BLOCKED', requestId, 'ledger_failed'); }

  let taskDigest;
  try { taskDigest = generalTaskDigestFor(task, await ensureTaskDigestKey(ledgerDir)); }
  catch { return generalReceipt('BLOCKED', requestId, 'ledger_failed'); }

  const ledgerPath = `${ledgerDir}/${requestId}.studio-mac-general.json`;
  const ackClaimPath = `${ledgerDir}/${requestId}.studio-mac-general.ack.claim`;
  const claimed = {
    schemaVersion: GENERAL_LEDGER_SCHEMA,
    state: 'claimed',
    requestId,
    envelopeDigest: generalEnvelopeDigestFor(validatedEnvelope),
    taskDigest,
    handoffId: validatedEnvelope.handoffId,
    taskType: GENERAL_TASK_TYPE,
    createdAt: timestamp,
    updatedAt: timestamp,
    result: null,
  };
  let created;
  try { created = await createRecord(ledgerPath, claimed, serializeGeneralRecord); }
  catch { return generalReceipt('BLOCKED', requestId, 'ledger_failed'); }

  let resumingAck = false;
  if (!created) {
    let existing;
    try { existing = await readRecord(ledgerPath, validateGeneralRecord); }
    catch { return generalReceipt('BLOCKED', requestId, 'ledger_failed'); }
    if (existing.envelopeDigest !== claimed.envelopeDigest) {
      return generalReceipt('BLOCKED', requestId, 'envelope_mismatch');
    }
    if (existing.taskDigest !== claimed.taskDigest) {
      return generalReceipt('BLOCKED', requestId, 'task_mismatch');
    }
    if (existing.state === 'completed') return generalReceipt('DUPLICATE', requestId);
    if (existing.state !== 'ack_ready') {
      const errorClass = existing.state.includes('unknown')
        ? 'delivery_unknown'
        : existing.state === 'running'
          ? 'needs_review'
          : 'in_progress';
      return generalReceipt('BLOCKED', requestId, errorClass);
    }
    Object.assign(claimed, existing);
    resumingAck = true;
  }

  if (resumingAck) {
    let ackClaimCreated;
    try { ackClaimCreated = await createDeliveryClaim(ackClaimPath, requestId, 'ACK'); }
    catch { return generalReceipt('BLOCKED', requestId, 'ledger_failed'); }
    if (!ackClaimCreated) return generalReceipt('BLOCKED', requestId, 'in_progress');
  }

  let ackDelivered;
  try {
    ackDelivered = await deliver(
      statusSink,
      generalStatusPayload(validatedEnvelope, requestId, 'ACK'),
      deliveryTimeoutMs,
    );
  } catch {
    await writeRecord(
      ledgerPath,
      { ...claimed, state: 'ack_delivery_unknown', updatedAt: timestamp },
      serializeGeneralRecord,
    ).catch(() => {});
    return generalReceipt('BLOCKED', requestId, 'delivery_unknown');
  }
  if (!ackDelivered) {
    try {
      await writeRecord(
        ledgerPath,
        { ...claimed, state: 'ack_ready', updatedAt: timestamp },
        serializeGeneralRecord,
      );
    } catch { return generalReceipt('BLOCKED', requestId, 'ledger_failed'); }
    if (resumingAck && !await removeDeliveryClaim(ackClaimPath)) {
      return generalReceipt('BLOCKED', requestId, 'ledger_failed');
    }
    return generalReceipt('BLOCKED', requestId, 'post_failed');
  }

  const acknowledged = { ...claimed, state: 'acknowledged', updatedAt: timestamp };
  try { await writeRecord(ledgerPath, acknowledged, serializeGeneralRecord); }
  catch { return generalReceipt('BLOCKED', requestId, 'ledger_failed'); }
  if (resumingAck && !await removeDeliveryClaim(ackClaimPath)) {
    return generalReceipt('BLOCKED', requestId, 'ledger_failed');
  }

  return enqueueStudioMac(async () => {
    const running = { ...acknowledged, state: 'running', updatedAt: timestamp };
    try { await writeRecord(ledgerPath, running, serializeGeneralRecord); }
    catch { return generalReceipt('BLOCKED', requestId, 'ledger_failed'); }

    let result;
    try { result = validateStudioMacGeneralResult(await actionRunner({ requestId, task })); }
    catch {
      result = validateStudioMacGeneralResult({
        schemaVersion: 'studio-mac-general-result/v1',
        status: 'BLOCKED',
        summary: '작업 변경 여부를 확인해야 합니다.',
        mutationObserved: false,
        readbackVerified: false,
        need: null,
        errorClass: 'outcome_unknown',
      });
    }
    const redactedResult = {
      status: result.status,
      mutationObserved: result.mutationObserved,
      readbackVerified: result.readbackVerified,
      need: result.need,
      errorClass: result.errorClass,
    };

    let finalDelivered;
    try {
      finalDelivered = await deliver(
        statusSink,
        generalStatusPayload(validatedEnvelope, requestId, 'FINAL', result),
        deliveryTimeoutMs,
      );
    } catch {
      finalDelivered = false;
    }
    if (!finalDelivered) {
      await writeRecord(
        ledgerPath,
        { ...running, state: 'final_delivery_unknown', updatedAt: timestamp, result: redactedResult },
        serializeGeneralRecord,
      ).catch(() => {});
      return generalReceipt('BLOCKED', requestId, 'delivery_unknown');
    }

    try {
      await writeRecord(
        ledgerPath,
        { ...running, state: 'completed', updatedAt: timestamp, result: redactedResult },
        serializeGeneralRecord,
      );
    } catch { return generalReceipt('BLOCKED', requestId, 'ledger_failed'); }
    return generalTerminalReceipt(result, requestId);
  });
}
