'use strict';

const fs = require('node:fs');
const { DEFAULT_ENV_FILE, parseEnv } = require('./village-live-read.js');

const ALLOWED_INPUT_FIELDS = new Set([
  'tradeId', 'operationId', 'expectedPeriod', 'dateChange', 'remove', 'add', 'sendEstimate'
]);
const ALLOWED_DATE_FIELDS = new Set([
  'newStartDate', 'newEndDate', 'startTime', 'endTime', 'allowConflicts'
]);
const ALLOWED_EXPECTED_PERIOD_FIELDS = new Set([
  'startDate', 'startTime', 'endDate', 'endTime'
]);

class CorrectionStageError extends Error {
  constructor(stage, message, { outcomeUnknown = false, appliedStages = [], details = null } = {}) {
    super(message);
    this.name = 'CorrectionStageError';
    this.stage = stage;
    this.outcomeUnknown = outcomeUnknown;
    this.appliedStages = appliedStages.slice();
    this.details = details;
    this.code = String(details?.code || '');
  }
}

function correctionFailureDetails(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  return {
    code: String(payload.code || ''),
    tradeId: String(payload.tradeId || ''),
    operationId: String(payload.operationId || ''),
    attemptedStage: String(payload.attemptedStage || ''),
    stages: Array.isArray(payload.stages) ? payload.stages.slice() : [],
    appliedStages: Array.isArray(payload.appliedStages) ? payload.appliedStages.slice() : [],
    readback: payload.readback ?? null,
    readbackError: String(payload.readbackError || ''),
    customerNotificationSent: payload.customerNotificationSent,
  };
}

function requiredText(value, name, maxLength = 200) {
  const text = String(value ?? '').trim();
  if (!text || text.length > maxLength) {
    throw new Error(`${name} must contain 1-${maxLength} characters`);
  }
  return text;
}

function booleanValue(value, name, defaultValue) {
  if (value === undefined) return defaultValue;
  if (value === true || value === false) return value;
  throw new Error(`${name} must be a boolean`);
}

function normalizeDate(value, name) {
  const text = requiredText(value, name, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) throw new Error(`${name} must use YYYY-MM-DD`);
  const [year, month, day] = text.split('-').map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (
    Number.isNaN(parsed.getTime())
    || parsed.getUTCFullYear() !== year
    || parsed.getUTCMonth() !== month - 1
    || parsed.getUTCDate() !== day
  ) {
    throw new Error(`${name} is not a valid date`);
  }
  return text;
}

function normalizeTime(value, name) {
  if (value === undefined || value === null || String(value).trim() === '') return undefined;
  const text = requiredText(value, name, 5);
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(text)) throw new Error(`${name} must use HH:MM`);
  return text;
}

function normalizeDateChange(value) {
  if (value === undefined) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('dateChange must be an object');
  }
  for (const field of Object.keys(value)) {
    if (!ALLOWED_DATE_FIELDS.has(field)) {
      throw new Error(`Unsupported or forbidden dateChange field: ${field}`);
    }
  }
  const normalized = {
    newStartDate: normalizeDate(value.newStartDate, 'dateChange.newStartDate'),
    newEndDate: normalizeDate(value.newEndDate, 'dateChange.newEndDate'),
    startTime: normalizeTime(value.startTime, 'dateChange.startTime'),
    endTime: normalizeTime(value.endTime, 'dateChange.endTime'),
    allowConflicts: booleanValue(value.allowConflicts, 'dateChange.allowConflicts', false)
  };
  if ((normalized.startTime && !normalized.endTime) || (!normalized.startTime && normalized.endTime)) {
    throw new Error('dateChange.startTime and endTime must both be supplied or both be omitted');
  }
  if (normalized.newEndDate < normalized.newStartDate) {
    throw new Error('dateChange.newEndDate must not be before newStartDate');
  }
  return normalized;
}

