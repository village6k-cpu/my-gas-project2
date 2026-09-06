import { lstat, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  buildKakaoAutomationAuditEvents,
  createKakaoAutomationAuditStore,
} from '../../tools/kakao-dom-bridge/kakao-automation-audit.mjs';

const HASHED_JOB_FILE = /^[0-9a-f]{64}\.json$/;
const MAX_JOB_BYTES = 8 * 1024 * 1024;
const MAX_FILES_LIMIT = 5000;
const MAX_EVENTS_LIMIT = 5000;

function positiveBounded(value, name, maximum) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1 || number > maximum || String(number) !== value) {
    throw new TypeError(`${name} is invalid`);
  }
  return number;
}

function parseArguments(argv) {
  if (!Array.isArray(argv)) throw new TypeError('arguments are invalid');
  const values = new Map();
  let apply = false;
  let dryRun = false;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--apply' || token === '--dry-run') {
      if (token === '--apply' ? apply : dryRun) throw new TypeError('duplicate mode is invalid');
      if (token === '--apply') apply = true;
      else dryRun = true;
      continue;
    }
    if (!['--queue-dir', '--max-files', '--max-events'].includes(token) || values.has(token)) {
      throw new TypeError('arguments are invalid');
    }
    const value = argv[index + 1];
    if (typeof value !== 'string' || !value || value.startsWith('--')) throw new TypeError('arguments are invalid');
    values.set(token, value);
    index += 1;
  }
  if (apply && dryRun) throw new TypeError('mode is invalid');
  const queueDir = values.get('--queue-dir');
  if (!queueDir) throw new TypeError('queue directory is required');
  return {
    queueDir,
    mode: apply ? 'apply' : 'dry-run',
    maxFiles: positiveBounded(values.get('--max-files') || '500', 'max files', MAX_FILES_LIMIT),
    maxEvents: positiveBounded(values.get('--max-events') || '500', 'max events', MAX_EVENTS_LIMIT),
  };
}

async function exactDirectory(value, name) {
  const metadata = await lstat(value);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new TypeError(`${name} is invalid`);
  return value;
}

export async function scanKakaoAutomationAuditHistory({ queueDir, maxFiles = 500, maxEvents = 500 } = {}) {
  if (typeof queueDir !== 'string' || !queueDir.trim()) throw new TypeError('queue directory is required');
  if (!Number.isSafeInteger(maxFiles) || maxFiles < 1 || maxFiles > MAX_FILES_LIMIT
    || !Number.isSafeInteger(maxEvents) || maxEvents < 1 || maxEvents > MAX_EVENTS_LIMIT) {
    throw new TypeError('scan bounds are invalid');
  }
  const queueRoot = await exactDirectory(path.resolve(queueDir), 'queue directory');
  const jobsDirectory = await exactDirectory(path.join(queueRoot, 'hermes-gateway'), 'job directory');
  const names = (await readdir(jobsDirectory)).filter((name) => HASHED_JOB_FILE.test(name)).sort();
  const regularFiles = [];
  for (const name of names) {
    const filePath = path.join(jobsDirectory, name);
    const metadata = await lstat(filePath);
    if (metadata.isSymbolicLink() || !metadata.isFile()) continue;
    regularFiles.push({ filePath, size: metadata.size });
  }

  const selected = regularFiles.slice(0, maxFiles);
  const summary = {
    scannedFiles: 0,
    provableFiles: 0,
    provableEvents: 0,
    skippedUnprovable: 0,
    skippedInvalid: 0,
    skippedDuplicate: 0,
    capped: regularFiles.length > selected.length,
  };
  const events = [];
  const byKey = new Map();
  for (let index = 0; index < selected.length; index += 1) {
    const file = selected[index];
    if (events.length >= maxEvents) {
      summary.capped = true;
      break;
    }
    summary.scannedFiles += 1;
    if (file.size < 2 || file.size > MAX_JOB_BYTES) {
      summary.skippedInvalid += 1;
      continue;
    }
    let job;
    try {
      job = JSON.parse(await readFile(file.filePath, 'utf8'));
    } catch {
      summary.skippedInvalid += 1;
      continue;
    }
    let candidates;
    try {
      candidates = buildKakaoAutomationAuditEvents({ durableJob: job, historicalImport: true });
    } catch {
      summary.skippedInvalid += 1;
      continue;
    }
    if (candidates.length === 0) {
      summary.skippedUnprovable += 1;
      continue;
    }
    summary.provableFiles += 1;
    for (let candidateIndex = 0; candidateIndex < candidates.length; candidateIndex += 1) {
      const event = candidates[candidateIndex];
      const existing = byKey.get(event.event_key);
      if (existing !== undefined) {
        if (JSON.stringify(existing) !== JSON.stringify(event)) throw new Error('historical audit evidence conflicts');
        summary.skippedDuplicate += 1;
        continue;
      }
      if (events.length >= maxEvents) {
        summary.capped = true;
        break;
      }
      byKey.set(event.event_key, event);
      events.push(event);
    }
    if (events.length >= maxEvents && (index < selected.length - 1 || candidates.length > 1)) summary.capped = true;
  }
  summary.provableEvents = events.length;
  return { summary, events };
}

export async function runKakaoAutomationAuditBackfill({
  argv = process.argv.slice(2),
  env = process.env,
  stdout = console.log,
  storeFactory = createKakaoAutomationAuditStore,
} = {}) {
  const options = parseArguments(argv);
  const { summary, events } = await scanKakaoAutomationAuditHistory(options);
  let inserted = 0;
  if (options.mode === 'apply') {
    const supabaseUrl = String(env.SUPABASE_URL || '').trim();
    const serviceRoleKey = String(env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
    if (!supabaseUrl || !serviceRoleKey) throw new Error('service role configuration is required');
    if (events.length > 0) {
      const store = storeFactory({ supabaseUrl, serviceRoleKey });
      for (let offset = 0; offset < events.length; offset += 100) {
        const result = await store.insertAndReadback(events.slice(offset, offset + 100));
        if (!result || !Number.isSafeInteger(result.inserted) || !Number.isSafeInteger(result.existing)
          || result.inserted < 0 || result.existing < 0
          || result.inserted + result.existing !== Math.min(100, events.length - offset)) {
          throw new Error('audit store result is invalid');
        }
        inserted += result.inserted;
      }
    }
  }
  const output = Object.freeze({ mode: options.mode, ...summary, inserted });
  stdout(JSON.stringify(output));
  return output;
}

async function main() {
  try {
    await runKakaoAutomationAuditBackfill();
  } catch {
    console.error(JSON.stringify({ mode: 'error', error: 'backfill_failed' }));
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await main();
}
