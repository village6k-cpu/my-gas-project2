'use strict';

const fs = require('node:fs');
const { DEFAULT_ENV_FILE, parseEnv } = require('./village-live-read.js');

const MAX_EQUIPMENT = 40;
const MAX_BATCH_REQUESTS = 10;
const ALLOWED_REQUEST_FIELDS = new Set([
  '반출일', '반출시간', '반납일', '반납시간', '예약자명', '연락처',
  '할인유형', '업체명', '장비', '비고', '추가요청'
]);
const ALLOWED_ITEM_FIELDS = new Set(['이름', '수량']);

function requiredText(value, name, maxLength = 200) {
  const normalized = String(value ?? '').trim();
  if (!normalized || normalized.length > maxLength) {
    throw new Error(`${name} must contain 1-${maxLength} characters`);
  }
  return normalized;
}

function baseUrl(config) {
  const apiUrl = config?.VILLAGE2_API_URL;
  const apiKey = config?.VILLAGE2_API_KEY;
  if (!apiUrl || !apiKey) throw new Error('Village confirmation-request configuration is incomplete');
  const url = new URL(apiUrl);
  if (url.protocol !== 'https:' || url.hostname !== 'script.google.com') {
    throw new Error('Village confirmation-request endpoint must use https://script.google.com');
  }
  url.searchParams.set('key', apiKey);
  return url;
}

function buildSearchRequest(config, { sheet, query }) {
  if (sheet !== '목록' && sheet !== '확인요청') {
    throw new Error(`Unsupported confirmation-request sheet: ${sheet}`);
  }
  const url = baseUrl(config);
  url.searchParams.set('action', 'search');
  url.searchParams.set('sheet', sheet);
  url.searchParams.set('col', 'A');
  url.searchParams.set('query', requiredText(query, 'query'));
  return { method: 'GET', url: url.toString() };
}

function buildInsertRequest(config, request) {
  const url = baseUrl(config);
  url.searchParams.set('action', 'run');
  url.searchParams.set('func', 'insertAndCheckRequest');
  url.searchParams.set('args', JSON.stringify(request));
  if (url.toString().length > 16_000) {
    throw new Error('Confirmation-request payload is too large for the bounded GET route');
  }
  return { method: 'GET', url: url.toString() };
}