function normalizeExpectedPeriod(value) {
  if (value === undefined) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('expectedPeriod must be an object');
  }
  for (const field of Object.keys(value)) {
    if (!ALLOWED_EXPECTED_PERIOD_FIELDS.has(field)) {
      throw new Error(`Unsupported or forbidden expectedPeriod field: ${field}`);
    }
  }
  const normalized = {
    startDate: normalizeDate(value.startDate, 'expectedPeriod.startDate'),
    startTime: normalizeTime(value.startTime, 'expectedPeriod.startTime'),
    endDate: normalizeDate(value.endDate, 'expectedPeriod.endDate'),
    endTime: normalizeTime(value.endTime, 'expectedPeriod.endTime'),
  };
  if (!normalized.startTime || !normalized.endTime) {
    throw new Error('expectedPeriod.startTime and endTime are required');
  }
  if (Date.parse(`${normalized.endDate}T${normalized.endTime}:00Z`)
      <= Date.parse(`${normalized.startDate}T${normalized.startTime}:00Z`)) {
    throw new Error('expectedPeriod end instant must be after start instant');
  }
  return normalized;
}

function normalizeCorrectionInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('correction input must be a JSON object');
  }
  for (const field of Object.keys(input)) {
    if (!ALLOWED_INPUT_FIELDS.has(field)) {
      throw new Error(`Unsupported or forbidden correction field: ${field}`);
    }
  }

  const tradeId = requiredText(input.tradeId, 'tradeId', 20);
  if (!/^\d{6}-\d{3}$/.test(tradeId)) throw new Error('tradeId must use YYMMDD-NNN format');
  const operationId = requiredText(input.operationId, 'operationId', 80);
  if (!/^[a-f0-9-]{16,80}$/i.test(operationId)) {
    throw new Error('operationId must be a 16-80 character hex/hyphen identifier');
  }

  const removeInput = input.remove === undefined ? [] : input.remove;
  if (!Array.isArray(removeInput) || removeInput.length > 50) {
    throw new Error('remove must be an array with at most 50 entries');
  }
  const seenScheduleIds = new Set();
  const remove = removeInput.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`remove[${index}] must be an object`);
    }
    const allowed = new Set(['scheduleId', 'expectedName', 'expectedQty']);
    for (const field of Object.keys(entry)) {
      if (!allowed.has(field)) throw new Error(`Unsupported or forbidden remove field: ${field}`);
    }
    const scheduleId = requiredText(entry.scheduleId, `remove[${index}].scheduleId`, 40);
    if (!scheduleId.startsWith(`${tradeId}-`) || !/^\d{6}-\d{3}-\d+$/.test(scheduleId)) {
      throw new Error(`remove[${index}].scheduleId does not belong to tradeId`);
    }
    if (seenScheduleIds.has(scheduleId)) throw new Error(`duplicate removal scheduleId: ${scheduleId}`);
    seenScheduleIds.add(scheduleId);
    const normalizedRemoval = {
      scheduleId,
      expectedName: requiredText(entry.expectedName, `remove[${index}].expectedName`, 160)
    };
    if (entry.expectedQty !== undefined) {
      if (typeof entry.expectedQty !== 'number'
          || !Number.isSafeInteger(entry.expectedQty)
          || entry.expectedQty < 1
          || entry.expectedQty > 99) {
        throw new Error(`remove[${index}].expectedQty must be an integer from 1 to 99`);
      }
      normalizedRemoval.expectedQty = entry.expectedQty;
    }
    return normalizedRemoval;
  });

  const addInput = input.add === undefined ? [] : input.add;
  if (!Array.isArray(addInput) || addInput.length > 50) {
    throw new Error('add must be an array with at most 50 entries');
  }
  const add = addInput.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`add[${index}] must be an object`);
    }
    const allowed = new Set(['name', 'qty']);
    for (const field of Object.keys(entry)) {
      if (!allowed.has(field)) throw new Error(`Unsupported or forbidden add field: ${field}`);
    }
    const qty = Number(entry.qty);
    if (!Number.isSafeInteger(qty) || qty < 1 || qty > 99) {
      throw new Error(`add[${index}].qty must be an integer from 1 to 99`);
    }
    return { name: requiredText(entry.name, `add[${index}].name`, 160), qty };
  });

  const normalized = {
    tradeId,
    operationId,
    expectedPeriod: normalizeExpectedPeriod(input.expectedPeriod),
    dateChange: normalizeDateChange(input.dateChange),
    remove,
    add,
    sendEstimate: booleanValue(input.sendEstimate, 'sendEstimate', false)
  };
  if (!normalized.dateChange && remove.length === 0 && add.length === 0 && !normalized.sendEstimate) {
    throw new Error('At least one correction or send must be requested');
  }
  return normalized;
}

