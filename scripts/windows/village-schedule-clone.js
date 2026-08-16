'use strict';

const fs = require('node:fs');
const { DEFAULT_ENV_FILE, parseEnv } = require('./village-live-read.js');

const ALLOWED_INPUT_FIELDS = new Set([
  'sourceTradeId',
  'customerName',
  'targetStart',
  'targetEnd',
  'expectedSourceFingerprint'
]);

function requiredText(value, name, maxLength = 200) {
  const text = String(value ?? '').trim();
  if (!text || text.length > maxLength) throw new Error(`${name} must contain 1-${maxLength} characters`);
  return text;
}

function normalizeDateTime(value, name) {
  const text = requiredText(value, name, 16);
  const match = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/.exec(text);
  if (!match) throw new Error(`${name} must use YYYY-MM-DD HH:MM`);
  const date = new Date(`${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:00+09:00`);
  if (Number.isNaN(date.getTime()) || Number(match[2]) > 12 || Number(match[3]) > 31
      || Number(match[4]) > 23 || Number(match[5]) > 59) {
    throw new Error(`${name} is invalid`);
  }
  return text;
}

function normalizeCloneInput(input, mode) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('clone input must be an object');
  for (const field of Object.keys(input)) {
    if (!ALLOWED_INPUT_FIELDS.has(field)) throw new Error(`unsupported clone field: ${field}`);
  }
  const normalizedMode = String(mode || '').trim().toLowerCase();
  if (normalizedMode !== 'preview' && normalizedMode !== 'execute') {
    throw new Error('clone mode must be preview or execute');
  }
  const normalized = {
    targetStart: normalizeDateTime(input.targetStart, 'targetStart'),
    targetEnd: normalizeDateTime(input.targetEnd, 'targetEnd')
  };
  if (new Date(`${normalized.targetEnd.replace(' ', 'T')}:00+09:00`).getTime()
      <= new Date(`${normalized.targetStart.replace(' ', 'T')}:00+09:00`).getTime()) {
    throw new Error('targetEnd must be later than targetStart');
  }
  if (input.sourceTradeId !== undefined && String(input.sourceTradeId).trim()) {
    normalized.sourceTradeId = requiredText(input.sourceTradeId, 'sourceTradeId', 20);
    if (!/^\d{6}-\d{3}$/.test(normalized.sourceTradeId)) throw new Error('sourceTradeId is invalid');
  }
  if (input.customerName !== undefined && String(input.customerName).trim()) {
    normalized.customerName = requiredText(input.customerName, 'customerName', 80);
  }
  if (!normalized.sourceTradeId && !normalized.customerName) {
    throw new Error('sourceTradeId or customerName is required');
  }
  if (normalizedMode === 'execute') {
    normalized.expectedSourceFingerprint = requiredText(
      input.expectedSourceFingerprint,
      'expectedSourceFingerprint',
      300
    );
  }
  return normalized;
}

function buildEndpoint(config) {
  if (!config?.VILLAGE2_API_URL || !config?.VILLAGE2_API_KEY) {
    throw new Error('Village schedule-clone configuration is incomplete');
  }
  const url = new URL(config.VILLAGE2_API_URL);
  if (url.protocol !== 'https:' || url.hostname !== 'script.google.com') {
    throw new Error('Village schedule-clone endpoint must use https://script.google.com');
  }
  url.searchParams.set('key', config.VILLAGE2_API_KEY);
  return url;
}

async function cloneRegisteredSchedule({
  config,
  mode,
  input,
  fetchImpl = globalThis.fetch,
  timeoutMs = 180_000
} = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('fetch is unavailable');
  const normalizedMode = String(mode || '').trim().toLowerCase();
  const normalized = normalizeCloneInput(input, normalizedMode);
  const body = {
    action: 'cloneScheduleNoSend',
    ...(normalized.sourceTradeId ? { sourceTradeId: normalized.sourceTradeId } : {}),
    ...(normalized.customerName ? { customerName: normalized.customerName } : {}),
    targetStart: normalized.targetStart,
    targetEnd: normalized.targetEnd,
    dryRun: normalizedMode === 'preview',
    ...(normalizedMode === 'execute'
      ? { expectedSourceFingerprint: normalized.expectedSourceFingerprint }
      : {})
  };
  const response = await fetchImpl(buildEndpoint(config).toString(), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    redirect: 'follow',
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!response?.ok) throw new Error(`Village exact clone failed with HTTP ${response?.status ?? 'unknown'}`);
  const payload = await response.json();
  if (!payload || payload.error || payload.success !== true) {
    throw new Error(`Village exact clone failed: ${String(payload?.error || payload?.status || 'empty response')}`);
  }
  if (!payload.sourceFingerprint || !Number.isSafeInteger(Number(payload.sourceRowCount))) {
    throw new Error('Village exact clone response is missing source fingerprint or row count');
  }
  if (normalizedMode === 'preview') return payload;
  const exactRows = Number(payload.sourceRowCount) === Number(payload.targetRowCount);
  const verifiedReadback = payload.readback?.contract === true
    && payload.readback?.schedule === true
    && payload.readback?.ledger === true;
  if (!exactRows || payload.customerSendSuppressed !== true || payload.customerSendFlagPresent !== true || !verifiedReadback) {
    throw new Error('Village exact clone authoritative readback failed');
  }
  return { ...payload, verifiedExactClone: true };
}

function parseCliArgs(args) {
  const mode = String(args[0] || '').toLowerCase();
  if (mode !== 'preview' && mode !== 'execute') throw new Error('Command must be preview or execute');
  const options = { mode, envFile: DEFAULT_ENV_FILE, inputFile: null };
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

async function main() {
  const options = parseCliArgs(process.argv.slice(2));
  const config = parseEnv(fs.readFileSync(options.envFile, 'utf8'));
  const input = JSON.parse(fs.readFileSync(options.inputFile || 0, 'utf8').replace(/^\uFEFF/, ''));
  const result = await cloneRegisteredSchedule({ config, mode: options.mode, input: input.request || input });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

module.exports = {
  cloneRegisteredSchedule,
  normalizeCloneInput,
  parseCliArgs
};

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${JSON.stringify({ ok: false, error: error.message })}\n`);
    process.exitCode = 1;
  });
}
