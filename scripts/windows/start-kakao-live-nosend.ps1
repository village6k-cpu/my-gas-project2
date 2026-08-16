[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'Medium')]
param(
    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string]$EnvFile,

    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string]$ChromePath,

    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string]$NodePath,

    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string]$HermesPythonPath,

    [switch]$PlanOnly
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

Import-Module (Join-Path $PSScriptRoot 'KakaoLiveNoSend.Common.psm1') -Force
Import-Module (Join-Path $PSScriptRoot 'KakaoLive.Common.psm1') -Force

$resolvedEnvFile = (Resolve-Path -LiteralPath $EnvFile -ErrorAction Stop).Path
$resolvedChromePath = (Resolve-Path -LiteralPath $ChromePath -ErrorAction Stop).Path
$resolvedNodePath = (Resolve-Path -LiteralPath $NodePath -ErrorAction Stop).Path
$resolvedHermesPythonPath = (Resolve-Path -LiteralPath $HermesPythonPath -ErrorAction Stop).Path
$watcherInjector = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..\tools\kakao-dom-bridge\inject-watcher-cdp.py') -ErrorAction Stop).Path
$loginRunner = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot 'kakao-login-recover.mjs') -ErrorAction Stop).Path
$plan = Get-KakaoLiveNoSendStartupPlan

function Test-KakaoWatcherRuntime {
    & $resolvedHermesPythonPath $watcherInjector --port 9223 --wait 3 --probe-only *> $null
    return ($LASTEXITCODE -eq 0)
}

function Repair-KakaoWatcherRuntime {
    param([switch]$Force)

    if (-not $Force.IsPresent -and (Test-KakaoWatcherRuntime)) { return $false }
    & $resolvedHermesPythonPath $watcherInjector --port 9223 --wait 8 *> $null
    if ($LASTEXITCODE -ne 0 -or -not (Test-KakaoWatcherRuntime)) {
        throw 'Kakao watcher injection did not satisfy the live/no-send observer contract.'
    }
    return $true
}

function Invoke-KakaoNoSendRuntimeRecovery {
    param([Parameter(Mandatory = $true)] [psobject]$Health)

    $runtimeState = if ($null -ne $Health.runtime -and $Health.runtime.PSObject.Properties.Name -contains 'state') {
        [string]$Health.runtime.state
    } else {
        'degraded'
    }
    $recoveryAction = Get-KakaoLiveNoSendRecoveryAction -RuntimeState $runtimeState
    if ($recoveryAction -eq 'none') {
        return [pscustomobject]@{ state = 'already_running'; changed = $false; watcherRepaired = $false; autoSendEnabled = $false }
    }
    if ($recoveryAction -eq 'preserve_and_wait') {
        return [pscustomobject]@{ state = $runtimeState; changed = $false; watcherRepaired = $false; autoSendEnabled = $false }
    }
    if ($recoveryAction -eq 'recover_login') {
        if (-not $PSCmdlet.ShouldProcess('Kakao login page', 'Recover the saved Chrome credential in live/no-send mode')) { return }
        $loginResult = Invoke-KakaoLoginRecovery -EnvFile $resolvedEnvFile -NodePath $resolvedNodePath `
            -LoginRunner $loginRunner
        if (-not $loginResult.ok) {
            return [pscustomobject]@{ state = [string]$loginResult.state; changed = [bool]$loginResult.attempted; watcherRepaired = $false; autoSendEnabled = $false }
        }
        $recoveryAction = 'repair_watcher_only'
    }

    $watcherRepaired = $false
    if ($recoveryAction -eq 'repair_watcher_only') {
        $watcherRepaired = Repair-KakaoWatcherRuntime -Force
    }
    $verified = Invoke-RestMethod -Uri 'http://127.0.0.1:8787/health' -TimeoutSec 8
    $verifiedState = if ($null -ne $verified.runtime) { [string]$verified.runtime.state } else { 'degraded' }
    return [pscustomobject]@{
        state = $verifiedState
        changed = $true
        watcherRepaired = $watcherRepaired
        autoSendEnabled = $false
    }
}

if ($PlanOnly.IsPresent) {
    $plan | ConvertTo-Json -Depth 5
    return
}

$health = $null
try {
    $health = Invoke-RestMethod -Uri 'http://127.0.0.1:8787/health' -TimeoutSec 5
}
catch {
    $health = $null
}

if ($null -ne $health) {
    if (Test-KakaoLiveNoSendHealth -Health $health) {
        Invoke-KakaoNoSendRuntimeRecovery -Health $health | ConvertTo-Json -Compress
        return
    }
    throw 'An existing Kakao bridge is reachable but does not satisfy the live/no-send contract; refusing automatic mutation.'
}

if (-not $PSCmdlet.ShouldProcess('owned AX-2 Kakao runtime', 'Recover live/no-send Chrome and bridge')) {
    return
}

$stopScript = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot 'stop-kakao-staging.ps1') -ErrorAction Stop).Path
$startScript = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot 'start-kakao-staging.ps1') -ErrorAction Stop).Path
$promoteScript = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot 'Restart-KakaoBridgeNoSend.ps1') -ErrorAction Stop).Path

& $stopScript -Confirm:$false | Out-Null
& $startScript `
    -EnvFile $resolvedEnvFile `
    -ChromePath $resolvedChromePath `
    -NodePath $resolvedNodePath `
    -HermesPythonPath $resolvedHermesPythonPath `
    -EnableWrites `
    -Confirm:$false | Out-Null
& $promoteScript `
    -EnvFile $resolvedEnvFile `
    -HermesPythonPath $resolvedHermesPythonPath `
    -Confirm:$false | Out-Null

$verified = Invoke-RestMethod -Uri 'http://127.0.0.1:8787/health' -TimeoutSec 8
if (-not (Test-KakaoLiveNoSendHealth -Health $verified)) {
    throw 'Recovered Kakao bridge did not satisfy the live/no-send contract.'
}

Invoke-KakaoNoSendRuntimeRecovery -Health $verified | ConvertTo-Json -Compress
