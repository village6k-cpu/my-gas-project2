[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string]$EnvFile
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

Import-Module (Join-Path $PSScriptRoot 'KakaoStaging.Common.psm1') -Force

$baseRequiredNames = @(
    'SUPABASE_URL',
    'SUPABASE_SERVICE_ROLE_KEY',
    'SUPABASE_TABLE',
    'SUPABASE_FOLLOW_UP_TABLE',
    'HERMES_WORKER_COMMAND',
    'HERMES_WORKER_PROFILE',
    'BLUEBUBBLES_SERVER_URL',
    'BLUEBUBBLES_PASSWORD'
)
$configurationPresence = [ordered]@{}
foreach ($name in $baseRequiredNames) {
    $configurationPresence[$name] = $false
}
$lineNumber = 0
foreach ($line in Get-Content -LiteralPath (Resolve-Path -LiteralPath $EnvFile -ErrorAction Stop).Path -ErrorAction Stop) {
    $lineNumber += 1
    $trimmed = $line.Trim()
    if ($trimmed.Length -eq 0 -or $trimmed.StartsWith('#')) {
        continue
    }

    $separator = $line.IndexOf('=')
    if ($separator -lt 1) {
        throw "Malformed environment file line $lineNumber."
    }
    $name = $line.Substring(0, $separator).Trim()
    $value = $line.Substring($separator + 1)

    if ($configurationPresence.Contains($name)) {
        $configurationPresence[$name] = -not [string]::IsNullOrWhiteSpace($value)
    }
}

$bridgeRecord = Read-OwnedProcessRecord -Name 'bridge'
$requiredNames = @($baseRequiredNames)
$configurationSet = [ordered]@{}
foreach ($name in $requiredNames) {
    $configurationSet[$name] = $configurationPresence[$name]
}

function Get-OwnedComponentState {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Name,

        [ValidateRange(0, 65535)]
        [int]$DefaultPort = 0
    )

    $record = Read-OwnedProcessRecord -Name $Name
    $effectivePort = $DefaultPort
    if ($null -eq $record) {
        $state = 'not_owned'
        $pidValue = $null
        $executable = $null
    }
    else {
        $state = if (Test-OwnedProcessRecord -Record $record) { 'running' } else { 'ownership_mismatch' }
        $parsedPid = 0
        $pidValue = if ([int]::TryParse([string]$record.Pid, [ref]$parsedPid)) { $parsedPid } else { $null }
        $executable = if ([string]::IsNullOrWhiteSpace([string]$record.ExecutablePath)) {
            $null
        }
        else {
            [IO.Path]::GetFileName([string]$record.ExecutablePath)
        }

        $portProperty = $record.PSObject.Properties['Port']
        if ($null -ne $portProperty) {
            $recordedPort = 0
            if ([int]::TryParse([string]$record.Port, [ref]$recordedPort) -and $recordedPort -ge 1 -and $recordedPort -le 65535) {
                $effectivePort = $recordedPort
            }
        }
    }

    $portReachable = if ($effectivePort -eq 0) { $null } else { Test-LocalTcpPort -Port $effectivePort }
    return [ordered]@{
        State         = $state
        Pid           = $pidValue
        Executable    = $executable
        PortReachable = $portReachable
    }
}

$profilePath = Join-Path (Join-Path $env:LOCALAPPDATA 'Village') 'chrome-kakao'
$workerEnabled = $false
if ($null -ne $bridgeRecord -and $null -ne $bridgeRecord.PSObject.Properties['WorkerEnabled']) {
    $workerEnabled = [bool]$bridgeRecord.WorkerEnabled
}
$status = [ordered]@{
    Processes = [ordered]@{
        Chrome  = Get-OwnedComponentState -Name 'chrome' -DefaultPort 9223
        Bridge  = Get-OwnedComponentState -Name 'bridge' -DefaultPort 8787
        Gateway = Get-OwnedComponentState -Name 'gateway'
    }
    ProfilePath   = $profilePath
    workerEnabled = $workerEnabled
    Configuration = $configurationSet
}

$status | ConvertTo-Json -Depth 5
