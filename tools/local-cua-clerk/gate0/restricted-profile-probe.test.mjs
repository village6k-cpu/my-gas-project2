import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyExecFailure, parseRestrictedJsonl, RESTRICTED_PROBE_PAYLOAD, runRestrictedProfileProbe } from './restricted-profile-probe.mjs';

const record = (overrides = {}) => ({ shellPresent: true, directNodeReplAllowed: false, rawInputInjectionAllowed: false, helperSocketAccessAllowed: false, ledgerWriteAllowed: false, narrowActionPathWorks: true, ...overrides });
const command = (normal, restricted) => async (_path, _args, options) => ({ exitCode: 0, stdout: JSON.stringify(options.profile === 'normal' ? normal : restricted) });

test('restricted payload forbids tool execution and fails unknown capabilities closed', () => {
  assert.match(RESTRICTED_PROBE_PAYLOAD, /Do not use any tools/);
  assert.match(RESTRICTED_PROBE_PAYLOAD, /return false/);
});

test('restricted probe compares profiles and records shell presence separately', async () => {
  const result = await runRestrictedProfileProbe({ command: command(record({ shellPresent: true }), record({ shellPresent: false })), runId: 'a'.repeat(16) });
  assert.equal(result.result, 'FAIL');
  assert.equal(result.evidence.normalShellPresent, true);
  assert.equal(result.evidence.restrictedShellPresent, false);
  assert.equal(result.evidence.directNodeReplDenied, true);
  assert.equal(result.errorClass, 'permission_boundary');
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

test('restricted parser accepts one exact Codex JSONL agent result', () => {
  const expected = record({ shellPresent: false });
  const jsonl = [
    JSON.stringify({ type: 'thread.started', thread_id: 'safe-id' }),
    JSON.stringify({ type: 'item.completed', item: { id: 'safe-error-id', type: 'error', message: 'redacted upstream diagnostic' } }),
    JSON.stringify({ type: 'item.completed', item: { id: 'safe-result-id', type: 'agent_message', text: JSON.stringify(expected) } }),
    JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } }),
  ].join('\n');
  assert.deepEqual(parseRestrictedJsonl(jsonl), expected);
  assert.throws(() => parseRestrictedJsonl(`${jsonl}\n${JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(expected) } })}`), /malformed/);
});

test('restricted probe preserves a timed out invocation as timeout', async () => {
  const result = await runRestrictedProfileProbe({
    command: async () => ({ exitCode: null, timedOut: true, stdout: '' }),
    runId: 'e'.repeat(16),
  });
  assert.equal(result.result, 'BLOCKED');
  assert.equal(result.errorClass, 'timeout');
});

test('exec timeout classification is redacted and does not retain subprocess output', () => {
  const result = classifyExecFailure({ code: 'ETIMEDOUT', killed: true, signal: 'SIGTERM', stdout: 'credential=must-not-escape' });
  assert.deepEqual(result, { exitCode: null, timedOut: true, stdout: '' });
  assert.doesNotMatch(JSON.stringify(result), /credential|must-not-escape/);
});
