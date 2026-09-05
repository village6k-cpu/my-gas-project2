[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'Medium')]
param(
    [Parameter(Mandatory = $true)] [string]$EnvFile,
    [Parameter(Mandatory = $true)] [string]$ChromePath,
    [Parameter(Mandatory = $true)] [string]$NodePath,
    [Parameter(Mandatory = $true)] [string]$HermesPythonPath,
    [string]$BenchmarkReportPath = '',
    [string]$PluginReceiptPath = '',
    [string]$SmokeEvidencePath = '',
    [switch]$ConfirmKakaoGatewayCutover,
    [switch]$GatewayMaintenance,
    [switch]$RollbackToCli,
    [switch]$PlanOnly
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'KakaoStaging.Common.psm1') -Force
Import-Module (Join-Path $PSScriptRoot 'KakaoLive.Common.psm1') -Force

$resolvedEnvFile = (Resolve-Path -LiteralPath $EnvFile -ErrorAction Stop).Path
$resolvedChromePath = (Resolve-Path -LiteralPath $ChromePath -ErrorAction Stop).Path
$resolvedNodePath = (Resolve-Path -LiteralPath $NodePath -ErrorAction Stop).Path
$resolvedHermesPythonPath = (Resolve-Path -LiteralPath $HermesPythonPath -ErrorAction Stop).Path
$watcherInjector = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..\tools\kakao-dom-bridge\inject-watcher-cdp.py') -ErrorAction Stop).Path
$loginRunner = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot 'kakao-login-recover.mjs') -ErrorAction Stop).Path
Import-DotEnvFile -Path $resolvedEnvFile
$gatewayCutoverRequested = ($ConfirmKakaoGatewayCutover.IsPresent -and -not $GatewayMaintenance.IsPresent) -or $RollbackToCli.IsPresent
$liveHermesTransport = if ($GatewayMaintenance.IsPresent) { 'gateway' } else { 'cli' }
Set-KakaoLiveRuntimeEnvironment -HermesTransport $liveHermesTransport
$plan = if ($gatewayCutoverRequested) {
    Get-KakaoGatewayCutoverPlan -BenchmarkReportPath $BenchmarkReportPath -RollbackToCli:$RollbackToCli.IsPresent
}
else { Get-KakaoLiveStartupPlan }

if ($PlanOnly.IsPresent) {
    $plan | ConvertTo-Json -Depth 8
    return
}

if ($GatewayMaintenance.IsPresent -and -not $ConfirmKakaoGatewayCutover.IsPresent) {
    throw 'GatewayMaintenance requires -ConfirmKakaoGatewayCutover and its recorded benchmark evidence.'
}

if ($RollbackToCli.IsPresent) {
    if (-not $ConfirmKakaoGatewayCutover.IsPresent) {
        throw 'RollbackToCli requires -ConfirmKakaoGatewayCutover because it changes the bridge transport and kakaoworker task.'
    }
}

