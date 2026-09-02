import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const modulePath = fileURLToPath(new URL('../scripts/windows/KakaoLive.Common.psm1', import.meta.url));
const startScriptPath = fileURLToPath(new URL('../scripts/windows/start-kakao-live.ps1', import.meta.url));
const bridgeRecoveryPath = fileURLToPath(new URL('../scripts/windows/recover-kakao-bridge-only.ps1', import.meta.url));
const watchdogPath = fileURLToPath(new URL('../scripts/windows/watch-kakao-production.ps1', import.meta.url));
const restartBridgePath = fileURLToPath(new URL('../scripts/windows/Restart-KakaoBridgeLive.ps1', import.meta.url));

function recoveryAction(runtimeState, bridgeContractHealthy = true, watcherProbeHealthy = true) {
  const escapedPath = modulePath.replaceAll("'", "''");
  const escapedState = runtimeState.replaceAll("'", "''");
  const command = [
    `$ErrorActionPreference='Stop'`,
    `Import-Module '${escapedPath}' -Force`,
    `$result=Get-KakaoLiveRecoveryAction -BridgeContractHealthy $${bridgeContractHealthy ? 'true' : 'false'} -RuntimeState '${escapedState}' -BridgeBusy $false -WatcherProbeHealthy $${watcherProbeHealthy ? 'true' : 'false'}`,
    `[Console]::Out.Write($result)`
  ].join('; ');
  return execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command], {
    encoding: 'utf8',
    windowsHide: true
  }).trim();
}

function sourceRefreshAction({ source = '2026-07-31T08:00:00Z', process = '2026-07-31T07:00:00Z', busy = false } = {}) {
  const escapedPath = modulePath.replaceAll("'", "''");
  const command = [
    `$ErrorActionPreference='Stop'`,
    `Import-Module '${escapedPath}' -Force`,
    `$result=Get-KakaoLiveSourceRefreshAction -SourceLastWriteTimeUtc ([datetime]'${source}') -ProcessStartTimeUtc ([datetime]'${process}') -BridgeBusy $${busy ? 'true' : 'false'}`,
    `[Console]::Out.Write($result)`
  ].join('; ');
  return execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command], {
    encoding: 'utf8',
    windowsHide: true
  }).trim();
}

function loginRunnerArguments() {
  const escapedPath = modulePath.replaceAll("'", "''");
  const command = [
    `$ErrorActionPreference='Stop'`,
    `Import-Module '${escapedPath}' -Force`,
    `$arguments=Get-KakaoLoginRunnerArguments -LoginRunner 'runner.mjs' -CredentialMode 'onepassword' -UsernameRef 'op://vault/item/username' -PasswordRef 'op://vault/item/password' -OtpRef 'op://vault/item/otp' -OpPath 'C:\\Tools\\op.exe' -SecretsStdin`,
    `$arguments | ConvertTo-Json -Compress`
  ].join('; ');
  return JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command], {
    encoding: 'utf8',
    windowsHide: true
  }));
}

function chromeAutofillRunnerArguments() {
  const escapedPath = modulePath.replaceAll("'", "''");
  const command = [
    `$ErrorActionPreference='Stop'`,
    `Import-Module '${escapedPath}' -Force`,
    `$arguments=Get-KakaoLoginRunnerArguments -LoginRunner 'runner.mjs' -CredentialMode 'chrome_saved_autofill'`,
    `$arguments | ConvertTo-Json -Compress`
  ].join('; ');
  return JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command], {
    encoding: 'utf8',
    windowsHide: true
  }));
}

function loginStdinPayload() {
  const escapedPath = modulePath.replaceAll("'", "''");
  const command = [
    `$ErrorActionPreference='Stop'`,
    `Import-Module '${escapedPath}' -Force`,
    `$readSecret={param($ref) switch -Exact ($ref) {'op://vault/item/username' {'fake-user'} 'op://vault/item/password' {'fake-password'} 'op://vault/item/otp' {'123456'} default {throw 'unexpected ref'}}}`,
    `New-KakaoLoginStdinPayload -UsernameRef 'op://vault/item/username' -PasswordRef 'op://vault/item/password' -OtpRef 'op://vault/item/otp' -ReadSecret $readSecret`
  ].join('; ');
  return JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command], {
    encoding: 'utf8',
    windowsHide: true
  }));
}

