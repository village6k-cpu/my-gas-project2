[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'Medium')]
param(
    [Parameter(Mandatory = $true)] [string]$ChromePath,
    [Parameter(Mandatory = $true)] [string]$HermesPythonPath,
    [ValidateRange(1, 65535)] [int]$DevToolsPort = 9223
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'KakaoStaging.Common.psm1') -Force

$resolvedChromePath = (Resolve-Path -LiteralPath $ChromePath -ErrorAction Stop).Path
$resolvedHermesPythonPath = (Resolve-Path -LiteralPath $HermesPythonPath -ErrorAction Stop).Path
$extensionPath = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..\tools\kakao-dom-watcher-extension') -ErrorAction Stop).Path
$watcherInjector = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..\tools\kakao-dom-bridge\inject-watcher-cdp.py') -ErrorAction Stop).Path

if (-not $PSCmdlet.ShouldProcess('owned AX-2 Kakao Chrome', 'Restart browser only and restore the watcher')) {
    return
}

$oldRecord = Read-OwnedProcessRecord -Name 'chrome'
if ($null -ne $oldRecord) {
    Stop-OwnedProcess -Name 'chrome' -Confirm:$false | Out-Null
}
elseif (Test-LocalTcpPort -Port $DevToolsPort) {
    throw 'The Kakao DevTools port is owned by an untracked process; refusing to replace it.'
}

$ownedChrome = Start-OwnedKakaoChrome -ChromePath $resolvedChromePath -ExtensionPath $extensionPath -DevToolsPort $DevToolsPort
try {
    $watcherOutput = & $resolvedHermesPythonPath $watcherInjector --port $DevToolsPort --wait 45 2>&1
    $watcherExitCode = $LASTEXITCODE
    try {
        $watcher = ($watcherOutput -join [Environment]::NewLine) | ConvertFrom-Json -ErrorAction Stop
    }
    catch {
        throw 'Watcher repair did not return valid JSON.'
    }
    if ($watcher.state -in @('login_required', 'second_factor_required')) {
        [pscustomobject]@{
            State = 'authentication_required'
            RuntimeState = [string]$watcher.state
            OldPid = if ($null -ne $oldRecord) { [int]$oldRecord.Pid } else { $null }
            NewPid = $ownedChrome.Process.Id
            DevToolsPort = $DevToolsPort
            WatcherReady = $false
        }
        return
    }
    if ($watcherExitCode -ne 0 -or -not $watcher.ok) {
        throw 'Watcher repair did not satisfy the observer contract.'
    }

    [pscustomobject]@{
        State = 'owned_chrome_restarted'
        OldPid = if ($null -ne $oldRecord) { [int]$oldRecord.Pid } else { $null }
        NewPid = $ownedChrome.Process.Id
        DevToolsPort = $DevToolsPort
        WatcherReady = $true
    }
}
catch {
    Stop-OwnedProcess -Name 'chrome' -Confirm:$false | Out-Null
    throw
}
