[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'Medium')]
param(
    [Parameter(Mandatory = $true)]
    [string]$EnvFile,

    [Parameter(Mandatory = $true)]
    [string]$HermesPythonPath,

    [switch]$AllowDurableQueueRecovery,

    [switch]$AllowCompletedWorkerHandoff,

    [string]$CompletedJobId = '',

    [switch]$AllowPreMutationWorkerHandoff,

    [string]$PreMutationJobId = ''
)

$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..')).Path
Import-Module (Join-Path $PSScriptRoot 'KakaoStaging.Common.psm1') -Force
Import-Module (Join-Path $PSScriptRoot 'KakaoLive.Common.psm1') -Force
Import-DotEnvFile -Path $EnvFile

function Get-CompletedWorkerResult {
    param([Parameter(Mandatory = $true)][string]$JobId)

    $resultPath = Join-Path $repoRoot 'tools\kakao-dom-bridge\queue\worker-results.ndjson'
    if (-not (Test-Path -LiteralPath $resultPath)) {
        throw 'Completed-worker handoff requires worker-results.ndjson.'
    }
    $matches = [IO.File]::ReadAllLines($resultPath) | ForEach-Object {
        try { $_ | ConvertFrom-Json } catch { $null }
    } | Where-Object { [string]$_.jobId -eq $JobId }
    $latest = $matches | Select-Object -Last 1
    if ($null -eq $latest -or [int]$latest.result.code -ne 0 -or [bool]$latest.result.timedOut) {
        throw 'Completed-worker handoff requires a successful non-timeout worker result.'
    }
    $completedAt = [datetime]$latest.at
    if ([DateTime]::UtcNow - $completedAt.ToUniversalTime() -gt [TimeSpan]::FromSeconds(30)) {
        throw 'Completed-worker handoff result is stale.'
    }
    return $latest
}

function Get-DurableWorkerState {
    param([Parameter(Mandatory = $true)][string]$JobId)

    $supabaseUrl = [string][Environment]::GetEnvironmentVariable('SUPABASE_URL', 'Process')
    $serviceRoleKey = [string][Environment]::GetEnvironmentVariable('SUPABASE_SERVICE_ROLE_KEY', 'Process')
    $table = [string][Environment]::GetEnvironmentVariable('SUPABASE_TABLE', 'Process')
    if (-not $supabaseUrl -or -not $serviceRoleKey -or -not $table) {
        throw 'Completed-worker handoff requires Supabase read configuration.'
    }
    $endpoint = '{0}/rest/v1/{1}?select=status,completed_at&event_hash=eq.{2}' -f `
        $supabaseUrl.TrimEnd('/'), [uri]::EscapeDataString($table), [uri]::EscapeDataString($JobId)
    $rows = @(Invoke-RestMethod -Uri $endpoint -Headers @{
        apikey = $serviceRoleKey
        Authorization = "Bearer $serviceRoleKey"
    } -TimeoutSec 8)
    $row = $rows | Select-Object -First 1
    if ($null -eq $row -or [string]$row.status -eq 'processing_by_ai_worker' -or -not [string]$row.completed_at) {
        throw 'Completed-worker handoff requires a durable non-processing Supabase result.'
    }
    return $row
}

function Get-ProcessingDurableWorkerState {
    param([Parameter(Mandatory = $true)][string]$JobId)

    $supabaseUrl = [string][Environment]::GetEnvironmentVariable('SUPABASE_URL', 'Process')
    $serviceRoleKey = [string][Environment]::GetEnvironmentVariable('SUPABASE_SERVICE_ROLE_KEY', 'Process')
    $table = [string][Environment]::GetEnvironmentVariable('SUPABASE_TABLE', 'Process')
    if (-not $supabaseUrl -or -not $serviceRoleKey -or -not $table) {
        throw 'Pre-mutation worker handoff requires Supabase read configuration.'
    }
    $endpoint = '{0}/rest/v1/{1}?select=status,completed_at&event_hash=eq.{2}' -f `
        $supabaseUrl.TrimEnd('/'), [uri]::EscapeDataString($table), [uri]::EscapeDataString($JobId)
    $rows = @(Invoke-RestMethod -Uri $endpoint -Headers @{
        apikey = $serviceRoleKey
        Authorization = "Bearer $serviceRoleKey"
    } -TimeoutSec 8)
    $row = $rows | Select-Object -First 1
    if ($null -eq $row -or [string]$row.status -ne 'processing_by_ai_worker' -or [string]$row.completed_at) {
        throw 'Pre-mutation worker handoff requires an incomplete processing Supabase row.'
    }
    return $row
}