function combinedLiveHealth(runtimeState, { authenticated = true, watcherReady = true } = {}) {
  const escapedPath = modulePath.replaceAll("'", "''");
  const command = [
    `$ErrorActionPreference='Stop'`,
    `Import-Module '${escapedPath}' -Force`,
    `$env:WORK_ORCHESTRATOR_V2_RUNTIME_MODE='v2'`,
    `$bridge=[pscustomobject]@{ok=$true; workOrchestrator=[pscustomobject]@{ok=$true}; config=[pscustomobject]@{workerLive=$true; workerDryRun=$false; windowsWritesEnabled=$true; autoSendEnabled=$true; slackCardDeliveryEnabled=$false; followUpRowsEnabled=$false; slackActionPollEnabled=$false; p0SlackEscalationEnabled=$false; slackBotTokenPresent=$true; supabaseRecoveryEnabled=$true; kakaoTabCleanupEnabled=$true; startupCatchupSupported=$true; aiDomSplitEnabled=$true; aiDecisionConcurrency=2; workOrchestrator=[pscustomobject]@{runtimeMode='v2';shadowWrites=$true;immediateEnabled=$true;workItemsEnabled=$true;digestEnabled=$true;cleanupEnabled=$true;p0ReadbackEnabled=$true;p0CutoverEnabled=$true;storeConfigured=$true;immediateLocalConfigReady=$true;p0LocalConfigReady=$true;digestLocalConfigReady=$true;actionLocalConfigReady=$true;cleanupLocalConfigReady=$true}}}`,
    `$probe=[pscustomobject]@{state='${runtimeState.replaceAll("'", "''")}'; cdpReady=$true; authenticated=$${authenticated ? 'true' : 'false'}; watcherReady=$${watcherReady ? 'true' : 'false'}}`,
    `[pscustomobject]@{state=(Get-KakaoLiveRuntimeState -Probe $probe); healthy=(Test-KakaoLiveHealth -Health $bridge -RuntimeProbe $probe)} | ConvertTo-Json -Compress`
  ].join('; ');
  try {
    return JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command], {
      encoding: 'utf8',
      windowsHide: true
    }));
  } catch {
    return { missingRuntimeProbeContract: true };
  }
}

function runtimeContract(mode) {
  const escapedPath = modulePath.replaceAll("'", "''");
  const modeAssignment = mode === undefined
    ? `[Environment]::SetEnvironmentVariable('WORK_ORCHESTRATOR_V2_RUNTIME_MODE',$null,'Process')`
    : `$env:WORK_ORCHESTRATOR_V2_RUNTIME_MODE='${String(mode).replaceAll("'", "''")}'`;
  const command = [
    `$ErrorActionPreference='Stop'`,
    `Import-Module '${escapedPath}' -Force`,
    modeAssignment,
    `$contract=Get-KakaoLiveRuntimeContract`,
    `$contract|ConvertTo-Json -Compress`
  ].join('; ');
  return JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command], {
    encoding: 'utf8', windowsHide: true
  }));
}

test('Kakao live recovery action preserves authentication pages and repairs only the failed layer', () => {
  const cases = {
    healthy: 'none',
    cdp_unavailable: 'restart_owned_chrome_only',
    login_required: 'recover_login',
    watcher_repair_required: 'repair_watcher_only',
    credential_recovery_running: 'preserve_and_wait',
    vault_unlock_required: 'preserve_and_wait',
    second_factor_required: 'preserve_and_wait',
    degraded: 'preserve_and_wait',
    unknown_state: 'preserve_and_wait'
  };
  for (const [runtimeState, expected] of Object.entries(cases)) {
    assert.equal(recoveryAction(runtimeState), expected, runtimeState);
  }
  assert.equal(recoveryAction('healthy', false), 'restart_full_runtime');
  assert.equal(recoveryAction('healthy', true, false), 'repair_watcher_only');
});

test('bridge health is combined with the direct CDP authentication and watcher probe', () => {
  assert.deepEqual(combinedLiveHealth('healthy'), { state: 'healthy', healthy: true });
  assert.deepEqual(combinedLiveHealth('login_required', { authenticated: false, watcherReady: false }), {
    state: 'login_required',
    healthy: false
  });
  assert.deepEqual(combinedLiveHealth('watcher_repair_required', { watcherReady: false }), {
    state: 'watcher_repair_required',
    healthy: false
  });
});

