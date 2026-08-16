[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'Medium')]
param(
    [Parameter(Mandatory = $true)] [string]$EnvFile,
    [Parameter(Mandatory = $true)] [string]$ChromePath,
    [Parameter(Mandatory = $true)] [string]$NodePath,
    [Parameter(Mandatory = $true)] [string]$HermesPythonPath,
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
$plan = Get-KakaoLiveStartupPlan

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

if ($PlanOnly.IsPresent) {
    $plan | ConvertTo-Json -Depth 5
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
            -HermesPythonPath $resolvedHermesPythonPath -Confirm:$false | Out-Null
    }
    else {
        if (-not $PSCmdlet.ShouldProcess('owned AX-2 Kakao runtime', 'Recover full-live Chrome and bridge')) { return }
        $stopScript = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot 'stop-kakao-staging.ps1')).Path
        $startScript = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot 'start-kakao-staging.ps1')).Path
        & $stopScript -Confirm:$false | Out-Null
        & $startScript -EnvFile $resolvedEnvFile -ChromePath $resolvedChromePath -NodePath $resolvedNodePath `
            -HermesPythonPath $resolvedHermesPythonPath -EnableWrites -Confirm:$false | Out-Null
    }
    $health = Invoke-RestMethod -Uri 'http://127.0.0.1:8787/health' -TimeoutSec 8
}

$bridgeHealthy = Test-KakaoLiveBridgeContract -Health $health
$runtimeProbe = Get-KakaoWatcherRuntime
$runtimeState = Get-KakaoLiveRuntimeState -Probe $runtimeProbe
$openRooms = if ($health.state.PSObject.Properties.Name -contains 'openRooms') { [int]$health.state.openRooms } else { 0 }
$bridgeBusy = $health.state.workerRunning -or [int]$health.state.workerQueueLength -ne 0 -or $openRooms -ne 0
$watcherProbeHealthy = Test-KakaoWatcherRuntime -Probe $runtimeProbe
$recoveryAction = Get-KakaoLiveRecoveryAction -BridgeContractHealthy $bridgeHealthy `
    -RuntimeState $runtimeState -BridgeBusy $bridgeBusy -WatcherProbeHealthy $watcherProbeHealthy

if ($recoveryAction -eq 'none') {
    $bridgeSource = Get-Item -LiteralPath (Join-Path $PSScriptRoot '..\..\tools\kakao-dom-bridge\server.mjs')
    $bridgeRecord = Read-OwnedProcessRecord -Name 'bridge'
    if ($null -ne $bridgeRecord -and (Test-OwnedProcessRecord -Record $bridgeRecord)) {
        $bridgeProcess = Get-Process -Id ([int]$bridgeRecord.Pid) -ErrorAction Stop
        $recoveryAction = Get-KakaoLiveSourceRefreshAction `
            -SourceLastWriteTimeUtc $bridgeSource.LastWriteTimeUtc `
            -ProcessStartTimeUtc $bridgeProcess.StartTime.ToUniversalTime() `
            -BridgeBusy $bridgeBusy
    }
}

if ($recoveryAction -eq 'none') {
    [pscustomobject]@{ state = 'already_running'; changed = $false; watcherRepaired = $false; autoSendEnabled = $true } |
        ConvertTo-Json -Compress
    return
}
if ($recoveryAction -eq 'preserve_and_wait') {
    [pscustomobject]@{ state = $runtimeState; changed = $false; watcherRepaired = $false; autoSendEnabled = $true } |
        ConvertTo-Json -Compress
    return
}
if ($recoveryAction -eq 'restart_full_runtime') {
    $restartScript = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot 'Restart-KakaoBridgeLive.ps1')).Path
    & $restartScript -EnvFile $resolvedEnvFile -HermesPythonPath $resolvedHermesPythonPath -Confirm:$false | Out-Null
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

[pscustomobject]@{ state = 'recovered'; changed = $true; watcherRepaired = $watcherRepaired; autoSendEnabled = $true } |
    ConvertTo-Json -Compress
