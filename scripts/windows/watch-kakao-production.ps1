# 카카오 프로덕션 워치독 — 소유 레코드/포트 기준으로 런타임 생존을 확인하고,
# 죽어 있으면 소유권 검증된 stop 후 -EnableWrites로 재시작한다.
# 살아 있으면 아무것도 바꾸지 않고 조용히 종료한다(읽기 전용).
# 라이브 PID 소유권 불일치처럼 사람이 판단해야 하는 상태에서는 재시작하지 않고
# 로그를 남기고 실패로 끝낸다 — 워치독이 남의 프로세스를 죽이는 일은 없어야 한다.
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

    [string]$HermesPythonPath = (Join-Path $env:LOCALAPPDATA 'hermes\hermes-agent\venv\Scripts\python.exe'),

    [string]$HermesPath,

    [switch]$IncludeGateway,

    [string]$BenchmarkReportPath = '',

    [string]$PluginReceiptPath = '',

    [string]$SmokeEvidencePath = '',

    [switch]$ConfirmKakaoGatewayCutover
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

Import-Module (Join-Path $PSScriptRoot 'KakaoStaging.Common.psm1') -Force
Import-Module (Join-Path $PSScriptRoot 'KakaoLive.Common.psm1') -Force

$stopScriptPath = Join-Path $PSScriptRoot 'stop-kakao-staging.ps1'
$startScriptPath = Join-Path $PSScriptRoot 'start-kakao-staging.ps1'
$liveStartScriptPath = Join-Path $PSScriptRoot 'start-kakao-live.ps1'
$resolvedHermesPythonPath = (Resolve-Path -LiteralPath $HermesPythonPath -ErrorAction Stop).Path
$watcherInjector = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..\tools\kakao-dom-bridge\inject-watcher-cdp.py') -ErrorAction Stop).Path

function Write-WatchdogLog {
    param([Parameter(Mandatory = $true)][string]$Message)

    $logPath = Join-Path (Get-KakaoStagingRoot) 'watchdog.log'
    $logDirectory = Split-Path -Parent $logPath
    [void](New-Item -ItemType Directory -Path $logDirectory -Force -ErrorAction SilentlyContinue)
    $existing = Get-Item -LiteralPath $logPath -ErrorAction SilentlyContinue
    if ($null -ne $existing -and $existing.Length -gt 1MB) {
        Move-Item -LiteralPath $logPath -Destination "$logPath.1" -Force -ErrorAction SilentlyContinue
    }
    $line = '{0} {1}' -f ([DateTime]::UtcNow.ToString('o')), $Message
    Add-Content -LiteralPath $logPath -Value $line -Encoding UTF8
}

function Get-UnhealthyComponents {
    param([Parameter(Mandatory = $true)][string[]]$Names)

    $unhealthy = @()
    foreach ($name in $Names) {
        $record = Read-OwnedProcessRecord -Name $name
        if ($null -eq $record) {
            $unhealthy += "{0}:no_record" -f $name
            continue
        }
        if (-not (Test-OwnedProcessRecord -Record $record)) {
            $unhealthy += "{0}:process_gone_or_mismatch" -f $name
            continue
        }
        $recordPort = 0
        $hasPort = $null -ne $record.PSObject.Properties['Port'] -and
            [int]::TryParse([string]$record.Port, [ref]$recordPort) -and
            $recordPort -ge 1 -and $recordPort -le 65535
        if ($hasPort -and -not (Test-LocalTcpPort -Port $recordPort)) {
            $unhealthy += "{0}:port_{1}_closed" -f $name, $recordPort
        }
    }
    return $unhealthy
}

