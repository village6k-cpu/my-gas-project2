import { readdirSync, mkdtempSync, openSync, closeSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

// Offline regression + real temporary-file queue fault injection. No deployment,
// production endpoint, credential loading, or customer transport in this runner.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (Number(process.versions.node.split('.')[0]) < 24) {
  throw new Error('Node 24+ is required, matching the production bridge and PGlite test contract.');
}
const directory = mkdtempSync(path.join(tmpdir(), 'village-automation-report-'));
const files = dir => readdirSync(path.join(root, dir)).filter(n => /\.test\.(?:mjs|js)$/.test(n))
  .sort().map(n => `${dir}/${n}`);
const allGas = files('test');
const excluded = process.platform === 'win32' ? [] : allGas.filter(f =>
  path.basename(f).startsWith('windows-') || path.basename(f) === 'kakao-live-model-contract.behavior.test.mjs');
const suites = {
  automation: ['tools/ai-browser-worker', 'tools/kakao-dom-bridge', 'tools/reservation-reconciliation',
    'tools/work-orchestrator-v2'].flatMap(files),
  gas: allGas.filter(f => !excluded.includes(f))
};
const report = { node: process.version, platform: process.platform, createdAt: new Date().toISOString(),
  scope: 'offline tests; production delivery and Windows runtime are not certified',
  excluded: excluded.map(file => ({ file, reason: 'Windows PowerShell/runtime required' })), suites: {} };
let failed = false;
for (const [name, selected] of Object.entries(suites)) {
  const log = path.join(directory, `${name}.tap`), fd = openSync(log, 'wx', 0o600);
  let run;
  try { run = spawnSync(process.execPath, ['--test', '--test-reporter=tap', '--test-concurrency=4', ...selected],
    { cwd: root, stdio: ['ignore', fd, fd] }); }
  finally { closeSync(fd); }
  const output = readFileSync(log, 'utf8');
  const counts = Object.fromEntries(['tests', 'pass', 'fail', 'skipped', 'cancelled'].map(key =>
    [key, Number(output.match(new RegExp(`^# ${key} (\\d+)$`, 'm'))?.[1] ?? -1)]));
  const ok = run.status === 0 && counts.fail === 0 && counts.cancelled === 0 && counts.tests > 0;
  report.suites[name] = { ok, ...counts, files: selected.length, log, exitCode: run.status,
    ...(run.error ? { error: run.error.message } : {}) };
  failed ||= !ok;
  console.log(`${name}: ${JSON.stringify(report.suites[name])}`);
}
report.passed = !failed;
writeFileSync(path.join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
console.log(`Excluded platform-specific files: ${excluded.length}; report: ${directory}/report.json`);
process.exitCode = failed ? 1 : 0;