test('v2 cutover health rejects every missing or false local/runtime proof', () => {
  const escapedPath = modulePath.replaceAll("'", "''");
  const command = [
    `$ErrorActionPreference='Stop'`,
    `Import-Module '${escapedPath}' -Force`,
    `$env:WORK_ORCHESTRATOR_V2_RUNTIME_MODE='v2'`,
    `$valid=[pscustomobject]@{ok=$true;workOrchestrator=[pscustomobject]@{ok=$true};config=[pscustomobject]@{workerLive=$true;workerDryRun=$false;windowsWritesEnabled=$true;autoSendEnabled=$true;slackCardDeliveryEnabled=$false;followUpRowsEnabled=$false;slackActionPollEnabled=$false;p0SlackEscalationEnabled=$false;slackBotTokenPresent=$true;supabaseRecoveryEnabled=$true;kakaoTabCleanupEnabled=$true;startupCatchupSupported=$true;aiDomSplitEnabled=$true;aiDecisionConcurrency=2;workOrchestrator=[pscustomobject]@{runtimeMode='v2';shadowWrites=$true;immediateEnabled=$true;workItemsEnabled=$true;digestEnabled=$true;cleanupEnabled=$true;p0ReadbackEnabled=$true;p0CutoverEnabled=$true;storeConfigured=$true;immediateLocalConfigReady=$true;p0LocalConfigReady=$true;digestLocalConfigReady=$true;actionLocalConfigReady=$true;cleanupLocalConfigReady=$true}}}`,
    `$results=[ordered]@{valid=(Test-KakaoLiveBridgeContract -Health $valid)}`,
    `foreach($name in @('slackBotTokenPresent')){$broken=$valid|ConvertTo-Json -Depth 8|ConvertFrom-Json;$broken.config.$name=$false;$results["false_$name"]=Test-KakaoLiveBridgeContract -Health $broken;$missing=$valid|ConvertTo-Json -Depth 8|ConvertFrom-Json;$missing.config.PSObject.Properties.Remove($name);$results["missing_$name"]=Test-KakaoLiveBridgeContract -Health $missing}`,
    `foreach($name in @('shadowWrites','immediateEnabled','workItemsEnabled','digestEnabled','cleanupEnabled','p0ReadbackEnabled','p0CutoverEnabled','storeConfigured','immediateLocalConfigReady','p0LocalConfigReady','digestLocalConfigReady','actionLocalConfigReady','cleanupLocalConfigReady')){$broken=$valid|ConvertTo-Json -Depth 8|ConvertFrom-Json;$broken.config.workOrchestrator.$name=$false;$results["false_$name"]=Test-KakaoLiveBridgeContract -Health $broken;$missing=$valid|ConvertTo-Json -Depth 8|ConvertFrom-Json;$missing.config.workOrchestrator.PSObject.Properties.Remove($name);$results["missing_$name"]=Test-KakaoLiveBridgeContract -Health $missing}`,
    `$invariant=$valid|ConvertTo-Json -Depth 8|ConvertFrom-Json;$invariant.workOrchestrator.ok=$false;$results['invariantHealth']=Test-KakaoLiveBridgeContract -Health $invariant`,
    `$missingInvariant=$valid|ConvertTo-Json -Depth 8|ConvertFrom-Json;$missingInvariant.workOrchestrator.PSObject.Properties.Remove('ok');$results['missingInvariantHealth']=Test-KakaoLiveBridgeContract -Health $missingInvariant`,
    `$results|ConvertTo-Json -Compress`
  ].join('; ');
  const observed = JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command], {
    encoding: 'utf8', windowsHide: true
  }));
  assert.equal(observed.valid, true);
  for (const [name, result] of Object.entries(observed)) {
    if (name !== 'valid') assert.equal(result, false, name);
  }
});

