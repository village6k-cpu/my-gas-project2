import test from 'node:test';
import assert from 'node:assert/strict';
import { collectRuntime } from './runtime-probe.mjs';

test('runtime probe uses injected commands and never captures command output fields', async () => {
  const calls = [];
  const exec = async (file, args) => {
    calls.push([file, args]);
    if (file === 'which') return { stdout: '/opt/codex' };
    if (file === 'git') return { stdout: 'codex/test\n' };
    return { stdout: 'codex 0.1\n', stderr: 'secret' };
  };
  const result = await collectRuntime({ exec, cwd: '/tmp/work', configuredMcp: [{ name: 'node_repl', status: 'available' }] });
  assert.equal(result.probeId, 'launchagent_security');
  assert.equal(result.evidence.branch, 'codex/test');
  assert.equal(result.evidence.mcp[0].name, 'node_repl');
  assert.equal(Object.hasOwn(result.evidence, 'stdout'), false);
  assert.deepEqual(calls, [
    ['which', ['codex']],
    ['/opt/codex', ['--version']],
    ['git', ['-C', '/tmp/work', 'branch', '--show-current']]
  ]);
});
