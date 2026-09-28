[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$ProductionRoot,
    [Parameter(Mandatory = $true)][string]$EnvFile,
    [Parameter(Mandatory = $true)][string]$ChromePath,
    [Parameter(Mandatory = $true)][string]$NodePath,
    [Parameter(Mandatory = $true)][string]$HermesPythonPath,
    [Parameter(Mandatory = $true)][string]$BenchmarkReportPath,
    [Parameter(Mandatory = $true)][string]$PluginReceiptPath,
    [Parameter(Mandatory = $true)][string]$SmokeEvidencePath,
    [string]$StatePath = '',
    [string]$LogPath = ''
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'KakaoLivenessGuard.Common.psm1') -Force
$resolvedRoot = (Resolve-Path -LiteralPath $ProductionRoot -ErrorAction Stop).Path
Import-Module (Join-Path $resolvedRoot 'scripts\windows\KakaoStaging.Common.psm1') -Force

$runtimeRoot = Join-Path $env:LOCALAPPDATA 'Village\kakao-staging'
if ([string]::IsNullOrWhiteSpace($StatePath)) { $StatePath = Join-Path $runtimeRoot 'liveness-guard.json' }
if ([string]::IsNullOrWhiteSpace($LogPath)) { $LogPath = Join-Path $runtimeRoot 'liveness-guard.log' }

function Write-GuardLog {
    param([Parameter(Mandatory = $true)][string]$Message)
    [void](New-Item -ItemType Directory -Path (Split-Path -Parent $LogPath) -Force -ErrorAction SilentlyContinue)
    $existing = Get-Item -LiteralPath $LogPath -ErrorAction SilentlyContinue
    if ($null -ne $existing -and $existing.Length -gt 1MB) {
        Move-Item -LiteralPath $LogPath -Destination "$LogPath.1" -Force -ErrorAction SilentlyContinue
    }
    Add-Content -LiteralPath $LogPath -Encoding UTF8 -Value ('{0} {1}' -f [DateTime]::UtcNow.ToString('o'), $Message)
}

function Read-GuardState {
    if (-not (Test-Path -LiteralPath $StatePath -PathType Leaf)) { return $null }
    try { return [IO.File]::ReadAllText($StatePath, [Text.Encoding]::UTF8) | ConvertFrom-Json -ErrorAction Stop }
    catch { return $null }
}

function Write-GuardState {
    param([Parameter(Mandatory = $true)][int]$Failures, [Parameter(Mandatory = $true)][string]$Action)
    $directory = Split-Path -Parent $StatePath
    [void](New-Item -ItemType Directory -Path $directory -Force)
    $temporary = Join-Path $directory ('.liveness-guard.{0}.tmp' -f [Guid]::NewGuid().ToString('N'))
    $payload = [pscustomobject]@{ consecutiveFailures = $Failures; lastAction = $Action; updatedAt = [DateTime]::UtcNow.ToString('o') } | ConvertTo-Json -Compress
    [IO.File]::WriteAllText($temporary, $payload, (New-Object Text.UTF8Encoding($false)))
    Move-Item -LiteralPath $temporary -Destination $StatePath -Force
}

function Test-OwnedComponent {
    param([Parameter(Mandatory = $true)][string]$Name, [Parameter(Mandatory = $true)][int]$Port)
    $record = Read-OwnedProcessRecord -Name $Name
    return $null -ne $record -and (Test-OwnedProcessRecord -Record $record) -and (Test-LocalTcpPort -Port $Port)
}

function Test-KakaoworkerGateway {
    $kakaoProfilePath = Join-Path $env:LOCALAPPDATA 'hermes\profiles\kakaoworker'
    $pidFile = Join-Path $kakaoProfilePath 'gateway.pid'
    $stateFile = Join-Path $kakaoProfilePath 'gateway_state.json'
    if (-not (Test-Path -LiteralPath $pidFile -PathType Leaf) -or -not (Test-Path -LiteralPath $stateFile -PathType Leaf)) { return $false }
    try {
        $pidRecord = [IO.File]::ReadAllText($pidFile, [Text.Encoding]::UTF8) | ConvertFrom-Json -ErrorAction Stop
        $gatewayState = [IO.File]::ReadAllText($stateFile, [Text.Encoding]::UTF8) | ConvertFrom-Json -ErrorAction Stop
        $gatewayPid = [int]$pidRecord.pid
        return $gatewayPid -gt 0 -and $null -ne (Get-Process -Id $gatewayPid -ErrorAction SilentlyContinue) -and
            [string]$gatewayState.gateway_state -eq 'running' -and
            [string]$gatewayState.platforms.kakao_village.state -eq 'connected'
    }
    catch { return $false }
}

