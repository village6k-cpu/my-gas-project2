import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const defaultRepoRoot = resolve(scriptDirectory, '..', '..');

export function buildWindowsAiWorkerInvocation({
  env = process.env,
  execPath = process.execPath,
  repoRoot = defaultRepoRoot
} = {}) {
  const writesEnabled = env.VILLAGE_WINDOWS_WRITES_ENABLED === '1';
  const args = [join(repoRoot, 'tools', 'ai-browser-worker', 'worker.mjs'), '--stdin-job'];
  const childEnv = writesEnabled ? { ...env } : { ...env, AI_WORKER_DRY_RUN: '1' };

  if (!writesEnabled) {
    args.push('--dry-run');
  }

  return {
    command: execPath,
    args,
    options: {
      env: childEnv,
      shell: false,
      stdio: 'inherit'
    }
  };
}

async function main() {
  const invocation = buildWindowsAiWorkerInvocation();
  const child = spawn(invocation.command, invocation.args, invocation.options);

  await new Promise((resolvePromise, rejectPromise) => {
    child.once('error', rejectPromise);
    child.once('exit', (code, signal) => {
      if (signal) {
        process.once('exit', () => process.kill(process.pid, signal));
        process.exitCode = 1;
      } else {
        process.exitCode = code ?? 1;
      }
      resolvePromise();
    });
  });
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  await main();
}
