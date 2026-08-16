#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

function requireObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
}

export function buildKakaoworkerBenchmarkPrompt(buildHermesPrompt, fixture) {
  if (typeof buildHermesPrompt !== 'function') {
    throw new TypeError('buildHermesPrompt must be a function');
  }
  requireObject(fixture, 'fixture');
  requireObject(fixture.job, 'fixture.job');
  requireObject(fixture.options, 'fixture.options');
  if (!fixture.id || typeof fixture.id !== 'string') {
    throw new TypeError('fixture.id must be a non-empty string');
  }

  const workerPrompt = buildHermesPrompt(fixture.job, fixture.options);
  return `ISOLATED NO-SEND KAKAOWORKER BENCHMARK

Case ID: ${fixture.id}

Benchmark execution boundary:
- AI_WORKER_LIVE=0, AI_WORKER_AUTO_SEND=0, AI_WORKER_DRY_RUN=1, VILLAGE_WINDOWS_WRITES_ENABLED=0.
- This is reasoning-only. No outer worker will execute should_write_to_sheet or reply_decision.
- Use only native skill catalog/read calls. Do not call skill_manage, terminal, browser, Slack, Kakao, GAS, Sheets, or scheduling tools.
- Treat benchmark_authoritative_readback inside BROWSER NAVIGATION RESULT as supplied mock current-state evidence.
- Preserve the normal worker FINAL_JSON contract so the real worker validator can judge the response.

${workerPrompt}`;
}

function parseArgs(argv) {
  const args = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith('--') || value === undefined) {
      throw new Error('arguments must be supplied as --name value pairs');
    }
    args.set(key.slice(2), value);
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  for (const name of ['worker-module', 'fixtures', 'case-id', 'output']) {
    if (!args.get(name)) throw new Error(`--${name} is required`);
  }

  const workerModulePath = path.resolve(args.get('worker-module'));
  const fixturesPath = path.resolve(args.get('fixtures'));
  const outputPath = path.resolve(args.get('output'));
  const fixtures = JSON.parse(fs.readFileSync(fixturesPath, 'utf8'));
  const fixture = fixtures.cases?.find((entry) => entry.id === args.get('case-id'));
  if (!fixture) throw new Error(`fixture not found: ${args.get('case-id')}`);

  const worker = await import(pathToFileURL(workerModulePath).href);
  const prompt = buildKakaoworkerBenchmarkPrompt(worker.buildHermesPrompt, fixture);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, prompt, { encoding: 'utf8' });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error?.stack || error}\n`);
    process.exitCode = 1;
  });
}
