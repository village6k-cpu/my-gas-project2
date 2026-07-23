Set-StrictMode -Version Latest

$script:KakaoStagingSafeDefaults = [ordered]@{
    PORT                              = '8787'
    KAKAO_REMOTE_DEBUGGING_PORT       = '9223'
    AI_WORKER_LIVE                    = '0'
    AI_WORKER_AUTO_SEND               = '0'
    SLACK_ACTION_POLL_ENABLED         = '0'
    SLACK_AGENT_CARD_DELIVERY_ENABLED = '0'
    KAKAO_TAB_CLEANUP_ENABLED         = '1'
    KAKAO_WORKER_CONTROL_MODE         = 'devtools_first'
    KAKAO_WORKER_SEARCH_TARGET_CHAT   = '1'
    KAKAO_APPLESCRIPT_FALLBACK        = '0'
    AI_WORKER_DRY_RUN                 = '1'
    VILLAGE_WINDOWS_WRITES_ENABLED    = '0'
    VILLAGE_ROLE                      = 'mini'
    VILLAGE_DISABLE_MINI_PUSH         = '1'
    VILLAGE_VAULT_ROOT                = 'C:\Village\VILLAGE_Brain'
}

$script:KakaoStagingAlwaysForcedNames = @(
    'VILLAGE_ROLE',
    'VILLAGE_DISABLE_MINI_PUSH',
    'VILLAGE_VAULT_ROOT'
)

$script:KakaoStagingBooleanNames = @(
    'AI_WORKER_LIVE',
    'AI_WORKER_AUTO_SEND',
    'SLACK_ACTION_POLL_ENABLED',
    'SLACK_AGENT_CARD_DELIVERY_ENABLED',
    'KAKAO_TAB_CLEANUP_ENABLED',
    'KAKAO_WORKER_SEARCH_TARGET_CHAT',
    'KAKAO_APPLESCRIPT_FALLBACK',
    'AI_WORKER_DRY_RUN'
)

function Get-OwnedProcessRecordPath {
    param(
        [Parameter(Mandatory = $true)]
        [ValidatePattern('^[A-Za-z0-9_-]+$')]
        [string]$Name
    )

    return Join-Path (Get-KakaoStagingRoot) ("{0}.json" -f $Name)
}

