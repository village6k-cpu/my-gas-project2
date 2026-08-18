const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const registerProduction = read('scripts/windows/register-kakao-production-tasks.ps1');
const watchdog = read('scripts/windows/watch-kakao-production.ps1');
const runbook = read('docs/windows-kakao-hermes-migration-runbook.md');
const routingConfig = read('scripts/windows/configure-hermes-village-routing.py');
const overlaySync = read('scripts/windows/sync-hermes-profile-overlay.ps1');
const contractRaw = read('scripts/windows/hermes-model-contract.json');
const bridgeRestart = read('scripts/windows/Restart-KakaoBridgeLive.ps1');
const bridgeRecover = read('scripts/windows/recover-kakao-bridge-only.ps1');
const registerLive = read('scripts/windows/register-kakao-live-task.ps1');

test('production task registration is an explicit post-cutover approval, not a staging default', () => {
  assert.match(registerProduction, /\[switch\]\$ConfirmProductionOwnership/);
  assert.match(
    registerProduction,
    /if \(-not \$ConfirmProductionOwnership\.IsPresent\)\s*\{\s*\r?\n\s*throw/,
    'registration must refuse to run without the recorded ownership approval'
  );
  assert.match(registerProduction, /SupportsShouldProcess/);
  assert.match(registerProduction, /ConfirmImpact = 'High'/);
  assert.match(registerProduction, /Village-Kakao-Production-Start/);
  assert.match(registerProduction, /Village-Kakao-Production-Watchdog/);
  assert.match(registerProduction, /-EnableWrites/);
  assert.doesNotMatch(
    registerProduction,
    /New-ScheduledTaskSettingsSet[^\n]*-Disable\b/,
    'production tasks are registered enabled'
  );
  assert.match(registerProduction, /watch-kakao-production\.ps1/);
  assert.match(registerProduction, /start-kakao-live\.ps1/);
  assert.match(
    registerProduction,
    /['"]-ExecutionPolicy['"]\s*,\s*['"]Bypass['"][\s\S]*?['"]-File['"]/,
    'tasks must bypass a Restricted host policy before invoking the reviewed scripts'
  );
});

test('every Windows Kakao reboot path uses the complete Hermes venv and passes it explicitly', () => {
  assert.match(registerProduction, /\[string\]\$HermesPythonPath/);
  assert.match(registerProduction, /['"]-HermesPythonPath['"]/);
  assert.match(watchdog, /\[string\]\$HermesPythonPath/);
  assert.match(watchdog, /HermesPythonPath\s*=\s*\$resolvedHermesPythonPath/);

  for (const source of [registerProduction, watchdog, bridgeRestart, bridgeRecover, registerLive]) {
    assert.doesNotMatch(source, /hermes-agent[\\/]\.venv[\\/]Scripts[\\/]python\.exe/i);
  }
  for (const source of [registerProduction, bridgeRestart, bridgeRecover, registerLive]) {
    assert.match(source, /hermes-agent[\\/]venv[\\/]Scripts[\\/]python\.exe/i);
  }
});

test('the watchdog observes first and only restarts through the ownership-validated lifecycle', () => {
  assert.match(watchdog, /Read-OwnedProcessRecord/);
  assert.match(watchdog, /Test-OwnedProcessRecord/);
  assert.match(watchdog, /Test-LocalTcpPort/);
  assert.match(watchdog, /stop-kakao-staging\.ps1/);
  assert.match(watchdog, /start-kakao-staging\.ps1/);
  assert.match(watchdog, /inject-watcher-cdp\.py/);
  assert.match(watchdog, /--probe-only/);
  assert.match(watchdog, /start-kakao-live\.ps1/);
  assert.match(watchdog, /EnableWrites\s*=\s*\$true/);
  assert.doesNotMatch(
    watchdog,
    /taskkill|Stop-Process|Get-Process\s+-Name/,
    'the watchdog must never kill processes directly; only the owned stop path may'
  );

  const healthCheck = watchdog.indexOf('Get-UnhealthyComponents -Names $componentNames');
  const stopCall = watchdog.indexOf('& $stopScriptPath');
  const startCall = watchdog.indexOf('& $startScriptPath');
  assert.ok(healthCheck >= 0 && stopCall >= 0 && startCall >= 0);
  assert.ok(healthCheck < stopCall, 'health must be evaluated before any stop');
  assert.ok(stopCall < startCall, 'the owned stop must complete before the write-enabled start');
  assert.match(
    watchdog,
    /catch\s*\{[\s\S]*?manual intervention required[\s\S]*?throw/,
    'an ownership mismatch must abort the automatic restart'
  );
});

test('busy bridge handoff requires a current per-job phase proof for stdin Hermes', () => {
  assert.match(bridgeRestart, /kakao-worker-handoff-phase\/v1/);
  assert.match(bridgeRestart, /worker-phases/);
  assert.match(bridgeRestart, /initial_hermes_in_flight/);
  assert.match(bridgeRestart, /workerPid/);
  assert.match(bridgeRestart, /hermes-stdin-runner\\\.py/);
  assert.match(bridgeRestart, /Get-ProcessingDurableWorkerState/);
  assert.doesNotMatch(
    bridgeRestart,
    /CreationDate[\s\S]{0,300}(?:TotalSeconds|AddSeconds)/,
    'elapsed-time guesses must never substitute for an explicit pre-mutation phase proof'
  );
});

test('worker advances the handoff phase before every mutation and post-action boundary', () => {
  const worker = read('tools/ai-browser-worker/worker.mjs');
  const prepareStart = worker.indexOf('export async function prepareKakaoDecisionFromSnapshot');
  const prepareEnd = worker.indexOf('export async function applyPreparedKakaoDecision', prepareStart);
  const prepare = worker.slice(prepareStart, prepareEnd);
  const initial = prepare.indexOf("reportHandoffPhase('initial_hermes_in_flight')");
  const initialHermes = prepare.indexOf('await runHermesDecision(prompt, config');
  const initialFinished = prepare.indexOf("reportHandoffPhase('initial_hermes_finished')");
  const mutation = prepare.indexOf("reportHandoffPhase('sheet_mutation_boundary')");
  const append = prepare.indexOf('await appendToSheet(config, sheetPayload)');
  const postAction = prepare.indexOf("reportHandoffPhase('post_action_hermes_in_flight')");
  const postActionHermes = prepare.indexOf('await runHermesPostActionDecision({');

  for (const [label, index] of Object.entries({ initial, initialHermes, initialFinished, mutation, append, postAction, postActionHermes })) {
    assert.ok(index >= 0, `${label} marker must exist`);
  }
  assert.ok(initial < initialHermes);
  assert.ok(initialHermes < initialFinished);
  assert.ok(initialFinished < mutation);
  assert.ok(mutation < append);
  assert.ok(append < postAction);
  assert.ok(postAction < postActionHermes);
});

test('the runbook documents production always-on operation after the cutover contract', () => {
  assert.match(runbook, /^##\s+Production operation \(post-cutover\)$/m);
  const cutover = runbook.indexOf('## Cutover');
  const production = runbook.indexOf('## Production operation (post-cutover)');
  assert.ok(cutover >= 0 && production > cutover, 'production section must follow the cutover contract');
  assert.match(runbook, /register-kakao-production-tasks\.ps1/);
  assert.match(runbook, /-ConfirmProductionOwnership/);
  assert.match(runbook, /watchdog\.log/);
});

test('one model contract feeds routing configuration, profile parity, and the tests', () => {
  const contract = JSON.parse(contractRaw);
  for (const [section, keys] of [
    ['root', ['provider', 'model', 'reasoning_effort']],
    ['kakaoworker', ['model', 'reasoning_effort', 'max_turns', 'disabled_toolsets']]
  ]) {
    assert.ok(contract[section], `contract must define ${section}`);
    for (const key of keys) {
      const value = contract[section][key];
      assert.ok(value !== undefined && String(value).trim() !== '', `${section}.${key} must be set`);
    }
  }

  assert.match(routingConfig, /hermes-model-contract\.json/);
  assert.match(
    routingConfig,
    /config\["model"\]\["default"\]\s*=\s*contract\["model"\]/,
    'routing configuration must take the model from the contract'
  );
  assert.match(
    routingConfig,
    /config\["model"\]\["provider"\]\s*=\s*contract\["provider"\]/,
    'the provider must be written together with the model so a switch can never produce a mixed state'
  );
  assert.match(overlaySync, /hermes-model-contract\.json/);
  assert.match(overlaySync, /disabled_toolsets[\s\S]*computer_use/i);
  assert.match(
    overlaySync,
    /-lt \[int\]\$contract\.max_turns/,
    'profile parity must enforce the contract max_turns as a minimum, not a cap'
  );
});
