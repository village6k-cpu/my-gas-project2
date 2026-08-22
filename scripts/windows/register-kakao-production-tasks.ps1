# 카카오 프로덕션 상시가동 등록 — 컷오버 승인 이후에만 사용한다.
# 스테이징용 register-kakao-scheduled-tasks.ps1(비활성·no-send 계약)과 달리,
# 이 스크립트는 로그온 시 -EnableWrites 자동 시작 태스크와 주기 워치독 태스크를
# ENABLED 상태로 등록한다. 맥미니가 더 이상 프로덕션 소유자가 아니고 윈도우가
# 유일한 라이브 워커임을 운영자가 확인했을 때, -ConfirmProductionOwnership로
# 그 승인을 명시해야만 동작한다(런북 Cutover 4단계 완료가 전제).
[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'High')]
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

    [ValidateRange(2, 120)]
    [int]$WatchdogIntervalMinutes = 5,

    [string]$BenchmarkReportPath = (Join-Path (Join-Path $PSScriptRoot '..\..') 'docs\kakao-hermes-gateway-benchmark-report.json'),

    [string]$PluginReceiptPath = (Join-Path $env:LOCALAPPDATA 'hermes\profiles\kakaoworker\plugin-state\kakao_village.json'),

    [string]$SmokeEvidencePath = '',

    [switch]$ConfirmProductionOwnership,

    [switch]$ConfirmKakaoGatewayCutover,

    [switch]$PlanOnly
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

Import-Module (Join-Path $PSScriptRoot 'KakaoStaging.Common.psm1') -Force

$repoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..') -ErrorAction Stop).Path
$resolvedEnvFile = (Resolve-Path -LiteralPath $EnvFile -ErrorAction Stop).Path
$resolvedChromePath = (Resolve-Path -LiteralPath $ChromePath -ErrorAction Stop).Path
$resolvedNodePath = (Resolve-Path -LiteralPath $NodePath -ErrorAction Stop).Path
$resolvedHermesPythonPath = (Resolve-Path -LiteralPath $HermesPythonPath -ErrorAction Stop).Path
$resolvedBenchmarkReportPath = (Resolve-Path -LiteralPath $BenchmarkReportPath -ErrorAction Stop).Path
$resolvedPluginReceiptPath = [IO.Path]::GetFullPath($PluginReceiptPath)
$resolvedSmokeEvidencePath = if ([string]::IsNullOrWhiteSpace($SmokeEvidencePath)) { '' } else { [IO.Path]::GetFullPath($SmokeEvidencePath) }
$startScriptPath = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot 'start-kakao-live.ps1') -ErrorAction Stop).Path
$watchdogScriptPath = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot 'watch-kakao-production.ps1') -ErrorAction Stop).Path

$powerShellExecutable = if ($PSVersionTable.PSEdition -eq 'Core') {
    Join-Path $PSHOME 'pwsh.exe'
}
else {
    Join-Path $PSHOME 'powershell.exe'
}
$powerShellExecutable = (Resolve-Path -LiteralPath $powerShellExecutable -ErrorAction Stop).Path

function New-ProductionArgumentLine {
    param(
        [Parameter(Mandatory = $true)][string]$ScriptPath,
        [Parameter(Mandatory = $true)][bool]$WithEnableWrites,
        [switch]$GatewayMaintenance
    )

    $parts = @(
        '-NoProfile',
        '-NonInteractive',
        '-WindowStyle',
        'Hidden',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        (ConvertTo-WindowsCommandLineArgument -Value $ScriptPath),
        '-EnvFile',
        (ConvertTo-WindowsCommandLineArgument -Value $resolvedEnvFile),
        '-ChromePath',
        (ConvertTo-WindowsCommandLineArgument -Value $resolvedChromePath),
        '-NodePath',
        (ConvertTo-WindowsCommandLineArgument -Value $resolvedNodePath),
        '-HermesPythonPath',
        (ConvertTo-WindowsCommandLineArgument -Value $resolvedHermesPythonPath),
        '-BenchmarkReportPath',
        (ConvertTo-WindowsCommandLineArgument -Value $resolvedBenchmarkReportPath),
        '-PluginReceiptPath',
        (ConvertTo-WindowsCommandLineArgument -Value $resolvedPluginReceiptPath),
        '-SmokeEvidencePath',
        (ConvertTo-WindowsCommandLineArgument -Value $resolvedSmokeEvidencePath),
        '-ConfirmKakaoGatewayCutover'
    )
    if ($IncludeGateway.IsPresent) {
        if ([string]::IsNullOrWhiteSpace($HermesPath)) {
            throw 'HermesPath is required when IncludeGateway is supplied.'
        }
        $resolvedHermesPath = (Resolve-Path -LiteralPath $HermesPath -ErrorAction Stop).Path
        $parts += @(
            '-HermesPath',
            (ConvertTo-WindowsCommandLineArgument -Value $resolvedHermesPath),
            '-IncludeGateway'
        )
    }
    if ($WithEnableWrites) {
        $parts += '-EnableWrites'
    }
    if ($GatewayMaintenance.IsPresent) {
        $parts += '-GatewayMaintenance'
    }
    # -Confirm는 넘기지 않는다. 두 스크립트 모두 ConfirmImpact Medium이라 기본
    # ConfirmPreference(High)에서 프롬프트 없이 진행되고, powershell.exe -File은
    # `-Confirm:$false` 형태 인자를 신뢰성 있게 바인딩하지 못한다.
    return $parts -join ' '
}

