import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeProbe } from './probe-contract.mjs';
import { serializeGate0Report } from './gate0-report.mjs';
import { DESKTOP_PREFLIGHT_SCHEMA, makeAuditedProbes, makeHistoricalResumeCorrection, serializeDesktopPreflight, writeTask4AuditArtifacts } from './task4-audit.mjs';

const timestamp = '2026-08-24T03:00:00.000Z';
let sequence = 0;
const id = () => (++sequence).toString(16).padStart(16, '0');
const terminal = () => makeProbe({ probeId: 'terminal_cua', result: 'BLOCKED', checkedAt: timestamp, runId: id(), evidence: { status: 'unknown', criterion: 'codex_probe', pointer: 'command_failed' }, errorClass: 'command_failed' });
const restricted = () => makeProbe({ probeId: 'restricted_profile', result: 'BLOCKED', checkedAt: timestamp, runId: id(), evidence: { assertions: { directNodeReplAllowed: false, rawInputInjectionAllowed: false, helperSocketAccessAllowed: false, ledgerWriteAllowed: false, narrowActionPathWorks: false }, normalShellPresent: false, restrictedShellPresent: false, directNodeReplDenied: false }, errorClass: 'command_failed' });
const historicalResume = () => ({ probeId: 'human_resume', checkedAt: timestamp, runId: id() });

test('desktop preflight is limited to its two approved booleans', () => {
  const text = serializeDesktopPreflight({ checkedAt: timestamp, runId: id(), chromeAccessibilityAvailable: true, screenshotAvailable: false });
  assert.deepEqual(Object.keys(JSON.parse(text)).sort(), ['checkedAt', 'chromeAccessibilityAvailable', 'runId', 'schemaVersion', 'screenshotAvailable']);
  assert.throws(() => serializeDesktopPreflight({ checkedAt: timestamp, runId: id(), chromeAccessibilityAvailable: true, screenshotAvailable: false, text: 'forbidden' }));
  assert.throws(() => serializeDesktopPreflight({ schemaVersion: 'other', checkedAt: timestamp, runId: id(), chromeAccessibilityAvailable: true, screenshotAvailable: false }));
});

test('committed desktop artifact strict-roundtrips byte-semantically', async () => {
  const artifact = new URL('../../../docs/gate0/2026-08-24-local-cua-gate0-desktop-preflight.json', import.meta.url);
  const bytes = await readFile(artifact);
  const parsed = JSON.parse(bytes);
  assert.equal(parsed.schemaVersion, DESKTOP_PREFLIGHT_SCHEMA);
  assert.deepEqual(Buffer.from(serializeDesktopPreflight(parsed)), bytes);
});

test('committed Gate 0 evidence strict-roundtrips through every probe contract', async () => {
  const artifact = new URL('../../../docs/gate0/2026-08-24-local-cua-gate0-evidence.json', import.meta.url);
  const bytes = await readFile(artifact);
  const parsed = JSON.parse(bytes);
  assert.deepEqual(Buffer.from(serializeGate0Report(parsed.probes)), bytes);
  assert.equal(parsed.probes.find(probe => probe.probeId === 'human_resume').result, 'NOT_RUN');
});

test('audit records every contract ID and downgrades unsafe reruns to NOT_RUN', async () => {
  const resume = historicalResume();
  const probes = makeAuditedProbes({ terminal: terminal(), restricted: restricted(), resume, residualLabelPresent: true, typedEvidencePassed: true, now: () => timestamp, makeId: id });
  assert.deepEqual(probes.map(probe => probe.probeId), ['terminal_cua', 'launchagent_cua', 'human_auth_boundary', 'human_resume', 'launchagent_security', 'single_instance_lease', 'restricted_profile', 'typed_evidence', 'orphan_recovery']);
  assert.equal(probes.find(probe => probe.probeId === 'launchagent_cua').result, 'NOT_RUN');
  assert.equal(probes.find(probe => probe.probeId === 'orphan_recovery').result, 'NOT_RUN');
  assert.equal(probes.find(probe => probe.probeId === 'human_resume').result, 'NOT_RUN');
  assert.equal(probes.find(probe => probe.probeId === 'human_resume').checkedAt, resume.checkedAt);
  assert.equal(probes.find(probe => probe.probeId === 'launchagent_security').result, 'BLOCKED');
  assert.equal(probes.find(probe => probe.probeId === 'typed_evidence').evidence.allRowsValidated, true);
});

test('historical same-function roundtrip is never promoted to audited resume PASS', () => {
  const corrected = makeHistoricalResumeCorrection({ checkedAt: timestamp, runId: id() });
  assert.equal(corrected.result, 'NOT_RUN'); assert.equal(corrected.evidence.pointer, 'historical_synthetic_only');
});

test('artifact writer uses Gate 0 serializer and persists only approved structures', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gate0-audit-test-'));
  try {
    const resume = historicalResume();
    const result = await writeTask4AuditArtifacts({ directory: root, desktopPreflight: { checkedAt: timestamp, runId: id(), chromeAccessibilityAvailable: true, screenshotAvailable: true }, terminal: terminal(), restricted: restricted(), resume, residualLabelPresent: true, typedEvidencePassed: true, now: () => timestamp, makeId: id });
    const evidence = JSON.parse(await readFile(result.evidencePath, 'utf8'));
    assert.equal(result.verdict, 'BLOCKED'); assert.equal(evidence.probes.length, 9); assert.equal(evidence.verdict, 'BLOCKED');
    const desktop = JSON.parse(await readFile(result.desktopPath, 'utf8'));
    assert.deepEqual(Object.keys(desktop).sort(), ['checkedAt', 'chromeAccessibilityAvailable', 'runId', 'schemaVersion', 'screenshotAvailable']);
  } finally { await rm(root, { recursive: true, force: true }); }
});