function Test-KakaoWatcher {
    param([Parameter(Mandatory = $true)][bool]$ChromeHealthy)
    if (-not $ChromeHealthy) { return $false }
    $injector = Join-Path $resolvedRoot 'tools\kakao-dom-bridge\inject-watcher-cdp.py'
    $output = & $HermesPythonPath $injector --port 9223 --wait 5 --probe-only 2>$null
    if ($LASTEXITCODE -ne 0) { return $false }
    try {
        $probe = ($output -join [Environment]::NewLine) | ConvertFrom-Json -ErrorAction Stop
        return $probe.ok -eq $true -and $probe.state -eq 'healthy' -and
            $probe.authenticated -eq $true -and $probe.watcherReady -eq $true
    }
    catch { return $false }
}

$mutex = New-Object Threading.Mutex($false, 'Local\VillageKakaoProductionLivenessGuard')
$acquired = $false
try {
    $acquired = $mutex.WaitOne(0)
    if (-not $acquired) { exit 0 }

    $chromeHealthy = Test-OwnedComponent -Name 'chrome' -Port 9223
    $bridgeHealthy = Test-OwnedComponent -Name 'bridge' -Port 8787
    $gatewayHealthy = Test-KakaoworkerGateway
    $watcherHealthy = Test-KakaoWatcher -ChromeHealthy $chromeHealthy
    $previous = Read-GuardState
    $previousFailures = if ($null -ne $previous) { [int]$previous.consecutiveFailures } else { 0 }
    $failures = if ($chromeHealthy -and $bridgeHealthy -and $gatewayHealthy -and $watcherHealthy) { 0 } else { $previousFailures + 1 }
    $action = Resolve-KakaoLivenessGuardAction -ChromeHealthy $chromeHealthy -BridgeHealthy $bridgeHealthy `
        -GatewayHealthy $gatewayHealthy -WatcherHealthy $watcherHealthy -ConsecutiveFailures $failures
    Write-GuardState -Failures $failures -Action $action

    if ($action -eq 'healthy') { exit 0 }
    if ($action -eq 'defer') {
        Write-GuardLog "DEFER failure=$failures chrome=$chromeHealthy bridge=$bridgeHealthy gateway=$gatewayHealthy watcher=$watcherHealthy"
        exit 0
    }

    switch ($action) {
        'recover_bridge_only' {
            $script = Join-Path $resolvedRoot 'scripts\windows\recover-kakao-bridge-only.ps1'
            & $script -EnvFile $EnvFile -NodePath $NodePath -HermesPythonPath $HermesPythonPath -HermesTransport gateway -Confirm:$false | Out-Null
        }
        'evaluate_live_runtime' {
            $script = Join-Path $resolvedRoot 'scripts\windows\start-kakao-live.ps1'
            & $script -EnvFile $EnvFile -ChromePath $ChromePath -NodePath $NodePath -HermesPythonPath $HermesPythonPath `
                -BenchmarkReportPath $BenchmarkReportPath -PluginReceiptPath $PluginReceiptPath -SmokeEvidencePath $SmokeEvidencePath `
                -ConfirmKakaoGatewayCutover -GatewayMaintenance -Confirm:$false | Out-Null
        }
        'run_full_watchdog' {
            $script = Join-Path $resolvedRoot 'scripts\windows\watch-kakao-production.ps1'
            & $script -EnvFile $EnvFile -ChromePath $ChromePath -NodePath $NodePath -HermesPythonPath $HermesPythonPath `
                -BenchmarkReportPath $BenchmarkReportPath -PluginReceiptPath $PluginReceiptPath -SmokeEvidencePath $SmokeEvidencePath `
                -ConfirmKakaoGatewayCutover -Confirm:$false | Out-Null
        }
    }
    Write-GuardState -Failures 0 -Action 'recovered'
    Write-GuardLog "RECOVERED action=$action"
}
catch {
    Write-GuardLog ("FAILED {0}" -f $_.Exception.Message)
    throw
}
finally {
    if ($acquired) { [void]$mutex.ReleaseMutex() }
    $mutex.Dispose()
}