$BenchmarkReport = $null
$pluginReceipt = $null
$smokeEvidence = $null
$pluginReceiptVerified = $false
if ($ConfirmKakaoGatewayCutover.IsPresent -and -not $RollbackToCli.IsPresent) {
    if ([string]::IsNullOrWhiteSpace($BenchmarkReportPath)) {
        throw 'Gateway cutover requires -BenchmarkReportPath.'
    }
    $resolvedBenchmarkReportPath = (Resolve-Path -LiteralPath $BenchmarkReportPath -ErrorAction Stop).Path
    $BenchmarkReport = [IO.File]::ReadAllText($resolvedBenchmarkReportPath, [Text.Encoding]::UTF8) | ConvertFrom-Json -ErrorAction Stop
    if ($BenchmarkReport.schema -ne 'village-kakao-hermes-benchmark-report/v1' -or
        $BenchmarkReport.accepted -ne $true -or $BenchmarkReport.latency_status -ne 'pass') {
        throw 'Gateway cutover benchmark is not accepted with latency_status=pass.'
    }
    if ([string]::IsNullOrWhiteSpace($PluginReceiptPath)) {
        $PluginReceiptPath = Join-Path $env:LOCALAPPDATA 'hermes\profiles\kakaoworker\plugin-state\kakao_village.json'
    }
    if ([string]::IsNullOrWhiteSpace($SmokeEvidencePath)) {
        throw 'Gateway cutover requires -SmokeEvidencePath.'
    }
    $resolvedPluginReceiptPath = (Resolve-Path -LiteralPath $PluginReceiptPath -ErrorAction Stop).Path
    $resolvedSmokeEvidencePath = (Resolve-Path -LiteralPath $SmokeEvidencePath -ErrorAction Stop).Path
    $pluginReceipt = [IO.File]::ReadAllText($resolvedPluginReceiptPath, [Text.Encoding]::UTF8) | ConvertFrom-Json -ErrorAction Stop
    $smokeEvidence = [IO.File]::ReadAllText($resolvedSmokeEvidencePath, [Text.Encoding]::UTF8) | ConvertFrom-Json -ErrorAction Stop
    $pluginReceiptVerified = Test-KakaoPluginInstallReceipt -Receipt $pluginReceipt
    if (-not $pluginReceiptVerified) {
        throw 'Gateway cutover installed plugin files do not match the reviewed receipt.'
    }
    if ($smokeEvidence.nativeSessionResult -ne 'pass' -or $smokeEvidence.scheduleOwnerReviewRequired -ne $true -or
        $smokeEvidence.sendCount -ne 0 -or $smokeEvidence.writeCount -ne 0 -or
        [string]$smokeEvidence.killSwitchObserved -notin @('active', 'price_paused')) {
        throw 'Gateway cutover native session smoke evidence is incomplete or unsafe.'
    }
    $modelContractPath = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot 'hermes-model-contract.json') -ErrorAction Stop).Path
    $modelContract = [IO.File]::ReadAllText($modelContractPath, [Text.Encoding]::UTF8) | ConvertFrom-Json -ErrorAction Stop
    if ($modelContract.kakaoworker.provider -ne 'xai-oauth' -or $modelContract.kakaoworker.model -ne 'grok-4.5' -or
        $modelContract.kakaoworker.reasoning_effort -ne 'xhigh' -or [int]$modelContract.kakaoworker.max_turns -ne 90) {
        throw 'Gateway cutover model contract drifted.'
    }
}

function Get-KakaoWatcherRuntime {
    $probeOutput = & $resolvedHermesPythonPath $watcherInjector --port 9223 --wait 3 --probe-only 2>$null
    try {
        return (($probeOutput -join [Environment]::NewLine) | ConvertFrom-Json -ErrorAction Stop)
    }
    catch {
        return [pscustomobject]@{
            ok = $false
            state = 'cdp_unavailable'
            cdpReady = $false
            authenticated = $false
            watcherReady = $false
        }
    }
}

function Test-KakaoWatcherRuntime {
    param([AllowNull()][psobject]$Probe = $null)
    if ($null -eq $Probe) { $Probe = Get-KakaoWatcherRuntime }
    return (Test-KakaoLiveRuntimeProbe -Probe $Probe)
}

function Repair-KakaoWatcherRuntime {
    param([switch]$Force)

    if (-not $Force.IsPresent -and (Test-KakaoWatcherRuntime)) { return $false }
    & $resolvedHermesPythonPath $watcherInjector --port 9223 --wait 8 *> $null
    $repairedProbe = Get-KakaoWatcherRuntime
    if ($LASTEXITCODE -ne 0 -or -not (Test-KakaoWatcherRuntime -Probe $repairedProbe)) {
        throw 'Kakao watcher injection did not satisfy the live observer contract.'
    }
    return $true
}

function Wait-KakaoLiveHealth {
    param([int]$Seconds = 15)
    $deadline = [DateTime]::UtcNow.AddSeconds($Seconds)
    $verified = [pscustomobject]@{ bridge = $null; runtime = $null }
    do {
        Start-Sleep -Milliseconds 250
        try { $verified.bridge = Invoke-RestMethod -Uri 'http://127.0.0.1:8787/health' -TimeoutSec 5 }
        catch { $verified.bridge = $null }
        $verified.runtime = Get-KakaoWatcherRuntime
        if ($null -ne $verified.bridge -and (Test-KakaoLiveHealth -Health $verified.bridge -RuntimeProbe $verified.runtime)) {
            return $verified
        }
    } while ([DateTime]::UtcNow -lt $deadline)
    return $verified
}

