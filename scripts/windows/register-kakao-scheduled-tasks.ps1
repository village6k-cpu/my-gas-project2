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

    [string]$HermesPath,

    [switch]$IncludeGateway
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

Import-Module (Join-Path $PSScriptRoot 'KakaoStaging.Common.psm1') -Force

$repoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..') -ErrorAction Stop).Path
$resolvedEnvFile = (Resolve-Path -LiteralPath $EnvFile -ErrorAction Stop).Path
$resolvedChromePath = (Resolve-Path -LiteralPath $ChromePath -ErrorAction Stop).Path
$resolvedNodePath = (Resolve-Path -LiteralPath $NodePath -ErrorAction Stop).Path
$statusScriptPath = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot 'status-kakao-staging.ps1') -ErrorAction Stop).Path
$startScriptPath = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot 'start-kakao-staging.ps1') -ErrorAction Stop).Path

$powerShellExecutable = if ($PSVersionTable.PSEdition -eq 'Core') {
    Join-Path $PSHOME 'pwsh.exe'
}
else {
    Join-Path $PSHOME 'powershell.exe'
}
$powerShellExecutable = (Resolve-Path -LiteralPath $powerShellExecutable -ErrorAction Stop).Path

$statusArguments = @(
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    (ConvertTo-WindowsCommandLineArgument -Value $statusScriptPath),
    '-EnvFile',
    (ConvertTo-WindowsCommandLineArgument -Value $resolvedEnvFile)
) -join ' '

$startArgumentParts = @(
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    (ConvertTo-WindowsCommandLineArgument -Value $startScriptPath),
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
    $startArgumentParts += @(
        '-HermesPath',
        (ConvertTo-WindowsCommandLineArgument -Value $resolvedHermesPath),
        '-IncludeGateway'
    )
}
$startArguments = $startArgumentParts -join ' '

$trigger = New-ScheduledTaskTrigger -AtLogOn
$disabledSettings = New-ScheduledTaskSettingsSet -Disable
$taskDefinitions = @(
    [pscustomobject]@{
        Name        = 'Village-Kakao-Staging-Status'
        Description = 'Disabled Windows Kakao staging status probe.'
        Action      = New-ScheduledTaskAction -Execute $powerShellExecutable -Argument $statusArguments -WorkingDirectory $repoRoot
    },
    [pscustomobject]@{
        Name        = 'Village-Kakao-Staging-Start'
        Description = 'Disabled no-send Windows Kakao staging startup.'
        Action      = New-ScheduledTaskAction -Execute $powerShellExecutable -Argument $startArguments -WorkingDirectory $repoRoot
    }
)

if (-not $PSCmdlet.ShouldProcess('Village Windows Kakao staging scheduled tasks', 'Register disabled at-logon definitions')) {
    return
}

foreach ($definition in $taskDefinitions) {
    Register-ScheduledTask -TaskName $definition.Name -Action $definition.Action -Trigger $trigger -Settings $disabledSettings -Description $definition.Description -Force | Out-Null
    Disable-ScheduledTask -TaskName $definition.Name -ErrorAction Stop | Out-Null
}