function Get-KakaoDirectProbe {
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

function Invoke-KakaoLiveEvaluator {
    $parameters = @{
        EnvFile = $EnvFile
        ChromePath = $ChromePath
        NodePath = $NodePath
        HermesPythonPath = $resolvedHermesPythonPath
        Confirm = $false
    }
    if ($ConfirmKakaoGatewayCutover.IsPresent) {
        $parameters['ConfirmKakaoGatewayCutover'] = $true
        $parameters['GatewayMaintenance'] = $true
        $parameters['BenchmarkReportPath'] = $BenchmarkReportPath
        $parameters['PluginReceiptPath'] = $PluginReceiptPath
        $parameters['SmokeEvidencePath'] = $SmokeEvidencePath
    }
    & $liveStartScriptPath @parameters | Out-Null
}

function Test-KakaoworkerGatewayHealthy {
    $task = Get-ScheduledTask -TaskName 'Hermes_Gateway_Kakaoworker_Native' -ErrorAction SilentlyContinue
    $pidPath = Join-Path $env:LOCALAPPDATA 'hermes\profiles\kakaoworker\gateway.pid'
    if ($null -eq $task -or $task.State -eq 'Disabled' -or -not (Test-Path -LiteralPath $pidPath -PathType Leaf)) {
        return $false
    }
    try {
        $gatewayPid = [int](([IO.File]::ReadAllText($pidPath, [Text.Encoding]::UTF8) | ConvertFrom-Json).pid)
        return $gatewayPid -gt 0 -and $null -ne (Get-Process -Id $gatewayPid -ErrorAction SilentlyContinue)
    }
    catch { return $false }
}

$pluginReceipt = $null
$smokeEvidence = $null
if ($ConfirmKakaoGatewayCutover.IsPresent) {
    if ([string]::IsNullOrWhiteSpace($BenchmarkReportPath)) { throw 'Gateway watchdog requires BenchmarkReportPath.' }
    $resolvedBenchmarkReportPath = (Resolve-Path -LiteralPath $BenchmarkReportPath -ErrorAction Stop).Path
    $benchmarkReport = [IO.File]::ReadAllText($resolvedBenchmarkReportPath, [Text.Encoding]::UTF8) | ConvertFrom-Json -ErrorAction Stop
    if ($benchmarkReport.accepted -ne $true -or $benchmarkReport.latency_status -ne 'pass') {
        throw 'Gateway watchdog refuses a blocked or failed benchmark.'
    }
    if ([string]::IsNullOrWhiteSpace($PluginReceiptPath) -or [string]::IsNullOrWhiteSpace($SmokeEvidencePath)) {
        throw 'Gateway watchdog requires plugin receipt and native smoke evidence paths.'
    }
    $pluginReceipt = [IO.File]::ReadAllText((Resolve-Path -LiteralPath $PluginReceiptPath -ErrorAction Stop).Path, [Text.Encoding]::UTF8) | ConvertFrom-Json -ErrorAction Stop
    $smokeEvidence = [IO.File]::ReadAllText((Resolve-Path -LiteralPath $SmokeEvidencePath -ErrorAction Stop).Path, [Text.Encoding]::UTF8) | ConvertFrom-Json -ErrorAction Stop
    if (-not (Test-KakaoPluginInstallReceipt -Receipt $pluginReceipt)) {
        throw 'Gateway watchdog refuses installed plugin hash drift.'
    }
    if (-not (Test-KakaoworkerGatewayHealthy)) {
        if (-not $PSCmdlet.ShouldProcess('Hermes_Gateway_Kakaoworker_Native', 'Heal only the kakaoworker Gateway')) { return }
        $gatewayRestart = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot 'restart-hermes-gateway.ps1')).Path
        & $gatewayRestart -Target kakaoworker -HealOnly | Out-Null
        if (-not (Test-KakaoworkerGatewayHealthy)) { throw 'kakaoworker Gateway recovery failed.' }
        Write-WatchdogLog 'kakaoworker Gateway healed independently; root Slack Gateway untouched'
    }
}

$componentNames = @('chrome', 'bridge')
if ($IncludeGateway.IsPresent) {
    if ([string]::IsNullOrWhiteSpace($HermesPath)) {
        throw 'HermesPath is required when IncludeGateway is supplied.'
    }
    $componentNames += 'gateway'
}

