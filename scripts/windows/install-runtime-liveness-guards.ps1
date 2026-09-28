[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'High')]
param(
    [Parameter(Mandatory = $true)][string]$ProductionRoot,
    [Parameter(Mandatory = $true)][string]$EnvFile,
    [Parameter(Mandatory = $true)][string]$ChromePath,
    [Parameter(Mandatory = $true)][string]$NodePath,
    [Parameter(Mandatory = $true)][string]$HermesPythonPath,
    [Parameter(Mandatory = $true)][string]$BenchmarkReportPath,
    [Parameter(Mandatory = $true)][string]$PluginReceiptPath,
    [Parameter(Mandatory = $true)][string]$SmokeEvidencePath,
    [switch]$ConfirmInstall
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if (-not $ConfirmInstall.IsPresent) {
    throw 'Refusing to install runtime guards without -ConfirmInstall.'
}

$stableDirectory = Join-Path $env:LOCALAPPDATA 'Village\runtime-guards'
$rootTaskName = 'Village-Hermes-Root-Liveness-Guard'
$kakaoTaskName = 'Village-Kakao-Production-Liveness-Guard'
$legacyTaskName = 'Village-Kakao-Production-Watchdog'
$powershellPath = 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe'
$sourceFiles = @(
    'HermesRootLiveness.Common.psm1',
    'KakaoLivenessGuard.Common.psm1',
    'watch-hermes-root-liveness.ps1',
    'watch-kakao-production-guard.ps1'
)

function ConvertTo-QuotedTaskArgument {
    param([Parameter(Mandatory = $true)][string]$Value)
    return '"{0}"' -f $Value.Replace('"', '""')
}

if (-not $PSCmdlet.ShouldProcess($stableDirectory, 'Install guarded Hermes and Kakao liveness tasks')) {
    return
}

[void](New-Item -ItemType Directory -Path $stableDirectory -Force)
foreach ($fileName in $sourceFiles) {
    $sourcePath = Join-Path $PSScriptRoot $fileName
    if (-not (Test-Path -LiteralPath $sourcePath -PathType Leaf)) {
        throw "Required guard file is missing: $sourcePath"
    }
    Copy-Item -LiteralPath $sourcePath -Destination (Join-Path $stableDirectory $fileName) -Force
}

$rootScript = Join-Path $stableDirectory 'watch-hermes-root-liveness.ps1'
$kakaoScript = Join-Path $stableDirectory 'watch-kakao-production-guard.ps1'
$commonPrefix = '-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File'
$rootArguments = '{0} {1}' -f $commonPrefix, (ConvertTo-QuotedTaskArgument $rootScript)
$kakaoArguments = @(
    $commonPrefix,
    (ConvertTo-QuotedTaskArgument $kakaoScript),
    '-ProductionRoot', (ConvertTo-QuotedTaskArgument $ProductionRoot),
    '-EnvFile', (ConvertTo-QuotedTaskArgument $EnvFile),
    '-ChromePath', (ConvertTo-QuotedTaskArgument $ChromePath),
    '-NodePath', (ConvertTo-QuotedTaskArgument $NodePath),
    '-HermesPythonPath', (ConvertTo-QuotedTaskArgument $HermesPythonPath),
    '-BenchmarkReportPath', (ConvertTo-QuotedTaskArgument $BenchmarkReportPath),
    '-PluginReceiptPath', (ConvertTo-QuotedTaskArgument $PluginReceiptPath),
    '-SmokeEvidencePath', (ConvertTo-QuotedTaskArgument $SmokeEvidencePath)
) -join ' '

$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited
$rootAction = New-ScheduledTaskAction -Execute $powershellPath -Argument $rootArguments
$kakaoAction = New-ScheduledTaskAction -Execute $powershellPath -Argument $kakaoArguments
$rootTrigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) `
    -RepetitionInterval (New-TimeSpan -Minutes 1) -RepetitionDuration (New-TimeSpan -Days 3650)
$kakaoTrigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) `
    -RepetitionInterval (New-TimeSpan -Minutes 5) -RepetitionDuration (New-TimeSpan -Days 3650)
$rootSettings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -StartWhenAvailable `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 3)
$kakaoSettings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -StartWhenAvailable `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 15)

Register-ScheduledTask -TaskName $rootTaskName -Action $rootAction -Trigger $rootTrigger `
    -Settings $rootSettings -Principal $principal `
    -Description 'Cheap root Hermes liveness guard; starts only after verified stale absence.' -Force | Out-Null
Register-ScheduledTask -TaskName $kakaoTaskName -Action $kakaoAction -Trigger $kakaoTrigger `
    -Settings $kakaoSettings -Principal $principal `
    -Description 'Circuit-breaker Kakao guard with bridge-only and confirmation-gated escalation.' -Force | Out-Null

$legacyTask = Get-ScheduledTask -TaskName $legacyTaskName -ErrorAction SilentlyContinue
if ($null -ne $legacyTask -and [string]$legacyTask.State -ne 'Disabled') {
    Disable-ScheduledTask -TaskName 'Village-Kakao-Production-Watchdog' | Out-Null
}

[pscustomobject]@{
    ok = $true
    installDirectory = $stableDirectory
    rootTask = $rootTaskName
    kakaoTask = $kakaoTaskName
    legacyWatchdogDisabled = [string](Get-ScheduledTask -TaskName $legacyTaskName -ErrorAction SilentlyContinue).State -eq 'Disabled'
} | ConvertTo-Json -Compress
