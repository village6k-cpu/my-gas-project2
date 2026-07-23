'use strict';

const fs = require('node:fs');
const { DEFAULT_ENV_FILE, parseEnv } = require('./village-live-read.js');

const ALLOWED_INPUT_FIELDS = new Set([
  'tradeId', 'name', 'currentDate', 'newStartDate', 'newEndDate',
  'startTime', 'endTime', 'allowConflicts', 'dryRun'
]);

function requiredText(value, name, maxLength = 120) {
  const text = String(value ?? '').trim();
  if (!text || text.length > maxLength) {
    throw new Error(`${name} must contain 1-${maxLength} characters`);
  }
  return text;
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

function booleanValue(value, name, defaultValue) {
  if (value === undefined) return defaultValue;
  if (value === true || value === false) return value;
  throw new Error(`${name} must be a boolean`);
}

function normalizeInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('change input must be a JSON object');
  }
  for (const key of Object.keys(input)) {
    if (!ALLOWED_INPUT_FIELDS.has(key)) {
      throw new Error(`Unsupported or forbidden field in date change: ${key}`);
    }
  }

  const tradeId = input.tradeId === undefined ? undefined : requiredText(input.tradeId, 'tradeId', 40);
  const name = input.name === undefined ? undefined : requiredText(input.name, 'name', 80);
  const currentDate = input.currentDate === undefined ? undefined : normalizeDate(input.currentDate, 'currentDate');
  if (!tradeId && (!name || !currentDate)) {
    throw new Error('Provide tradeId, or both name and currentDate');
  }
  if (tradeId && !/^\d{6}-\d{3,}$/.test(tradeId)) {
    throw new Error('tradeId must use YYMMDD-NNN format');
  }

  const normalized = {
    tradeId,
    name,
    currentDate,
    newStartDate: normalizeDate(input.newStartDate, 'newStartDate'),
    newEndDate: normalizeDate(input.newEndDate, 'newEndDate'),
    startTime: normalizeTime(input.startTime, 'startTime'),
    endTime: normalizeTime(input.endTime, 'endTime'),
    allowConflicts: booleanValue(input.allowConflicts, 'allowConflicts', false),
    dryRun: booleanValue(input.dryRun, 'dryRun', false)
  };
  if ((normalized.startTime && !normalized.endTime) || (!normalized.startTime && normalized.endTime)) {
    throw new Error('startTime and endTime must either both be supplied or both be omitted');
  }
  return normalized;
}

function baseUrl(config) {
  const apiUrl = config?.VILLAGE2_API_URL;
  const apiKey = config?.VILLAGE2_API_KEY;
  if (!apiUrl || !apiKey) throw new Error('Village trade-date configuration is incomplete');
  const url = new URL(apiUrl);
  if (url.protocol !== 'https:' || url.hostname !== 'script.google.com') {
    throw new Error('Village trade-date endpoint must use https://script.google.com');
  }
  return { url, apiKey };
}

function buildCandidateRequest(config, { name }) {
  const { url, apiKey } = baseUrl(config);
  url.searchParams.set('key', apiKey);
  url.searchParams.set('action', 'search');
  url.searchParams.set('sheet', '스케줄상세');
  url.searchParams.set('col', '예약자명');
  url.searchParams.set('query', requiredText(name, 'name', 80));
  return { method: 'GET', url: url.toString() };
}

function buildChangeRequest(config, args) {
  const { url, apiKey } = baseUrl(config);
  return {
    method: 'POST',
    url: url.toString(),
    body: JSON.stringify({ key: apiKey, action: 'scheduleChangeDates', args }),
    headers: { 'content-type': 'application/json; charset=utf-8' }
  };
}

