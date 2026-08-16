'use strict';

const fs = require('node:fs');
const { DEFAULT_ENV_FILE, parseEnv } = require('./village-live-read.js');

const ALLOWED_INPUT_FIELDS = new Set([
  'tradeId', 'operationId', 'dateChange', 'remove', 'add', 'sendEstimate'
]);
const ALLOWED_DATE_FIELDS = new Set([
  'newStartDate', 'newEndDate', 'startTime', 'endTime', 'allowConflicts'
]);
const SCHEDULE_SHEET = '스케줄상세';
const CONTRACT_SHEET = '계약마스터';

class CorrectionStageError extends Error {
  constructor(stage, message, { outcomeUnknown = false, appliedStages = [] } = {}) {
    super(message);
    this.name = 'CorrectionStageError';
    this.stage = stage;
    this.outcomeUnknown = outcomeUnknown;
    this.appliedStages = appliedStages.slice();
  }
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
    const allowed = new Set(['scheduleId', 'expectedName']);
    for (const field of Object.keys(entry)) {
      if (!allowed.has(field)) throw new Error(`Unsupported or forbidden remove field: ${field}`);
    }
    const scheduleId = requiredText(entry.scheduleId, `remove[${index}].scheduleId`, 40);
    if (!scheduleId.startsWith(`${tradeId}-`) || !/^\d{6}-\d{3}-\d+$/.test(scheduleId)) {
      throw new Error(`remove[${index}].scheduleId does not belong to tradeId`);
    }
    if (seenScheduleIds.has(scheduleId)) throw new Error(`duplicate removal scheduleId: ${scheduleId}`);
    seenScheduleIds.add(scheduleId);
    return {
      scheduleId,
      expectedName: entry.expectedName === undefined
        ? undefined
        : requiredText(entry.expectedName, `remove[${index}].expectedName`, 160)
    };
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

function buildSearchRequest(config, sheet, column, tradeId) {
  const { url, apiKey } = buildEndpoint(config);
  url.searchParams.set('key', apiKey);
  url.searchParams.set('action', 'search');
  url.searchParams.set('sheet', sheet);
  url.searchParams.set('col', column);
  url.searchParams.set('query', tradeId);
  return { url: url.toString(), method: 'GET' };
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

function normalizeDateCell(value) {
  const text = String(value ?? '').trim();
  const match = text.match(/(\d{4})[-/.]\s*(\d{1,2})[-/.]\s*(\d{1,2})/);
  if (!match) return '';
  return `${match[1]}-${String(match[2]).padStart(2, '0')}-${String(match[3]).padStart(2, '0')}`;
}

function normalizeTimeCell(value) {
  const text = String(value ?? '').trim();
  if (/^1899-\d{2}-\d{2}\s/.test(text)) return '';
  const match = text.match(/(?:^|\s)(\d{1,2}):(\d{2})(?::\d{2})?(?:\s|$)/);
  return match ? `${String(match[1]).padStart(2, '0')}:${match[2]}` : '';
}

function numericCell(value) {
  const number = Number(String(value ?? '').replace(/,/g, '').trim());
  return Number.isFinite(number) ? number : 0;
}

function headerIndex(headers, name, stage) {
  const index = headers.findIndex((header) => String(header ?? '').trim() === name);
  if (index < 0) throw new CorrectionStageError(stage, `${stage} is missing required column: ${name}`);
  return index;
}

function parseAuthoritativePayloads(schedulePayload, contractPayload, tradeId, stage) {
  if (!schedulePayload || schedulePayload.error || !Array.isArray(schedulePayload.headers)) {
    throw new CorrectionStageError(stage, `${stage} schedule payload is invalid`);
  }
  if (!contractPayload || contractPayload.error || !Array.isArray(contractPayload.headers)) {
    throw new CorrectionStageError(stage, `${stage} contract payload is invalid`);
  }

  const sh = schedulePayload.headers;
  const scheduleIndex = {
    scheduleId: headerIndex(sh, '스케줄ID', stage),
    tradeId: headerIndex(sh, '거래ID', stage),
    setName: headerIndex(sh, '세트명', stage),
    name: headerIndex(sh, '장비명', stage),
    qty: headerIndex(sh, '수량', stage),
    startDate: headerIndex(sh, '반출일', stage),
    startTime: headerIndex(sh, '반출시간', stage),
    endDate: headerIndex(sh, '반납일', stage),
    endTime: headerIndex(sh, '반납시간', stage),
    unitPrice: headerIndex(sh, '단가', stage)
  };
  const scheduleRows = (Array.isArray(schedulePayload.results) ? schedulePayload.results : [])
    .map((result) => Array.isArray(result?.data) ? result.data : [])
    .filter((row) => String(row[scheduleIndex.tradeId] ?? '').trim() === tradeId)
    .map((row) => {
      const setName = String(row[scheduleIndex.setName] ?? '').trim();
      const name = String(row[scheduleIndex.name] ?? '').trim();
      return {
        scheduleId: String(row[scheduleIndex.scheduleId] ?? '').trim(),
        setName,
        name,
        qty: numericCell(row[scheduleIndex.qty]),
        startDate: normalizeDateCell(row[scheduleIndex.startDate]),
        startTime: normalizeTimeCell(row[scheduleIndex.startTime]),
        endDate: normalizeDateCell(row[scheduleIndex.endDate]),
        endTime: normalizeTimeCell(row[scheduleIndex.endTime]),
        unitPrice: numericCell(row[scheduleIndex.unitPrice]),
        topLevel: !setName || setName === name
      };
    });
  if (scheduleRows.length === 0) {
    throw new CorrectionStageError(stage, `${stage} found no exact schedule rows for ${tradeId}`);
  }

  const ch = contractPayload.headers;
  const contractIndex = {
    tradeId: headerIndex(ch, '거래ID', stage),
    startDate: headerIndex(ch, '반출일', stage),
    startTime: headerIndex(ch, '반출시간', stage),
    endDate: headerIndex(ch, '반납일', stage),
    endTime: headerIndex(ch, '반납시간', stage),
    rounds: headerIndex(ch, '회차', stage)
  };
  const contractRows = (Array.isArray(contractPayload.results) ? contractPayload.results : [])
    .map((result) => Array.isArray(result?.data) ? result.data : [])
    .filter((row) => String(row[contractIndex.tradeId] ?? '').trim() === tradeId);
  if (contractRows.length !== 1) {
    throw new CorrectionStageError(stage, `${stage} requires exactly one contract row for ${tradeId}`);
  }
  const row = contractRows[0];
  const contract = {
    tradeId,
    startDate: normalizeDateCell(row[contractIndex.startDate]),
    startTime: normalizeTimeCell(row[contractIndex.startTime]),
    endDate: normalizeDateCell(row[contractIndex.endDate]),
    endTime: normalizeTimeCell(row[contractIndex.endTime]),
    rounds: numericCell(row[contractIndex.rounds])
  };
  return { schedule: { rows: scheduleRows }, contract };
}

async function readJson(fetchImpl, request, timeoutMs, stage) {
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
    throw new CorrectionStageError(stage, `${stage} request failed: ${error.message}`);
  }
  if (!response?.ok) {
    throw new CorrectionStageError(stage, `${stage} failed with HTTP ${response?.status ?? 'unknown'}`);
  }
  try {
    return await response.json();
  } catch (error) {
    throw new CorrectionStageError(stage, `${stage} returned non-JSON data`);
  }
}

async function readAuthoritativeTrade(config, tradeId, fetchImpl, timeoutMs, stage) {
  const requests = [
    buildSearchRequest(config, SCHEDULE_SHEET, 'B', tradeId),
    buildSearchRequest(config, CONTRACT_SHEET, 'A', tradeId)
  ];
  const [schedulePayload, contractPayload] = await Promise.all(
    requests.map((request) => readJson(fetchImpl, request, Math.min(timeoutMs, 30_000), stage))
  );
  return parseAuthoritativePayloads(schedulePayload, contractPayload, tradeId, stage);
}

function verifyRemovalPreflight(baseline, remove) {
  const byId = new Map(baseline.schedule.rows.map((row) => [row.scheduleId, row]));
  for (const entry of remove) {
    const row = byId.get(entry.scheduleId);
    if (!row) {
      throw new CorrectionStageError(
        'preflight',
        `Removal preflight failed: scheduleId not found: ${entry.scheduleId}`
      );
    }
    if (entry.expectedName && row.name !== entry.expectedName) {
      throw new CorrectionStageError(
        'preflight',
        `Removal preflight failed: expected ${entry.expectedName}, found ${row.name}`
      );
    }
  }
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
    throw new CorrectionStageError(
      stage,
      `${stage} ${explicitFailure ? 'failed' : 'outcome is unknown'}: ${String(payload?.error || payload?.message || payload?.status || 'no explicit success')}`,
      { outcomeUnknown: !explicitFailure, appliedStages }
    );
  }
  appliedStages.push(stage);
  return payload;
}

