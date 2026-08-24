import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { makeProbe, makeRunId } from './probe-contract.mjs';
import { makeGate0Report, serializeGate0Report } from './gate0-report.mjs';

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const HASH = /^[a-f0-9]{16,64}$/;
export const DESKTOP_PREFLIGHT_SCHEMA = 'gate0-desktop-preflight/v1';
const DESKTOP_PREFLIGHT_FIELDS = Object.freeze(['schemaVersion', 'checkedAt', 'runId', 'chromeAccessibilityAvailable', 'screenshotAvailable']);
const desktopShape = value => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).every(key => DESKTOP_PREFLIGHT_FIELDS.includes(key))
  && value.schemaVersion === DESKTOP_PREFLIGHT_SCHEMA
  && ISO.test(value.checkedAt) && HASH.test(value.runId)
  && typeof value.chromeAccessibilityAvailable === 'boolean'
  && typeof value.screenshotAvailable === 'boolean';

export function serializeDesktopPreflight(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !DESKTOP_PREFLIGHT_FIELDS.includes(key))) throw new TypeError('invalid desktop preflight');
  const { schemaVersion = DESKTOP_PREFLIGHT_SCHEMA, checkedAt = new Date().toISOString(), runId = makeRunId(), chromeAccessibilityAvailable, screenshotAvailable } = input;
  const value = { schemaVersion, checkedAt, runId, chromeAccessibilityAvailable, screenshotAvailable };
  if (!desktopShape(value)) throw new TypeError('invalid desktop preflight');
  return JSON.stringify(value, null, 2) + '\n';
}

export function makeHistoricalResumeCorrection({ checkedAt, runId } = {}) {
  return makeProbe({ probeId: 'human_resume', result: 'NOT_RUN', checkedAt, runId, evidence: { status: 'unknown', criterion: 'human_interruption_resume', pointer: 'historical_synthetic_only' } });
}

export function makeAuditedProbes({ terminal, restricted, resume, residualLabelPresent, typedEvidencePassed, now = () => new Date().toISOString(), makeId = makeRunId } = {}) {
  if (!terminal || terminal.probeId !== 'terminal_cua') throw new TypeError('terminal probe required');
  if (!restricted || restricted.probeId !== 'restricted_profile') throw new TypeError('restricted probe required');
  if (!resume || resume.probeId !== 'human_resume') throw new TypeError('historical resume record required');
  if (typeof residualLabelPresent !== 'boolean' || typeof typedEvidencePassed !== 'boolean') throw new TypeError('audit booleans required');
  const record = (probeId, result, evidence, errorClass) => makeProbe({ probeId, result, checkedAt: now(), runId: makeId(), evidence, ...(errorClass ? { errorClass } : {}) });
  return [
    terminal,
    record('launchagent_cua', 'NOT_RUN', { status: 'unknown', criterion: 'live_reexecution', pointer: 'prior_cleanup_unresolved' }),
    record('human_auth_boundary', 'NOT_RUN', { status: 'unknown', criterion: 'safe_login_boundary', pointer: 'not_opened' }),
    makeHistoricalResumeCorrection({ checkedAt: resume.checkedAt, runId: resume.runId }),
    record('launchagent_security', 'BLOCKED', { status: residualLabelPresent ? 'denied' : 'unknown', criterion: 'temporary_launchagent_cleanup', pointer: residualLabelPresent ? 'residual_label_present' : 'residual_label_unavailable' }, residualLabelPresent ? 'cleanup_incomplete' : 'not_available'),
    record('single_instance_lease', 'NOT_RUN', { status: 'unknown', criterion: 'lease_probe', pointer: 'not_implemented' }),
    restricted,
    record('typed_evidence', typedEvidencePassed ? 'PASS' : 'BLOCKED', typedEvidencePassed
      ? { status: 'clean', criterion: 'contract_unit_suite', pointer: 'tests_passed', allRowsValidated: true, sensitiveValuesRejected: true }
      : { status: 'unknown', criterion: 'contract_unit_suite', pointer: 'tests_failed' }, typedEvidencePassed ? undefined : 'command_failed'),
    record('orphan_recovery', 'NOT_RUN', { status: 'unknown', criterion: 'live_reexecution', pointer: 'prior_cleanup_unresolved' }),
  ];
}

export async function writeTask4AuditArtifacts({ directory, desktopPreflight, terminal, restricted, resume, residualLabelPresent, typedEvidencePassed, now, makeId } = {}) {
  if (typeof directory !== 'string' || !directory.startsWith('/')) throw new TypeError('absolute artifact directory required');
  const desktopText = serializeDesktopPreflight(desktopPreflight);
  const probes = makeAuditedProbes({ terminal, restricted, resume, residualLabelPresent, typedEvidencePassed, now, makeId });
  const reportText = serializeGate0Report(probes);
  const desktopPath = join(directory, '2026-08-24-local-cua-gate0-desktop-preflight.json');
  const evidencePath = join(directory, '2026-08-24-local-cua-gate0-evidence.json');
  await writeFile(desktopPath, desktopText, { mode: 0o600 });
  await writeFile(evidencePath, reportText, { mode: 0o600 });
  return Object.freeze({ desktopPath, evidencePath, verdict: makeGate0Report(probes).verdict, probes: Object.freeze(probes) });
}
