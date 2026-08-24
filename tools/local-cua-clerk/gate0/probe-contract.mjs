import { createHash } from 'node:crypto';

export const SCHEMA_VERSION = 'gate0-probe/v1';
export const RESULT_STATES = Object.freeze(['PASS', 'FAIL', 'BLOCKED', 'NOT_RUN']);
export const PROBE_IDS = Object.freeze([
  'terminal_cua', 'launchagent_cua', 'human_auth_boundary', 'human_resume',
  'launchagent_security', 'single_instance_lease', 'restricted_profile',
  'typed_evidence', 'orphan_recovery',
]);

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const HASH = /^[a-f0-9]{16,64}$/;
const ERROR_CLASSES = new Set([
  'command_failed', 'empty_path', 'invalid_path', 'version_failed', 'missing_assertion',
  'timeout', 'permission_boundary', 'not_available', 'malformed_evidence', 'identity_mismatch',
  'grant_reused', 'wrong_epoch', 'pid_reuse', 'unrelated_process', 'cleanup_incomplete',
]);
const SENSITIVE_KEY = /(pass(word)?|secret|token|api[_-]?key|cookie|credential|auth|email|phone|customer|client|resident|full.?name|first.?name|last.?name|address|certificate|autofill|stdout|stderr|screenshot|ax.?tree|page.?text|raw.?output|input|keystroke|click|session)/i;
const SENSITIVE_VALUE = /(customer|client|phone|email|address|certificate|credential|password|passwd|token|secret|api[_-]?key|cookie|bearer|authorization|autofill|page.?text|ax.?tree|raw.?output|stdout|stderr|keystroke|customer[_-]?\d|client[_-]?\d|[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}|\b\d{2,4}[- .]\d{3,4}[- .]\d{4}\b|\b\d+\s+\w+\s+(street|st|road|rd|avenue|ave)\b|\bpage[_-]?\w*|\bax[_-]?\w*)/i;
const SUMMARY_KEYS = Object.freeze(['status', 'criterion', 'pointer']);
const RESTRICTED_ASSERTIONS = Object.freeze(['directNodeReplAllowed', 'rawInputInjectionAllowed', 'helperSocketAccessAllowed', 'ledgerWriteAllowed', 'narrowActionPathWorks']);
const ORPHAN_BOOLEAN_KEYS = Object.freeze(['registeredOwnedChild', 'daemonEpochRevoked', 'recoveryAuthorityConsumed', 'exactIdentityVerified', 'unrelatedPidProtected', 'pidReuseBlocked', 'termSent', 'killSent', 'processGroupAbsent', 'cleanupCompleted']);