function calculateRentalRounds(startDate, startTime, endDate, endTime) {
  const startMs = Date.parse(`${startDate}T${startTime}:00+09:00`);
  const endMs = Date.parse(`${endDate}T${endTime}:00+09:00`);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
    throw new Error('Final readback has an invalid rental period');
  }
  return Math.max(1, Math.ceil(((endMs - startMs) / 3_600_000 - 3) / 24));
}

function topLevelQuantities(rows, excludedScheduleIds = new Set()) {
  const quantities = new Map();
  for (const row of rows) {
    if (!row.topLevel || excludedScheduleIds.has(row.scheduleId)) continue;
    quantities.set(row.name, (quantities.get(row.name) || 0) + Number(row.qty || 0));
  }
  return quantities;
}

function singleSchedulePeriod(rows, stage) {
  const byKey = new Map();
  for (const row of rows) {
    const period = {
      startDate: row.startDate,
      startTime: row.startTime,
      endDate: row.endDate,
      endTime: row.endTime
    };
    const key = [period.startDate, period.startTime, period.endDate, period.endTime].join('|');
    byKey.set(key, period);
  }
  if (byKey.size !== 1) {
    throw new CorrectionStageError(stage, `${stage} schedule rows do not have one exact period`);
  }
  const period = [...byKey.values()][0];
  if (!period.startDate || !period.startTime || !period.endDate || !period.endTime) {
    throw new CorrectionStageError(stage, `${stage} schedule period is incomplete`);
  }
  return period;
}

