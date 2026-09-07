'use strict';

const fs = require('node:fs');
const { DEFAULT_ENV_FILE, parseEnv } = require('./village-live-read.js');

const DOMAIN_SHEETS = Object.freeze({
  inventory: Object.freeze(['장비마스터', '세트마스터']),
  schedule: Object.freeze(['스케줄상세', '확인요청', '계약마스터']),
  customer: Object.freeze(['고객DB']),
  finance: Object.freeze(['거래내역', '발행처DB']),
  documents: Object.freeze(['계약마스터', '확인요청', '발행처DB'])
});

const ALLOWED_SHEETS = new Set(Object.values(DOMAIN_SHEETS).flat());
const CATALOG_SHEETS = new Set(DOMAIN_SHEETS.inventory);

function requiredText(value, name, maxLength = 200) {
  const normalized = String(value ?? '').trim();
  if (!normalized || normalized.length > maxLength) {
    throw new Error(`${name} must contain 1-${maxLength} characters`);
  }
  return normalized;
}

function buildSearchRequest(config, { sheet, query, column } = {}) {
  const baseUrl = config?.VILLAGE2_API_URL;
  const apiKey = config?.VILLAGE2_API_KEY;
  if (!baseUrl || !apiKey) throw new Error('Village live-query configuration is incomplete');

  const normalizedSheet = requiredText(sheet, 'sheet', 80);
  if (!ALLOWED_SHEETS.has(normalizedSheet)) {
    throw new Error(`Village live-query sheet is not allowlisted: ${normalizedSheet}`);
  }
  const normalizedQuery = requiredText(query, 'query');
  const url = new URL(baseUrl);
  if (url.protocol !== 'https:' || url.hostname !== 'script.google.com') {
    throw new Error('Village live-query endpoint must use https://script.google.com');
  }
  url.searchParams.set('key', apiKey);
  url.searchParams.set('action', 'search');
  url.searchParams.set('sheet', normalizedSheet);
  url.searchParams.set('query', normalizedQuery);
  if (column !== undefined && String(column).trim() !== '') {
    url.searchParams.set('col', requiredText(column, 'column', 80));
  }
  return { method: 'GET', url: url.toString(), sheet: normalizedSheet };
}

function buildCatalogRequest(config, { sheet } = {}) {
  const baseUrl = config?.VILLAGE2_API_URL;
  const apiKey = config?.VILLAGE2_API_KEY;
  if (!baseUrl || !apiKey) throw new Error('Village live-query configuration is incomplete');

  const normalizedSheet = requiredText(sheet, 'sheet', 80);
  if (!CATALOG_SHEETS.has(normalizedSheet)) {
    throw new Error(`Village live-query sheet is not an inventory catalog: ${normalizedSheet}`);
  }
  const url = new URL(baseUrl);
  if (url.protocol !== 'https:' || url.hostname !== 'script.google.com') {
    throw new Error('Village live-query endpoint must use https://script.google.com');
  }
  url.searchParams.set('key', apiKey);
  url.searchParams.set('action', 'read');
  url.searchParams.set('sheet', normalizedSheet);
  url.searchParams.set('limit', '1000');
  return { method: 'GET', url: url.toString(), sheet: normalizedSheet };
}

async function lookupVillage({ config, domain, query, column, fetchImpl = globalThis.fetch, timeoutMs = 30_000 } = {}) {
  const normalizedDomain = String(domain ?? '').trim().toLowerCase();
  const sheets = DOMAIN_SHEETS[normalizedDomain];
  if (!sheets) throw new Error(`Unknown Village lookup domain: ${normalizedDomain || '[empty]'}`);
  if (typeof fetchImpl !== 'function') throw new Error('fetch is unavailable');

  const requests = sheets.map((sheet) => buildSearchRequest(config, { sheet, query, column }));
  const payloads = await Promise.all(requests.map(async (request) => {
    const response = await fetchImpl(request.url, {
      method: request.method,
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs)
    });
    if (!response.ok) throw new Error(`Village live-query failed for ${request.sheet} with HTTP ${response.status}`);
    const payload = await response.json();
    if (!payload || payload.error) throw new Error(`Village live-query returned an error for ${request.sheet}`);
    return {
      sheet: request.sheet,
      headers: Array.isArray(payload.headers) ? payload.headers : [],
      count: Number.isFinite(Number(payload.count)) ? Number(payload.count) : 0,
      results: Array.isArray(payload.results) ? payload.results : []
    };
  }));

  return {
    ok: true,
    source: 'Village 2.0 GAS read-only search',
    retrievedAt: new Date().toISOString(),
    domain: normalizedDomain,
    query: requiredText(query, 'query'),
    matches: payloads.reduce((sum, payload) => sum + payload.count, 0),
    sheets: payloads
  };
}