const ENUMS = Object.freeze({
  terminal_cua: { status: ['available', 'denied', 'unknown'], criterion: ['chrome_accessibility_screenshot', 'codex_probe', 'codex_probe_identity', 'codex_probe_timeout'], pointer: ['boolean_only', 'preflight_unavailable', 'identity_capture_failed_child_reaped', 'cleanup_incomplete', 'child_group_escalated', 'child_group_not_terminated', 'spawn_error', 'capability_unavailable', 'malformed_jsonl', 'output_limit_exceeded', 'command_failed'] },
  launchagent_cua: { status: ['available', 'denied', 'unknown'], criterion: ['chrome_accessibility_screenshot', 'launchagent_probe', 'launchagent_probe_identity', 'launchagent_probe_timeout', 'temporary_launchagent_cleanup', 'live_reexecution'], pointer: ['boolean_only', 'bounded_wait', 'launchctl_error', 'cleanup_incomplete', 'cleanup_mapping_retained', 'exact_label_bootout_confirmed', 'prior_cleanup_unresolved', 'preflight_unavailable', 'identity_capture_failed_child_reaped', 'child_group_escalated', 'child_group_not_terminated', 'spawn_error', 'capability_unavailable', 'malformed_jsonl', 'output_limit_exceeded', 'command_failed'] },
  human_auth_boundary: { status: ['available', 'unknown'], criterion: ['safe_login_boundary'], pointer: ['human_boundary_observed', 'not_opened'] },
  human_resume: { status: ['clean', 'unknown'], criterion: ['human_interruption_resume'], pointer: ['audited_resume_confirmed', 'historical_synthetic_only', 'not_run_no_live_fix'] },
  launchagent_security: { status: ['clean', 'denied', 'unknown'], criterion: ['temporary_launchagent_cleanup'], pointer: ['exact_label_bootout_confirmed', 'residual_label_present', 'residual_label_unavailable', 'cleanup_mapping_retained'] },
  single_instance_lease: { status: ['clean', 'unknown'], criterion: ['single_instance_lease', 'lease_probe'], pointer: ['lease_exclusion_confirmed', 'not_implemented'] },
  typed_evidence: { status: ['clean', 'unknown'], criterion: ['contract_unit_suite'], pointer: ['tests_passed', 'tests_failed'] },
  orphan_recovery: { status: ['clean', 'denied', 'unknown'], criterion: ['identity_checked_orphan_cleanup', 'live_reexecution', 'disposable_child', 'identity'], pointer: ['private_recovery_authority_consumed', 'prior_cleanup_unresolved', 'spawn_failed', 'cleanup_blocked', 'cleanup_incomplete', 'cleanup_attempted'] },
});
const LAUNCHAGENT_POINTERS_BY_CRITERION = Object.freeze({
  chrome_accessibility_screenshot: Object.freeze(['boolean_only']),
  launchagent_probe: Object.freeze(['launchctl_error', 'spawn_error', 'capability_unavailable', 'malformed_jsonl', 'output_limit_exceeded', 'command_failed']),
  launchagent_probe_identity: Object.freeze(['preflight_unavailable', 'identity_capture_failed_child_reaped', 'cleanup_incomplete']),
  launchagent_probe_timeout: Object.freeze(['bounded_wait', 'child_group_escalated', 'child_group_not_terminated']),
  temporary_launchagent_cleanup: Object.freeze(['cleanup_incomplete', 'cleanup_mapping_retained', 'exact_label_bootout_confirmed']),
  live_reexecution: Object.freeze(['prior_cleanup_unresolved']),
});
const SAFE_ENUM_VALUES = new Set(Object.values(ENUMS).flatMap(group => Object.values(group).flat()));
const SAFE_EVIDENCE_KEYS = new Set([
  ...SUMMARY_KEYS, 'assertions', 'normalShellPresent', 'restrictedShellPresent', 'directNodeReplDenied',
  ...RESTRICTED_ASSERTIONS, ...ORPHAN_BOOLEAN_KEYS, 'bootstrapOwned', 'exactLabelBootout',
  'ownDirectoryRemoved', 'recoveryMappingRetained', 'concurrentRunDenied', 'leaseReleased',
  'allRowsValidated', 'sensitiveValuesRejected',
]);

