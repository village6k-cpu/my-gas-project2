const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const common = read('scripts/windows/KakaoStaging.Common.psm1');
const start = read('scripts/windows/start-kakao-staging.ps1');
const status = read('scripts/windows/status-kakao-staging.ps1');
const stop = read('scripts/windows/stop-kakao-staging.ps1');
const restart = read('scripts/windows/restart-kakao-staging.ps1');
const register = read('scripts/windows/register-kakao-scheduled-tasks.ps1');
const runbook = read('docs/windows-kakao-hermes-migration-runbook.md');
const envExample = read('scripts/windows/.env.windows.example');
const bridgeServer = read('tools/kakao-dom-bridge/server.mjs');
const workerWrapperPath = path.join(root, 'scripts/windows/windows-ai-worker.mjs');
const workerWrapper = fs.existsSync(workerWrapperPath) ? fs.readFileSync(workerWrapperPath, 'utf8') : '';
const allScripts = [common, start, status, stop, restart].join('\n');

function sourceIndex(source, pattern, label) {
  const match = pattern.exec(source);
  assert.ok(match, `${label} marker must exist`);
  return match.index;
}

function quotePowerShellLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function runPowerShell(command, env = {}) {
  return spawnSync(
    'powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command],
    {
      encoding: 'utf8',
      env: { ...process.env, ...env }
    }
  );
}