function ConvertTo-WindowsCommandLineArgument {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [AllowEmptyString()]
        [string]$Value
    )

    if ($Value.Length -gt 0 -and $Value -notmatch '[\s"]') {
        return $Value
    }

    $builder = New-Object System.Text.StringBuilder
    [void]$builder.Append('"')
    $backslashCount = 0

    foreach ($character in $Value.ToCharArray()) {
        if ($character -eq [char]92) {
            $backslashCount += 1
            continue
        }

        if ($character -eq [char]34) {
            [void]$builder.Append((('\' * ($backslashCount * 2 + 1)) -join ''))
            [void]$builder.Append('"')
            $backslashCount = 0
            continue
        }

        if ($backslashCount -gt 0) {
            [void]$builder.Append((('\' * $backslashCount) -join ''))
            $backslashCount = 0
        }
        [void]$builder.Append($character)
    }

    if ($backslashCount -gt 0) {
        [void]$builder.Append((('\' * ($backslashCount * 2)) -join ''))
    }
    [void]$builder.Append('"')
    return $builder.ToString()
}

function Import-DotEnvFile {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [ValidateNotNullOrEmpty()]
        [string]$Path
    )

    $resolvedPath = (Resolve-Path -LiteralPath $Path -ErrorAction Stop).Path
    $lineNumber = 0

    foreach ($line in Get-Content -LiteralPath $resolvedPath -ErrorAction Stop) {
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
        if ($name -notmatch '^[A-Za-z_][A-Za-z0-9_]*$') {
            throw "Invalid environment setting name on line $lineNumber."
        }

        $value = $line.Substring($separator + 1)
        [Environment]::SetEnvironmentVariable($name, $value, 'Process')
    }
}

function Set-KakaoStagingSafeEnvironment {
    [CmdletBinding()]
    param(
        [switch]$EnableWrites
    )

    foreach ($entry in $script:KakaoStagingSafeDefaults.GetEnumerator()) {
        $currentValue = [Environment]::GetEnvironmentVariable($entry.Key, 'Process')
        if ($script:KakaoStagingAlwaysForcedNames -contains $entry.Key -or
            -not $EnableWrites.IsPresent -or
            [string]::IsNullOrWhiteSpace($currentValue)) {
            [Environment]::SetEnvironmentVariable($entry.Key, $entry.Value, 'Process')
        }
        elseif ($script:KakaoStagingBooleanNames -contains $entry.Key) {
            $normalizedValue = ConvertTo-KakaoStagingBooleanValue -Name $entry.Key -Value $currentValue
            [Environment]::SetEnvironmentVariable($entry.Key, $normalizedValue, 'Process')
        }
    }

    $lifecycleWriteMarker = if ($EnableWrites.IsPresent) { '1' } else { '0' }
    [Environment]::SetEnvironmentVariable('VILLAGE_WINDOWS_WRITES_ENABLED', $lifecycleWriteMarker, 'Process')
}

function ConvertTo-KakaoStagingBooleanValue {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [ValidateNotNullOrEmpty()]
        [string]$Name,

        [Parameter(Mandatory = $true)]
        [AllowEmptyString()]
        [string]$Value
    )

    switch ($Value.Trim().ToLowerInvariant()) {
        '1' { return '1' }
        'true' { return '1' }
        '0' { return '0' }
        'false' { return '0' }
        default { throw "Invalid boolean setting '$Name'; expected 1, 0, true, or false." }
    }
}

function Get-KakaoStagingRoot {
    [CmdletBinding()]
    param()

    if ([string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) {
        throw 'LOCALAPPDATA is required for Windows Kakao staging.'
    }

    return Join-Path (Join-Path $env:LOCALAPPDATA 'Village') 'kakao-staging'
}

function Initialize-KakaoStagingRuntimeStorage {
    [CmdletBinding()]
    param()

    $root = Get-KakaoStagingRoot
    [void](New-Item -ItemType Directory -Path $root -Force -ErrorAction Stop)

    $probeId = [Guid]::NewGuid().ToString('N')
    $temporary = Join-Path $root (".storage.$probeId.tmp")
    $destination = Join-Path $root (".storage.$probeId.probe")
    $encoding = New-Object System.Text.UTF8Encoding($false)

    try {
        [IO.File]::WriteAllText($temporary, 'storage-probe', $encoding)
        Move-Item -LiteralPath $temporary -Destination $destination -ErrorAction Stop | Out-Null
    }
    finally {
        Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath $destination -Force -ErrorAction SilentlyContinue
    }
}

function Write-OwnedProcessRecord {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [ValidatePattern('^[A-Za-z0-9_-]+$')]
        [string]$Name,

        [Parameter(Mandatory = $true)]
        [System.Diagnostics.Process]$Process,

        [Parameter(Mandatory = $true)]
        [ValidateNotNullOrEmpty()]
        [string]$ExecutablePath,

        [Parameter(Mandatory = $true)]
        [ValidateNotNullOrEmpty()]
        [string]$CommandMarker,

        [ValidateRange(0, 65535)]
        [int]$Port = 0,

        [Nullable[bool]]$WorkerEnabled = $null
    )

    $root = Get-KakaoStagingRoot
    [void](New-Item -ItemType Directory -Path $root -Force -ErrorAction Stop)

    $record = [ordered]@{
        Name           = $Name
        Pid            = $Process.Id
        ExecutablePath = [IO.Path]::GetFullPath($ExecutablePath)
        CommandMarker  = $CommandMarker
    }
    if ($Port -gt 0) {
        $record['Port'] = $Port
    }
    if ($null -ne $WorkerEnabled) {
        $record['WorkerEnabled'] = [bool]$WorkerEnabled
    }

    $destination = Get-OwnedProcessRecordPath -Name $Name
    $temporary = Join-Path $root (".{0}.{1}.tmp" -f $Name, [Guid]::NewGuid().ToString('N'))
    $encoding = New-Object System.Text.UTF8Encoding($false)

    try {
        $json = $record | ConvertTo-Json -Depth 3 -Compress
        [IO.File]::WriteAllText($temporary, $json, $encoding)
        [IO.File]::Move($temporary, $destination)
    }
    finally {
        if (Test-Path -LiteralPath $temporary) {
            Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue
        }
    }
}

function Read-OwnedProcessRecord {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [ValidatePattern('^[A-Za-z0-9_-]+$')]
        [string]$Name
    )

    $path = Get-OwnedProcessRecordPath -Name $Name
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        return $null
    }

    return Get-Content -LiteralPath $path -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop
}

function Test-OwnedProcessRecord {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [psobject]$Record
    )

    $pidValue = 0
    if (-not [int]::TryParse([string]$Record.Pid, [ref]$pidValue) -or $pidValue -le 0) {
        return $false
    }
    if ([string]::IsNullOrWhiteSpace([string]$Record.ExecutablePath) -or
        [string]::IsNullOrWhiteSpace([string]$Record.CommandMarker)) {
        return $false
    }

    try {
        $process = Get-CimInstance -ClassName Win32_Process -Filter ("ProcessId = {0}" -f $pidValue) -ErrorAction Stop
        if ($null -eq $process -or
            [string]::IsNullOrWhiteSpace([string]$process.ExecutablePath) -or
            [string]::IsNullOrWhiteSpace([string]$process.CommandLine)) {
            return $false
        }

        $actualExecutable = [IO.Path]::GetFullPath([string]$process.ExecutablePath)
        $recordedExecutable = [IO.Path]::GetFullPath([string]$Record.ExecutablePath)
        $executableMatches = [string]::Equals(
            $actualExecutable,
            $recordedExecutable,
            [StringComparison]::OrdinalIgnoreCase
        )
        $markerMatches = $process.CommandLine.IndexOf(
            [string]$Record.CommandMarker,
            [StringComparison]::OrdinalIgnoreCase
        ) -ge 0

        return $executableMatches -and $markerMatches
    }
    catch {
        return $false
    }
}

function Stop-OwnedProcess {
    [CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'High')]
    param(
        [Parameter(Mandatory = $true)]
        [ValidatePattern('^[A-Za-z0-9_-]+$')]
        [string]$Name
    )

    $record = Read-OwnedProcessRecord -Name $Name
    if ($null -eq $record) {
        return $false
    }

    $pidValue = 0
    if (-not [int]::TryParse([string]$record.Pid, [ref]$pidValue) -or $pidValue -le 0) {
        throw "Ownership validation failed for '$Name'; refusing to alter the ownership record."
    }

    $recordedProcess = Get-CimInstance -ClassName Win32_Process -Filter ("ProcessId = {0}" -f $pidValue) -ErrorAction Stop
    if ($null -eq $recordedProcess) {
        if (-not $PSCmdlet.ShouldProcess("stale ownership record for absent PID $pidValue ($Name)", 'Remove stale ownership record')) {
            return $false
        }
        Remove-Item -LiteralPath (Get-OwnedProcessRecordPath -Name $Name) -Force -ErrorAction Stop
        return $true
    }

    if (-not (Test-OwnedProcessRecord -Record $record)) {
        throw "Ownership validation failed for '$Name'; refusing to stop the recorded PID."
    }

    if (-not $PSCmdlet.ShouldProcess("PID $pidValue ($Name)", 'Stop owned staging process')) {
        return $false
    }

    Stop-VerifiedProcess -Process ([Diagnostics.Process]::GetProcessById($pidValue)) -ExecutablePath $record.ExecutablePath -CommandMarker $record.CommandMarker -Confirm:$false | Out-Null
    Remove-Item -LiteralPath (Get-OwnedProcessRecordPath -Name $Name) -Force -ErrorAction Stop
    return $true
}

function Stop-VerifiedProcess {
    [CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'High')]
    param(
        [Parameter(Mandatory = $true)]
        [System.Diagnostics.Process]$Process,

        [Parameter(Mandatory = $true)]
        [ValidateNotNullOrEmpty()]
        [string]$ExecutablePath,

        [Parameter(Mandatory = $true)]
        [ValidateNotNullOrEmpty()]
        [string]$CommandMarker
    )

    $verificationRecord = [pscustomobject]@{
        Pid            = $Process.Id
        ExecutablePath = $ExecutablePath
        CommandMarker  = $CommandMarker
    }
    if (-not (Test-OwnedProcessRecord -Record $verificationRecord)) {
        throw 'Executable or command marker validation failed; refusing to stop the just-started PID.'
    }

    $pidValue = $Process.Id
    $descendantProcessIds = @(Get-DescendantProcessIds -ParentId $pidValue)
    $trackedProcessIds = @($pidValue) + $descendantProcessIds
    if (-not $PSCmdlet.ShouldProcess("PID $pidValue", 'Stop verified staging process')) {
        return $false
    }

    $taskkillOutput = & taskkill.exe /PID $pidValue /T /F 2>&1
    $taskkillExitCode = $LASTEXITCODE
    if ($taskkillExitCode -ne 0) {
        throw 'Verified staging process tree could not be stopped.'
    }
    $null = $taskkillOutput

    $deadline = [DateTime]::UtcNow.AddSeconds(30)
    do {
        $remainingProcessIds = @(Get-RemainingProcessTreeIds -ProcessIds $trackedProcessIds)
        if ($remainingProcessIds.Count -eq 0) {
            return $true
        }
        Start-Sleep -Milliseconds 250
    } while ([DateTime]::UtcNow -lt $deadline)

    $remainingProcessIds = @(Get-RemainingProcessTreeIds -ProcessIds $trackedProcessIds)
    if ($remainingProcessIds.Count -gt 0) {
        throw 'Verified staging process tree still has running descendants.'
    }
    return $true
}

function Get-DescendantProcessIds {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [ValidateRange(1, 2147483647)]
        [int]$ParentId
    )

    $processes = @(Get-CimInstance -ClassName Win32_Process -ErrorAction Stop)
    $pendingParents = New-Object 'System.Collections.Generic.Queue[int]'
    $pendingParents.Enqueue($ParentId)
    $descendantIds = New-Object System.Collections.ArrayList

    while ($pendingParents.Count -gt 0) {
        $currentParent = $pendingParents.Dequeue()
        foreach ($candidate in $processes) {
            $candidateParentId = 0
            $candidateProcessId = 0
            if (-not [int]::TryParse([string]$candidate.ParentProcessId, [ref]$candidateParentId) -or
                -not [int]::TryParse([string]$candidate.ProcessId, [ref]$candidateProcessId)) {
                continue
            }
            if ($candidateParentId -eq $currentParent -and -not $descendantIds.Contains($candidateProcessId)) {
                [void]$descendantIds.Add($candidateProcessId)
                $pendingParents.Enqueue($candidateProcessId)
            }
        }
    }

    return @($descendantIds)
}

