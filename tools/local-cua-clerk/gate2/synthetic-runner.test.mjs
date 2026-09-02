import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function loadRunner() {
  try { return await import('./synthetic-runner.mjs'); }
  catch { return null; }
}

const CHECKED_AT = '2026-08-24T13:00:00.000Z';
const PROOF_ID = '0123456789abcdef';
const PASS_EVIDENCE = Object.freeze({
  syntheticEnvelopeUsed: true,
  realSlackConnected: false,
  homeTaxTouched: false,
  gate1ReadOnlyPassed: true,
  firstExecutionRecorded: true,
  duplicateSuppressed: true,
  duplicateExecutionSkipped: true,
  resultPostedOnce: true,
  ledgerCompleted: true,
  ledgerCleaned: true,
});
const GATE1_PASS = Object.freeze({
  schemaVersion: 'gate1-desktop-cua/v1',
  status: 'PASS',
  checkedAt: CHECKED_AT,
  runId: 'fedcba9876543210',
  evidence: {
    threadCreated: true,
    fixedActionDispatched: true,
    nodeReplCallCompleted: true,
    desktopThreadCuaAvailable: true,
    chromeWasRunning: true,
    chromeAccessibilityAvailable: true,
    screenshotAvailable: true,
    resultValidated: true,
    cleanupCompleted: true,
  },
});

async function temporaryRoot(t) {
  const path = await mkdtemp(join(tmpdir(), 'village-gate2-runner-test-'));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}

test('strict synthetic proof accepts only fixed boolean evidence and serializes canonically', async () => {
  const runner = await loadRunner();
  assert.equal(typeof runner?.validateSyntheticProof, 'function');
  assert.equal(typeof runner?.serializeSyntheticProof, 'function');
  const proof = {
    schemaVersion: 'gate2-slack-synthetic-proof/v1',
    status: 'PASS',
    checkedAt: CHECKED_AT,
    proofId: PROOF_ID,
    evidence: { ...PASS_EVIDENCE },
  };
  assert.deepEqual(runner.validateSyntheticProof(proof), proof);
  assert.equal(runner.serializeSyntheticProof(proof), `${JSON.stringify(proof, null, 2)}\n`);
  assert.throws(() => runner.validateSyntheticProof({ ...proof, channelId: 'C_PRIVATE' }), /unknown or missing keys/);
  assert.throws(
    () => runner.validateSyntheticProof({ ...proof, evidence: { ...proof.evidence, screenshot: true } }),
    /unknown or missing keys/,
  );
});

test('committed blocked and final PASS proof artifacts strict-roundtrip', async () => {
  const runner = await loadRunner();
  for (const relativePath of [
    '../../../docs/gate2/2026-08-24-slack-intake-synthetic-attempt-1.json',
    '../../../docs/gate2/2026-08-24-slack-intake-synthetic-evidence.json',
  ]) {
    const raw = await readFile(new URL(relativePath, import.meta.url), 'utf8');
    assert.equal(runner.serializeSyntheticProof(JSON.parse(raw)), raw);
  }
});

test('synthetic proof runs one Gate 1 action, posts once, suppresses the repeat, and removes its ledger', async t => {
  const runner = await loadRunner();
  assert.equal(typeof runner?.runSyntheticGate2Proof, 'function');
  const root = await temporaryRoot(t);
  let executions = 0;
  const proof = await runner.runSyntheticGate2Proof({
    temporaryRoot: root,
    actionRunner: async () => { executions += 1; return GATE1_PASS; },
    allowTestOverrides: true,
    now: () => CHECKED_AT,
    proofId: PROOF_ID,
  });
  assert.equal(proof.status, 'PASS');
  assert.deepEqual(proof.evidence, PASS_EVIDENCE);
  assert.equal(executions, 1);
  assert.deepEqual(await readdir(root), []);
  assert.equal(JSON.stringify(proof).includes(GATE1_PASS.runId), false);
});

test('a blocked action produces only a redacted BLOCKED proof and still removes its ledger', async t => {
  const runner = await loadRunner();
  const root = await temporaryRoot(t);
  const rawMarker = 'private-runner-exception';
  const proof = await runner.runSyntheticGate2Proof({
    temporaryRoot: root,
    actionRunner: async () => { throw new Error(rawMarker); },
    allowTestOverrides: true,
    now: () => CHECKED_AT,
    proofId: PROOF_ID,
  });
  assert.equal(proof.status, 'BLOCKED');
  assert.equal(proof.errorClass, 'gate2_not_ready');
  assert.equal(proof.evidence.gate1ReadOnlyPassed, false);
  assert.equal(proof.evidence.duplicateSuppressed, true);
  assert.equal(proof.evidence.ledgerCleaned, true);
  assert.equal(JSON.stringify(proof).includes(rawMarker), false);
  assert.deepEqual(await readdir(root), []);
});

test('custom proof execution is unavailable without the explicit test seam', async t => {
  const runner = await loadRunner();
  const root = await temporaryRoot(t);
  await assert.rejects(
    runner.runSyntheticGate2Proof({
      temporaryRoot: root,
      actionRunner: async () => GATE1_PASS,
    }),
    /test override/,
  );
  assert.deepEqual(await readdir(root), []);
});
