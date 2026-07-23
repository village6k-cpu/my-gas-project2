import assert from 'node:assert/strict';
import { join } from 'node:path';
import test from 'node:test';

import { buildWindowsAiWorkerInvocation } from '../scripts/windows/windows-ai-worker.mjs';

test('reviewed Windows worker wrapper always uses stdin-job and defaults to dry-run', () => {
  const repoRoot = 'C:\\Village Worker';
  const invocation = buildWindowsAiWorkerInvocation({
    env: {},
    execPath: 'C:\\Program Files\\nodejs\\node.exe',
    repoRoot
  });

  assert.equal(invocation.command, 'C:\\Program Files\\nodejs\\node.exe');
  assert.deepEqual(invocation.args, [
    join(repoRoot, 'tools', 'ai-browser-worker', 'worker.mjs'),
    '--stdin-job',
    '--dry-run'
  ]);
  assert.equal(invocation.options.shell, false);
  assert.equal(invocation.options.stdio, 'inherit');
  assert.equal(invocation.options.env.AI_WORKER_DRY_RUN, '1');
});

test('only the exact lifecycle write marker removes the wrapper dry-run guard', () => {
  for (const marker of ['true', 'TRUE', '01', ' 1 ', '']) {
    const invocation = buildWindowsAiWorkerInvocation({
      env: { VILLAGE_WINDOWS_WRITES_ENABLED: marker },
      execPath: 'node.exe',
      repoRoot: 'C:\\Village'
    });
    assert.ok(invocation.args.includes('--dry-run'), `marker ${JSON.stringify(marker)} must stay dry`);
    assert.equal(invocation.options.env.AI_WORKER_DRY_RUN, '1');
  }

  const enabled = buildWindowsAiWorkerInvocation({
    env: {
      VILLAGE_WINDOWS_WRITES_ENABLED: '1',
      AI_WORKER_DRY_RUN: '1'
    },
    execPath: 'node.exe',
    repoRoot: 'C:\\Village'
  });

  assert.deepEqual(enabled.args.slice(-1), ['--stdin-job']);
  assert.ok(!enabled.args.includes('--dry-run'));
  assert.equal(enabled.options.shell, false);
  assert.equal(enabled.options.stdio, 'inherit');
});
