[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'Medium')]
param(
    [Parameter(Mandatory = $true)] [string]$EnvFile,
    [Parameter(Mandatory = $true)] [string]$NodePath,
    [Parameter(Mandatory = $true)] [string]$HermesPythonPath,

    [ValidateSet('cli', 'gateway')]
    [string]$HermesTransport = 'cli'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..')).Path
Import-Module (Join-Path $PSScriptRoot 'KakaoStaging.Common.psm1') -Force
Import-Module (Join-Path $PSScriptRoot 'KakaoLive.Common.psm1') -Force

$resolvedEnvFile = (Resolve-Path -LiteralPath $EnvFile -ErrorAction Stop).Path
$resolvedNodePath = (Resolve-Path -LiteralPath $NodePath -ErrorAction Stop).Path
$resolvedHermesPythonPath = (Resolve-Path -LiteralPath $HermesPythonPath -ErrorAction Stop).Path
$canonicalHermesPythonPath = (Resolve-Path -LiteralPath (Join-Path $env:LOCALAPPDATA 'hermes\hermes-agent\venv\Scripts\python.exe') -ErrorAction Stop).Path
if (-not [string]::Equals($resolvedHermesPythonPath, $canonicalHermesPythonPath, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Bridge-only recovery requires the installed Hermes runtime: $canonicalHermesPythonPath"
}

Import-DotEnvFile -Path $resolvedEnvFile
[Environment]::SetEnvironmentVariable('HERMES_WORKER_COMMAND', $resolvedHermesPythonPath, 'Process')
[Environment]::SetEnvironmentVariable('HERMES_WORKER_COMMAND_MODE', 'python_module', 'Process')
Set-KakaoStagingSafeEnvironment -EnableWrites
Set-KakaoLiveRuntimeEnvironment -HermesTransport $HermesTransport

$watcherInjector = (Resolve-Path -LiteralPath (Join-Path $repoRoot 'tools\kakao-dom-bridge\inject-watcher-cdp.py')).Path
$probeOutput = & $resolvedHermesPythonPath $watcherInjector --port 9223 --wait 3 --probe-only 2>$null
try { $probe = (($probeOutput -join [Environment]::NewLine) | ConvertFrom-Json -ErrorAction Stop) }
catch { throw 'Bridge-only recovery requires a valid CDP watcher probe.' }
if ($probe.ok -ne $true -or $probe.state -ne 'healthy' -or $probe.authenticated -ne $true -or $probe.watcherReady -ne $true) {
    throw 'Bridge-only recovery requires an authenticated healthy Chrome watcher.'
}

$record = Read-OwnedProcessRecord -Name 'bridge'
if ($null -ne $record) {
    $recordedProcess = Get-CimInstance Win32_Process -Filter ("ProcessId = {0}" -f [int]$record.Pid) -ErrorAction SilentlyContinue
    if ($null -ne $recordedProcess) {
        throw 'A recorded bridge process is still alive; refusing bridge-only recovery.'
    }
    [void](Stop-OwnedProcess -Name 'bridge' -Confirm:$false)
}
if (Test-LocalTcpPort -Port 8787) { throw 'Bridge port 8787 is unexpectedly occupied.' }
if (-not $PSCmdlet.ShouldProcess('owned AX-2 Kakao bridge', 'Start bridge without replacing healthy Chrome')) { return }

$bridgeScript = (Resolve-Path -LiteralPath (Join-Path $repoRoot 'tools\kakao-dom-bridge\server.mjs')).Path
$bridgeDirectory = Split-Path -Parent $bridgeScript
$commandMarker = ConvertTo-WindowsCommandLineArgument -Value $bridgeScript
$process = Start-Process -FilePath $resolvedNodePath -ArgumentList $commandMarker `
    -WorkingDirectory $bridgeDirectory -WindowStyle Hidden -PassThru

try {
    Write-OwnedProcessRecord -Name 'bridge' -Process $process -ExecutablePath $resolvedNodePath `
        -CommandMarker $commandMarker -Port 8787 -WorkerEnabled $true
    $deadline = [DateTime]::UtcNow.AddSeconds(20)
    $health = $null
    do {
        Start-Sleep -Milliseconds 250
        try { $health = Invoke-RestMethod -Uri 'http://127.0.0.1:8787/health' -TimeoutSec 2 }
        catch { $health = $null }
    } while ($null -eq $health -and [DateTime]::UtcNow -lt $deadline -and -not $process.HasExited)
    if ($null -eq $health -or -not (Test-KakaoLiveBridgeContract -Health $health -RequireInvariantHealth $false)) {
        throw 'Bridge-only recovery did not satisfy the full-live contract.'
    }
    [pscustomobject]@{
        State = 'bridge_recovered'
        Pid = $process.Id
        AutoSend = [bool]$health.config.autoSendEnabled
        WorkerDryRun = [bool]$health.config.workerDryRun
        WindowsWrites = [bool]$health.config.windowsWritesEnabled
        SlackDelivery = [bool]$health.config.slackCardDeliveryEnabled
        ActionPoll = [bool]$health.config.slackActionPollEnabled
    }
}
catch {
    if (-not $process.HasExited) {
        Stop-VerifiedProcess -Process $process -ExecutablePath $resolvedNodePath `
            -CommandMarker $commandMarker -Confirm:$false | Out-Null
    }
    try { [void](Stop-OwnedProcess -Name 'bridge' -Confirm:$false) } catch {}
    throw
}
