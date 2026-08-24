import test from 'node:test';
import assert from 'node:assert/strict';
import { makeProbe, deriveVerdict, serializeEvidence, PROBE_IDS } from './probe-contract.mjs';

const passEvidence = probeId => ({
  terminal_cua: { status: 'available', criterion: 'chrome_accessibility_screenshot', pointer: 'boolean_only' },
  launchagent_cua: { status: 'available', criterion: 'chrome_accessibility_screenshot', pointer: 'boolean_only' },
  human_auth_boundary: { status: 'available', criterion: 'safe_login_boundary', pointer: 'human_boundary_observed' },
  human_resume: { status: 'clean', criterion: 'human_interruption_resume', pointer: 'audited_resume_confirmed' },
  launchagent_security: { status: 'clean', criterion: 'temporary_launchagent_cleanup', pointer: 'exact_label_bootout_confirmed', bootstrapOwned: true, exactLabelBootout: true, ownDirectoryRemoved: true, recoveryMappingRetained: false },
  single_instance_lease: { status: 'clean', criterion: 'single_instance_lease', pointer: 'lease_exclusion_confirmed', concurrentRunDenied: true, leaseReleased: true },
  restricted_profile: { assertions: { directNodeReplAllowed: false, rawInputInjectionAllowed: false, helperSocketAccessAllowed: false, ledgerWriteAllowed: false, narrowActionPathWorks: true }, normalShellPresent: true, restrictedShellPresent: false, directNodeReplDenied: true },
  typed_evidence: { status: 'clean', criterion: 'contract_unit_suite', pointer: 'tests_passed', allRowsValidated: true, sensitiveValuesRejected: true },
  orphan_recovery: { status: 'clean', criterion: 'identity_checked_orphan_cleanup', pointer: 'private_recovery_authority_consumed', registeredOwnedChild: true, daemonEpochRevoked: true, recoveryAuthorityConsumed: true, exactIdentityVerified: true, unrelatedPidProtected: true, pidReuseBlocked: true, termSent: true, killSent: false, processGroupAbsent: true, cleanupCompleted: true },
}[probeId]);
const pass = probeId => makeProbe({ probeId, result: 'PASS', evidence: passEvidence(probeId) });

test('every probe rejects empty or partial PASS evidence', () => {
  for (const probeId of PROBE_IDS) assert.throws(() => makeProbe({ probeId, result: 'PASS', evidence: {} }), { name: 'TypeError' }, probeId);
});

test('valid complete global set passes and incomplete set stays supervised', () => {
  assert.equal(deriveVerdict(PROBE_IDS.map(pass)), 'PASS');
  assert.equal(deriveVerdict([pass('terminal_cua')]), 'SUPERVISED_ONLY');
});

test('deriveVerdict validates forged rows before considering PASS', () => {
  const forged = PROBE_IDS.map(pass).map(row => ({ ...row }));
  forged[0] = { ...forged[0], evidence: {} };
  assert.equal(deriveVerdict(forged), 'BLOCKED');
  const unknown = PROBE_IDS.map(pass).map(row => ({ ...row }));
  unknown[0] = { ...unknown[0], forged: true };
  assert.equal(deriveVerdict(unknown), 'BLOCKED');
});

test('sensitive-looking values and unknown nested keys are rejected', () => {
  assert.throws(() => makeProbe({ probeId: 'terminal_cua', result: 'PASS', evidence: { status: 'available', criterion: 'chrome_accessibility_screenshot', pointer: 'customer_12345' } }), /sensitive value/);
  for (const pointer of ['person@example.com', '010-1234-5678', 'page_checkout', 'AX_customer']) {
    assert.throws(() => makeProbe({ probeId: 'terminal_cua', result: 'PASS', evidence: { status: 'available', criterion: 'chrome_accessibility_screenshot', pointer } }), /sensitive value/);
  }
  const restricted = structuredClone(passEvidence('restricted_profile'));
  restricted.assertions.rawOutput = false;
  assert.throws(() => makeProbe({ probeId: 'restricted_profile', result: 'PASS', evidence: restricted }), /sensitive field|unknown or missing/);
  assert.throws(() => serializeEvidence({ ...pass('terminal_cua'), extra: true }), /probe has unknown or missing keys/);
});

test('fixed safe enum strings remain accepted', () => {
  for (const probeId of PROBE_IDS) assert.doesNotThrow(() => pass(probeId));
});

test('LaunchAgent failure criterion rejects pointers from a different failure class', () => {
  assert.throws(() => makeProbe({
    probeId: 'launchagent_cua',
    result: 'BLOCKED',
    evidence: { status: 'unknown', criterion: 'launchagent_probe_identity', pointer: 'command_failed' },
    errorClass: 'command_failed',
  }), /invalid launchagent_cua criterion-pointer pair/);
});
