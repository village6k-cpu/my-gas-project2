import { createHash } from 'node:crypto';
import { lstat, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { runDesktopCuaBridge } from '../gate1/desktop-cua-bridge.mjs';
import { processSyntheticSlackEnvelope } from './slack-intake-shell.mjs';

export const SYNTHETIC_PROOF_SCHEMA_VERSION = 'gate2-slack-synthetic-proof/v1';

const EVIDENCE_KEYS = Object.freeze([
  'syntheticEnvelopeUsed',
  'realSlackConnected',
  'homeTaxTouched',
  'gate1ReadOnlyPassed',
  'firstExecutionRecorded',
  'duplicateSuppressed',
  'duplicateExecutionSkipped',
  'resultPostedOnce',
  'ledgerCompleted',
  'ledgerCleaned',
]);
const ERRORS = new Set([
  'gate2_not_ready',
  'duplicate_not_suppressed',
  'ledger_not_completed',
  'cleanup_incomplete',
  'proof_failed',
]);
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const PROOF_ID = /^[a-f0-9]{16}$/;

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

export function validateSyntheticProof(proof) {
  const topKeys = [
    'schemaVersion',
    'status',
    'checkedAt',
    'proofId',
    'evidence',
    ...(proof?.errorClass === undefined ? [] : ['errorClass']),
  ];
  exactKeys(proof, topKeys, 'Gate 2 synthetic proof');
  if (
    proof.schemaVersion !== SYNTHETIC_PROOF_SCHEMA_VERSION
    || !['PASS', 'BLOCKED'].includes(proof.status)
    || !ISO.test(proof.checkedAt)
    || !PROOF_ID.test(proof.proofId)
  ) throw new TypeError('invalid Gate 2 synthetic proof header');
  exactKeys(proof.evidence, EVIDENCE_KEYS, 'Gate 2 synthetic proof evidence');
  for (const key of EVIDENCE_KEYS) {
    if (typeof proof.evidence[key] !== 'boolean') throw new TypeError(`invalid proof boolean ${key}`);
  }
  if (!proof.evidence.syntheticEnvelopeUsed || proof.evidence.realSlackConnected || proof.evidence.homeTaxTouched) {
    throw new TypeError('synthetic proof boundary is inconsistent');
  }
  if (proof.status === 'PASS') {
    if (proof.errorClass !== undefined) throw new TypeError('PASS cannot include errorClass');
    for (const key of EVIDENCE_KEYS) {
      const expected = !['realSlackConnected', 'homeTaxTouched'].includes(key);
      if (proof.evidence[key] !== expected) throw new TypeError(`PASS has invalid ${key}`);
    }
  } else if (!ERRORS.has(proof.errorClass)) {
    throw new TypeError('BLOCKED requires a fixed errorClass');
  }
  return Object.freeze(proof);
}

export function serializeSyntheticProof(proof) {
  return `${JSON.stringify(validateSyntheticProof(proof), null, 2)}\n`;
}

function makeProofId(seed = `${Date.now()}-${Math.random()}`) {
  return createHash('sha256').update(seed).digest('hex').slice(0, 16);
}

function safeNow(now) {
  const value = now();
  if (typeof value !== 'string' || !ISO.test(value)) throw new TypeError('now must return an ISO timestamp');
  return value;
}

async function directoryIsAbsent(path) {
  try { await lstat(path); return false; }
  catch (error) { return error?.code === 'ENOENT'; }
}

function proofError(evidence) {
  if (!evidence.ledgerCleaned) return 'cleanup_incomplete';
  if (!evidence.gate1ReadOnlyPassed || !evidence.firstExecutionRecorded || !evidence.resultPostedOnce) {
    return 'gate2_not_ready';
  }
  if (!evidence.duplicateSuppressed || !evidence.duplicateExecutionSkipped) {
    return 'duplicate_not_suppressed';
  }
  if (!evidence.ledgerCompleted) return 'ledger_not_completed';
  return 'proof_failed';
}

export async function runSyntheticGate2Proof({
  temporaryRoot = tmpdir(),
  actionRunner,
  allowTestOverrides = false,
  now = () => new Date().toISOString(),
  proofId = makeProofId(),
} = {}) {
  if (typeof temporaryRoot !== 'string' || !isAbsolute(temporaryRoot)) {
    throw new TypeError('temporaryRoot must be absolute');
  }
  const rootInfo = await lstat(temporaryRoot);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new TypeError('temporaryRoot must be a real directory');
  if (actionRunner !== undefined && typeof actionRunner !== 'function') throw new TypeError('actionRunner must be a function');
  if (actionRunner !== undefined && !allowTestOverrides) {
    throw new TypeError('custom actionRunner requires the explicit test override');
  }
  if (typeof now !== 'function') throw new TypeError('now must be a function');
  if (!PROOF_ID.test(proofId)) throw new TypeError('invalid proofId');

  const checkedAt = safeNow(now);
  const envelope = Object.freeze({
    schemaVersion: 'gate2-slack-envelope/v1',
    source: 'synthetic_local',
    teamId: 'T_SYNTHETIC',
    channelId: 'C_SYNTHETIC',
    eventId: `Ev_SYNTHETIC_${proofId}`,
    threadTs: '1787536800.000001',
    action: 'desktop_readiness',
  });
  const allowedRoute = Object.freeze({ teamId: envelope.teamId, channelId: envelope.channelId });
  const evidence = {
    syntheticEnvelopeUsed: true,
    realSlackConnected: false,
    homeTaxTouched: false,
    gate1ReadOnlyPassed: false,
    firstExecutionRecorded: false,
    duplicateSuppressed: false,
    duplicateExecutionSkipped: false,
    resultPostedOnce: false,
    ledgerCompleted: false,
    ledgerCleaned: false,
  };
  let ledgerDir;
  let first;
  let duplicate;
  let resultPosts = 0;
  try {
    ledgerDir = await mkdtemp(join(temporaryRoot, 'village-gate2-proof-'));
    const options = {
      envelope,
      allowedRoute,
      ledgerDir,
      resultSink: async () => { resultPosts += 1; return { delivered: true }; },
      now,
      ...(actionRunner === undefined ? {} : { actionRunner, allowTestOverrides: true }),
    };
    first = await processSyntheticSlackEnvelope(options);
    duplicate = await processSyntheticSlackEnvelope(options);
    evidence.gate1ReadOnlyPassed = first.status === 'PASS' && first.evidence.resultValidated;
    evidence.firstExecutionRecorded = first.evidence.executionStarted && first.evidence.executionCompleted;
    evidence.duplicateSuppressed = duplicate.status === 'DUPLICATE' && duplicate.evidence.duplicateSuppressed;
    evidence.duplicateExecutionSkipped = !duplicate.evidence.executionStarted && !duplicate.evidence.deliveryAttempted;
    evidence.resultPostedOnce = resultPosts === 1;

    const files = (await readdir(ledgerDir)).sort();
    const expectedFile = `${first.requestId}.json`;
    if (files.length === 1 && files[0] === expectedFile) {
      const record = JSON.parse(await readFile(join(ledgerDir, expectedFile), 'utf8'));
      evidence.ledgerCompleted = record?.state === 'completed' && record?.requestId === first.requestId;
    }
  } catch {
    // The strict proof below reports only fixed booleans and a fixed error class.
  } finally {
    if (ledgerDir) {
      try { await rm(ledgerDir, { recursive: true, force: true }); } catch {}
      evidence.ledgerCleaned = await directoryIsAbsent(ledgerDir);
    }
  }

  const passed = Object.entries(evidence).every(([key, value]) => (
    ['realSlackConnected', 'homeTaxTouched'].includes(key) ? value === false : value === true
  ));
  return validateSyntheticProof({
    schemaVersion: SYNTHETIC_PROOF_SCHEMA_VERSION,
    status: passed ? 'PASS' : 'BLOCKED',
    checkedAt,
    proofId,
    evidence,
    ...(passed ? {} : { errorClass: proofError(evidence) }),
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const proof = await runSyntheticGate2Proof();
  process.stdout.write(serializeSyntheticProof(proof));
  if (proof.status !== 'PASS') process.exitCode = 1;
}
