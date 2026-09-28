[CmdletBinding()]
param(
    [string]$HermesHome = (Join-Path $env:LOCALAPPDATA 'hermes'),
    [string]$TaskName = 'Hermes_Gateway',
    [ValidateRange(10, 900)][int]$StartupGraceSeconds = 120,
    [ValidateRange(10, 300)][int]$StartWaitSeconds = 120,
    [string]$LogPath = '',
    [switch]$EvaluateOnly
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'HermesRootLiveness.Common.psm1') -Force

$resolvedHome = [IO.Path]::GetFullPath($HermesHome).TrimEnd('\', '/')
$statePath = Join-Path $resolvedHome 'gateway_state.json'
$pidPath = Join-Path $resolvedHome 'gateway.pid'
if ([string]::IsNullOrWhiteSpace($LogPath)) {
    $LogPath = Join-Path $resolvedHome 'logs\root-liveness-watchdog.log'
}

function Write-LivenessLog {
    param([Parameter(Mandatory = $true)][string]$Message)
    $directory = Split-Path -Parent $LogPath
    [void](New-Item -ItemType Directory -Path $directory -Force -ErrorAction SilentlyContinue)
    $existing = Get-Item -LiteralPath $LogPath -ErrorAction SilentlyContinue
    if ($null -ne $existing -and $existing.Length -gt 1MB) {
        Move-Item -LiteralPath $LogPath -Destination "$LogPath.1" -Force -ErrorAction SilentlyContinue
    }
    Add-Content -LiteralPath $LogPath -Encoding UTF8 -Value ('{0} {1}' -f [DateTime]::UtcNow.ToString('o'), $Message)
}

function Read-JsonFile {
    param([Parameter(Mandatory = $true)][string]$Path)
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
    try { return [IO.File]::ReadAllText($Path, [Text.Encoding]::UTF8) | ConvertFrom-Json -ErrorAction Stop }
    catch { return $null }
}

function Test-RootGatewayProcess {
    param([Parameter(Mandatory = $true)][int]$ProcessId)
    $process = Get-CimInstance Win32_Process -Filter ("ProcessId = {0}" -f $ProcessId) -ErrorAction SilentlyContinue
    if ($null -eq $process -or [string]::IsNullOrWhiteSpace([string]$process.CommandLine)) { return $false }
    $commandLine = [string]$process.CommandLine
    return $commandLine -match '(?i)-m\s+hermes_cli\.main\s+gateway\s+run(?:\s|$)' -and
        $commandLine -notmatch '(?i)--profile\s+' 
}

$mutex = New-Object Threading.Mutex($false, 'Local\VillageHermesRootLivenessWatchdog')
$acquired = $false
try {
    $acquired = $mutex.WaitOne(0)
    if (-not $acquired) { exit 0 }

    $state = Read-JsonFile -Path $statePath
    $pidRecord = Read-JsonFile -Path $pidPath
    $pidRecordPresent = $null -ne $pidRecord
    $gatewayPid = 0
    $pidValid = $pidRecordPresent -and [int]::TryParse([string]$pidRecord.pid, [ref]$gatewayPid) -and $gatewayPid -gt 0
    $processAlive = $pidValid -and $null -ne (Get-Process -Id $gatewayPid -ErrorAction SilentlyContinue)
    $processMatchesRoot = $processAlive -and (Test-RootGatewayProcess -ProcessId $gatewayPid)
    if ($processMatchesRoot -and $null -ne $state -and $state.PSObject.Properties.Name -contains 'hermes_home') {
        $stateHome = [IO.Path]::GetFullPath([string]$state.hermes_home).TrimEnd('\', '/')
        $processMatchesRoot = $stateHome.Equals($resolvedHome, [StringComparison]::OrdinalIgnoreCase)
    }

    $gatewayState = if ($null -ne $state -and $state.PSObject.Properties.Name -contains 'gateway_state') {
        [string]$state.gateway_state
    } else { 'unknown' }
    $activeAgents = 0
    if ($null -ne $state -and $state.PSObject.Properties.Name -contains 'active_agents') {
        [void][int]::TryParse([string]$state.active_agents, [ref]$activeAgents)
    }
    $stateAgeSeconds = 86400.0
    $stateFile = Get-Item -LiteralPath $statePath -ErrorAction SilentlyContinue
    if ($null -ne $stateFile) {
        $stateAgeSeconds = [Math]::Max(0, ([DateTime]::UtcNow - $stateFile.LastWriteTimeUtc).TotalSeconds)
    }
    $action = Resolve-HermesRootLivenessAction -PidRecordPresent $pidRecordPresent `
        -ProcessAlive $processAlive -ProcessMatchesRoot $processMatchesRoot `
        -GatewayState $gatewayState -StateAgeSeconds $stateAgeSeconds `
        -ActiveAgents $activeAgents -StartupGraceSeconds $StartupGraceSeconds

    if ($EvaluateOnly.IsPresent) {
        [pscustomobject]@{
            action = $action
            pid = $gatewayPid
            processAlive = $processAlive
            processMatchesRoot = $processMatchesRoot
            gatewayState = $gatewayState
            activeAgents = $activeAgents
            stateAgeSeconds = [Math]::Round($stateAgeSeconds, 1)
        } | ConvertTo-Json -Compress
        exit 0
    }
    if ($action -eq 'healthy' -or $action -eq 'defer_startup') { exit 0 }
    if ($action -eq 'blocked_process_mismatch') {
        Write-LivenessLog "BLOCKED pid=$gatewayPid does not match the root Hermes gateway contract"
        exit 1
    }

    $startedAtUtc = [DateTime]::UtcNow
    Start-ScheduledTask -TaskName $TaskName -ErrorAction Stop
    Write-LivenessLog "START requested via scheduled task $TaskName"
    $deadline = [DateTime]::UtcNow.AddSeconds($StartWaitSeconds)
    do {
        Start-Sleep -Milliseconds 500
        $newState = Read-JsonFile -Path $statePath
        $newPidRecord = Read-JsonFile -Path $pidPath
        $newPid = 0
        $newPidValid = $null -ne $newPidRecord -and [int]::TryParse([string]$newPidRecord.pid, [ref]$newPid) -and $newPid -gt 0
        $slackConnected = $null -ne $newState -and
            $newState.PSObject.Properties.Name -contains 'platforms' -and
            $null -ne $newState.platforms.slack -and
            [string]$newState.platforms.slack.state -eq 'connected'
        $stateFresh = $null -ne (Get-Item -LiteralPath $statePath -ErrorAction SilentlyContinue) -and
            (Get-Item -LiteralPath $statePath).LastWriteTimeUtc -ge $startedAtUtc
        $ready = $newPidValid -and $newPid -ne $gatewayPid -and $stateFresh -and $slackConnected -and
            (Test-RootGatewayProcess -ProcessId $newPid)
    } while (-not $ready -and [DateTime]::UtcNow -lt $deadline)
    if (-not $ready) {
        Write-LivenessLog "FAIL scheduled task $TaskName did not restore a fresh Slack-connected root gateway"
        exit 1
    }
    Write-LivenessLog "RECOVERED pid=$newPid Slack=connected"
}
finally {
    if ($acquired) { [void]$mutex.ReleaseMutex() }
    $mutex.Dispose()
}