# 빈 배열이 $null로 언롤되는 PowerShell 특성 방어: 파이프로 걸러 항상 배열화한다.
$unhealthy = @(Get-UnhealthyComponents -Names $componentNames | Where-Object { $_ })
if ($unhealthy.Count -eq 0) {
    $runtimeProbe = Get-KakaoDirectProbe
    if ($ConfirmKakaoGatewayCutover.IsPresent) {
        $gatewayHealth = Invoke-RestMethod -Uri 'http://127.0.0.1:8787/health' -TimeoutSec 5
        $pidPath = Join-Path $env:LOCALAPPDATA 'hermes\profiles\kakaoworker\gateway.pid'
        $gatewayPid = if (Test-Path -LiteralPath $pidPath -PathType Leaf) {
            try { [int](([IO.File]::ReadAllText($pidPath, [Text.Encoding]::UTF8) | ConvertFrom-Json).pid) } catch { 0 }
        } else { 0 }
        $gatewayRuntime = [pscustomobject]@{
            profile = 'kakaoworker'
            pid = $gatewayPid
            pluginPath = [string]$pluginReceipt.targetPluginPath
            manifestSha256 = [string]$pluginReceipt.manifestSha256
            pluginReceiptVerified = Test-KakaoPluginInstallReceipt -Receipt $pluginReceipt
        }
        $gatewayOnlyProbe = [pscustomobject]@{ state = 'healthy'; cdpReady = $true; authenticated = $true; watcherReady = $true }
        if (-not (Test-KakaoGatewayCutoverHealth -Health $gatewayHealth -RuntimeProbe $gatewayOnlyProbe `
            -GatewayRuntime $gatewayRuntime -SmokeEvidence $smokeEvidence)) {
            throw 'Gateway watchdog direct plugin/consumer/queue/safety readback failed; refusing broad recovery.'
        }
        if (Test-KakaoGatewayCutoverHealth -Health $gatewayHealth -RuntimeProbe $runtimeProbe `
            -GatewayRuntime $gatewayRuntime -SmokeEvidence $smokeEvidence) { return }
    }
    elseif (Test-KakaoLiveRuntimeProbe -Probe $runtimeProbe) { return }
    if (-not $PSCmdlet.ShouldProcess('Windows Kakao production authentication/watcher', 'Recover only the failed live layer')) {
        return
    }
    Write-WatchdogLog ("runtime probe requires recovery: {0}" -f (Get-KakaoLiveRuntimeState -Probe $runtimeProbe))
    Invoke-KakaoLiveEvaluator
    Write-WatchdogLog 'live authentication/watcher evaluation completed'
    return
}

if (-not $PSCmdlet.ShouldProcess('Windows Kakao production runtime', 'Restart dead owned runtime with writes enabled')) {
    return
}

Write-WatchdogLog ("unhealthy components detected: {0}" -f ($unhealthy -join ', '))

try {
    & $stopScriptPath -Confirm:$false | Out-Null
    Write-WatchdogLog 'owned stop completed'
}
catch {
    # 살아 있는 PID의 소유권 불일치 등 — 자동 재시작 금지 상태. 사람 확인 필요.
    Write-WatchdogLog ("owned stop refused; manual intervention required: {0}" -f $_.Exception.Message)
    throw
}

try {
    $startParameters = @{
        EnvFile      = $EnvFile
        ChromePath   = $ChromePath
        NodePath     = $NodePath
        HermesPythonPath = $resolvedHermesPythonPath
        HermesTransport = if ($ConfirmKakaoGatewayCutover.IsPresent) { 'gateway' } else { 'cli' }
        EnableWrites = $true
        Confirm      = $false
    }
    if ($IncludeGateway.IsPresent) {
        $startParameters['HermesPath'] = $HermesPath
        $startParameters['IncludeGateway'] = $true
    }
    & $startScriptPath @startParameters | Out-Null
    Write-WatchdogLog 'write-enabled production start completed'
    Invoke-KakaoLiveEvaluator
    Write-WatchdogLog 'post-start authentication/watcher evaluation completed'
}
catch {
    Write-WatchdogLog ("write-enabled production start failed: {0}" -f $_.Exception.Message)
    throw
}
