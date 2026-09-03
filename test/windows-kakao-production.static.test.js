const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const registerProduction = read('scripts/windows/register-kakao-production-tasks.ps1');
const watchdog = read('scripts/windows/watch-kakao-production.ps1');
const stagingStart = read('scripts/windows/start-kakao-staging.ps1');
const runbook = read('docs/windows-kakao-hermes-migration-runbook.md');
const routingConfig = read('scripts/windows/configure-hermes-village-routing.py');
const overlaySync = read('scripts/windows/sync-hermes-profile-overlay.ps1');
const contractRaw = read('scripts/windows/hermes-model-contract.json');
const bridgeRestart = read('scripts/windows/Restart-KakaoBridgeLive.ps1');
const bridgeRecover = read('scripts/windows/recover-kakao-bridge-only.ps1');
const registerLive = read('scripts/windows/register-kakao-live-task.ps1');
const liveCommon = read('scripts/windows/KakaoLive.Common.psm1');
const liveStart = read('scripts/windows/start-kakao-live.ps1');
const gatewayTaskRegistration = read('scripts/windows/register-hermes-gateway-tasks.ps1');
const benchmarkReport = JSON.parse(read('docs/kakao-hermes-gateway-benchmark-report.json'));

test('native Gateway cutover is explicit, benchmark-gated, plan-only, and rollback-first', () => {
  assert.match(liveStart, /\[switch\]\$ConfirmKakaoGatewayCutover/);
  assert.match(liveStart, /\[string\]\$BenchmarkReportPath/);
  assert.match(liveStart, /\[switch\]\$RollbackToCli/);
  assert.match(liveStart, /\[switch\]\$GatewayMaintenance/);
  assert.match(liveStart, /GatewayMaintenance\.IsPresent[\s\S]{0,220}-not \$ConfirmKakaoGatewayCutover\.IsPresent[\s\S]{0,220}throw/i);
  assert.match(liveStart, /if \(-not \$ConfirmKakaoGatewayCutover\.IsPresent\)[\s\S]{0,240}throw/i);
  assert.match(liveStart, /BenchmarkReport[\s\S]{0,500}accepted[\s\S]{0,200}latency_status/i);
  assert.match(liveStart, /HermesTransport\s+['"]gateway['"]/i);
  assert.match(liveStart, /HermesTransport\s+['"]cli['"]/i);
  assert.match(liveStart, /function\s+Test-KakaoworkerGatewayTaskDefinition/i);
  const taskDefinitionCheck = liveStart.indexOf('Test-KakaoworkerGatewayTaskDefinition');
  const cutoverMutation = liveStart.indexOf("ShouldProcess('owned Kakao bridge and kakaoworker Gateway', 'Cut over transport");
  assert.ok(taskDefinitionCheck >= 0 && cutoverMutation > taskDefinitionCheck);
  const rollbackStart = liveStart.indexOf('function Invoke-KakaoGatewayRollback');
  const rollbackEnd = liveStart.indexOf('if ($RollbackToCli.IsPresent)', rollbackStart);
  const rollback = liveStart.slice(rollbackStart, rollbackEnd);
  assert.match(rollback, /Hermes_Gateway_Kakaoworker_Native/i);
  assert.match(rollback, /leaveHealthyChromeUntouched/i);
  assert.doesNotMatch(rollback, /--profile['"]?\s*,?\s*['"]root|TaskName\s+['"]Hermes_Gateway['"]/i);

  const planIndex = liveStart.indexOf('if ($PlanOnly.IsPresent)');
  const confirmationIndex = liveStart.indexOf('if (-not $ConfirmKakaoGatewayCutover.IsPresent)');
  const firstHealthCall = liveStart.indexOf('Invoke-RestMethod');
  assert.ok(planIndex >= 0 && confirmationIndex > planIndex);
  assert.ok(firstHealthCall > confirmationIndex, 'no live probe or transition may occur before explicit cutover confirmation');
  assert.equal(benchmarkReport.accepted, true);
  assert.equal(benchmarkReport.latency_status, 'pass');
});

test('Gateway cutover treats an absent legacy health gateway section as an empty queue', () => {
  assert.match(
    liveStart,
    /\$preHealth\.PSObject\.Properties\.Name\s+-contains\s+['"]gateway['"][\s\S]{0,220}\$preHealth\.gateway/,
  );
});

test('Gateway production health requires direct plugin, consumer, queue, Kakao, and safety readback', () => {
  assert.match(liveCommon, /function\s+Test-KakaoGatewayCutoverHealth/i);
  assert.match(liveCommon, /function\s+Test-KakaoPluginInstallReceipt/i);
  for (const marker of [
    'hermesTransport',
    'gatewayReady',
    'consumer',
    'fresh',
    'pluginPath',
    'manifestSha256',
    'profile',
    'pid',
    'queue',
    'failed',
    'authenticated',
    'watcherReady',
    'scheduleOwnerReviewRequired',
    'killSwitchObserved'
  ]) {
    assert.match(liveCommon, new RegExp(marker, 'i'), `missing cutover health marker ${marker}`);
  }
  assert.match(liveCommon, /queue\.ready[^\r\n]+-eq 0/i);
  assert.match(liveCommon, /queue\.claimed[^\r\n]+-eq 0/i);
  assert.match(liveCommon, /queue\.retry[^\r\n]+-eq 0/i);
  assert.match(liveCommon, /queue\.failed[^\r\n]+-eq 0/i);
});

test('production tasks carry recorded Gateway approval while preserving root Slack ownership', () => {
  assert.match(registerProduction, /\[switch\]\$ConfirmKakaoGatewayCutover/);
  assert.match(registerProduction, /\[switch\]\$PlanOnly/);
  assert.match(registerProduction, /['"]-ConfirmKakaoGatewayCutover['"]/);
  assert.match(registerProduction, /['"]-BenchmarkReportPath['"]/);
  assert.match(registerProduction, /startArguments[\s\S]{0,220}-GatewayMaintenance/i);
  assert.match(registerProduction, /PlanOnly[\s\S]{0,1600}ConvertTo-Json/i);
  assert.match(watchdog, /\[switch\]\$ConfirmKakaoGatewayCutover/);
  assert.match(watchdog, /GatewayMaintenance/);
  assert.match(watchdog, /Hermes_Gateway_Kakaoworker_Native/);
  assert.doesNotMatch(watchdog, /restart-hermes-gateway\.ps1[^\r\n]+-Target\s+root/i);
  assert.match(gatewayTaskRegistration, /root[\s\S]{0,160}mutated\s*=\s*\$false/i);
  assert.match(registerProduction, /-WindowStyle['"],?\s*['"]Hidden/i);
  assert.match(registerProduction, /C:\\Windows\\System32\\WindowsPowerShell\\v1\.0\\powershell\.exe/i);
  assert.doesNotMatch(registerProduction, /Join-Path\s+\$PSHOME/i);
  assert.match(registerProduction, /RepetitionDuration\s+\(New-TimeSpan\s+-Days\s+3650\)/i);
  assert.doesNotMatch(registerProduction, /\[TimeSpan\]::MaxValue/i);
  assert.match(registerProduction, /function\s+Set-ExistingHiddenTaskWrapper/i);
  assert.match(registerProduction, /wscript\.exe[\s\S]{0,1200}hidden-tasks/i);
  assert.match(registerProduction, /\[IO\.File\]::Replace\(/i);
  assert.doesNotMatch(registerProduction, /Unregister-ScheduledTask|Remove-ScheduledTask/i);
});

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

test('the owned Chrome launcher preserves one bounded generation of startup diagnostics', () => {
  assert.match(stagingStart, /chrome\.out\.log/);
  assert.match(stagingStart, /chrome\.err\.log/);
  assert.match(stagingStart, /foreach \(\$stream in @\('out', 'err'\)\)/);
  assert.match(stagingStart, /chrome\.\{0\}\.prev\.log/);
  assert.match(stagingStart, /-RedirectStandardOutput/);
  assert.match(stagingStart, /-RedirectStandardError/);
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
  const operationStart = worker.indexOf('export async function executeVillageConfirmationRequest');
  const operationEnd = worker.indexOf('export async function prepareKakaoGatewayDecision', operationStart);
  const operation = worker.slice(operationStart, operationEnd);
  const prepareStart = worker.indexOf('export async function prepareKakaoDecisionFromSnapshot');
  const prepareEnd = worker.indexOf('export async function applyPreparedKakaoDecision', prepareStart);
  const prepare = worker.slice(prepareStart, prepareEnd);
  const initial = prepare.indexOf("reportHandoffPhase('initial_hermes_in_flight')");
  const initialHermes = prepare.indexOf('await runHermesDecision(prompt, config');
  const initialFinished = prepare.indexOf("reportHandoffPhase('initial_hermes_finished')");
  const mutation = prepare.indexOf("reportHandoffPhase('sheet_mutation_boundary')");
  const execute = prepare.indexOf('await executeVillageConfirmationRequest({');
  const postAction = prepare.indexOf("reportHandoffPhase('post_action_hermes_in_flight')");
  const postActionHermes = prepare.indexOf('await runHermesPostActionDecision({');
  const append = operation.indexOf('sheetResult = await appendImpl(config, sheetPayload)');
  const freshnessCheck = operation.lastIndexOf('await freshnessGuard.checkNow()', append);
  const freshnessFence = operation.lastIndexOf('freshnessGuard.throwIfSuperseded()', append);
  const claimFence = operation.lastIndexOf('await assertCurrentClaim()', append);

  for (const [label, index] of Object.entries({
    operationStart,
    operationEnd,
    initial,
    initialHermes,
    initialFinished,
    mutation,
    execute,
    postAction,
    postActionHermes,
    freshnessCheck,
    freshnessFence,
    claimFence,
    append
  })) {
    assert.ok(index >= 0, `${label} marker must exist`);
  }
  assert.ok(initial < initialHermes);
  assert.ok(initialHermes < initialFinished);
  assert.ok(initialFinished < mutation);
  assert.ok(mutation < execute);
  assert.ok(execute < postAction);
  assert.ok(postAction < postActionHermes);
  assert.ok(freshnessCheck < freshnessFence);
  assert.ok(freshnessFence < claimFence);
  assert.ok(claimFence < append);
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