$startArguments = New-ProductionArgumentLine -ScriptPath $startScriptPath -WithEnableWrites $false -GatewayMaintenance
$watchdogArguments = New-ProductionArgumentLine -ScriptPath $watchdogScriptPath -WithEnableWrites $false

$registrationPlan = [pscustomobject]@{
    schema = 'village-kakao-production-task-plan/v2'
    mode = if ($PlanOnly.IsPresent) { 'plan' } else { 'apply' }
    benchmarkReportPath = $resolvedBenchmarkReportPath
    pluginReceiptPath = $resolvedPluginReceiptPath
    smokeEvidencePath = $resolvedSmokeEvidencePath
    requiredConfirmations = @('ConfirmProductionOwnership', 'ConfirmKakaoGatewayCutover')
    tasks = @(
        [pscustomobject]@{ name = 'Village-Kakao-Production-Start'; enabled = $true; arguments = $startArguments },
        [pscustomobject]@{ name = 'Village-Kakao-Production-Watchdog'; enabled = $true; arguments = $watchdogArguments }
    )
    rootSlackGatewayMutated = $false
}
if ($PlanOnly.IsPresent) {
    $registrationPlan | ConvertTo-Json -Depth 6
    return
}

if (-not $ConfirmProductionOwnership.IsPresent) {
    throw 'Production registration requires -ConfirmProductionOwnership: confirm the Mac (or any other machine) no longer owns the Kakao bridge/worker before enabling an always-on write path.'
}
if (-not $ConfirmKakaoGatewayCutover.IsPresent) {
    throw 'Production registration requires -ConfirmKakaoGatewayCutover after an accepted provider-backed benchmark.'
}
if ([string]::IsNullOrWhiteSpace($resolvedSmokeEvidencePath) -or
    -not (Test-Path -LiteralPath $resolvedSmokeEvidencePath -PathType Leaf) -or
    -not (Test-Path -LiteralPath $resolvedPluginReceiptPath -PathType Leaf)) {
    throw 'Production registration requires existing plugin receipt and native smoke evidence files.'
}
$benchmarkReport = [IO.File]::ReadAllText($resolvedBenchmarkReportPath, [Text.Encoding]::UTF8) | ConvertFrom-Json -ErrorAction Stop
if ($benchmarkReport.accepted -ne $true -or $benchmarkReport.latency_status -ne 'pass') {
    throw 'Production registration refuses a blocked or failed Kakao Gateway benchmark.'
}

$enabledSettings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew
$logonTrigger = New-ScheduledTaskTrigger -AtLogOn
# Windows Task Scheduler가 거부하는 TimeSpan.MaxValue 대신 충분히 긴 10년 반복창을 사용한다.
$watchdogTrigger = New-ScheduledTaskTrigger -Once -At ([DateTime]::Now.AddMinutes(2)) `
    -RepetitionInterval (New-TimeSpan -Minutes $WatchdogIntervalMinutes) `
    -RepetitionDuration (New-TimeSpan -Days 3650)

$taskDefinitions = @(
    [pscustomobject]@{
        Name        = 'Village-Kakao-Production-Start'
        Description = 'Write-enabled Windows Kakao startup plus authentication/watcher recovery at logon (post-cutover).'
        Trigger     = $logonTrigger
        Action      = New-ScheduledTaskAction -Execute $powerShellExecutable -Argument $startArguments -WorkingDirectory $repoRoot
    },
    [pscustomobject]@{
        Name        = 'Village-Kakao-Production-Watchdog'
        Description = 'Restarts the owned Kakao production runtime when its processes or ports die.'
        Trigger     = $watchdogTrigger
        Action      = New-ScheduledTaskAction -Execute $powerShellExecutable -Argument $watchdogArguments -WorkingDirectory $repoRoot
    }
)

if (-not $PSCmdlet.ShouldProcess('Village Windows Kakao production scheduled tasks', 'Register enabled write-path definitions')) {
    return
}

foreach ($definition in $taskDefinitions) {
    Register-ScheduledTask -TaskName $definition.Name -Action $definition.Action -Trigger $definition.Trigger -Settings $enabledSettings -Description $definition.Description -Force | Out-Null
}

# 스테이징 시절의 비활성 태스크가 남아 있으면 혼동을 막기 위해 상태만 보고한다(삭제하지 않음).
foreach ($stagingTaskName in @('Village-Kakao-Staging-Status', 'Village-Kakao-Staging-Start')) {
    $stagingTask = Get-ScheduledTask -TaskName $stagingTaskName -ErrorAction SilentlyContinue
    if ($null -ne $stagingTask) {
        Write-Output ("staging task '{0}' remains registered with state '{1}'" -f $stagingTaskName, $stagingTask.State)
    }
}

Write-Output 'Village-Kakao-Production-Start and Village-Kakao-Production-Watchdog registered and enabled.'
