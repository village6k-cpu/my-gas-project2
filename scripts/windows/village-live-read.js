'use strict';

const fs = require('node:fs');

const DEFAULT_ENV_FILE = 'C:\\Village\\village-ai\\.env.finance';
const ALLOWED_ENV_NAMES = new Set(['VILLAGE2_API_URL', 'VILLAGE2_API_KEY']);

function unquote(value) {
  const trimmed = String(value ?? '').trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed.at(-1);
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
}

function parseEnv(source) {
  const selected = {};
  for (const line of String(source).split(/\r?\n/)) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (!match || !ALLOWED_ENV_NAMES.has(match[1])) continue;
    selected[match[1]] = unquote(match[2]);
  }
  return selected;
}

function buildAutopilotRequest(config) {
  const baseUrl = config?.VILLAGE2_API_URL;
  const apiKey = config?.VILLAGE2_API_KEY;
  if (!baseUrl || !apiKey) {
    throw new Error('Village live-read configuration is incomplete');
  }

  const url = new URL(baseUrl);
  if (url.protocol !== 'https:' || url.hostname !== 'script.google.com') {
    throw new Error('Village live-read endpoint must use https://script.google.com');
  }
  url.searchParams.set('key', apiKey);
  url.searchParams.set('action', 'autopilot');
  return { method: 'GET', url: url.toString() };
}

function requiredNumber(value, name) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    throw new Error(`Village autopilot response is missing required revenue KPI: ${name}`);
  }
  return number;
}

function summarizeAutopilotPayload(payload) {
  if (!payload || payload.ok !== true || !payload.kpi) {
    throw new Error('Village autopilot response was not successful');
  }

  const revenueThisMonth = requiredNumber(payload.kpi.revenueThisMonth, 'revenueThisMonth');
  const revenueLastMonth = requiredNumber(payload.kpi.revenueLastMonth, 'revenueLastMonth');
  const transactionCountThisMonth = requiredNumber(payload.kpi.txThisMonth, 'txThisMonth');
  const transactionCountLastMonth = requiredNumber(payload.kpi.txLastMonth, 'txLastMonth');
  const revenueDelta = revenueThisMonth - revenueLastMonth;

  return {
    ok: true,
    source: 'Village 2.0 GAS autopilot',
    generatedAt: String(payload.generatedAt || ''),
    thisMonth: String(payload.kpi.thisMonth || ''),
    lastMonth: String(payload.kpi.lastMonth || ''),
    revenueThisMonth,
    revenueLastMonth,
    transactionCountThisMonth,
    transactionCountLastMonth,
    revenueDelta,
    revenueChangePercent: revenueLastMonth === 0 ? null : revenueDelta / revenueLastMonth * 100
  };
}

async function readLiveRevenue({
  envFile = DEFAULT_ENV_FILE,
  fetchImpl = globalThis.fetch,
  timeoutMs = 30000
} = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('fetch is unavailable');
  const config = parseEnv(fs.readFileSync(envFile, 'utf8'));
  const request = buildAutopilotRequest(config);
  const response = await fetchImpl(request.url, {
    method: request.method,
    redirect: 'follow',
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!response.ok) throw new Error(`Village live-read request failed with HTTP ${response.status}`);
  return summarizeAutopilotPayload(await response.json());
}

function parseArgs(args) {
  let envFile = DEFAULT_ENV_FILE;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== '--env-file' || !args[index + 1]) {
      throw new Error('Only --env-file PATH is supported');
    }
    envFile = args[index + 1];
    index += 1;
  }
  return { envFile };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const summary = await readLiveRevenue(options);
  process.stdout.write(`${JSON.stringify(summary)}\n`);
}

module.exports = {
  DEFAULT_ENV_FILE,
  buildAutopilotRequest,
  parseEnv,
  readLiveRevenue,
  summarizeAutopilotPayload
};

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${JSON.stringify({ ok: false, error: error.message })}\n`);
    process.exitCode = 1;
  });
}