function Reset-DurableWorkerForRecovery {
    param([Parameter(Mandatory = $true)][string]$JobId)

    $supabaseUrl = [string][Environment]::GetEnvironmentVariable('SUPABASE_URL', 'Process')
    $serviceRoleKey = [string][Environment]::GetEnvironmentVariable('SUPABASE_SERVICE_ROLE_KEY', 'Process')
    $table = [string][Environment]::GetEnvironmentVariable('SUPABASE_TABLE', 'Process')
    $endpoint = '{0}/rest/v1/{1}?event_hash=eq.{2}' -f `
        $supabaseUrl.TrimEnd('/'), [uri]::EscapeDataString($table), [uri]::EscapeDataString($JobId)
    return Invoke-RestMethod -Uri $endpoint -Method Patch -Headers @{
        apikey = $serviceRoleKey
        Authorization = "Bearer $serviceRoleKey"
        Prefer = 'return=representation'
    } -ContentType 'application/json' -Body (@{
        status = 'ready_for_ai_worker'
        claimed_at = $null
        completed_at = $null
        error_message = $null
    } | ConvertTo-Json -Compress) -TimeoutSec 8
}

function Get-BridgeDescendants {
    param([Parameter(Mandatory = $true)][int]$BridgePid)

    $processes = @(Get-CimInstance Win32_Process)
    $descendants = New-Object 'System.Collections.Generic.HashSet[int]'
    [void]$descendants.Add($BridgePid)
    $changed = $true
    while ($changed) {
        $changed = $false
        foreach ($process in $processes) {
            if ($descendants.Contains([int]$process.ParentProcessId) -and
                -not $descendants.Contains([int]$process.ProcessId)) {
                [void]$descendants.Add([int]$process.ProcessId)
                $changed = $true
            }
        }
    }
    return @($processes | Where-Object {
        $descendants.Contains([int]$_.ProcessId) -and [int]$_.ProcessId -ne $BridgePid
    })
}

function Test-InitialHermesDecisionInFlight {
    param(
        [Parameter(Mandatory = $true)][int]$BridgePid,
        [Parameter(Mandatory = $true)][string]$JobId,
        [Parameter(Mandatory = $true)][datetime]$StartedAt
    )

    $descendants = @(Get-BridgeDescendants -BridgePid $BridgePid)
    $postAction = @($descendants | Where-Object {
        [string]$_.Name -eq 'python.exe' -and
        [string]$_.CommandLine -match 'POST-ACTION|AUTHORITATIVE SHEET RESULT'
    })
    if ($postAction.Count -gt 0) { return $false }

    $legacyHermes = @($descendants | Where-Object {
        [string]$_.Name -eq 'python.exe' -and
        ([string]$_.CommandLine).Length -gt 2000 -and
        [string]$_.CommandLine -match 'AI-first Kakao rental-shop worker task'
    })
    if ($legacyHermes.Count -gt 0) { return $true }

    $safeJobId = ($JobId -replace '[^a-zA-Z0-9._-]', '_')
    if ($safeJobId.Length -gt 160) { $safeJobId = $safeJobId.Substring(0, 160) }
    $phasePath = Join-Path $repoRoot "tools\kakao-dom-bridge\queue\worker-phases\$safeJobId.json"
    if (-not (Test-Path -LiteralPath $phasePath)) { return $false }
    try { $phase = Get-Content -LiteralPath $phasePath -Raw | ConvertFrom-Json } catch { return $false }
    if ([string]$phase.schema -ne 'kakao-worker-handoff-phase/v1' -or
        [string]$phase.jobId -ne $JobId -or
        [string]$phase.phase -ne 'initial_hermes_in_flight' -or
        -not [int]$phase.workerPid -or
        -not [string]$phase.recordedAt -or
        ([datetime]$phase.recordedAt).ToUniversalTime() -lt $StartedAt.ToUniversalTime()) {
        return $false
    }

    $workerPid = [int]$phase.workerPid
    $worker = @($descendants | Where-Object {
        [int]$_.ProcessId -eq $workerPid -and
        [string]$_.Name -eq 'node.exe' -and
        [string]$_.CommandLine -match 'ai-browser-worker[\\/]worker\.mjs\s+--stdin-job'
    }) | Select-Object -First 1
    if ($null -eq $worker) { return $false }

    $stdinHermes = @($descendants | Where-Object {
        [string]$_.Name -eq 'python.exe' -and
        [int]$_.ParentProcessId -eq $workerPid -and
        [string]$_.CommandLine -match 'hermes-stdin-runner\.py'
    })
    return $stdinHermes.Count -gt 0
}

function Test-JobAuditAfterStart {
    param(
        [Parameter(Mandatory = $true)][string]$Filename,
        [Parameter(Mandatory = $true)][string]$JobId,
        [Parameter(Mandatory = $true)][datetime]$StartedAt
    )

    $path = Join-Path $repoRoot "tools\kakao-dom-bridge\queue\$Filename"
    if (-not (Test-Path -LiteralPath $path)) { return $false }
    foreach ($line in [IO.File]::ReadAllLines($path)) {
        try { $row = $line | ConvertFrom-Json } catch { continue }
        if ([string]$row.jobId -ne $JobId -or -not [string]$row.at) { continue }
        if (([datetime]$row.at).ToUniversalTime() -ge $StartedAt.ToUniversalTime()) { return $true }
    }
    return $false
}

function Test-BridgeHasWorkerDescendant {
    param([Parameter(Mandatory = $true)][int]$BridgePid)

    return [bool](Get-BridgeDescendants -BridgePid $BridgePid | Where-Object {
        [string]$_.Name -ne 'conhost.exe'
    } | Select-Object -First 1)
}

$pre = Invoke-RestMethod -Uri 'http://127.0.0.1:8787/health' -TimeoutSec 5
$workerBusy = [bool]$pre.state.workerRunning
$queuedWorkerCount = [int]$pre.state.workerQueueLength
$queuedForDurableRecovery = 0
$completedWorkerHandoff = $false
$preMutationWorkerHandoff = $false
$preMutationJobToRequeue = ''
$preMutationRequeueError = ''

$record = Read-OwnedProcessRecord -Name 'bridge'
if ($null -eq $record -or -not (Test-OwnedProcessRecord -Record $record)) {
    throw 'Bridge ownership validation failed.'
}

if ($workerBusy -and
    -not $AllowCompletedWorkerHandoff.IsPresent -and
    -not $AllowPreMutationWorkerHandoff.IsPresent) {
    throw 'Bridge has an active worker; wait for it to finish before restart.'
}
if ($workerBusy -and $AllowCompletedWorkerHandoff.IsPresent) {
    if ($AllowPreMutationWorkerHandoff.IsPresent) {
        throw 'Choose exactly one active-worker handoff mode.'
    }
    if (-not $CompletedJobId -or [string]$pre.state.currentJobId -ne $CompletedJobId) {
        throw 'Completed-worker handoff job does not match the active bridge job.'
    }
    [void](Get-CompletedWorkerResult -JobId $CompletedJobId)
    [void](Get-DurableWorkerState -JobId $CompletedJobId)
    if (Test-BridgeHasWorkerDescendant -BridgePid ([int]$record.Pid)) {
        throw 'Completed-worker handoff still has a worker subprocess.'
    }
    $completedWorkerHandoff = $true
}
if ($workerBusy -and $AllowPreMutationWorkerHandoff.IsPresent) {
    if (-not $PreMutationJobId -or [string]$pre.state.currentJobId -ne $PreMutationJobId) {
        throw 'Pre-mutation handoff job does not match the active bridge job.'
    }
    $startedAt = ([datetime]$pre.state.workerStartedAt).ToUniversalTime()
    if (Test-JobAuditAfterStart -Filename 'worker-results.ndjson' -JobId $PreMutationJobId -StartedAt $startedAt) {
        throw 'Pre-mutation handoff found a worker result for this execution.'
    }
    if (Test-JobAuditAfterStart -Filename 'auto-replies.ndjson' -JobId $PreMutationJobId -StartedAt $startedAt) {
        throw 'Pre-mutation handoff found an auto-reply decision for this execution.'
    }
    if (-not (Test-InitialHermesDecisionInFlight -BridgePid ([int]$record.Pid) `
        -JobId $PreMutationJobId -StartedAt $startedAt)) {
        throw 'Pre-mutation handoff requires the initial Hermes decision subprocess.'
    }
    [void](Get-ProcessingDurableWorkerState -JobId $PreMutationJobId)
    $preMutationWorkerHandoff = $true
    $preMutationJobToRequeue = $PreMutationJobId
}
if ($queuedWorkerCount -ne 0) {
    if (-not $AllowDurableQueueRecovery.IsPresent) {
        throw 'Bridge is not idle.'
    }
    if (-not [bool]$pre.config.supabaseEnabled -or -not [bool]$pre.config.supabaseRecoveryEnabled) {
        throw 'Busy bridge restart requires enabled Supabase durable recovery.'
    }
    $queuedForDurableRecovery = $queuedWorkerCount
}
$canonicalHermesPythonPath = Join-Path $env:LOCALAPPDATA 'hermes\hermes-agent\venv\Scripts\python.exe'
$canonicalHermesPythonPath = (Resolve-Path -LiteralPath $canonicalHermesPythonPath -ErrorAction Stop).Path
$resolvedHermesPythonPath = (Resolve-Path -LiteralPath $HermesPythonPath -ErrorAction Stop).Path
if (-not [string]::Equals($resolvedHermesPythonPath, $canonicalHermesPythonPath, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Full-live Hermes runtime must match the installed gateway runtime: $canonicalHermesPythonPath"
}
[Environment]::SetEnvironmentVariable('HERMES_WORKER_COMMAND', $resolvedHermesPythonPath, 'Process')
[Environment]::SetEnvironmentVariable('HERMES_WORKER_COMMAND_MODE', 'python_module', 'Process')
Set-KakaoStagingSafeEnvironment -EnableWrites
Set-KakaoLiveRuntimeEnvironment

$required = Get-KakaoLiveRuntimeContract
foreach ($name in $required.Keys) {
    if ([Environment]::GetEnvironmentVariable($name, 'Process') -ne $required[$name]) {
        throw "Full-live runtime setting mismatch: $name"
    }
}

$oldPid = [int]$record.Pid
$executable = [string]$record.ExecutablePath
$commandMarker = [string]$record.CommandMarker
$port = [int]$record.Port
$bridgeDirectory = Join-Path $repoRoot 'tools\kakao-dom-bridge'

if (-not $PSCmdlet.ShouldProcess("owned bridge PID $oldPid", 'Restart in full-live mode')) {
    return
}

Stop-OwnedProcess -Name 'bridge' -Confirm:$false | Out-Null
if ($preMutationJobToRequeue) {
    try {
        [void](Reset-DurableWorkerForRecovery -JobId $preMutationJobToRequeue)
    }
    catch {
        $preMutationRequeueError = $_.Exception.Message
    }
}
$newProcess = Start-Process -FilePath $executable -ArgumentList $commandMarker `
    -WorkingDirectory $bridgeDirectory -WindowStyle Hidden -PassThru

try {
    $deadline = [DateTime]::UtcNow.AddSeconds(20)
    $post = $null
    do {
        Start-Sleep -Milliseconds 250
        try { $post = Invoke-RestMethod -Uri 'http://127.0.0.1:8787/health' -TimeoutSec 2 }
        catch { $post = $null }
    } while ($null -eq $post -and [DateTime]::UtcNow -lt $deadline -and -not $newProcess.HasExited)

    if ($null -eq $post -or -not (Test-KakaoLiveBridgeContract -Health $post)) {
        throw 'Restarted bridge did not satisfy the full-live contract.'
    }

    Write-OwnedProcessRecord -Name 'bridge' -Process $newProcess -ExecutablePath $executable `
        -CommandMarker $commandMarker -Port $port -WorkerEnabled $true

    [pscustomobject]@{
        OldPid = $oldPid
        NewPid = $newProcess.Id
        HealthOk = [bool]$post.ok
        WorkerLive = [bool]$post.config.workerLive
        WorkerDryRun = [bool]$post.config.workerDryRun
        AutoSend = [bool]$post.config.autoSendEnabled
        SlackDelivery = [bool]$post.config.slackCardDeliveryEnabled
        ActionPoll = [bool]$post.config.slackActionPollEnabled
        QueuedForDurableRecovery = $queuedForDurableRecovery
        CompletedWorkerHandoff = $completedWorkerHandoff
        PreMutationWorkerHandoff = $preMutationWorkerHandoff
        PreMutationRequeued = [bool]($preMutationWorkerHandoff -and -not $preMutationRequeueError)
        PreMutationRequeueError = $preMutationRequeueError
    }
}
catch {
    if (-not $newProcess.HasExited) {
        Stop-VerifiedProcess -Process $newProcess -ExecutablePath $executable `
            -CommandMarker $commandMarker -Confirm:$false | Out-Null
    }
    throw
}
