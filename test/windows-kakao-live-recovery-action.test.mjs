import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const modulePath = fileURLToPath(new URL('../scripts/windows/KakaoLive.Common.psm1', import.meta.url));
const startScriptPath = fileURLToPath(new URL('../scripts/windows/start-kakao-live.ps1', import.meta.url));
const bridgeRecoveryPath = fileURLToPath(new URL('../scripts/windows/recover-kakao-bridge-only.ps1', import.meta.url));

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
    `$bridge=[pscustomobject]@{ok=$true; config=[pscustomobject]@{workerLive=$true; workerDryRun=$false; windowsWritesEnabled=$true; autoSendEnabled=$true; slackCardDeliveryEnabled=$true; slackActionPollEnabled=$true; supabaseRecoveryEnabled=$true; kakaoTabCleanupEnabled=$true; startupCatchupSupported=$true; aiDomSplitEnabled=$true; aiDecisionConcurrency=2}}`,
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

function gatewayCutoverHealth({ failed = 0, fresh = true, receiptVerified = true } = {}) {
  const escapedPath = modulePath.replaceAll("'", "''");
  const command = [
    `$ErrorActionPreference='Stop'`,
    `Import-Module '${escapedPath}' -Force`,
    `$health=[pscustomobject]@{ok=$true; config=[pscustomobject]@{hermesTransport='gateway'; scheduleOwnerReviewRequired=$true; killSwitchPolicyEnforced=$true}; gateway=[pscustomobject]@{gatewayReady=$true; consumer=[pscustomobject]@{fresh=$${fresh ? 'true' : 'false'}}; queue=[pscustomobject]@{ready=0; claimed=0; retry=0; failed=${failed}}; unnotified_application_failures=0}}`,
    `$probe=[pscustomobject]@{state='healthy'; cdpReady=$true; authenticated=$true; watcherReady=$true}`,
    `$runtime=[pscustomobject]@{profile='kakaoworker'; pid=123; pluginPath='C:\\fixture\\kakao_village'; manifestSha256=('a' * 64); pluginReceiptVerified=$${receiptVerified ? 'true' : 'false'}}`,
    `$smoke=[pscustomobject]@{nativeSessionResult='pass'; scheduleOwnerReviewRequired=$true; sendCount=0; writeCount=0; killSwitchObserved='active'}`,
    `Test-KakaoGatewayCutoverHealth -Health $health -RuntimeProbe $probe -GatewayRuntime $runtime -SmokeEvidence $smoke`
  ].join('; ');
  return execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command], {
    encoding: 'utf8',
    windowsHide: true
  }).trim() === 'True';
}

function gatewayWatchdogHealth({
  ready = 0,
  claimed = 0,
  retry = 0,
  failed = 0,
  unnotified = 0,
  fresh = true,
  receiptVerified = true
} = {}) {
  const escapedPath = modulePath.replaceAll("'", "''");
  const command = [
    `$ErrorActionPreference='Stop'`,
    `Import-Module '${escapedPath}' -Force`,
    `$health=[pscustomobject]@{ok=$true; config=[pscustomobject]@{hermesTransport='gateway'; scheduleOwnerReviewRequired=$true; killSwitchPolicyEnforced=$true}; gateway=[pscustomobject]@{gatewayReady=$true; consumer=[pscustomobject]@{fresh=$${fresh ? 'true' : 'false'}}; queue=[pscustomobject]@{ready=${ready}; claimed=${claimed}; retry=${retry}; failed=${failed}}; unnotified_application_failures=${unnotified}}}`,
    `$probe=[pscustomobject]@{state='healthy'; cdpReady=$true; authenticated=$true; watcherReady=$true}`,
    `$runtime=[pscustomobject]@{profile='kakaoworker'; pid=123; pluginPath='C:\\fixture\\kakao_village'; manifestSha256=('a' * 64); pluginReceiptVerified=$${receiptVerified ? 'true' : 'false'}}`,
    `$smoke=[pscustomobject]@{nativeSessionResult='pass'; scheduleOwnerReviewRequired=$true; sendCount=0; writeCount=0; killSwitchObserved='active'}`,
    `Test-KakaoGatewayWatchdogHealth -Health $health -RuntimeProbe $probe -GatewayRuntime $runtime -SmokeEvidence $smoke`
  ].join('; ');
  try {
    return execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command], {
      encoding: 'utf8',
      windowsHide: true
    }).trim() === 'True';
  } catch {
    return false;
  }
}

function verifyPluginReceipt({ tamper = false } = {}) {
  const temp = mkdtempSync(path.join(tmpdir(), 'kakao-plugin-receipt-'));
  try {
    const target = path.join(temp, 'hermes', 'profiles', 'kakaoworker', 'plugins', 'kakao_village');
    mkdirSync(target, { recursive: true });
    const body = Buffer.from('reviewed plugin fixture\n', 'utf8');
    const filePath = path.join(target, '__init__.py');
    writeFileSync(filePath, body);
    const fileSha = createHash('sha256').update(body).digest('hex').toUpperCase();
    const canonical = `__init__.py|${body.length}|${fileSha}`;
    const manifestSha = createHash('sha256').update(canonical, 'utf8').digest('hex').toUpperCase();
    const receipt = {
      schema: 'village-kakao-plugin-install/v1',
      pluginName: 'kakao_village',
      targetPluginPath: target,
      manifestSha256: manifestSha,
      fileManifest: [{ relativePath: '__init__.py', bytes: body.length, sha256: fileSha }]
    };
    if (tamper) writeFileSync(filePath, 'tampered\n');
    const escapedModule = modulePath.replaceAll("'", "''");
    const escapedRoot = temp.replaceAll("'", "''");
    const encodedReceipt = Buffer.from(JSON.stringify(receipt), 'utf8').toString('base64');
    const command = [
      `$ErrorActionPreference='Stop'`,
      `$env:LOCALAPPDATA='${escapedRoot}'`,
      `Import-Module '${escapedModule}' -Force`,
      `$receipt=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedReceipt}')) | ConvertFrom-Json`,
      `Test-KakaoPluginInstallReceipt -Receipt $receipt`
    ].join('; ');
    return execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command], {
      encoding: 'utf8',
      windowsHide: true
    }).trim() === 'True';
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
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

test('Gateway cutover health fails closed on queue, consumer, or plugin receipt drift', () => {
  assert.equal(gatewayCutoverHealth(), true);
  assert.equal(gatewayCutoverHealth({ failed: 1 }), false);
  assert.equal(gatewayCutoverHealth({ fresh: false }), false);
  assert.equal(gatewayCutoverHealth({ receiptVerified: false }), false);
});

test('Gateway watchdog ignores terminal history but still requires an idle safe live path', () => {
  assert.equal(gatewayWatchdogHealth(), true);
  assert.equal(gatewayWatchdogHealth({ failed: 3, unnotified: 1 }), true);
  assert.equal(gatewayWatchdogHealth({ ready: 1 }), false);
  assert.equal(gatewayWatchdogHealth({ claimed: 1 }), false);
  assert.equal(gatewayWatchdogHealth({ retry: 1 }), false);
  assert.equal(gatewayWatchdogHealth({ fresh: false }), false);
  assert.equal(gatewayWatchdogHealth({ receiptVerified: false }), false);
});

test('plugin receipt verification hashes the exact installed profile files', () => {
  assert.equal(verifyPluginReceipt(), true);
  assert.equal(verifyPluginReceipt({ tamper: true }), false);
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