function object(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${name} must be an object`);
  return value;
}

function exactKeys(value, expected, name) {
  object(value, name);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) throw new TypeError(`${name} has unknown or missing keys`);
}

function rejectSensitive(value, path = 'evidence') {
  if (typeof value === 'string') {
    if (!SAFE_ENUM_VALUES.has(value) && SENSITIVE_VALUE.test(value)) throw new TypeError(`sensitive value rejected at ${path}`);
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, nested] of Object.entries(value)) {
    if (!SAFE_EVIDENCE_KEYS.has(key) && SENSITIVE_KEY.test(key)) throw new TypeError(`sensitive field rejected: ${key}`);
    rejectSensitive(nested, `${path}.${key}`);
  }
}

function validateSummary(probeId, evidence, extraKeys = []) {
  exactKeys(evidence, [...SUMMARY_KEYS, ...extraKeys], `${probeId} evidence`);
  const allowed = ENUMS[probeId];
  for (const key of SUMMARY_KEYS) if (!allowed[key].includes(evidence[key])) throw new TypeError(`invalid ${probeId} ${key}`);
  if (probeId === 'launchagent_cua' && !LAUNCHAGENT_POINTERS_BY_CRITERION[evidence.criterion]?.includes(evidence.pointer)) throw new TypeError('invalid launchagent_cua criterion-pointer pair');
}

function validateRestricted(evidence, result) {
  exactKeys(evidence, ['assertions', 'normalShellPresent', 'restrictedShellPresent', 'directNodeReplDenied'], 'restricted_profile evidence');
  exactKeys(evidence.assertions, RESTRICTED_ASSERTIONS, 'restricted_profile assertions');
  for (const key of RESTRICTED_ASSERTIONS) if (typeof evidence.assertions[key] !== 'boolean') throw new TypeError(`invalid restricted assertion: ${key}`);
  for (const key of ['normalShellPresent', 'restrictedShellPresent', 'directNodeReplDenied']) if (typeof evidence[key] !== 'boolean') throw new TypeError(`invalid restricted field: ${key}`);
  if (result === 'PASS') {
    const expected = key => key === 'narrowActionPathWorks';
    if (!evidence.normalShellPresent || evidence.restrictedShellPresent || !evidence.directNodeReplDenied || RESTRICTED_ASSERTIONS.some(key => evidence.assertions[key] !== expected(key))) throw new TypeError('restricted profile PASS does not prove autonomous boundary');
  }
}

function validateOrphan(evidence, result) {
  const fullKeys = [...SUMMARY_KEYS, ...ORPHAN_BOOLEAN_KEYS];
  const isFull = Object.keys(evidence).length === fullKeys.length;
  validateSummary('orphan_recovery', evidence, isFull ? ORPHAN_BOOLEAN_KEYS : []);
  if (isFull) for (const key of ORPHAN_BOOLEAN_KEYS) if (typeof evidence[key] !== 'boolean') throw new TypeError(`invalid orphan recovery field: ${key}`);
  if (result === 'PASS') {
    const requiredTrue = ORPHAN_BOOLEAN_KEYS.filter(key => key !== 'killSent');
    if (!isFull || evidence.status !== 'clean' || evidence.criterion !== 'identity_checked_orphan_cleanup' || evidence.pointer !== 'private_recovery_authority_consumed' || requiredTrue.some(key => evidence[key] !== true)) throw new TypeError('orphan recovery PASS does not prove safety');
  }
}

function validateEvidence(probeId, result, evidence) {
  object(evidence, 'evidence');
  rejectSensitive(evidence);
  if (probeId === 'restricted_profile') return validateRestricted(evidence, result);
  if (probeId === 'orphan_recovery') return validateOrphan(evidence, result);
  const passExtras = {
    launchagent_security: ['bootstrapOwned', 'exactLabelBootout', 'ownDirectoryRemoved', 'recoveryMappingRetained'],
    single_instance_lease: ['concurrentRunDenied', 'leaseReleased'],
    typed_evidence: ['allRowsValidated', 'sensitiveValuesRejected'],
  };
  const extras = result === 'PASS' ? (passExtras[probeId] ?? []) : [];
  validateSummary(probeId, evidence, extras);
  for (const key of extras) if (typeof evidence[key] !== 'boolean') throw new TypeError(`invalid ${probeId} boolean: ${key}`);
  if (result !== 'PASS') return;
  const expectedSummary = {
    terminal_cua: ['available', 'chrome_accessibility_screenshot', 'boolean_only'],
    launchagent_cua: ['available', 'chrome_accessibility_screenshot', 'boolean_only'],
    human_auth_boundary: ['available', 'safe_login_boundary', 'human_boundary_observed'],
    human_resume: ['clean', 'human_interruption_resume', 'audited_resume_confirmed'],
    launchagent_security: ['clean', 'temporary_launchagent_cleanup', 'exact_label_bootout_confirmed'],
    single_instance_lease: ['clean', 'single_instance_lease', 'lease_exclusion_confirmed'],
    typed_evidence: ['clean', 'contract_unit_suite', 'tests_passed'],
  }[probeId];
  if (!expectedSummary || SUMMARY_KEYS.some((key, index) => evidence[key] !== expectedSummary[index])) throw new TypeError(`${probeId} PASS has invalid summary`);
  if (probeId === 'launchagent_security' && !(evidence.bootstrapOwned && evidence.exactLabelBootout && evidence.ownDirectoryRemoved && evidence.recoveryMappingRetained === false)) throw new TypeError('launchagent_security PASS lacks cleanup proof');
  if (probeId === 'single_instance_lease' && !(evidence.concurrentRunDenied && evidence.leaseReleased)) throw new TypeError('single_instance_lease PASS lacks lease proof');
  if (probeId === 'typed_evidence' && !(evidence.allRowsValidated && evidence.sensitiveValuesRejected)) throw new TypeError('typed_evidence PASS lacks contract proof');
}

export function validateResultState(value) {
  if (!RESULT_STATES.includes(value)) throw new TypeError(`invalid result state: ${value}`);
  return value;
}

export function makeRunId(seed = `${Date.now()}-${Math.random()}`) {
  return createHash('sha256').update(seed).digest('hex').slice(0, 16);
}

export function makeProbe({ schemaVersion = SCHEMA_VERSION, probeId, result, evidence, checkedAt = new Date().toISOString(), runId = makeRunId(), errorClass } = {}) {
  if (schemaVersion !== SCHEMA_VERSION) throw new TypeError('invalid schemaVersion');
  if (!PROBE_IDS.includes(probeId)) throw new TypeError(`unknown probe id: ${probeId}`);
  validateResultState(result);
  if (!ISO.test(checkedAt)) throw new TypeError('invalid checkedAt');
  if (!HASH.test(runId)) throw new TypeError('invalid runId');
  if (result === 'PASS' && errorClass !== undefined) throw new TypeError('PASS cannot include errorClass');
  if (['FAIL', 'BLOCKED'].includes(result) && !ERROR_CLASSES.has(errorClass)) throw new TypeError('failure requires valid errorClass');
  if (result === 'NOT_RUN' && errorClass !== undefined) throw new TypeError('NOT_RUN cannot include errorClass');
  validateEvidence(probeId, result, evidence);
  return Object.freeze({ schemaVersion: SCHEMA_VERSION, probeId, result, checkedAt, runId, evidence, ...(errorClass ? { errorClass } : {}) });
}

export function validateProbeRecord(input) {
  const expected = input?.errorClass === undefined ? ['schemaVersion', 'probeId', 'result', 'checkedAt', 'runId', 'evidence'] : ['schemaVersion', 'probeId', 'result', 'checkedAt', 'runId', 'evidence', 'errorClass'];
  exactKeys(input, expected, 'probe');
  return makeProbe(input);
}

export function serializeEvidence(input) {
  return JSON.stringify(validateProbeRecord(input), null, 2) + '\n';
}

export function deriveVerdict(probes) {
  const rows = Array.isArray(probes) ? probes : Object.values(probes ?? {});
  let valid;
  try { valid = rows.map(validateProbeRecord); } catch { return 'BLOCKED'; }
  const ids = new Set(valid.map(probe => probe.probeId));
  if (valid.length !== PROBE_IDS.length || ids.size !== PROBE_IDS.length || PROBE_IDS.some(id => !ids.has(id))) return 'SUPERVISED_ONLY';
  if (valid.some(probe => probe.result === 'BLOCKED')) return 'BLOCKED';
  if (valid.some(probe => probe.result === 'FAIL')) return valid.some(probe => ['orphan_recovery', 'typed_evidence'].includes(probe.probeId) && probe.result === 'FAIL') ? 'BLOCKED' : 'SUPERVISED_ONLY';
  return valid.every(probe => probe.result === 'PASS') ? 'PASS' : 'SUPERVISED_ONLY';
}

export function serializeProbes(probes) {
  const rows = Array.isArray(probes) ? probes : Object.values(probes ?? {});
  return JSON.stringify(rows.map(validateProbeRecord), null, 2) + '\n';
}