function Get-KakaoworkerGatewayRuntime {
    $pidPath = Join-Path $env:LOCALAPPDATA 'hermes\profiles\kakaoworker\gateway.pid'
    $gatewayPid = 0
    if (Test-Path -LiteralPath $pidPath -PathType Leaf) {
        try { $gatewayPid = [int](([IO.File]::ReadAllText($pidPath, [Text.Encoding]::UTF8) | ConvertFrom-Json).pid) }
        catch { $gatewayPid = 0 }
    }
    return [pscustomobject]@{
        profile = 'kakaoworker'
        pid = $gatewayPid
        pluginPath = if ($null -ne $pluginReceipt) { [string]$pluginReceipt.targetPluginPath } else { '' }
        manifestSha256 = if ($null -ne $pluginReceipt) { [string]$pluginReceipt.manifestSha256 } else { '' }
        pluginReceiptVerified = $null -ne $pluginReceipt -and (Test-KakaoPluginInstallReceipt -Receipt $pluginReceipt)
    }
}

function Test-KakaoworkerGatewayTaskDefinition {
    $task = Get-ScheduledTask -TaskName 'Hermes_Gateway_Kakaoworker_Native' -ErrorAction SilentlyContinue
    $actions = @(if ($null -ne $task) { $task.Actions } else { @() })
    if ($actions.Count -ne 1) { return $false }
    $expectedPowerShell = [IO.Path]::GetFullPath('C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe')
    $launcher = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot 'start-hermes-kakaoworker-gateway.ps1') -ErrorAction Stop).Path
    $actualExecutable = [IO.Path]::GetFullPath([string]$actions[0].Execute)
    $arguments = [string]$actions[0].Arguments
    return [string]::Equals($actualExecutable, $expectedPowerShell, [StringComparison]::OrdinalIgnoreCase) -and
        $arguments.IndexOf($launcher, [StringComparison]::OrdinalIgnoreCase) -ge 0 -and
        $arguments.IndexOf($resolvedHermesPythonPath, [StringComparison]::OrdinalIgnoreCase) -ge 0 -and
        $arguments.IndexOf($resolvedEnvFile, [StringComparison]::OrdinalIgnoreCase) -ge 0 -and
        $arguments -notmatch '(?i)(?:--profile|Target)\s+root'
}

function Start-KakaoworkerGatewayRuntime {
    $taskName = 'Hermes_Gateway_Kakaoworker_Native'
    if (-not (Test-KakaoworkerGatewayTaskDefinition)) {
        throw 'Hermes_Gateway_Kakaoworker_Native task is missing or does not match the reviewed launcher.'
    }
    Enable-ScheduledTask -TaskName $taskName | Out-Null
    $gatewayRestart = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot 'restart-hermes-gateway.ps1')).Path
    & $gatewayRestart -Target kakaoworker -HealOnly | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'kakaoworker Gateway maintenance start failed.' }
}