function buildEndpoint(config) {
  const apiUrl = config?.VILLAGE2_API_URL;
  const apiKey = config?.VILLAGE2_API_KEY;
  if (!apiUrl || !apiKey) throw new Error('Village registered-trade correction configuration is incomplete');
  const url = new URL(apiUrl);
  if (url.protocol !== 'https:' || url.hostname !== 'script.google.com') {
    throw new Error('Village registered-trade correction endpoint must use https://script.google.com');
  }
  return { url, apiKey };
}

function buildPostRequest(config, body) {
  const { url, apiKey } = buildEndpoint(config);
  return {
    url: url.toString(),
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ key: apiKey, ...body })
  };
}

function isExplicitSuccess(payload) {
  return payload?.success === true || String(payload?.status || '').trim().toUpperCase() === 'OK';
}

async function postAction({ config, fetchImpl, timeoutMs, stage, body, appliedStages }) {
  const request = buildPostRequest(config, body);
  let response;
  try {
    response = await fetchImpl(request.url, {
      method: request.method,
      headers: request.headers,
      body: request.body,
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs)
    });
  } catch (error) {
    throw new CorrectionStageError(stage, `${stage} outcome is unknown: ${error.message}`, {
      outcomeUnknown: true,
      appliedStages
    });
  }
  if (!response?.ok) {
    throw new CorrectionStageError(stage, `${stage} outcome is unknown after HTTP ${response?.status ?? 'unknown'}`, {
      outcomeUnknown: true,
      appliedStages
    });
  }
  let payload;
  try {
    payload = await response.json();
  } catch (error) {
    throw new CorrectionStageError(stage, `${stage} outcome is unknown because the response was not JSON`, {
      outcomeUnknown: true,
      appliedStages
    });
  }
  if (!isExplicitSuccess(payload)) {
    const explicitFailure = !!payload && (
      payload.success === false
      || String(payload.status || '').trim().toUpperCase() === 'ERROR'
      || !!payload.error
    );
    const serverAppliedStages = Array.isArray(payload?.appliedStages)
      ? payload.appliedStages.map((value) => String(value || '').trim()).filter(Boolean)
      : [];
    throw new CorrectionStageError(
      stage,
      `${stage} ${explicitFailure ? 'failed' : 'outcome is unknown'}: ${String(payload?.error || payload?.message || payload?.status || 'no explicit success')}`,
      {
        outcomeUnknown: payload?.outcomeUnknown === true || !explicitFailure,
        appliedStages: serverAppliedStages.length ? serverAppliedStages : appliedStages,
        details: correctionFailureDetails(payload),
      }
    );
  }
  appliedStages.push(stage);
  return payload;
}

function mutationId(operationId, stage, index) {
  return `${operationId}-${stage}${index === undefined ? '' : `-${index + 1}`}`;
}

function sendSummary(payload) {
  return {
    attempted: true,
    accepted: true,
    status: String(payload.status || (payload.success === true ? 'OK' : '')),
    action: String(payload.action || 'sendEstimate'),
    tradeId: String(payload.tradeID || payload.tradeId || payload.id || ''),
    quoteUrl: String(payload.quoteUrl || payload.url || ''),
    message: String(payload.message || '')
  };
}