function verifyFinalReadback(baseline, finalState, input) {
  const finalRows = finalState.schedule.rows;
  const finalIds = new Set(finalRows.map((row) => row.scheduleId));
  for (const removal of input.remove) {
    if (finalIds.has(removal.scheduleId)) {
      throw new CorrectionStageError('finalReadback', `Final readback still contains removed row: ${removal.scheduleId}`);
    }
  }

  const removedIds = new Set(input.remove.map((entry) => entry.scheduleId));
  const expectedQuantities = topLevelQuantities(baseline.schedule.rows, removedIds);
  for (const addition of input.add) {
    expectedQuantities.set(addition.name, (expectedQuantities.get(addition.name) || 0) + addition.qty);
  }
  const actualQuantities = topLevelQuantities(finalRows);
  for (const [name, expectedQty] of expectedQuantities) {
    if (actualQuantities.get(name) !== expectedQty) {
      throw new CorrectionStageError(
        'finalReadback',
        `Final readback item quantity mismatch for ${name}: expected ${expectedQty}, got ${String(actualQuantities.get(name))}`
      );
    }
  }
  for (const name of actualQuantities.keys()) {
    if (!expectedQuantities.has(name)) {
      throw new CorrectionStageError('finalReadback', `Final readback contains an unexpected item: ${name}`);
    }
  }

  const baselinePeriod = singleSchedulePeriod(baseline.schedule.rows, 'baselineReadback');
  const finalPeriod = singleSchedulePeriod(finalRows, 'finalReadback');
  const expectedPeriod = input.dateChange
    ? {
        startDate: input.dateChange.newStartDate,
        startTime: input.dateChange.startTime || baselinePeriod.startTime,
        endDate: input.dateChange.newEndDate,
        endTime: input.dateChange.endTime || baselinePeriod.endTime
      }
    : baselinePeriod;
  const contract = finalState.contract;
  if (
    contract.startDate !== expectedPeriod.startDate
    || contract.endDate !== expectedPeriod.endDate
  ) {
    throw new CorrectionStageError('finalReadback', 'Final readback contract dates do not match the requested period');
  }
  const periodKey = [
    expectedPeriod.startDate,
    expectedPeriod.startTime,
    expectedPeriod.endDate,
    expectedPeriod.endTime
  ].join('|');
  const finalPeriodKey = [
    finalPeriod.startDate, finalPeriod.startTime, finalPeriod.endDate, finalPeriod.endTime
  ].join('|');
  if (finalPeriodKey !== periodKey) {
    throw new CorrectionStageError('finalReadback', 'Final readback schedule period does not match the request');
  }
  const expectedRounds = calculateRentalRounds(
    expectedPeriod.startDate,
    expectedPeriod.startTime,
    expectedPeriod.endDate,
    expectedPeriod.endTime
  );
  if (Number(contract.rounds) !== expectedRounds) {
    throw new CorrectionStageError(
      'finalReadback',
      `Final readback rental rounds mismatch: expected ${expectedRounds}, got ${String(contract.rounds)}`
    );
  }
  return finalState;
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
  const baseline = await readAuthoritativeTrade(
    config, normalized.tradeId, fetchImpl, timeoutMs, 'baselineReadback'
  );
  verifyRemovalPreflight(baseline, normalized.remove);

  const appliedStages = [];
  if (normalized.dateChange) {
    const dateChange = normalized.dateChange;
    await postAction({
      config,
      fetchImpl,
      timeoutMs,
      stage: 'scheduleChangeDates',
      appliedStages,
      body: {
        action: 'scheduleChangeDates',
        args: {
          tradeId: normalized.tradeId,
          newStartDate: dateChange.newStartDate,
          newEndDate: dateChange.newEndDate,
          ...(dateChange.startTime
            ? { startTime: dateChange.startTime, endTime: dateChange.endTime }
            : {}),
          allowConflicts: dateChange.allowConflicts,
          dryRun: false
        }
      }
    });
  }

  for (let index = 0; index < normalized.remove.length; index += 1) {
    const removal = normalized.remove[index];
    await postAction({
      config,
      fetchImpl,
      timeoutMs,
      stage: 'scheduleRemoveEquip',
      appliedStages,
      body: {
        action: 'scheduleRemoveEquip',
        tid: normalized.tradeId,
        scheduleId: removal.scheduleId,
        mutationId: mutationId(normalized.operationId, 'remove', index),
        directRegenerate: false
      }
    });
  }

  if (normalized.add.length > 0) {
    await postAction({
      config,
      fetchImpl,
      timeoutMs,
      stage: 'scheduleAddEquips',
      appliedStages,
      body: {
        action: 'scheduleAddEquips',
        tid: normalized.tradeId,
        entries: normalized.add,
        mutationId: mutationId(normalized.operationId, 'add'),
        directRegenerate: false
      }
    });
  }

  let contractRegeneration = null;
  if (normalized.remove.length > 0 || normalized.add.length > 0) {
    contractRegeneration = await postAction({
      config,
      fetchImpl,
      timeoutMs,
      stage: 'regenerateContract',
      appliedStages,
      body: { action: 'regenerateContract', tradeId: normalized.tradeId }
    });
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

  let finalState;
  try {
    finalState = await readAuthoritativeTrade(
      config, normalized.tradeId, fetchImpl, timeoutMs, 'finalReadback'
    );
    verifyFinalReadback(baseline, finalState, normalized);
  } catch (error) {
    if (error instanceof CorrectionStageError) {
      error.appliedStages = appliedStages.slice();
      throw error;
    }
    throw new CorrectionStageError('finalReadback', `Final readback failed: ${error.message}`, {
      appliedStages
    });
  }

  return {
    ok: true,
    verified: true,
    tradeId: normalized.tradeId,
    appliedStages,
    contractRegeneration: contractRegeneration
      ? {
          success: true,
          url: String(contractRegeneration.url || contractRegeneration.contractUrl || ''),
          fileId: String(contractRegeneration.fileId || '')
        }
      : null,
    send,
    readback: finalState
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
  buildSearchRequest,
  calculateRentalRounds,
  getCliHelpText,
  normalizeCorrectionInput,
  parseCliArgs,
  runRegisteredTradeCorrection,
  verifyFinalReadback
};

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${JSON.stringify({
      ok: false,
      error: error.message,
      stage: error.stage || '',
      outcomeUnknown: error.outcomeUnknown === true,
      appliedStages: Array.isArray(error.appliedStages) ? error.appliedStages : []
    })}\n`);
    process.exitCode = 1;
  });
}