function normalizeBatchQueries(queries) {
  if (!Array.isArray(queries) || queries.length < 1 || queries.length > 12) {
    throw new Error('Village live-query batch requires 1-12 queries');
  }
  const seen = new Set();
  const normalized = [];
  for (const entry of queries) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error('Each Village live-query batch entry must be an object');
    }
    const domain = requiredText(entry.domain, 'domain', 40).toLowerCase();
    if (!DOMAIN_SHEETS[domain]) throw new Error(`Unknown Village lookup domain: ${domain}`);
    const query = requiredText(entry.query, 'query');
    const column = entry.column === undefined || String(entry.column).trim() === ''
      ? undefined
      : requiredText(entry.column, 'column', 80);
    const identity = JSON.stringify([domain, query, column || '']);
    if (seen.has(identity)) continue;
    seen.add(identity);
    normalized.push({ domain, query, ...(column ? { column } : {}) });
  }
  return normalized;
}

async function lookupVillageBatch({
  config,
  queries,
  fetchImpl = globalThis.fetch,
  timeoutMs = 30_000
} = {}) {
  const normalized = normalizeBatchQueries(queries);
  const results = await Promise.all(normalized.map(async (entry) => {
    try {
      return {
        ...entry,
        result: await lookupVillage({ ...entry, config, fetchImpl, timeoutMs })
      };
    } catch (error) {
      return {
        ...entry,
        result: { ok: false, error: String(error?.message || error).slice(0, 1000) }
      };
    }
  }));
  return {
    ok: results.every((entry) => entry.result?.ok === true),
    source: 'Village 2.0 GAS read-only batch search',
    retrievedAt: new Date().toISOString(),
    queries: results
  };
}

async function readVillageCatalog({
  config,
  sheet,
  fetchImpl = globalThis.fetch,
  timeoutMs = 30_000
} = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('fetch is unavailable');
  const request = buildCatalogRequest(config, { sheet });
  const response = await fetchImpl(request.url, {
    method: request.method,
    redirect: 'follow',
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!response.ok) throw new Error(`Village catalog read failed for ${request.sheet} with HTTP ${response.status}`);
  const payload = await response.json();
  if (!payload || payload.error) throw new Error(`Village catalog read returned an error for ${request.sheet}`);
  return {
    ok: true,
    source: 'Village 2.0 GAS read-only catalog',
    retrievedAt: new Date().toISOString(),
    sheet: request.sheet,
    rowCount: Number.isFinite(Number(payload.rowCount)) ? Number(payload.rowCount) : 0,
    headers: Array.isArray(payload.headers) ? payload.headers : [],
    rows: Array.isArray(payload.data) ? payload.data : []
  };
}

async function readVillageCatalogs({
  config,
  fetchImpl = globalThis.fetch,
  timeoutMs = 30_000
} = {}) {
  const catalogs = await Promise.all(DOMAIN_SHEETS.inventory.map((sheet) => (
    readVillageCatalog({ config, sheet, fetchImpl, timeoutMs })
  )));
  return {
    ok: true,
    source: 'Village 2.0 GAS read-only catalogs',
    retrievedAt: new Date().toISOString(),
    rowCount: catalogs.reduce((total, catalog) => total + Number(catalog.rowCount || 0), 0),
    catalogs
  };
}

function parseArgs(args) {
  const command = args[0];
  if (command !== 'lookup' && command !== 'catalog' && command !== 'batch') {
    throw new Error('Only the lookup, catalog, and batch commands are supported');
  }
  const values = { command, envFile: DEFAULT_ENV_FILE };
  const keyByFlag = command === 'batch'
    ? { '--env-file': 'envFile' }
    : command === 'catalog'
    ? { '--sheet': 'sheet', '--env-file': 'envFile' }
    : {
        '--domain': 'domain',
        '--query': 'query',
        '--column': 'column',
        '--env-file': 'envFile'
      };
  for (let index = 1; index < args.length; index += 1) {
    const name = args[index];
    const value = args[index + 1];
    if (!value || !keyByFlag[name]) throw new Error(`${command} received an invalid or incomplete option`);
    values[keyByFlag[name]] = value;
    index += 1;
  }
  if (command === 'catalog' && !values.sheet) throw new Error('catalog requires --sheet');
  if (command === 'lookup' && (!values.domain || !values.query)) {
    throw new Error('lookup requires --domain and --query');
  }
  return values;
}

async function main() {
  const { command, ...options } = parseArgs(process.argv.slice(2));
  const config = parseEnv(fs.readFileSync(options.envFile, 'utf8'));
  const result = command === 'batch'
    ? await lookupVillageBatch({
        ...options,
        config,
        queries: JSON.parse(fs.readFileSync(0, 'utf8')).queries
      })
    : command === 'catalog'
    ? (options.sheet === 'all'
        ? await readVillageCatalogs({ ...options, config })
        : await readVillageCatalog({ ...options, config }))
    : await lookupVillage({ ...options, config });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

module.exports = {
  ALLOWED_SHEETS,
  CATALOG_SHEETS,
  DOMAIN_SHEETS,
  buildCatalogRequest,
  buildSearchRequest,
  lookupVillage,
  lookupVillageBatch,
  normalizeBatchQueries,
  parseArgs,
  readVillageCatalog,
  readVillageCatalogs
};

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${JSON.stringify({ ok: false, error: error.message })}\n`);
    process.exitCode = 1;
  });
}