test('Windows Kakao staging scripts satisfy the owned lifecycle contract', () => {
  assert.match(start, /SupportsShouldProcess/);
  assert.match(start, /--remote-debugging-address=127\.0\.0\.1/);
  assert.match(start, /--remote-debugging-port=/);
  assert.match(start, /--user-data-dir=/);
  assert.match(start, /windows-runtime-config\.mjs/);
  assert.match(common, /AI_WORKER_AUTO_SEND/);
  assert.match(common, /KAKAO_WORKER_CONTROL_MODE/);
  assert.match(common, /KAKAO_WORKER_CONTROL_MODE\s*=\s*['"]devtools_first['"]/);
  assert.match(common, /KAKAO_WORKER_SEARCH_TARGET_CHAT\s*=\s*['"]1['"]/);
  assert.match(common, /function\s+ConvertTo-KakaoStagingBooleanValue/);
  assert.match(common, /AI_WORKER_LIVE\s*=\s*['"]0['"]/);
  assert.match(common, /SLACK_ACTION_POLL_ENABLED\s*=\s*['"]0['"]/);
  assert.match(common, /KAKAO_TAB_CLEANUP_ENABLED\s*=\s*['"]1['"]/);
  assert.match(envExample, /^KAKAO_TAB_CLEANUP_ENABLED=1$/m);
  assert.match(envExample, /^KAKAO_WORKER_CONTROL_MODE=devtools_first$/m);
  assert.match(envExample, /^KAKAO_WORKER_SEARCH_TARGET_CHAT=1$/m);
  assert.match(common, /Get-CimInstance\s+-ClassName\s+Win32_Process/);
  assert.match(common, /CommandLine/);
  assert.match(common, /ExecutablePath/);
  assert.doesNotMatch(
    allScripts,
    /launchctl|osascript|\/Applications\/Google Chrome|Library\/Application Support/
  );
  assert.doesNotMatch(stop, /taskkill\s+\/IM|Get-Process\s+-Name/);

  const validationIndex = sourceIndex(
    start,
    /&\s+\$NodePath\s+\$configScriptPath/,
    'configuration validation'
  );
  const chromeIndex = sourceIndex(
    start,
    /Write-OwnedProcessRecord\s+-Name\s+['"]chrome['"]/,
    'Chrome ownership record'
  );
  const bridgeIndex = sourceIndex(
    start,
    /Write-OwnedProcessRecord\s+-Name\s+['"]bridge['"]/,
    'bridge ownership record'
  );
  const gatewayIndex = sourceIndex(start, /if\s*\(\$IncludeGateway\)/, 'optional gateway');

  assert.ok(validationIndex < chromeIndex, 'configuration validation must happen before Chrome');
  assert.ok(chromeIndex < bridgeIndex, 'Chrome must start before the bridge');
  assert.ok(bridgeIndex < gatewayIndex, 'the bridge must start before the optional gateway');

  assert.match(
    restart,
    /if\s*\(\$PSBoundParameters\.ContainsKey\(['"]EnableWrites['"]\)\)[\s\S]*?\$startParameters\[['"]EnableWrites['"]\]\s*=\s*\$true/,
    'restart must forward EnableWrites only after checking that the switch was explicitly supplied'
  );
  assert.doesNotMatch(
    restart,
    /\$startParameters\[['"]EnableWrites['"]\]\s*=\s*\$EnableWrites/,
    'restart must not forward an implicit false EnableWrites value'
  );
});

test('start rejects Google Chrome 137+ because command-line extension loading is unavailable', () => {
  assert.match(start, /VersionInfo\.ProductName/);
  assert.match(start, /VersionInfo\.FileVersion/);
  assert.match(start, /Google Chrome/);
  assert.match(start, /\.Major\s+-ge\s+137/);
  assert.match(start, /Chrome for Testing|Chromium/);
  assert.match(runbook, /Chrome 137/);
});

test('start opens the fixed Kakao chat list in the owned browser', () => {
  assert.match(
    start,
    /\$kakaoStartUrl\s*=\s*['"]https:\/\/business\.kakao\.com\/_xhPMls\/chats\?t_src=business_partnercenter/
  );
  assert.match(start, /ConvertTo-WindowsCommandLineArgument\s+-Value\s+['"]--no-first-run['"]/);
  assert.match(start, /ConvertTo-WindowsCommandLineArgument\s+-Value\s+['"]--start-minimized['"]/);
  assert.match(start, /ConvertTo-WindowsCommandLineArgument\s+-Value\s+\$kakaoStartUrl/);
  assert.doesNotMatch(
    start,
    /KAKAO_START_URL/,
    'the environment file must not redirect the owned browser to an arbitrary origin'
  );
});

test('stop removes only an ownership record whose recorded PID is absent', {
  skip: process.platform !== 'win32'
}, () => {
  const localAppData = fs.mkdtempSync(path.join(os.tmpdir(), 'village-stale-record-'));
  const recordDirectory = path.join(localAppData, 'Village', 'kakao-staging');
  const recordPath = path.join(recordDirectory, 'chrome.json');
  fs.mkdirSync(recordDirectory, { recursive: true });
  fs.writeFileSync(recordPath, JSON.stringify({
    Name: 'chrome',
    Pid: 2147483647,
    ExecutablePath: 'C:\\missing\\chrome.exe',
    CommandMarker: '--user-data-dir=C:\\missing\\profile'
  }));

  try {
    const stopScriptPath = path.join(root, 'scripts', 'windows', 'stop-kakao-staging.ps1');
    const result = runPowerShell(
      `& ${quotePowerShellLiteral(stopScriptPath)} -Confirm:$false`,
      { LOCALAPPDATA: localAppData }
    );

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(fs.existsSync(recordPath), false, 'the definitely stale record must be removed');
  } finally {
    fs.rmSync(localAppData, { recursive: true, force: true });
  }
});

test('stop preserves an ownership record when a live PID fails executable or marker validation', {
  skip: process.platform !== 'win32'
}, () => {
  const localAppData = fs.mkdtempSync(path.join(os.tmpdir(), 'village-live-mismatch-'));
  const recordDirectory = path.join(localAppData, 'Village', 'kakao-staging');
  const recordPath = path.join(recordDirectory, 'chrome.json');
  fs.mkdirSync(recordDirectory, { recursive: true });
  fs.writeFileSync(recordPath, JSON.stringify({
    Name: 'chrome',
    Pid: process.pid,
    ExecutablePath: process.execPath,
    CommandMarker: `--definitely-not-present-${process.pid}`
  }));

  try {
    const stopScriptPath = path.join(root, 'scripts', 'windows', 'stop-kakao-staging.ps1');
    const result = runPowerShell(
      `& ${quotePowerShellLiteral(stopScriptPath)} -Confirm:$false`,
      { LOCALAPPDATA: localAppData }
    );

    assert.notEqual(result.status, 0, 'a live ownership mismatch must be rejected');
    assert.equal(fs.existsSync(recordPath), true, 'the mismatched live record must be preserved');
  } finally {
    fs.rmSync(localAppData, { recursive: true, force: true });
  }
});

test('verified process shutdown allows slow browser descendants up to thirty seconds', () => {
  assert.match(common, /\$deadline\s*=\s*\[DateTime\]::UtcNow\.AddSeconds\(30\)/);
  const stopVerified = /function Stop-VerifiedProcess\s*\{([\s\S]*?)\n\}\s*\n\s*function Get-DescendantProcessIds/.exec(common);
  assert.ok(stopVerified, 'verified process stop function must exist');
  const remainingProbes = stopVerified[1].match(/Get-RemainingProcessTreeIds\s+-ProcessIds\s+\$trackedProcessIds/g) || [];
  assert.ok(
    remainingProbes.length >= 2,
    'shutdown must make a fresh final process-tree probe after the timed wait'
  );
});

test('Windows staging computes, validates, and reports only the reviewed AI worker wrapper', () => {
  assert.match(envExample, /^VILLAGE_AI_WORKER_CMD=$/m);
  assert.match(start, /windows-ai-worker\.mjs/);
  assert.match(start, /--worker-command/);
  assert.match(start, /SetEnvironmentVariable\(['"]VILLAGE_AI_WORKER_CMD['"],\s*\$workerCommand/);
  assert.match(start, /Write-OwnedProcessRecord\s+-Name\s+['"]bridge['"][^\n]+-WorkerEnabled\s+\$true/);
  assert.match(status, /workerEnabled\s*=\s*\[bool\]\$bridgeRecord\.WorkerEnabled/);
  assert.doesNotMatch(status, /workerEnabled\s*=\s*\$configurationPresence\[['"]VILLAGE_AI_WORKER_CMD['"]\]/);
  const baseRequiredBlock = /\$baseRequiredNames\s*=\s*@\(([\s\S]*?)\n\)/.exec(status);
  assert.ok(baseRequiredBlock, 'base required-name block must exist');
  assert.doesNotMatch(baseRequiredBlock[1], /VILLAGE_AI_WORKER_CMD/);
});

test('reviewed Windows AI worker wrapper inherits stdio and enforces safe arguments', () => {
  assert.match(workerWrapper, /process\.execPath/);
  assert.match(workerWrapper, /tools[\s\S]*ai-browser-worker[\s\S]*worker\.mjs/);
  assert.match(workerWrapper, /['"]--stdin-job['"]/);
  assert.match(workerWrapper, /['"]--dry-run['"]/);
  assert.match(workerWrapper, /VILLAGE_WINDOWS_WRITES_ENABLED\s*===\s*['"]1['"]/);
  assert.match(workerWrapper, /AI_WORKER_DRY_RUN\s*:\s*['"]1['"]/);
  assert.match(workerWrapper, /shell\s*:\s*false/);
  assert.match(workerWrapper, /stdio\s*:\s*['"]inherit['"]/);
});

test('safe staging uses isolated Supabase queue names and write enablement is explicit', () => {
  assert.match(envExample, /^SUPABASE_TABLE=[A-Za-z0-9_]+_windows_staging$/m);
  assert.match(envExample, /^SUPABASE_FOLLOW_UP_TABLE=[A-Za-z0-9_]+_windows_staging$/m);
  assert.doesNotMatch(envExample, /^SUPABASE_TABLE=ai_processing_events$/m);
  assert.doesNotMatch(envExample, /^SUPABASE_FOLLOW_UP_TABLE=ai_follow_up_items$/m);
  assert.match(runbook, /_windows_staging/);
  assert.match(runbook, /must not share production queue tables/i);
  assert.match(runbook, /-EnableWrites/);
  assert.match(envExample, /^AI_WORKER_DRY_RUN=1$/m);
  assert.match(envExample, /^VILLAGE_WINDOWS_WRITES_ENABLED=0$/m);
  assert.match(common, /AI_WORKER_DRY_RUN\s*=\s*['"]1['"]/);
  assert.match(common, /VILLAGE_WINDOWS_WRITES_ENABLED\s*=\s*['"]0['"]/);
  assert.match(common, /SetEnvironmentVariable\(['"]VILLAGE_WINDOWS_WRITES_ENABLED['"],\s*\$lifecycleWriteMarker/);
});

test('canonical 1 and 0 booleans are consumed consistently by PowerShell and the bridge', () => {
  assert.match(common, /function\s+ConvertTo-KakaoStagingBooleanValue/);
  assert.match(common, /['"]true['"]\s*\{\s*return\s+['"]1['"]\s*\}/);
  assert.match(common, /['"]false['"]\s*\{\s*return\s+['"]0['"]\s*\}/);
  assert.match(bridgeServer, /function\s+readBooleanEnvironment/);
  assert.match(
    bridgeServer,
    /slackActionPollEnabled:\s*readBooleanEnvironment\(process\.env\.SLACK_ACTION_POLL_ENABLED,\s*true\)/
  );
  assert.match(
    bridgeServer,
    /kakaoTabCleanupEnabled:\s*readBooleanEnvironment\(process\.env\.KAKAO_TAB_CLEANUP_ENABLED,\s*true\)/
  );
});

test('Start-Process receives one safely quoted command line for values containing spaces', () => {
  const spaceContracts = [
    ['Chrome profile', 'C:\\Village Worker\\chrome profile', /ConvertTo-WindowsCommandLineArgument\s+-Value\s+\$chromeProfileArgument/],
    ['extension', 'C:\\Village Worker\\watcher extension', /ConvertTo-WindowsCommandLineArgument\s+-Value\s+\$extensionArgument/],
    ['bridge entrypoint', 'C:\\Village Worker\\bridge runtime\\server.mjs', /ConvertTo-WindowsCommandLineArgument\s+-Value\s+\$bridgeScriptPath/],
    ['Hermes profile', 'kakao staging worker', /ConvertTo-WindowsCommandLineArgument\s+-Value\s+\$env:HERMES_WORKER_PROFILE/]
  ];

  assert.match(common, /function\s+ConvertTo-WindowsCommandLineArgument/);
  assert.match(common, /\$backslashCount\s*\*\s*2\s*\+\s*1/);
  assert.match(common, /\$backslashCount\s*\*\s*2\)/);
  for (const [label, value, pattern] of spaceContracts) {
    assert.match(value, /\s/, `${label} fixture must exercise embedded spaces`);
    assert.match(start, pattern, `${label} must use the reusable Windows quoting helper`);
  }

  assert.match(start, /Start-Process[^\n]+-FilePath\s+\$ChromePath[^\n]+-ArgumentList\s+\$chromeCommandLine/);
  assert.match(start, /Start-Process[^\n]+-FilePath\s+\$NodePath[^\n]+-ArgumentList\s+\$bridgeCommandLine/);
  assert.match(start, /Start-Process[^\n]+-FilePath\s+\$HermesPath[^\n]+-ArgumentList\s+\$gatewayCommandLine/);
  assert.doesNotMatch(start, /-ArgumentList\s+@\(/, 'Start-Process must not receive an argument array');
});

test('stop and restart use one effective outer ShouldProcess decision', () => {
  const stopApproval = sourceIndex(stop, /\$PSCmdlet\.ShouldProcess/, 'stop outer approval');
  const stopChildSuppression = sourceIndex(stop, /Stop-OwnedProcess[^\n]+-Confirm:\$false/, 'stop child confirmation suppression');
  assert.ok(stopApproval < stopChildSuppression, 'stop must approve the composite action before suppressing child confirmation');

  const restartApproval = sourceIndex(restart, /\$PSCmdlet\.ShouldProcess/, 'restart outer approval');
  const restartStop = sourceIndex(restart, /&\s+\$stopScriptPath[^\n]+-Confirm:\$false/, 'restart stop invocation');
  const restartStart = sourceIndex(restart, /&\s+\$startScriptPath\s+@startParameters/, 'restart start invocation');
  assert.ok(restartApproval < restartStop, 'restart must approve before suppressing stop confirmation');
  assert.ok(restartApproval < restartStart, 'restart WhatIf must return before child lifecycle calls');

  const startApproval = sourceIndex(start, /\$PSCmdlet\.ShouldProcess/, 'start approval');
  const existingRecordCheck = sourceIndex(start, /Read-OwnedProcessRecord\s+-Name\s+\$ownedName/, 'existing record check');
  assert.ok(startApproval < existingRecordCheck, 'start WhatIf preview must not fail on existing ownership records');
});

test('start does not mutate the caller process environment before outer approval', () => {
  const startApproval = sourceIndex(start, /\$PSCmdlet\.ShouldProcess/, 'start approval');
  const envImport = sourceIndex(start, /Import-DotEnvFile\s+-Path/, 'environment import');
  const safeEnvironment = sourceIndex(start, /Set-KakaoStagingSafeEnvironment/, 'safe environment application');
  const beforeApproval = start.slice(0, startApproval);

  assert.ok(startApproval < envImport, 'dotenv import must happen only after start approval');
  assert.ok(startApproval < safeEnvironment, 'safe defaults must be forced only after start approval');
  assert.doesNotMatch(
    beforeApproval,
    /Import-DotEnvFile|Set-KakaoStagingSafeEnvironment|SetEnvironmentVariable/,
    'WhatIf and declined Confirm paths must not mutate the caller process environment'
  );
});

test('gateway ownership marker includes the exact safely quoted profile value', () => {
  assert.match(
    start,
    /\$gatewayProfileArgument\s*=\s*ConvertTo-WindowsCommandLineArgument\s+-Value\s+\$env:HERMES_WORKER_PROFILE/
  );
  assert.match(start, /\$gatewayCommandLine\s*=.*\$gatewayProfileArgument/);
  assert.match(
    start,
    /Write-OwnedProcessRecord\s+-Name\s+['"]gateway['"][^\n]+-CommandMarker\s+\$gatewayCommandLine/
  );
  assert.doesNotMatch(start, /-CommandMarker\s+['"]gateway --profile['"]/);
});

test('gateway start uses the current Hermes foreground CLI', () => {
  assert.match(
    start,
    /\$gatewayCommandLine\s*=\s*"--profile \$gatewayProfileArgument gateway run"/
  );
  assert.doesNotMatch(start, /\$gatewayCommandLine\s*=\s*"gateway --profile/);
  assert.doesNotMatch(start, /--external-supervisor/);
});

test('gateway startup must reach a fresh running state before ownership is recorded', () => {
  assert.match(start, /\$gatewayProfileHome\s*=[^\r\n]*\$env:HERMES_HOME[^\r\n]*\$env:HERMES_WORKER_PROFILE/);
  assert.match(start, /\$gatewayPidPath\s*=\s*Join-Path \$gatewayProfileHome 'gateway\.pid'/);
  assert.match(start, /\$gatewayStatePath\s*=\s*Join-Path \$gatewayProfileHome 'gateway_state\.json'/);
  assert.match(start, /\$gatewayDeadline\s*=\s*\[DateTime\]::UtcNow\.AddSeconds\(150\)/);
  assert.match(
    start,
    /\$gatewayDeadline[\s\S]*?while\s*\(\[DateTime\]::UtcNow\s+-lt\s+\$gatewayDeadline\)[\s\S]*?\$gatewayProcess\.Refresh\(\)[\s\S]*?\$gatewayProcess\.HasExited[\s\S]*?Owned Hermes gateway exited during startup[\s\S]*?gateway_state[\s\S]*?startup_failed[\s\S]*?Write-OwnedProcessRecord -Name 'gateway'/
  );
  assert.match(start, /Get-Process -Id \$runtimePid/);
  assert.match(start, /gatewayState\.kind\s+-eq\s+'hermes-gateway'/);
  assert.match(start, /\$gatewayStateFile\.LastWriteTimeUtc\s+-ge\s+\$gatewayLaunchUtc/);
  assert.match(start, /\$stateUpdatedAt\.UtcDateTime\s+-ge\s+\$gatewayLaunchUtc/);
  assert.match(start, /\$runtimePid\s+-eq\s+\$pidFilePid/);
  assert.match(start, /Get-DescendantProcessIds -ParentId \$gatewayProcess\.Id/);
  assert.match(start, /\$runtimeOwnedByLauncher/);
  assert.match(
    start,
    /\$gatewayStateCandidateReady\s*=[\s\S]*?gateway_state\s+-eq\s+'running'[\s\S]*?if\s*\(\$gatewayStateCandidateReady\)[\s\S]*?Get-DescendantProcessIds/
  );
  assert.match(start, /did not reach a fresh running state before the startup deadline/);
  assert.match(common, /Export-ModuleMember[\s\S]*?'Get-DescendantProcessIds'/);
});

test('record storage and just-started processes are protected against record-write failure', () => {
  assert.match(common, /function\s+Initialize-KakaoStagingRuntimeStorage/);
  assert.match(common, /function\s+Stop-VerifiedProcess/);

  const storagePreflight = sourceIndex(start, /Initialize-KakaoStagingRuntimeStorage/, 'runtime storage preflight');
  const chromeStart = sourceIndex(start, /\$chromeProcess\s*=\s*Start-Process/, 'Chrome start');
  assert.ok(storagePreflight < chromeStart, 'storage must be writable before any process starts');

  for (const component of ['chrome', 'bridge', 'gateway']) {
    const processStart = sourceIndex(
      start,
      new RegExp(`\\$${component}Process\\s*=\\s*Start-Process`),
      `${component} process start`
    );
    const immediateTrack = sourceIndex(
      start,
      new RegExp(`\\$startedProcesses\\.Add\\(\\$${component}Started\\)`),
      `${component} immediate tracking`
    );
    const recordWrite = sourceIndex(
      start,
      new RegExp(`Write-OwnedProcessRecord\\s+-Name\\s+['"]${component}['"]`),
      `${component} record write`
    );
    assert.ok(processStart < immediateTrack && immediateTrack < recordWrite, `${component} must be tracked before its record write`);
  }

  assert.match(start, /if\s*\(\$started\.Recorded\)[\s\S]*?Stop-OwnedProcess[\s\S]*?else[\s\S]*?Stop-VerifiedProcess/);

  const recordFunction = /function Write-OwnedProcessRecord\s*\{([\s\S]*?)\n\}/.exec(common);
  assert.ok(recordFunction, 'owned process record writer must exist');
  assert.match(recordFunction[1], /\[IO\.File\]::Move\(\$temporary,\s*\$destination\)/);
  assert.doesNotMatch(recordFunction[1], /Move-Item[\s\S]*?-Force/);
});

test('manual and scheduled starts share one nonblocking lifecycle mutex', () => {
  const acquire = sourceIndex(start, /\[System\.Threading\.Mutex\]::new/, 'mutex construction');
  const wait = sourceIndex(start, /\.WaitOne\(0\)/, 'nonblocking mutex acquisition');
  const recordPreflight = sourceIndex(start, /Read-OwnedProcessRecord\s+-Name\s+\$ownedName/, 'record preflight');
  const processStart = sourceIndex(start, /Start-Process/, 'first process start');
  const finallyBlock = /finally\s*\{([\s\S]*?)\n\}/.exec(start);

  assert.match(start, /Local\\Village\.KakaoStaging\.Start\.v1/);
  assert.ok(acquire < wait && wait < recordPreflight, 'mutex must cover ownership preflight');
  assert.ok(wait < processStart, 'mutex must cover process creation');
  assert.ok(finallyBlock, 'start must always release its mutex');
  assert.match(finallyBlock[1], /ReleaseMutex\(\)/);
  assert.match(finallyBlock[1], /Dispose\(\)/);
  assert.match(runbook, /concurrent manual and scheduled starts/i);
  assert.match(runbook, /mutex/i);
});

test('owned process stop validates ownership then kills and verifies the entire process tree', () => {
  const ownershipValidation = sourceIndex(
    common,
    /Test-OwnedProcessRecord\s+-Record\s+\$verificationRecord/,
    'ownership validation'
  );
  const descendantCapture = sourceIndex(
    common,
    /Get-DescendantProcessIds\s+-ParentId\s+\$pidValue/,
    'descendant capture'
  );
  const treeKill = sourceIndex(
    common,
    /taskkill\.exe[^\n]+\/PID[^\n]+\/T[^\n]+\/F/,
    'owned process tree kill'
  );
  const remainingCheck = sourceIndex(
    common,
    /\$remainingProcessIds\s*=\s*@\(Get-RemainingProcessTreeIds\s+-ProcessIds/,
    'remaining process tree verification'
  );

  assert.ok(ownershipValidation < descendantCapture, 'ownership must be validated before descendants are captured');
  assert.ok(descendantCapture < treeKill, 'descendants must be captured before taskkill');
  assert.ok(treeKill < remainingCheck, 'tree exit must be verified after taskkill');
  assert.doesNotMatch(common, /taskkill\.exe[^\n]+\/IM/);
  assert.doesNotMatch(common, /Stop-Process\s+-Id/);
});

test('status probes persisted effective lifecycle ports instead of raw env overrides', () => {
  assert.match(start, /Write-OwnedProcessRecord\s+-Name\s+['"]chrome['"][^\n]+-Port\s+\$devToolsPort/);
  assert.match(start, /Write-OwnedProcessRecord\s+-Name\s+['"]bridge['"][^\n]+-Port\s+\$bridgePort/);
  assert.match(status, /\$record\.Port/);
  assert.doesNotMatch(status, /\$name\s+-eq\s+['"]KAKAO_REMOTE_DEBUGGING_PORT['"]/);
  assert.doesNotMatch(status, /\$name\s+-eq\s+['"]PORT['"]/);
});

test('status treats the isolated follow-up table as an unconditional base requirement', () => {
  assert.doesNotMatch(start, /FollowUpTableRequired/);
  assert.doesNotMatch(common, /FollowUpTableRequired/);
  assert.doesNotMatch(status, /FollowUpTableRequired/);
  assert.doesNotMatch(status, /SLACK_AGENT_CARD_DELIVERY_ENABLED|SLACK_ACTION_POLL_ENABLED/);
  const baseRequiredBlock = /\$baseRequiredNames\s*=\s*@\(([\s\S]*?)\n\)/.exec(status);
  assert.ok(baseRequiredBlock, 'base required-name block must exist');
  assert.match(
    baseRequiredBlock[1],
    /SUPABASE_FOLLOW_UP_TABLE/,
    'follow-up table must be an unconditional base requirement'
  );
});

test('scheduled tasks are registered disabled and never started by the registration script', () => {
  assert.match(register, /Register-ScheduledTask/);
  assert.match(register, /New-ScheduledTaskTrigger\s+-AtLogOn/);
  assert.match(register, /New-ScheduledTaskSettingsSet[^\n]+-Disable/);
  assert.match(register, /Disable-ScheduledTask/);
  assert.match(register, /SupportsShouldProcess/);
  assert.match(register, /status-kakao-staging\.ps1/);
  assert.match(register, /start-kakao-staging\.ps1/);
  assert.doesNotMatch(register, /Start-ScheduledTask|Enable-ScheduledTask|-EnableWrites/);

  const approvalIndex = sourceIndex(register, /\$PSCmdlet\.ShouldProcess/, 'scheduled task approval');
  const registrationIndex = sourceIndex(register, /Register-ScheduledTask/, 'scheduled task registration');
  assert.ok(approvalIndex < registrationIndex, 'scheduled task registration requires prior operator approval');

  const statusArguments = /\$statusArguments\s*=\s*@\(([\s\S]*?)\)\s*-join/.exec(register);
  const startArguments = /\$startArgumentParts\s*=\s*@\(([\s\S]*?)\)\s*\n/.exec(register);
  assert.ok(statusArguments, 'status task argument block must exist');
  assert.ok(startArguments, 'start task argument block must exist');
  for (const [label, argumentBlock] of [
    ['status', statusArguments[1]],
    ['start', startArguments[1]]
  ]) {
    assert.match(
      argumentBlock,
      /['"]-ExecutionPolicy['"]\s*,\s*['"]Bypass['"][\s\S]*?['"]-File['"]/,
      `${label} task must bypass the host's Restricted execution policy before invoking the reviewed script`
    );
  }
});

test('migration runbook documents the manual no-send cutover and rollback contract', () => {
  for (const heading of [
    'Preconditions',
    'Secret transfer',
    'No-send staging',
    'Mac-retained services',
    'Cutover',
    'Verification',
    'Rollback',
    'Abort criteria'
  ]) {
    assert.match(runbook, new RegExp(`^##\\s+${heading}$`, 'mi'));
  }

  for (const safeFlag of [
    'AI_WORKER_AUTO_SEND',
    'AI_WORKER_DRY_RUN',
    'SLACK_ACTION_POLL_ENABLED',
    'VILLAGE_WINDOWS_WRITES_ENABLED',
    'KAKAO_WORKER_CONTROL_MODE',
    'KAKAO_WORKER_SEARCH_TARGET_CHAT',
    'KAKAO_APPLESCRIPT_FALLBACK'
  ]) {
    assert.match(runbook, new RegExp(`\\b${safeFlag}\\b`));
  }
  assert.match(runbook, /KAKAO_WORKER_CONTROL_MODE=devtools_first/);
  assert.match(runbook, /KAKAO_WORKER_SEARCH_TARGET_CHAT=1/);

  assert.match(runbook, /BlueBubbles/);
  assert.match(runbook, /Messages/);
  assert.match(runbook, /watch voice relay/i);
  assert.match(runbook, /duplicate workers/i);
  assert.match(runbook, /PID ownership mismatch/i);
  assert.match(runbook, /unexpected external send/i);

  const safeStaging = sourceIndex(runbook, /## No-send staging/, 'safe staging section');
  const stopSafeStaging = sourceIndex(
    runbook,
    /stop Windows safe staging/i,
    'stop safe staging transition'
  );
  const transferOwnership = sourceIndex(
    runbook,
    /transfer production ownership/i,
    'production ownership transfer'
  );
  const writeEnabledStart = sourceIndex(
    runbook,
    /start Windows[^\n]+-EnableWrites/i,
    'write-enabled start'
  );

  assert.ok(safeStaging < stopSafeStaging, 'safe staging must be verified before it is stopped');
  assert.ok(stopSafeStaging < transferOwnership, 'safe staging must stop before ownership transfer');
  assert.ok(transferOwnership < writeEnabledStart, 'ownership transfer must precede write-enabled start');
  assert.match(runbook, /do not call[^\n]+start-kakao-staging\.ps1[^\n]+ownership records/i);
  assert.match(runbook, /zero descendant processes/i);
  assert.match(runbook, /do not restore the Mac/i);
});
