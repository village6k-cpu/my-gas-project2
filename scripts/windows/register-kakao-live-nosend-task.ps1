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

    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string]$HermesPythonPath,

    [switch]$Enable,

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
$startScript = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot 'start-kakao-live-nosend.ps1') -ErrorAction Stop).Path
$taskName = 'Village-Kakao-Live-NoSend-Start'
$conflictingTaskName = 'Village-Kakao-Live-Start'
$currentUser = [Security.Principal.WindowsIdentity]::GetCurrent().Name

$plan = [pscustomobject]@{
    taskName = $taskName
    enabled = $Enable.IsPresent
    triggers = @('AtLogOn', 'Every2Minutes')
    selfHealInterval = 'PT2M'
    conflictingTask = $conflictingTaskName
    userId = $currentUser
    runLevel = 'Limited'
    actionScript = $startScript
    workingDirectory = $repoRoot
    autoSendEnabled = $false
    hermesCommandMode = 'python_module'
}

if ($PlanOnly.IsPresent) {
    $plan | ConvertTo-Json -Depth 4
    return
}

$powerShellExecutable = (Resolve-Path -LiteralPath (Join-Path $PSHOME 'powershell.exe') -ErrorAction Stop).Path
$arguments = @(
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    (ConvertTo-WindowsCommandLineArgument -Value $startScript),
    '-EnvFile',
    (ConvertTo-WindowsCommandLineArgument -Value $resolvedEnvFile),
    '-ChromePath',
    (ConvertTo-WindowsCommandLineArgument -Value $resolvedChromePath),
    '-NodePath',
    (ConvertTo-WindowsCommandLineArgument -Value $resolvedNodePath),
    '-HermesPythonPath',
    (ConvertTo-WindowsCommandLineArgument -Value $resolvedHermesPythonPath)
) -join ' '

if (-not $PSCmdlet.ShouldProcess($taskName, "Register AX-2 live/no-send logon and two-minute self-heal task (enabled=$($Enable.IsPresent))")) {
    return
}

$action = New-ScheduledTaskAction -Execute $powerShellExecutable -Argument $arguments -WorkingDirectory $repoRoot
$logonTrigger = New-ScheduledTaskTrigger -AtLogOn -User $currentUser
$selfHealTrigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) `
    -RepetitionInterval (New-TimeSpan -Minutes 2) `
    -RepetitionDuration (New-TimeSpan -Days 3650)
$principal = New-ScheduledTaskPrincipal -UserId $currentUser -LogonType Interactive -RunLevel Limited
$settings = if ($Enable.IsPresent) {
    New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew
}
else {
    New-ScheduledTaskSettingsSet -Disable -StartWhenAvailable -MultipleInstances IgnoreNew
}

Register-ScheduledTask `
    -TaskName $taskName `
    -Action $action `
    -Trigger @($logonTrigger, $selfHealTrigger) `
    -Principal $principal `
    -Settings $settings `
    -Description 'AX-2 Kakao live classification and Slack cards, with customer auto-send and Slack action polling disabled.' `
    -Force | Out-Null

if ($Enable.IsPresent) {
    Enable-ScheduledTask -TaskName $taskName | Out-Null

    $conflictingTask = Get-ScheduledTask -TaskName $conflictingTaskName -ErrorAction SilentlyContinue
    if ($null -ne $conflictingTask) {
        $knownFullLiveAction = @($conflictingTask.Actions) | Where-Object {
            [string]$_.Arguments -match '(?i)start-kakao-live\.ps1(?:\"|\s|$)'
        }
        if ($null -ne $knownFullLiveAction) {
            Disable-ScheduledTask -TaskName $conflictingTaskName | Out-Null
        }
    }
}
else {
    Disable-ScheduledTask -TaskName $taskName | Out-Null
}

$registered = Get-ScheduledTask -TaskName $taskName -ErrorAction Stop
[pscustomobject]@{
    taskName = $registered.TaskName
    enabled = [bool]$registered.Settings.Enabled
    state = [string]$registered.State
    userId = $registered.Principal.UserId
    runLevel = [string]$registered.Principal.RunLevel
} | ConvertTo-Json -Compress
