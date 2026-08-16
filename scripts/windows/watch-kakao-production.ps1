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

    [switch]$IncludeGateway
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
    & $liveStartScriptPath -EnvFile $EnvFile -ChromePath $ChromePath -NodePath $NodePath `
        -HermesPythonPath $resolvedHermesPythonPath -Confirm:$false | Out-Null
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
    if (Test-KakaoLiveRuntimeProbe -Probe $runtimeProbe) { return }
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
