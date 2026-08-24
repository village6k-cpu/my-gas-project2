import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRestrictedJsonl, runRestrictedProfileProbe } from './restricted-profile-probe.mjs';

const record = (overrides = {}) => ({ shellPresent: true, directNodeReplAllowed: false, rawInputInjectionAllowed: false, helperSocketAccessAllowed: false, ledgerWriteAllowed: false, narrowActionPathWorks: true, ...overrides });
const command = (normal, restricted) => async (_path, _args, options) => ({ exitCode: 0, stdout: JSON.stringify(options.profile === 'normal' ? normal : restricted) });

test('restricted probe compares profiles and records shell presence separately', async () => {
  const result = await runRestrictedProfileProbe({ command: command(record({ shellPresent: true }), record({ shellPresent: false })), runId: 'a'.repeat(16) });
  assert.equal(result.result, 'PASS');
  assert.equal(result.evidence.normalShellPresent, true);
  assert.equal(result.evidence.restrictedShellPresent, false);
  assert.equal(result.evidence.directNodeReplDenied, true);
});

test('restricted probe fails closed when direct node_repl remains available', async () => {
  const result = await runRestrictedProfileProbe({ command: command(record(), record({ directNodeReplAllowed: true })), runId: 'b'.repeat(16) });
  assert.equal(result.result, 'FAIL');
  assert.equal(result.errorClass, 'permission_boundary');
});

test('restricted probe rejects forged or incomplete evidence', async () => {
  assert.throws(() => parseRestrictedJsonl(JSON.stringify({ ...record(), forged: true })), /malformed/);
  const result = await runRestrictedProfileProbe({ command: command(record(), { shellPresent: true }), runId: 'c'.repeat(16) });
  assert.equal(result.result, 'BLOCKED');
  assert.equal(result.errorClass, 'malformed_evidence');
});

test('restricted probe records command failure without subprocess output', async () => {
  const result = await runRestrictedProfileProbe({ command: async () => ({ exitCode: 1, stdout: 'credential=must-not-escape' }), runId: 'd'.repeat(16) });
  assert.equal(result.result, 'BLOCKED');
  assert.equal(result.errorClass, 'command_failed');
  assert.doesNotMatch(JSON.stringify(result), /credential|must-not-escape/);
});