test('bridge health validates the selected legacy or v2 mode without silently switching contracts', () => {
  const escapedPath = modulePath.replaceAll("'", "''");
  const command = [
    `$ErrorActionPreference='Stop'`,
    `Import-Module '${escapedPath}' -Force`,
    `$base=[ordered]@{ok=$true;config=[pscustomobject]@{workerLive=$true;workerDryRun=$false;windowsWritesEnabled=$true;autoSendEnabled=$true;slackBotTokenPresent=$true;supabaseRecoveryEnabled=$true;kakaoTabCleanupEnabled=$true;startupCatchupSupported=$true;aiDomSplitEnabled=$true;aiDecisionConcurrency=2}}`,
    `$legacy=$base|ConvertTo-Json -Depth 8|ConvertFrom-Json;$legacy|Add-Member workOrchestrator ([pscustomobject]@{ok=$false});$legacy.config|Add-Member slackCardDeliveryEnabled $true;$legacy.config|Add-Member followUpRowsEnabled $true;$legacy.config|Add-Member slackActionPollEnabled $true;$legacy.config|Add-Member p0SlackEscalationEnabled $true;$legacy.config|Add-Member workOrchestrator ([pscustomobject]@{runtimeMode='legacy';shadowWrites=$false;immediateEnabled=$false;workItemsEnabled=$false;digestEnabled=$false;cleanupEnabled=$false;p0ReadbackEnabled=$false;p0CutoverEnabled=$false})`,
    `$v2=$base|ConvertTo-Json -Depth 8|ConvertFrom-Json;$v2|Add-Member workOrchestrator ([pscustomobject]@{ok=$true});$v2.config|Add-Member slackCardDeliveryEnabled $false;$v2.config|Add-Member followUpRowsEnabled $false;$v2.config|Add-Member slackActionPollEnabled $false;$v2.config|Add-Member p0SlackEscalationEnabled $false;$v2.config|Add-Member workOrchestrator ([pscustomobject]@{runtimeMode='v2';shadowWrites=$true;immediateEnabled=$true;workItemsEnabled=$true;digestEnabled=$true;cleanupEnabled=$true;p0ReadbackEnabled=$true;p0CutoverEnabled=$true;storeConfigured=$true;immediateLocalConfigReady=$true;p0LocalConfigReady=$true;digestLocalConfigReady=$true;actionLocalConfigReady=$true;cleanupLocalConfigReady=$true})`,
    `$env:WORK_ORCHESTRATOR_V2_RUNTIME_MODE='legacy';$legacyResult=Test-KakaoLiveBridgeContract -Health $legacy;$legacyRejectsV2=Test-KakaoLiveBridgeContract -Health $v2`,
    `$env:WORK_ORCHESTRATOR_V2_RUNTIME_MODE='v2';$v2Result=Test-KakaoLiveBridgeContract -Health $v2;$v2RejectsLegacy=Test-KakaoLiveBridgeContract -Health $legacy`,
    `[pscustomobject]@{legacy=$legacyResult;legacyRejectsV2=$legacyRejectsV2;v2=$v2Result;v2RejectsLegacy=$v2RejectsLegacy}|ConvertTo-Json -Compress`
  ].join('; ');
  const observed = JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command], {
    encoding: 'utf8', windowsHide: true
  }));
  assert.deepEqual(observed, { legacy: true, legacyRejectsV2: false, v2: true, v2RejectsLegacy: false });
});

test('new bridge source waits for a fully idle runtime before restart', () => {
  assert.equal(sourceRefreshAction({ busy: true }), 'preserve_and_wait');
  assert.equal(sourceRefreshAction({ busy: false }), 'restart_full_runtime');
  assert.equal(sourceRefreshAction({
    source: '2026-07-31T06:00:00Z',
    process: '2026-07-31T07:00:00Z',
    busy: false
  }), 'none');
});

test('a missing bridge preserves healthy Chrome and takes the bridge-only recovery path', () => {
  const startScript = readFileSync(startScriptPath, 'utf8');
  const bridgeRecovery = readFileSync(bridgeRecoveryPath, 'utf8');

  assert.match(startScript, /if \(\$null -eq \$health\)[\s\S]*Test-KakaoWatcherRuntime[\s\S]*recover-kakao-bridge-only\.ps1/);
  assert.match(startScript, /if \(\$watcherStillHealthy\)[\s\S]*recover-kakao-bridge-only\.ps1[\s\S]*else[\s\S]*stop-kakao-staging\.ps1/);
  assert.match(bridgeRecovery, /--probe-only/);
  assert.match(bridgeRecovery, /authenticated -ne \$true/);
  assert.match(bridgeRecovery, /watcherReady -ne \$true/);
  assert.match(bridgeRecovery, /Test-KakaoLiveBridgeContract/);
  assert.match(bridgeRecovery, /-WindowStyle Hidden/);
});