function Invoke-KakaoGatewayRollback {
    $taskName = 'Hermes_Gateway_Kakaoworker_Native'
    $task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    if ($null -ne $task) {
        Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
        Disable-ScheduledTask -TaskName $taskName | Out-Null
    }
    & $resolvedHermesPythonPath '-m' 'hermes_cli.main' '--profile' 'kakaoworker' 'gateway' 'stop' *> $null
    $restartScript = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot 'Restart-KakaoBridgeLive.ps1')).Path
    & $restartScript -EnvFile $resolvedEnvFile -HermesPythonPath $resolvedHermesPythonPath `
        -HermesTransport 'cli' -Confirm:$false | Out-Null
    return [pscustomobject]@{
        state = 'rolled_back_to_cli'
        transport = 'cli'
        stoppedTask = $taskName
        leaveRootSlackGatewayUntouched = $true
        leaveHealthyChromeUntouched = $true
    }
}

if ($RollbackToCli.IsPresent) {
    if (-not $PSCmdlet.ShouldProcess('owned Kakao bridge and kakaoworker Gateway', 'Rollback transport to CLI')) { return }
    Invoke-KakaoGatewayRollback | ConvertTo-Json -Compress
    return
}

if ($ConfirmKakaoGatewayCutover.IsPresent -and -not $GatewayMaintenance.IsPresent) {
    if (-not (Test-KakaoworkerGatewayTaskDefinition)) {
        throw 'Gateway cutover requires the reviewed Hermes_Gateway_Kakaoworker_Native task definition.'
    }
    $preHealth = Invoke-RestMethod -Uri 'http://127.0.0.1:8787/health' -TimeoutSec 5
    $preProbe = Get-KakaoWatcherRuntime
    $queue = if ($preHealth.PSObject.Properties.Name -contains 'gateway' -and $null -ne $preHealth.gateway) {
        $preHealth.gateway.queue
    }
    else { $null }
    $bridgeIdle = -not [bool]$preHealth.state.workerRunning -and [int]$preHealth.state.workerQueueLength -eq 0 -and
        [int]$preHealth.state.openRooms -eq 0 -and
        ($null -eq $queue -or ([int]$queue.ready -eq 0 -and [int]$queue.claimed -eq 0 -and [int]$queue.retry -eq 0))
    if (-not $bridgeIdle) { throw 'Gateway cutover requires an idle bridge queue.' }
    if (-not (Test-KakaoLiveRuntimeProbe -Probe $preProbe)) { throw 'Gateway cutover requires authenticated=true and watcherReady=true.' }
    if (-not $PSCmdlet.ShouldProcess('owned Kakao bridge and kakaoworker Gateway', 'Cut over transport to native Gateway')) { return }

    $restartScript = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot 'Restart-KakaoBridgeLive.ps1')).Path
    & $restartScript -EnvFile $resolvedEnvFile -HermesPythonPath $resolvedHermesPythonPath `
        -HermesTransport 'gateway' -Confirm:$false | Out-Null
    $gatewayTaskName = 'Hermes_Gateway_Kakaoworker_Native'
    if ($null -eq (Get-ScheduledTask -TaskName $gatewayTaskName -ErrorAction SilentlyContinue)) {
        Invoke-KakaoGatewayRollback | Out-Null
        throw 'Hermes_Gateway_Kakaoworker_Native task is not registered.'
    }
    Enable-ScheduledTask -TaskName $gatewayTaskName | Out-Null
    Start-ScheduledTask -TaskName $gatewayTaskName

    $deadline = [DateTime]::UtcNow.AddSeconds(45)
    $postHealth = $null
    do {
        Start-Sleep -Milliseconds 500
        try { $postHealth = Invoke-RestMethod -Uri 'http://127.0.0.1:8787/health' -TimeoutSec 3 }
        catch { $postHealth = $null }
    } while (($null -eq $postHealth -or $postHealth.gateway.gatewayReady -ne $true) -and [DateTime]::UtcNow -lt $deadline)
    $gatewayRuntime = Get-KakaoworkerGatewayRuntime
    $gatewayPid = [int]$gatewayRuntime.pid
    $postProbe = Get-KakaoWatcherRuntime
    if ($null -eq $postHealth -or -not (Test-KakaoGatewayCutoverHealth -Health $postHealth -RuntimeProbe $postProbe `
        -GatewayRuntime $gatewayRuntime -SmokeEvidence $smokeEvidence)) {
        Invoke-KakaoGatewayRollback | Out-Null
        throw 'Gateway cutover direct readback failed; rolled back to CLI.'
    }
    [pscustomobject]@{
        state = 'cutover_complete'
        transport = [string]$postHealth.config.hermesTransport
        gatewayPid = $gatewayPid
        profile = 'kakaoworker'
        pluginPath = [string]$pluginReceipt.targetPluginPath
        manifestSha256 = [string]$pluginReceipt.manifestSha256
        consumer = $postHealth.gateway.consumer
        queue = $postHealth.gateway.queue
        authenticated = [bool]$postProbe.authenticated
        watcherReady = [bool]$postProbe.watcherReady
        scheduleOwnerReviewRequired = [bool]$postHealth.config.scheduleOwnerReviewRequired
        killSwitchObserved = [string]$smokeEvidence.killSwitchObserved
    } | ConvertTo-Json -Depth 6 -Compress
    return
}

$health = $null
try { $health = Invoke-RestMethod -Uri 'http://127.0.0.1:8787/health' -TimeoutSec 5 }
catch { $health = $null }

if ($null -eq $health) {
    $watcherStillHealthy = Test-KakaoWatcherRuntime
    if ($watcherStillHealthy) {
        if (-not $PSCmdlet.ShouldProcess('owned AX-2 Kakao bridge', 'Recover bridge without replacing healthy Chrome')) { return }
        $bridgeRecoveryScript = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot 'recover-kakao-bridge-only.ps1')).Path
        & $bridgeRecoveryScript -EnvFile $resolvedEnvFile -NodePath $resolvedNodePath `
            -HermesPythonPath $resolvedHermesPythonPath -HermesTransport $liveHermesTransport -Confirm:$false | Out-Null
    }
    else {
        if (-not $PSCmdlet.ShouldProcess('owned AX-2 Kakao runtime', 'Recover full-live Chrome and bridge')) { return }
        $stopScript = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot 'stop-kakao-staging.ps1')).Path
        $startScript = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot 'start-kakao-staging.ps1')).Path
        & $stopScript -Confirm:$false | Out-Null
        & $startScript -EnvFile $resolvedEnvFile -ChromePath $resolvedChromePath -NodePath $resolvedNodePath `
            -HermesPythonPath $resolvedHermesPythonPath -HermesTransport $liveHermesTransport -EnableWrites -Confirm:$false | Out-Null
    }
    $health = Invoke-RestMethod -Uri 'http://127.0.0.1:8787/health' -TimeoutSec 8
}

$bridgeHealthy = Test-KakaoLiveBridgeContract -Health $health -RequireInvariantHealth $false
$runtimeProbe = Get-KakaoWatcherRuntime
$runtimeState = Get-KakaoLiveRuntimeState -Probe $runtimeProbe
$openRooms = if ($health.state.PSObject.Properties.Name -contains 'openRooms') { [int]$health.state.openRooms } else { 0 }
$bridgeBusy = $health.state.workerRunning -or [int]$health.state.workerQueueLength -ne 0 -or $openRooms -ne 0
$watcherProbeHealthy = Test-KakaoWatcherRuntime -Probe $runtimeProbe
$recoveryAction = Get-KakaoLiveRecoveryAction -BridgeContractHealthy $bridgeHealthy `
    -RuntimeState $runtimeState -BridgeBusy $bridgeBusy -WatcherProbeHealthy $watcherProbeHealthy