async function fetchJson(fetchImpl, request, timeoutMs, label) {
  const response = await fetchImpl(request.url, {
    method: request.method,
    headers: request.headers,
    body: request.body,
    redirect: 'follow',
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!response?.ok) throw new Error(`${label} failed with HTTP ${response?.status ?? 'unknown'}`);
  const payload = await response.json();
  if (!payload || payload.error) throw new Error(`${label} failed: ${String(payload?.error || 'empty response')}`);
  return payload;
}

function dateOnly(value) {
  const text = String(value ?? '').trim();
  const iso = text.match(/(\d{4})[-/.]\s*(\d{1,2})[-/.]\s*(\d{1,2})/);
  if (!iso) return '';
  return `${iso[1]}-${String(iso[2]).padStart(2, '0')}-${String(iso[3]).padStart(2, '0')}`;
}

function resolveCandidate(payload, { name, currentDate }) {
  const tradeIds = new Set();
  for (const result of Array.isArray(payload?.results) ? payload.results : []) {
    const row = Array.isArray(result?.data) ? result.data : [];
    if (String(row[12] ?? '').trim() !== name) continue;
    if (dateOnly(row[5]) !== currentDate) continue;
    const tradeId = String(row[1] ?? '').trim();
    if (tradeId) tradeIds.add(tradeId);
  }
  if (tradeIds.size === 0) throw new Error(`No registered trade matched ${name} on ${currentDate}`);
  if (tradeIds.size !== 1) throw new Error(`Ambiguous registered trade for ${name} on ${currentDate}`);
  return [...tradeIds][0];
}

function verifyReadback(payload, expected) {
  if (payload.success !== true) {
    throw new Error(`Date change failed: ${String(payload.message || payload.status || 'unknown error')}`);
  }
  if (expected.dryRun) return;
  if (payload.customerNotificationSent !== false) {
    throw new Error('Date change readback verification failed: notification state is unsafe');
  }
  const regeneration = payload.contractRegeneration;
  if (
    !regeneration
    || regeneration.success !== true
    || !String(regeneration.url || '').trim()
    || !String(regeneration.fileId || '').trim()
  ) {
    throw new Error('Date change readback verification failed: contract was not regenerated');
  }
  const readback = payload.readback;
  const contract = readback?.contract;
  const schedule = readback?.schedule;
  const ledger = readback?.ledger;
  const startTime = expected.startTime || contract?.startTime;
  const endTime = expected.endTime || contract?.endTime;
  const period = `${expected.newStartDate}|${startTime}|${expected.newEndDate}|${endTime}`;
  if (
    !contract
    || contract.startDate !== expected.newStartDate
    || contract.endDate !== expected.newEndDate
    || !startTime || !endTime
    || contract.startTime !== startTime
    || contract.endTime !== endTime
    || !schedule || Number(schedule.rows) < 1
    || !Array.isArray(schedule.periods) || schedule.periods.length !== 1
    || schedule.periods[0] !== period
    || !ledger || Number(ledger.rows) < 1
    || ledger.startDate !== expected.newStartDate
    || !Array.isArray(ledger.links) || ledger.links.length !== 1
    || ledger.links[0] !== regeneration.url
    || ledger.contractLink !== regeneration.url
  ) {
    throw new Error('Date change readback verification failed: authoritative layers do not match');
  }
}

async function changeTradeDates({
  config,
  input,
  fetchImpl = globalThis.fetch,
  timeoutMs = 240_000
} = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('fetch is unavailable');
  const normalized = normalizeInput(input);
  let tradeId = normalized.tradeId;
  if (!tradeId) {
    const candidateRequest = buildCandidateRequest(config, normalized);
    const candidates = await fetchJson(fetchImpl, candidateRequest, Math.min(timeoutMs, 30_000), 'Trade lookup');
    tradeId = resolveCandidate(candidates, normalized);
  }

  const args = {
    tradeId,
    newStartDate: normalized.newStartDate,
    newEndDate: normalized.newEndDate,
    ...(normalized.startTime ? { startTime: normalized.startTime, endTime: normalized.endTime } : {}),
    allowConflicts: normalized.allowConflicts,
    dryRun: normalized.dryRun
  };
  const request = buildChangeRequest(config, args);
  const payload = await fetchJson(fetchImpl, request, timeoutMs, 'Registered-trade date change');
  if (payload.success !== true && payload.status === 'CONFLICT') {
    return {
      ok: false,
      mode: 'blocked',
      tradeId,
      verified: false,
      status: 'CONFLICT',
      conflicts: Array.isArray(payload.conflicts) ? payload.conflicts : [],
      availabilityWarnings: Array.isArray(payload.availabilityWarnings) ? payload.availabilityWarnings : [],
      matchedScheduleRows: Number(payload.matchedScheduleRows) || 0,
      updatedScheduleRows: 0,
      customerNotificationSent: payload.customerNotificationSent
    };
  }
  verifyReadback(payload, { ...normalized, tradeId });

  return {
    ok: true,
    mode: normalized.dryRun ? 'dry-run' : 'changed',
    tradeId,
    verified: normalized.dryRun ? false : true,
    status: payload.status,
    conflicts: Array.isArray(payload.conflicts) ? payload.conflicts : [],
    availabilityWarnings: Array.isArray(payload.availabilityWarnings) ? payload.availabilityWarnings : [],
    updatedScheduleRows: Number(payload.updatedScheduleRows) || 0,
    contractRegeneration: payload.contractRegeneration || null,
    readback: payload.readback || null,
    customerNotificationSent: payload.customerNotificationSent
  };
}

function parseCliArgs(args) {
  const command = args[0];
  if (command === '--help' || command === '-h' || command === 'help') {
    return { command: 'help', envFile: DEFAULT_ENV_FILE, inputFile: null };
  }
  if (command !== 'change') throw new Error('Command must be change');
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

function parseJsonInput(source) {
  return JSON.parse(String(source ?? '').replace(/^\uFEFF/, ''));
}

function getCliHelpText() {
  return [
    'Usage: village-trade-date-change.js change [--input-file PATH] [--env-file PATH]',
    'Read JSON from stdin unless --input-file is provided.',
    'Input envelope:',
    '  change {"name":"customer","currentDate":"YYYY-MM-DD","newStartDate":"YYYY-MM-DD","newEndDate":"YYYY-MM-DD","allowConflicts":false}',
    '  Or provide "tradeId" instead of "name" + "currentDate".',
    '  Omit startTime/endTime to preserve the registered times. No customer message is sent.',
    '  Set allowConflicts true only when the owner explicitly accepts the reported conflicts.',
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
  const input = parseJsonInput(fs.readFileSync(options.inputFile || 0, 'utf8'));
  const result = await changeTradeDates({ config, input });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (!result.ok) process.exitCode = 2;
}

module.exports = {
  ALLOWED_INPUT_FIELDS,
  buildCandidateRequest,
  buildChangeRequest,
  changeTradeDates,
  getCliHelpText,
  normalizeInput,
  parseCliArgs,
  parseJsonInput,
  resolveCandidate,
  verifyReadback
};

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${JSON.stringify({ ok: false, error: error.message })}\n`);
    process.exitCode = 1;
  });
}