test('login runner stdin mode receives refs but no CLI path or secret values', () => {
  assert.deepEqual(loginRunnerArguments(), [
    'runner.mjs',
    '--port', '9223',
    '--credential-mode', 'onepassword',
    '--username-ref', 'op://vault/item/username',
    '--password-ref', 'op://vault/item/password',
    '--timeout-ms', '60000',
    '--otp-ref', 'op://vault/item/otp',
    '--secrets-stdin', '1'
  ]);
});

test('Chrome saved autofill mode does not receive 1Password refs, paths, or stdin', () => {
  assert.deepEqual(chromeAutofillRunnerArguments(), [
    'runner.mjs',
    '--port', '9223',
    '--credential-mode', 'chrome_saved_autofill',
    '--timeout-ms', '60000'
  ]);
});

test('PowerShell builds the bounded stdin secret payload from exact refs', () => {
  assert.deepEqual(loginStdinPayload(), {
    username: 'fake-user',
    password: 'fake-password',
    otp: '123456'
  });
});

test('v2 cutover guard rejects an invalid contract before stamping the Process environment', () => {
  const escapedPath = modulePath.replaceAll("'", "''");
  const command = [
    `$ErrorActionPreference='Stop'`,
    `Import-Module '${escapedPath}' -Force`,
    `$env:AI_WORKER_LIVE='before-guard'`,
    `$invalid=Get-KakaoLiveRuntimeContract -RuntimeMode 'v2';$invalid['WORK_ORCHESTRATOR_V2_IMMEDIATE_ENABLED']='0'`,
    `$reason=''; try { Set-KakaoLiveRuntimeEnvironment -Contract $invalid } catch { $reason=$_.Exception.Message }`,
    `[pscustomobject]@{reason=$reason;workerLive=$env:AI_WORKER_LIVE} | ConvertTo-Json -Compress`
  ].join('; ');
  const result = execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command], {
    encoding: 'utf8', windowsHide: true
  });
  const observed = JSON.parse(result);
  assert.match(observed.reason, /legacy cards.*immediate/i);
  assert.equal(observed.workerLive, 'before-guard');
});

test('persistent runtime mode selects exact legacy rollback and v2 cutover contracts', () => {
  assert.deepEqual(runtimeContract(), {
    AI_WORKER_LIVE: '1',
    AI_WORKER_AUTO_SEND: '1',
    AI_WORKER_DRY_RUN: '0',
    SLACK_ACTION_POLL_ENABLED: '1',
    SLACK_AGENT_CARD_DELIVERY_ENABLED: '1',
    AI_WORKER_FOLLOW_UP_ITEMS_ENABLED: '1',
    KAKAO_FOLLOW_UP_ITEMS_ENABLED: '1',
    P0_SLACK_ESCALATION_ENABLED: '1',
    WORK_ORCHESTRATOR_V2_RUNTIME_MODE: 'legacy',
    WORK_ORCHESTRATOR_V2_SHADOW_WRITES: '0',
    WORK_ORCHESTRATOR_V2_IMMEDIATE_ENABLED: '0',
    WORK_ORCHESTRATOR_V2_WORK_ITEMS_ENABLED: '0',
    WORK_ORCHESTRATOR_V2_DIGEST_ENABLED: '0',
    WORK_ORCHESTRATOR_V2_CLEANUP_ENABLED: '0',
    WORK_ORCHESTRATOR_V2_P0_READBACK_ENABLED: '0',
    WORK_ORCHESTRATOR_V2_P0_CUTOVER_ENABLED: '0',
    VILLAGE_WINDOWS_WRITES_ENABLED: '1',
    SUPABASE_RECOVERY_ENABLED: '1',
    KAKAO_TAB_CLEANUP_ENABLED: '1',
    HERMES_WORKER_COMMAND_MODE: 'python_module',
    HERMES_HOME: `${process.env.LOCALAPPDATA}\\hermes`,
    DEBOUNCE_MS: '15000',
    MAX_WAIT_MS: '45000',
    WORKER_SLOW_ALERT_MS: '30000',
    WORKER_TIMEOUT_MS: '300000',
    WORKER_CATCHUP_TIMEOUT_MS: '300000',
    HERMES_WORKER_TIMEOUT_MS: '240000',
    HERMES_WORKER_MAX_TURNS: '90',
    HERMES_WORKER_SKILLS: 'village-operations,village-confirm-request',
    KAKAO_AI_DOM_SPLIT_ENABLED: '1',
    KAKAO_AI_DECISION_CONCURRENCY: '2'
  });

  const v2 = runtimeContract('v2');
  assert.equal(v2.WORK_ORCHESTRATOR_V2_RUNTIME_MODE, 'v2');
  assert.equal(v2.SLACK_ACTION_POLL_ENABLED, '0');
  assert.equal(v2.SLACK_AGENT_CARD_DELIVERY_ENABLED, '0');
  assert.equal(v2.AI_WORKER_FOLLOW_UP_ITEMS_ENABLED, '0');
  assert.equal(v2.KAKAO_FOLLOW_UP_ITEMS_ENABLED, '0');
  assert.equal(v2.P0_SLACK_ESCALATION_ENABLED, '0');
  for (const key of [
    'WORK_ORCHESTRATOR_V2_SHADOW_WRITES',
    'WORK_ORCHESTRATOR_V2_IMMEDIATE_ENABLED',
    'WORK_ORCHESTRATOR_V2_WORK_ITEMS_ENABLED',
    'WORK_ORCHESTRATOR_V2_DIGEST_ENABLED',
    'WORK_ORCHESTRATOR_V2_CLEANUP_ENABLED',
    'WORK_ORCHESTRATOR_V2_P0_READBACK_ENABLED',
    'WORK_ORCHESTRATOR_V2_P0_CUTOVER_ENABLED'
  ]) assert.equal(v2[key], '1', key);

  assert.throws(() => runtimeContract('shadow'), /runtime mode.*legacy.*v2/i);
});