function Get-RemainingProcessTreeIds {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [int[]]$ProcessIds
    )

    $processes = @(Get-CimInstance -ClassName Win32_Process -ErrorAction Stop)
    $treeIds = @($ProcessIds | Select-Object -Unique)
    $discovered = $true
    while ($discovered) {
        $discovered = $false
        foreach ($candidate in $processes) {
            $candidateParentId = 0
            $candidateProcessId = 0
            if (-not [int]::TryParse([string]$candidate.ParentProcessId, [ref]$candidateParentId) -or
                -not [int]::TryParse([string]$candidate.ProcessId, [ref]$candidateProcessId)) {
                continue
            }
            if ($treeIds -contains $candidateParentId -and -not ($treeIds -contains $candidateProcessId)) {
                $treeIds += $candidateProcessId
                $discovered = $true
            }
        }
    }

    $runningIds = @()
    foreach ($candidate in $processes) {
        $candidateProcessId = 0
        if ([int]::TryParse([string]$candidate.ProcessId, [ref]$candidateProcessId) -and
            $treeIds -contains $candidateProcessId) {
            $runningIds += $candidateProcessId
        }
    }
    return @($runningIds | Select-Object -Unique)
}

function Test-LocalTcpPort {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [ValidateRange(1, 65535)]
        [int]$Port
    )

    $client = New-Object System.Net.Sockets.TcpClient
    try {
        $connection = $client.BeginConnect('127.0.0.1', $Port, $null, $null)
        if (-not $connection.AsyncWaitHandle.WaitOne(500)) {
            return $false
        }
        $client.EndConnect($connection)
        return $true
    }
    catch {
        return $false
    }
    finally {
        $client.Dispose()
    }
}

Export-ModuleMember -Function @(
    'ConvertTo-WindowsCommandLineArgument',
    'Import-DotEnvFile',
    'ConvertTo-KakaoStagingBooleanValue',
    'Set-KakaoStagingSafeEnvironment',
    'Get-KakaoStagingRoot',
    'Initialize-KakaoStagingRuntimeStorage',
    'Write-OwnedProcessRecord',
    'Read-OwnedProcessRecord',
    'Test-OwnedProcessRecord',
    'Stop-OwnedProcess',
    'Stop-VerifiedProcess',
    'Get-DescendantProcessIds',
    'Test-LocalTcpPort'
)
