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

    [string]$HermesPath,

    [switch]$IncludeGateway,

    [ValidateRange(2, 120)]
    [int]$WatchdogIntervalMinutes = 5,

    [switch]$ConfirmProductionOwnership
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

Import-Module (Join-Path $PSScriptRoot 'KakaoStaging.Common.psm1') -Force

if (-not $ConfirmProductionOwnership.IsPresent) {
    throw 'Production registration requires -ConfirmProductionOwnership: confirm the Mac (or any other machine) no longer owns the Kakao bridge/worker before enabling an always-on write path.'
}

$repoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..') -ErrorAction Stop).Path
$resolvedEnvFile = (Resolve-Path -LiteralPath $EnvFile -ErrorAction Stop).Path
$resolvedChromePath = (Resolve-Path -LiteralPath $ChromePath -ErrorAction Stop).Path
$resolvedNodePath = (Resolve-Path -LiteralPath $NodePath -ErrorAction Stop).Path
$startScriptPath = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot 'start-kakao-staging.ps1') -ErrorAction Stop).Path
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
        [Parameter(Mandatory = $true)][bool]$WithEnableWrites
    )

    $parts = @(
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        (ConvertTo-WindowsCommandLineArgument -Value $ScriptPath),
        '-EnvFile',
        (ConvertTo-WindowsCommandLineArgument -Value $resolvedEnvFile),
        '-ChromePath',
        (ConvertTo-WindowsCommandLineArgument -Value $resolvedChromePath),
        '-NodePath',
        (ConvertTo-WindowsCommandLineArgument -Value $resolvedNodePath)
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
    # -Confirm는 넘기지 않는다. 두 스크립트 모두 ConfirmImpact Medium이라 기본
    # ConfirmPreference(High)에서 프롬프트 없이 진행되고, powershell.exe -File은
    # `-Confirm:$false` 형태 인자를 신뢰성 있게 바인딩하지 못한다.
    return $parts -join ' '
}

$startArguments = New-ProductionArgumentLine -ScriptPath $startScriptPath -WithEnableWrites $true
$watchdogArguments = New-ProductionArgumentLine -ScriptPath $watchdogScriptPath -WithEnableWrites $false

$enabledSettings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew
$logonTrigger = New-ScheduledTaskTrigger -AtLogOn
# RepetitionDuration을 MaxValue로 명시해 모든 PS/OS 조합에서 무기한 반복을 보장한다.
$watchdogTrigger = New-ScheduledTaskTrigger -Once -At ([DateTime]::Now.AddMinutes(2)) `
    -RepetitionInterval (New-TimeSpan -Minutes $WatchdogIntervalMinutes) `
    -RepetitionDuration ([TimeSpan]::MaxValue)

$taskDefinitions = @(
    [pscustomobject]@{
        Name        = 'Village-Kakao-Production-Start'
        Description = 'Write-enabled Windows Kakao production startup at logon (post-cutover).'
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