test('natural startup, watchdog, and bridge recovery reload the persistent mode before stamping or starting', () => {
  const start = readFileSync(startScriptPath, 'utf8');
  const watchdog = readFileSync(watchdogPath, 'utf8');
  const restart = readFileSync(restartBridgePath, 'utf8');
  const recoverBridge = readFileSync(bridgeRecoveryPath, 'utf8');

  assert.match(start, /Import-DotEnvFile[\s\S]*Set-KakaoLiveRuntimeEnvironment[\s\S]*Get-KakaoLiveStartupPlan/);
  assert.match(watchdog, /Import-DotEnvFile[\s\S]*Set-KakaoLiveRuntimeEnvironment[\s\S]*& \$startScriptPath/);
  assert.match(restart, /Import-DotEnvFile[\s\S]*Set-KakaoLiveRuntimeEnvironment/);
  assert.match(recoverBridge, /Import-DotEnvFile[\s\S]*Set-KakaoLiveRuntimeEnvironment/);
});

test('v2 cutover environment stamp validates exact contract shape and rolls back partial writes', () => {
  const escapedPath = modulePath.replaceAll("'", "''");
  const command = [
    `$ErrorActionPreference='Stop'`,
    `Import-Module '${escapedPath}' -Force`,
    `$base=Get-KakaoLiveRuntimeContract -RuntimeMode 'v2'`,
    `$missing=[ordered]@{};foreach($entry in $base.GetEnumerator()){if($entry.Key -ne 'WORK_ORCHESTRATOR_V2_CLEANUP_ENABLED'){$missing[$entry.Key]=$entry.Value}}`,
    `$extra=[ordered]@{};foreach($entry in $base.GetEnumerator()){$extra[$entry.Key]=$entry.Value};$extra['UNAPPROVED_RUNTIME_FLAG']='1'`,
    `$missingReason='';try{Set-KakaoLiveRuntimeEnvironment -Contract $missing}catch{$missingReason=$_.Exception.Message}`,
    `$extraReason='';try{Set-KakaoLiveRuntimeEnvironment -Contract $extra}catch{$extraReason=$_.Exception.Message}`,
    `$booleanResults=[ordered]@{}`,
    `foreach($case in @(@{name='cardsFalseImmediateFalse';values=@{SLACK_AGENT_CARD_DELIVERY_ENABLED='false';WORK_ORCHESTRATOR_V2_IMMEDIATE_ENABLED='false';WORK_ORCHESTRATOR_V2_CLEANUP_ENABLED='false'}},@{name='mixedWork';values=@{AI_WORKER_FOLLOW_UP_ITEMS_ENABLED='false';KAKAO_FOLLOW_UP_ITEMS_ENABLED='true';WORK_ORCHESTRATOR_V2_WORK_ITEMS_ENABLED='false'}},@{name='p0False';values=@{P0_SLACK_ESCALATION_ENABLED='false';WORK_ORCHESTRATOR_V2_P0_READBACK_ENABLED='false';WORK_ORCHESTRATOR_V2_P0_CUTOVER_ENABLED='false'}},@{name='unknown';values=@{SLACK_AGENT_CARD_DELIVERY_ENABLED='unexpected'}})){$candidate=[ordered]@{};foreach($entry in $base.GetEnumerator()){$candidate[$entry.Key]=$entry.Value};foreach($entry in $case.values.GetEnumerator()){$candidate[$entry.Key]=$entry.Value};try{Assert-KakaoLiveV2CutoverContract -Contract $candidate;$booleanResults[$case.name]='accepted'}catch{$booleanResults[$case.name]=$_.Exception.Message}}`,
    `$normalized=[ordered]@{};foreach($entry in $base.GetEnumerator()){$normalized[$entry.Key]=$entry.Value};$normalized['SLACK_AGENT_CARD_DELIVERY_ENABLED']=' FALSE ';$normalized['WORK_ORCHESTRATOR_V2_IMMEDIATE_ENABLED']=' TRUE ';$normalized['AI_WORKER_FOLLOW_UP_ITEMS_ENABLED']=' FALSE ';$normalized['KAKAO_FOLLOW_UP_ITEMS_ENABLED']=' FALSE ';$normalized['WORK_ORCHESTRATOR_V2_WORK_ITEMS_ENABLED']=' TRUE ';$normalized['P0_SLACK_ESCALATION_ENABLED']=' FALSE ';$normalized['WORK_ORCHESTRATOR_V2_P0_READBACK_ENABLED']=' TRUE ';$normalized['WORK_ORCHESTRATOR_V2_P0_CUTOVER_ENABLED']=' TRUE ';$normalized['WORK_ORCHESTRATOR_V2_CLEANUP_ENABLED']=' TRUE ';$normalizedResult='';try{Assert-KakaoLiveV2CutoverContract -Contract $normalized;$normalizedResult='accepted'}catch{$normalizedResult=$_.Exception.Message}`,
    `$env:AI_WORKER_LIVE='before-marker';$env:WORKER_TIMEOUT_MS='before-timeout'`,
    `$setter={param($name,$value)if($name -eq 'WORKER_TIMEOUT_MS'){throw 'injected set failure'};[Environment]::SetEnvironmentVariable($name,$value,'Process')}`,
    `$failureReason='';try{Set-KakaoLiveRuntimeEnvironment -Contract $base -SetEnvironmentVariable $setter}catch{$failureReason=$_.Exception.Message};$rollbackMarker=$env:AI_WORKER_LIVE;$rollbackTimeout=$env:WORKER_TIMEOUT_MS`,
    `Set-KakaoLiveRuntimeEnvironment -Contract $base;$actual=[ordered]@{};foreach($entry in $base.GetEnumerator()){$actual[$entry.Key]=[Environment]::GetEnvironmentVariable($entry.Key,'Process')}`,
    `[pscustomobject]@{missingReason=$missingReason;extraReason=$extraReason;booleanResults=$booleanResults;normalizedResult=$normalizedResult;failureReason=$failureReason;marker=$rollbackMarker;timeout=$rollbackTimeout;stamped=($actual|ConvertTo-Json -Compress);expected=($base|ConvertTo-Json -Compress)}|ConvertTo-Json -Compress`
  ].join('; ');
  const observed = JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command], {
    encoding: 'utf8', windowsHide: true
  }));
  assert.match(observed.missingReason, /missing.*cleanup/i);
  assert.match(observed.extraReason, /not allowed/i);
  assert.match(observed.booleanResults.cardsFalseImmediateFalse, /legacy cards.*immediate/i);
  assert.match(observed.booleanResults.mixedWork, /legacy work rows.*work items/i);
  assert.match(observed.booleanResults.p0False, /legacy P0.*work items.*readback.*cutover/i);
  assert.match(observed.booleanResults.unknown, /invalid boolean/i);
  assert.equal(observed.normalizedResult, 'accepted');
  assert.match(observed.failureReason, /injected set failure/i);
  assert.equal(observed.marker, 'before-marker');
  assert.equal(observed.timeout, 'before-timeout');
  assert.deepEqual(JSON.parse(observed.stamped), JSON.parse(observed.expected));
});