if ($recoveryAction -eq 'none') {
    # 브리지는 worker.mjs를 in-process import하고 정책 JSON을 읽으므로, server.mjs만
    # 보면 worker/정책 변경이 배포돼도 재시작이 걸리지 않는다 (2026-08-19 실측).
    $bridgeSourcePaths = @(
        (Join-Path $PSScriptRoot '..\..\tools\kakao-dom-bridge\server.mjs'),
        (Join-Path $PSScriptRoot '..\..\tools\ai-browser-worker\worker.mjs'),
        (Join-Path $PSScriptRoot '..\..\tools\ai-browser-worker\current-confirmed-policy.json')
    )
    $bridgeSourceLastWriteUtc = ($bridgeSourcePaths |
        Where-Object { Test-Path -LiteralPath $_ } |
        ForEach-Object { (Get-Item -LiteralPath $_).LastWriteTimeUtc } |
        Sort-Object -Descending |
        Select-Object -First 1)
    $bridgeRecord = Read-OwnedProcessRecord -Name 'bridge'
    if ($null -ne $bridgeRecord -and (Test-OwnedProcessRecord -Record $bridgeRecord) -and $null -ne $bridgeSourceLastWriteUtc) {
        $bridgeProcess = Get-Process -Id ([int]$bridgeRecord.Pid) -ErrorAction Stop
        $recoveryAction = Get-KakaoLiveSourceRefreshAction `
            -SourceLastWriteTimeUtc $bridgeSourceLastWriteUtc `
            -ProcessStartTimeUtc $bridgeProcess.StartTime.ToUniversalTime() `
            -BridgeBusy $bridgeBusy
    }
}

if ($recoveryAction -eq 'none') {
    if (-not $GatewayMaintenance.IsPresent) {
        [pscustomobject]@{ state = 'already_running'; changed = $false; watcherRepaired = $false; autoSendEnabled = $true } |
            ConvertTo-Json -Compress
        return
    }
}
if ($recoveryAction -eq 'preserve_and_wait') {
    [pscustomobject]@{ state = $runtimeState; changed = $false; watcherRepaired = $false; autoSendEnabled = $true } |
        ConvertTo-Json -Compress
    return
}
if ($recoveryAction -eq 'restart_full_runtime') {
    $restartScript = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot 'Restart-KakaoBridgeLive.ps1')).Path
    & $restartScript -EnvFile $resolvedEnvFile -HermesPythonPath $resolvedHermesPythonPath `
        -HermesTransport $liveHermesTransport -Confirm:$false | Out-Null
    $health = Invoke-RestMethod -Uri 'http://127.0.0.1:8787/health' -TimeoutSec 8
    $runtimeProbe = Get-KakaoWatcherRuntime
    $runtimeState = Get-KakaoLiveRuntimeState -Probe $runtimeProbe
    $recoveryAction = Get-KakaoLiveRecoveryAction -BridgeContractHealthy $true -RuntimeState $runtimeState -BridgeBusy $false
}
if ($recoveryAction -eq 'restart_owned_chrome_only') {
    if (-not $PSCmdlet.ShouldProcess('owned AX-2 Kakao Chrome', 'Repair CDP without stopping the bridge')) { return }
    $repairChromeScript = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot 'restart-kakao-owned-chrome.ps1')).Path
    $chromeResult = & $repairChromeScript -ChromePath $resolvedChromePath -HermesPythonPath $resolvedHermesPythonPath -Confirm:$false
    if ($chromeResult.State -eq 'authentication_required') {
        $recoveryAction = if ($chromeResult.RuntimeState -eq 'login_required') { 'recover_login' } else { 'preserve_and_wait' }
        $runtimeState = [string]$chromeResult.RuntimeState
    } else {
        $recoveryAction = 'none'
    }
}
if ($recoveryAction -eq 'recover_login') {
    if (-not $PSCmdlet.ShouldProcess('Kakao login page', 'Select the uniquely saved account or use the configured bounded login recovery')) { return }
    $loginResult = Invoke-KakaoLoginRecovery -EnvFile $resolvedEnvFile -NodePath $resolvedNodePath `
        -LoginRunner $loginRunner
    if (-not $loginResult.ok) {
        [pscustomobject]@{ state = [string]$loginResult.state; changed = [bool]$loginResult.attempted; watcherRepaired = $false; autoSendEnabled = $true } |
            ConvertTo-Json -Compress
        return
    }
    $recoveryAction = 'repair_watcher_only'
}

$watcherRepaired = $false
if ($recoveryAction -eq 'repair_watcher_only') {
    $watcherRepaired = Repair-KakaoWatcherRuntime -Force
}
$verified = Wait-KakaoLiveHealth -Seconds 15
if ($null -eq $verified.bridge -or -not (Test-KakaoLiveHealth -Health $verified.bridge -RuntimeProbe $verified.runtime)) {
    $pausedState = Get-KakaoLiveRuntimeState -Probe $verified.runtime
    [pscustomobject]@{ state = $pausedState; changed = $true; watcherRepaired = $watcherRepaired; autoSendEnabled = $true } |
        ConvertTo-Json -Compress
    return
}

if ($GatewayMaintenance.IsPresent) {
    Start-KakaoworkerGatewayRuntime
    $deadline = [DateTime]::UtcNow.AddSeconds(45)
    $gatewayHealthy = $false
    $gatewayRuntime = $null
    do {
        Start-Sleep -Milliseconds 500
        try { $verified.bridge = Invoke-RestMethod -Uri 'http://127.0.0.1:8787/health' -TimeoutSec 3 }
        catch { $verified.bridge = $null }
        $verified.runtime = Get-KakaoWatcherRuntime
        $gatewayRuntime = Get-KakaoworkerGatewayRuntime
        $gatewayHealthy = $null -ne $verified.bridge -and (Test-KakaoGatewayCutoverHealth -Health $verified.bridge `
            -RuntimeProbe $verified.runtime -GatewayRuntime $gatewayRuntime -SmokeEvidence $smokeEvidence)
    } while (-not $gatewayHealthy -and [DateTime]::UtcNow -lt $deadline)
    if (-not $gatewayHealthy) { throw 'Gateway maintenance direct readback failed.' }
    [pscustomobject]@{
        state = 'gateway_healthy'
        changed = $true
        transport = 'gateway'
        gatewayPid = [int]$gatewayRuntime.pid
        authenticated = [bool]$verified.runtime.authenticated
        watcherReady = [bool]$verified.runtime.watcherReady
        rootSlackGatewayMutated = $false
    } | ConvertTo-Json -Compress
    return
}

[pscustomobject]@{ state = 'recovered'; changed = $true; watcherRepaired = $watcherRepaired; autoSendEnabled = $true } |
    ConvertTo-Json -Compress
