<#
.SYNOPSIS
Registers the root lineage watchdog and a profile-scoped Kakao Gateway task.

.DESCRIPTION
The root Slack Gateway task is never rewritten. The kakaoworker task is
registered disabled by default and runs only through Task Scheduler clean
lineage. Use -PlanOnly for a strictly read-only task plan.
#>
[CmdletBinding()]
param(
    [string]$HermesHome = (Join-Path $env:LOCALAPPDATA 'hermes'),
    [string]$HermesPythonPath = '',
    [Parameter(Mandatory = $true)][ValidateNotNullOrEmpty()][string]$EnvFile,
    [switch]$EnableKakaoworker,
    [switch]$PlanOnly
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Get-FullPath {
    param([Parameter(Mandatory = $true)][string]$Path)
    return [IO.Path]::GetFullPath($Path).TrimEnd('\', '/')
}

function Quote-TaskArgument {
    param([Parameter(Mandatory = $true)][string]$Value)
    return '"' + $Value.Replace('"', '\"') + '"'
}

$resolvedHermesHome = Get-FullPath -Path $HermesHome
if ([string]::IsNullOrWhiteSpace($HermesPythonPath)) {
    $HermesPythonPath = Join-Path $resolvedHermesHome 'hermes-agent\venv\Scripts\python.exe'
}
$resolvedPython = Get-FullPath -Path (Resolve-Path -LiteralPath $HermesPythonPath -ErrorAction Stop).Path
$resolvedEnvFile = Get-FullPath -Path (Resolve-Path -LiteralPath $EnvFile -ErrorAction Stop).Path
$expectedPython = Get-FullPath -Path (Join-Path $resolvedHermesHome 'hermes-agent\venv\Scripts\python.exe')
if (-not $resolvedPython.Equals($expectedPython, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Hermes_Gateway_Kakaoworker_Native must use hermes-agent\venv\Scripts\python.exe.'
}

$wrapperPs1 = Join-Path $PSScriptRoot 'restart-hermes-gateway.ps1'
$launcherPs1 = Join-Path $PSScriptRoot 'start-hermes-kakaoworker-gateway.ps1'
$psExe = 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe'
foreach ($required in @($wrapperPs1, $launcherPs1, $psExe)) {
    if (-not (Test-Path -LiteralPath $required -PathType Leaf)) { throw "Required Gateway launcher is missing: '$required'." }
}

$hiddenDir = Join-Path $env:LOCALAPPDATA 'Village\hidden-tasks'
$watchVbs = Join-Path $hiddenDir 'Village-Hermes-Gateway-Lineage-Watchdog.vbs'
$kakaoArguments = @(
    '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass',
    '-File', (Quote-TaskArgument -Value $launcherPs1),
    '-HermesHome', (Quote-TaskArgument -Value $resolvedHermesHome),
    '-HermesPythonPath', (Quote-TaskArgument -Value $resolvedPython),
    '-EnvFile', (Quote-TaskArgument -Value $resolvedEnvFile)
) -join ' '

$plan = [ordered]@{
    ok = $true
    mode = if ($PlanOnly.IsPresent) { 'plan' } else { 'apply' }
    root = [ordered]@{
        taskName = 'Hermes_Gateway'
        mutated = $false
        watchdogTaskName = 'Village-Hermes-Gateway-Lineage-Watchdog'
    }
    kakaoworker = [ordered]@{
        taskName = 'Hermes_Gateway_Kakaoworker_Native'
        legacyTaskPreserved = 'Hermes_Gateway_Kakaoworker'
        enabled = $EnableKakaoworker.IsPresent
        profile = 'kakaoworker'
        executable = $psExe
        actionScript = $launcherPs1
        arguments = $kakaoArguments
        pythonPath = $resolvedPython
        envFile = $resolvedEnvFile
        pidFile = Join-Path $resolvedHermesHome 'profiles\kakaoworker\gateway.pid'
        pluginPath = Join-Path $resolvedHermesHome 'profiles\kakaoworker\plugins\kakao_village'
        launchCommand = @($resolvedPython, '-m', 'hermes_cli.main', '--profile', 'kakaoworker', 'gateway', 'run')
        cleanLineage = $true
    }
}
if ($PlanOnly.IsPresent) {
    [pscustomobject]$plan | ConvertTo-Json -Depth 6 -Compress
    exit 0
}

[void](New-Item -ItemType Directory -Path $hiddenDir -Force -ErrorAction Stop)
$vbsLine = 'CreateObject("WScript.Shell").Run """' + $psExe + '"" -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File ""' + $wrapperPs1 + '"" -Target root -HealOnly", 0, False'
Set-Content -LiteralPath $watchVbs -Value $vbsLine -Encoding ASCII

$kakaoAction = New-ScheduledTaskAction -Execute $psExe -Argument $kakaoArguments
$kakaoSettings = New-ScheduledTaskSettingsSet `
    -MultipleInstances IgnoreNew `
    -StartWhenAvailable `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -ExecutionTimeLimit ([TimeSpan]::Zero)
Register-ScheduledTask -TaskName 'Hermes_Gateway_Kakaoworker_Native' `
    -Description 'Profile-scoped native Hermes Gateway for Village Kakao bridge events' `
    -Action $kakaoAction -Settings $kakaoSettings -Force -ErrorAction Stop | Out-Null
if ($EnableKakaoworker.IsPresent) {
    Enable-ScheduledTask -TaskName 'Hermes_Gateway_Kakaoworker_Native' -ErrorAction Stop | Out-Null
}
else {
    Disable-ScheduledTask -TaskName 'Hermes_Gateway_Kakaoworker_Native' -ErrorAction Stop | Out-Null
}

$existingWatchdog = Get-ScheduledTask -TaskName 'Village-Hermes-Gateway-Lineage-Watchdog' -ErrorAction SilentlyContinue
if ($null -eq $existingWatchdog) {
    $watchAction = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument ('//B //Nologo "{0}"' -f $watchVbs)
    $watchTrigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(5) `
        -RepetitionInterval (New-TimeSpan -Minutes 30)
    $watchSettings = New-ScheduledTaskSettingsSet `
        -MultipleInstances IgnoreNew `
        -StartWhenAvailable `
        -AllowStartIfOnBatteries `
        -DontStopIfGoingOnBatteries `
        -ExecutionTimeLimit (New-TimeSpan -Minutes 15)
    Register-ScheduledTask -TaskName 'Village-Hermes-Gateway-Lineage-Watchdog' `
        -Description 'Detect and heal the poisoned or dead root Hermes Slack gateway every 30 minutes' `
        -Action $watchAction -Trigger $watchTrigger -Settings $watchSettings -ErrorAction Stop | Out-Null
}

[pscustomobject]$plan | ConvertTo-Json -Depth 6 -Compress