async function runRegisteredTradeCorrection({
  config,
  input,
  fetchImpl = globalThis.fetch,
  timeoutMs = 240_000
} = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('fetch is unavailable');
  const normalized = normalizeCorrectionInput(input);
  const appliedStages = [];
  const hasCorrection = !!normalized.dateChange || normalized.remove.length > 0 || normalized.add.length > 0;
  let correctionPayload = null;
  if (hasCorrection) {
    const args = {
      tradeId: normalized.tradeId,
      operationId: normalized.operationId,
      ...(normalized.expectedPeriod ? { expectedPeriod: normalized.expectedPeriod } : {}),
      ...(normalized.dateChange ? { dateChange: normalized.dateChange } : {}),
      ...(normalized.remove.length ? { remove: normalized.remove } : {}),
      ...(normalized.add.length ? { add: normalized.add } : {})
    };
    correctionPayload = await postAction({
      config,
      fetchImpl,
      timeoutMs,
      stage: 'scheduleCorrectRegisteredTrade',
      appliedStages,
      body: { action: 'scheduleCorrectRegisteredTrade', args }
    });
    const returnedTradeId = String(correctionPayload.tradeId || '').trim();
    const returnedOperationId = String(correctionPayload.operationId || '').trim();
    const validReadback = correctionPayload.readback
      && correctionPayload.readback.contract
      && correctionPayload.readback.schedule
      && correctionPayload.readback.ledger;
    const validRegeneration = correctionPayload.contractRegeneration
      && correctionPayload.contractRegeneration.success === true
      && correctionPayload.contractRegeneration.url
      && correctionPayload.contractRegeneration.fileId;
    if (
      returnedTradeId !== normalized.tradeId
      || returnedOperationId !== normalized.operationId
      || !validReadback
      || !validRegeneration
      || correctionPayload.customerNotificationSent !== false
    ) {
      throw new CorrectionStageError(
        'scheduleCorrectRegisteredTrade',
        'scheduleCorrectRegisteredTrade returned incomplete or mismatched authoritative readback',
        {
          outcomeUnknown: true,
          appliedStages,
          details: correctionFailureDetails(correctionPayload),
        }
      );
    }
  }

  let send = { attempted: false, accepted: false };
  if (normalized.sendEstimate) {
    const sendPayload = await postAction({
      config,
      fetchImpl,
      timeoutMs,
      stage: 'sendEstimate',
      appliedStages,
      body: {
        action: 'sendEstimate',
        tradeId: normalized.tradeId,
        mutationId: mutationId(normalized.operationId, 'send')
      }
    });
    const returnedTradeId = String(
      sendPayload.tradeID || sendPayload.tradeId || sendPayload.id || normalized.tradeId
    ).trim();
    if (returnedTradeId !== normalized.tradeId) {
      throw new CorrectionStageError('sendEstimate', 'sendEstimate acknowledged a different tradeId', {
        outcomeUnknown: true,
        appliedStages
      });
    }
    send = sendSummary(sendPayload);
  }

  return {
    ok: true,
    verified: true,
    tradeId: normalized.tradeId,
    appliedStages,
    contractRegeneration: correctionPayload?.contractRegeneration
      ? {
          success: true,
          url: String(correctionPayload.contractRegeneration.url || correctionPayload.contractRegeneration.contractUrl || ''),
          fileId: String(correctionPayload.contractRegeneration.fileId || '')
        }
      : null,
    send,
    readback: correctionPayload?.readback || null
  };
}

function parseCliArgs(args) {
  const command = String(args[0] || '').trim().toLowerCase();
  if (command === '--help' || command === '-h' || command === 'help') {
    return { command: 'help', envFile: DEFAULT_ENV_FILE, inputFile: null };
  }
  if (command !== 'execute') throw new Error('Command must be execute');
  const options = { command, envFile: DEFAULT_ENV_FILE, inputFile: null };
  for (let index = 1; index < args.length; index += 1) {
    const flag = args[index];
    const value = args[index + 1];
    if (!value || (flag !== '--env-file' && flag !== '--input-file')) {
      throw new Error('Only --env-file PATH and --input-file PATH are supported');
    }
    if (flag === '--env-file') options.envFile = value;
    if (flag === '--input-file') options.inputFile = value;
    index += 1;
  }
  return options;
}

function getCliHelpText() {
  return [
    'Usage: village-registered-trade-correction.js execute [--input-file PATH] [--env-file PATH]',
    'Read an explicit JSON envelope from stdin unless --input-file is provided.',
    'No natural-language parsing, generic sheet writes, automatic retries, or implicit customer send.',
    'sendEstimate runs only when the JSON field is true.',
    ''
  ].join('\n');
}

async function main() {
  const options = parseCliArgs(process.argv.slice(2));
  if (options.command === 'help') {
    process.stdout.write(getCliHelpText());
    return;
  }
  const config = parseEnv(fs.readFileSync(options.envFile, 'utf8'));
  const input = JSON.parse(fs.readFileSync(options.inputFile || 0, 'utf8').replace(/^\uFEFF/, ''));
  const result = await runRegisteredTradeCorrection({ config, input });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

module.exports = {
  ALLOWED_INPUT_FIELDS,
  CorrectionStageError,
  buildPostRequest,
  getCliHelpText,
  normalizeCorrectionInput,
  parseCliArgs,
  runRegisteredTradeCorrection
};

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${JSON.stringify({
      ok: false,
      error: error.message,
      stage: error.stage || '',
      outcomeUnknown: error.outcomeUnknown === true,
      appliedStages: Array.isArray(error.appliedStages) ? error.appliedStages : [],
      details: error.details || null,
    })}\n`);
    process.exitCode = 1;
  });
}
