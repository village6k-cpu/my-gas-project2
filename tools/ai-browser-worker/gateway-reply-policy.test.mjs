import test from 'node:test';
import assert from 'node:assert/strict';
import { buildHermesPrompt } from './worker.mjs';

for (const status of ['active', 'paused', 'price_paused', 'not_checked']) {
  test(`native gateway prompt exposes the server-observed ${status} reply policy`, () => {
    const prompt = buildHermesPrompt({ job_id: 'policy-evidence' }, {
      gatewayConfirmationToolAvailable: true,
      lookupContext: {
        generated_at: '2026-09-14T10:07:43.645Z',
        kill_switch: { status, error: status === 'not_checked' ? 'read failed: private-token' : null },
        lookup_urls: { kill_switch_read: 'https://private.example/?key=private-token' },
        lookup_tool: { command: 'legacy-shell-command' },
      },
    });
    const block = prompt.match(/SERVER-OBSERVED REPLY POLICY:\n([^\n]+)\n/);
    assert.ok(block, 'the AI-consumed prompt must include the already-read policy');
    assert.deepEqual(JSON.parse(block[1]), {
      observed_at: '2026-09-14T10:07:43.645Z',
      kill_switch_status: status,
      read_failed: status === 'not_checked',
    });
    assert.ok(!prompt.includes('private-token'));
    assert.ok(!prompt.includes('legacy-shell-command'));
    assert.ok(!prompt.includes('READ-ONLY VILLAGE LIVE LOOKUP:'));
  });
}

test('native gateway does not invent an active policy without a server read', () => {
  const prompt = buildHermesPrompt({ job_id: 'no-policy-evidence' }, { gatewayConfirmationToolAvailable: true });
  assert.ok(!prompt.includes('SERVER-OBSERVED REPLY POLICY:'));
});