async function fetchJson(fetchImpl, request, timeoutMs, label) {
  const response = await fetchImpl(request.url, {
    method: request.method,
    redirect: 'follow',
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!response?.ok) {
    throw new Error(`${label} failed with HTTP ${response?.status ?? 'unknown'}`);
  }
  const payload = await response.json();
  if (!payload || payload.error) {
    throw new Error(`${label} failed: ${String(payload?.error || 'empty response')}`);
  }
  return payload;
}

function uniqueCandidateNames(payload) {
  const names = [];
  const seen = new Set();
  for (const result of Array.isArray(payload?.results) ? payload.results : []) {
    const name = String(Array.isArray(result?.data) ? result.data[0] : '').trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    names.push(name);
    if (names.length >= 30) break;
  }
  return names;
}

async function searchCatalog({ config, query, fetchImpl, timeoutMs }) {
  const normalizedQuery = requiredText(query, 'equipment query', 120);
  const request = buildSearchRequest(config, { sheet: '목록', query: normalizedQuery });
  const payload = await fetchJson(fetchImpl, request, timeoutMs, `Catalog search for ${normalizedQuery}`);
  return { query: normalizedQuery, candidates: uniqueCandidateNames(payload) };
}

async function resolveEquipment({
  config,
  queries,
  fetchImpl = globalThis.fetch,
  timeoutMs = 30_000
} = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('fetch is unavailable');
  if (!Array.isArray(queries) || queries.length === 0 || queries.length > MAX_EQUIPMENT) {
    throw new Error(`queries must contain 1-${MAX_EQUIPMENT} equipment terms`);
  }
  const normalized = queries.map((query) => requiredText(query, 'equipment query', 120));
  const items = await Promise.all(normalized.map((query) => searchCatalog({
    config, query, fetchImpl, timeoutMs
  })));
  return { ok: true, mode: 'resolve-only', items };
}

function assertOnlyAllowedFields(value, allowed, scope) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${scope} must be an object`);
  }
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`Unsupported or forbidden field in ${scope}: ${key}`);
  }
}

function normalizeDate(value, name) {
  const text = requiredText(value, name, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) throw new Error(`${name} must use YYYY-MM-DD`);
  return text;
}

function normalizeTime(value, name) {
  const text = requiredText(value, name, 5);
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(text)) throw new Error(`${name} must use HH:MM`);
  return text;
}

function normalizeConfirmationRequest(request) {
  assertOnlyAllowedFields(request, ALLOWED_REQUEST_FIELDS, 'confirmation request');
  if (!Array.isArray(request.장비) || request.장비.length === 0 || request.장비.length > MAX_EQUIPMENT) {
    throw new Error(`장비 must contain 1-${MAX_EQUIPMENT} items`);
  }
  const equipment = request.장비.map((item, index) => {
    assertOnlyAllowedFields(item, ALLOWED_ITEM_FIELDS, `장비[${index}]`);
    const quantity = Number(item.수량 ?? 1);
    if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > 999) {
      throw new Error(`장비[${index}].수량 must be an integer from 1 to 999`);
    }
    return { 이름: requiredText(item.이름, `장비[${index}].이름`, 120), 수량: quantity };
  });
  const normalized = {
    반출일: normalizeDate(request.반출일, '반출일'),
    반출시간: normalizeTime(request.반출시간, '반출시간'),
    반납일: normalizeDate(request.반납일, '반납일'),
    반납시간: normalizeTime(request.반납시간, '반납시간'),
    예약자명: requiredText(request.예약자명, '예약자명', 80),
    장비: equipment
  };
  for (const key of ['연락처', '할인유형', '업체명', '비고', '추가요청']) {
    if (request[key] !== undefined && request[key] !== null && String(request[key]).trim()) {
      normalized[key] = requiredText(request[key], key, key === '비고' || key === '추가요청' ? 180 : 80);
    }
  }
  return normalized;
}

function summarizeReadback(payload, reqID) {
  const rows = [];
  for (const result of Array.isArray(payload?.results) ? payload.results : []) {
    const data = Array.isArray(result?.data) ? result.data : [];
    if (String(data[0] ?? '').trim() !== reqID) continue;
    rows.push({
      row: Number(result.row) || null,
      pickupDate: String(data[1] ?? ''),
      pickupTime: String(data[2] ?? ''),
      returnDate: String(data[3] ?? ''),
      returnTime: String(data[4] ?? ''),
      equipment: String(data[5] ?? ''),
      quantity: data[6] ?? '',
      availability: String(data[8] ?? ''),
      detail: String(data[9] ?? ''),
      requester: String(data[10] ?? ''),
      hasContact: Boolean(String(data[11] ?? '').trim()),
      discountType: String(data[12] ?? ''),
      registrationStatus: String(data[14] ?? ''),
      note: String(data[16] ?? ''),
      additionalRequest: String(data[17] ?? '')
    });
  }
  if (rows.length === 0) throw new Error(`Confirmation-request readback verification failed for ${reqID}`);
  return rows;
}

function verifyIntendedReadback(rows, request, reqID) {
  const header = rows.find((row) => row.pickupDate || row.requester) || rows[0];
  if (
    header.pickupDate !== request.반출일
    || header.pickupTime !== request.반출시간
    || header.returnDate !== request.반납일
    || header.returnTime !== request.반납시간
    || header.requester !== request.예약자명
  ) {
    throw new Error(`Confirmation-request schedule readback verification failed for ${reqID}`);
  }
  if (request.연락처 && !header.hasContact) {
    throw new Error(`Confirmation-request contact readback verification failed for ${reqID}`);
  }
  if (request.할인유형 && header.discountType !== request.할인유형) {
    throw new Error(`Confirmation-request discount readback verification failed for ${reqID}`);
  }
  for (const item of request.장비) {
    const found = rows.some((row) => (
      row.equipment === item.이름 && Number(row.quantity) === item.수량
    ));
    if (!found) {
      throw new Error(`Intended equipment readback verification failed for ${reqID}: ${item.이름}`);
    }
  }
}

async function createConfirmationRequest({
  config,
  request,
  fetchImpl = globalThis.fetch,
  readTimeoutMs = 30_000,
  writeTimeoutMs = 180_000
} = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('fetch is unavailable');
  const normalized = normalizeConfirmationRequest(request);

  await preflightCatalog({
    config,
    requests: [normalized],
    fetchImpl,
    timeoutMs: readTimeoutMs
  });

  return insertAndVerifyConfirmationRequest({
    config,
    request: normalized,
    fetchImpl,
    readTimeoutMs,
    writeTimeoutMs
  });
}

async function preflightCatalog({ config, requests, fetchImpl, timeoutMs }) {
  const catalog = await Promise.all(requests.flatMap((request) => (
    request.장비.map((item) => searchCatalog({
      config,
      query: item.이름,
      fetchImpl,
      timeoutMs
    }))
  )));
  const unresolved = catalog.filter((item) => !item.candidates.includes(item.query));
  if (unresolved.length > 0) {
    throw new Error(`Catalog exact match required before mutation: ${unresolved.map((item) => item.query).join(', ')}`);
  }
}

async function insertAndVerifyConfirmationRequest({
  config,
  request,
  fetchImpl,
  readTimeoutMs,
  writeTimeoutMs
}) {
  const insertPayload = await fetchJson(
    fetchImpl,
    buildInsertRequest(config, request),
    writeTimeoutMs,
    'Confirmation-request insert'
  );
  if (insertPayload.success !== true || !/^RQ-\d{6}-\d{3,}$/.test(String(insertPayload.reqID || ''))) {
    throw new Error('Confirmation-request insert did not return a valid request ID');
  }
  const reqID = String(insertPayload.reqID);
  const readbackPayload = await fetchJson(
    fetchImpl,
    buildSearchRequest(config, { sheet: '확인요청', query: reqID }),
    readTimeoutMs,
    'Confirmation-request readback'
  );
  const rows = summarizeReadback(readbackPayload, reqID);
  verifyIntendedReadback(rows, request, reqID);

  return {
    ok: true,
    reqID,
    duplicate: insertPayload.duplicate === true,
    verified: true,
    rows
  };
}

async function createConfirmationRequests({
  config,
  requests,
  fetchImpl = globalThis.fetch,
  readTimeoutMs = 30_000,
  writeTimeoutMs = 180_000
} = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('fetch is unavailable');
  if (!Array.isArray(requests) || requests.length === 0 || requests.length > MAX_BATCH_REQUESTS) {
    throw new Error(`requests must contain 1-${MAX_BATCH_REQUESTS} AI-planned schedule groups`);
  }
  const normalized = requests.map((request) => normalizeConfirmationRequest(request));

  // Validate every AI-planned group before the first mutation. This keeps an
  // unresolved item in a later return-time group from producing a partial batch.
  await preflightCatalog({
    config,
    requests: normalized,
    fetchImpl,
    timeoutMs: readTimeoutMs
  });

  const created = [];
  for (const request of normalized) {
    try {
      created.push(await insertAndVerifyConfirmationRequest({
        config,
        request,
        fetchImpl,
        readTimeoutMs,
        writeTimeoutMs
      }));
    } catch (error) {
      const completed = created.map((item) => item.reqID).join(', ') || 'none';
      throw new Error(
        `Confirmation-request batch stopped after ${created.length}/${normalized.length}; `
        + `completed request IDs: ${completed}. Do not retry completed groups automatically. ${error.message}`
      );
    }
  }

  return {
    ok: true,
    mode: 'batch',
    verified: created.every((item) => item.verified === true),
    requests: created
  };
}

function parseCliArgs(args) {
  const command = args[0];
  if (command !== 'resolve' && command !== 'create' && command !== 'create-batch') {
    throw new Error('Command must be resolve, create, or create-batch');
  }
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

async function main() {
  const options = parseCliArgs(process.argv.slice(2));
  const config = parseEnv(fs.readFileSync(options.envFile, 'utf8'));
  const input = parseJsonInput(fs.readFileSync(options.inputFile || 0, 'utf8'));
  let result;
  if (options.command === 'resolve') {
    result = await resolveEquipment({ config, queries: Array.isArray(input) ? input : input.queries });
  } else if (options.command === 'create-batch') {
    result = await createConfirmationRequests({
      config,
      requests: Array.isArray(input) ? input : input.requests
    });
  } else {
    result = await createConfirmationRequest({ config, request: input.request || input });
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

module.exports = {
  buildInsertRequest,
  buildSearchRequest,
  createConfirmationRequest,
  createConfirmationRequests,
  normalizeConfirmationRequest,
  parseCliArgs,
  parseJsonInput,
  resolveEquipment,
  summarizeReadback,
  verifyIntendedReadback
};

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${JSON.stringify({ ok: false, error: error.message })}\n`);
    process.exitCode = 1;
  });
}
