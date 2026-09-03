Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Resolve-KakaoLiveRuntimeMode {
    [CmdletBinding()]
    param([AllowEmptyString()][string]$RuntimeMode = $env:WORK_ORCHESTRATOR_V2_RUNTIME_MODE)

    $normalized = if ([string]::IsNullOrWhiteSpace($RuntimeMode)) { 'legacy' } else { $RuntimeMode.Trim().ToLowerInvariant() }
    if ($normalized -notin @('legacy', 'v2')) {
        throw 'Work Orchestrator v2 runtime mode must be legacy or v2.'
    }
    return $normalized
}

function Get-KakaoLiveRuntimeContract {
    [CmdletBinding()]
    param(
        [ValidateSet('cli', 'gateway')]
        [string]$HermesTransport = 'cli',
        [AllowEmptyString()]
        [string]$RuntimeMode = $env:WORK_ORCHESTRATOR_V2_RUNTIME_MODE
    )

    $mode = Resolve-KakaoLiveRuntimeMode -RuntimeMode $RuntimeMode
    $legacy = $mode -eq 'legacy'
    $v2 = $mode -eq 'v2'

    return [ordered]@{
        AI_WORKER_LIVE                    = '1'
        AI_WORKER_AUTO_SEND               = '1'
        AI_WORKER_DRY_RUN                 = '0'
        SLACK_ACTION_POLL_ENABLED         = $(if ($legacy) { '1' } else { '0' })
        SLACK_AGENT_CARD_DELIVERY_ENABLED = $(if ($legacy) { '1' } else { '0' })
        AI_WORKER_FOLLOW_UP_ITEMS_ENABLED = $(if ($legacy) { '1' } else { '0' })
        KAKAO_FOLLOW_UP_ITEMS_ENABLED     = $(if ($legacy) { '1' } else { '0' })
        P0_SLACK_ESCALATION_ENABLED       = $(if ($legacy) { '1' } else { '0' })
        WORK_ORCHESTRATOR_V2_RUNTIME_MODE = $mode
        WORK_ORCHESTRATOR_V2_SHADOW_WRITES = $(if ($v2) { '1' } else { '0' })
        WORK_ORCHESTRATOR_V2_IMMEDIATE_ENABLED = $(if ($v2) { '1' } else { '0' })
        WORK_ORCHESTRATOR_V2_WORK_ITEMS_ENABLED = $(if ($v2) { '1' } else { '0' })
        WORK_ORCHESTRATOR_V2_DIGEST_ENABLED = $(if ($v2) { '1' } else { '0' })
        WORK_ORCHESTRATOR_V2_CLEANUP_ENABLED = $(if ($v2) { '1' } else { '0' })
        WORK_ORCHESTRATOR_V2_P0_READBACK_ENABLED = $(if ($v2) { '1' } else { '0' })
        WORK_ORCHESTRATOR_V2_P0_CUTOVER_ENABLED = $(if ($v2) { '1' } else { '0' })
        VILLAGE_WINDOWS_WRITES_ENABLED    = '1'
        SUPABASE_RECOVERY_ENABLED         = '1'
        KAKAO_TAB_CLEANUP_ENABLED         = '1'
        HERMES_WORKER_COMMAND_MODE        = 'python_module'
        HERMES_HOME                       = (Join-Path $env:LOCALAPPDATA 'hermes')
        DEBOUNCE_MS                       = '15000'
        MAX_WAIT_MS                       = '45000'
        WORKER_SLOW_ALERT_MS              = '30000'
        WORKER_TIMEOUT_MS                 = '300000'
        WORKER_CATCHUP_TIMEOUT_MS         = '300000'
        HERMES_WORKER_TIMEOUT_MS          = '240000'
        HERMES_WORKER_MAX_TURNS           = '90'
        HERMES_WORKER_SKILLS              = 'village-operations,village-confirm-request'
        KAKAO_AI_DOM_SPLIT_ENABLED        = '1'
        KAKAO_AI_DECISION_CONCURRENCY     = '2'
    }
}

function ConvertFrom-KakaoLiveContractBoolean {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [string]$Name,
        [Parameter(Mandatory = $true)]
        [string]$Value
    )

    switch ($Value.Trim().ToLowerInvariant()) {
        '1' { return $true }
        'true' { return $true }
        '0' { return $false }
        'false' { return $false }
        default { throw "Invalid boolean value for Kakao live runtime contract key $Name." }
    }
}

function Assert-KakaoLiveV2CutoverContract {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [System.Collections.IDictionary]$Contract
    )

    $allowedKeys = @(
        'AI_WORKER_LIVE', 'AI_WORKER_AUTO_SEND', 'AI_WORKER_DRY_RUN',
        'SLACK_ACTION_POLL_ENABLED', 'SLACK_AGENT_CARD_DELIVERY_ENABLED',
        'AI_WORKER_FOLLOW_UP_ITEMS_ENABLED', 'KAKAO_FOLLOW_UP_ITEMS_ENABLED',
        'P0_SLACK_ESCALATION_ENABLED', 'WORK_ORCHESTRATOR_V2_RUNTIME_MODE', 'WORK_ORCHESTRATOR_V2_SHADOW_WRITES',
        'WORK_ORCHESTRATOR_V2_IMMEDIATE_ENABLED', 'WORK_ORCHESTRATOR_V2_WORK_ITEMS_ENABLED',
        'WORK_ORCHESTRATOR_V2_DIGEST_ENABLED', 'WORK_ORCHESTRATOR_V2_CLEANUP_ENABLED',
        'WORK_ORCHESTRATOR_V2_P0_READBACK_ENABLED', 'WORK_ORCHESTRATOR_V2_P0_CUTOVER_ENABLED',
        'VILLAGE_WINDOWS_WRITES_ENABLED', 'SUPABASE_RECOVERY_ENABLED', 'KAKAO_TAB_CLEANUP_ENABLED',
        'HERMES_WORKER_COMMAND_MODE', 'HERMES_HOME', 'DEBOUNCE_MS', 'MAX_WAIT_MS',
        'WORKER_SLOW_ALERT_MS', 'WORKER_TIMEOUT_MS', 'WORKER_CATCHUP_TIMEOUT_MS',
        'HERMES_WORKER_TIMEOUT_MS', 'HERMES_WORKER_MAX_TURNS', 'HERMES_WORKER_SKILLS',
        'KAKAO_AI_DOM_SPLIT_ENABLED', 'KAKAO_AI_DECISION_CONCURRENCY'
    )
    foreach ($key in $allowedKeys) {
        if (-not $Contract.Contains($key)) { throw "Kakao live runtime contract is missing $key." }
        if ($Contract[$key] -isnot [string]) { throw "Kakao live runtime contract value for $key must be a string." }
    }
    foreach ($key in $Contract.Keys) {
        if ($allowedKeys -notcontains [string]$key) { throw "Kakao live runtime contract key $key is not allowed." }
    }
    if ($Contract.Count -ne $allowedKeys.Count) { throw 'Kakao live runtime contract must contain exactly the allowed keys.' }

    $legacyCardsEnabled = ConvertFrom-KakaoLiveContractBoolean -Name 'SLACK_AGENT_CARD_DELIVERY_ENABLED' -Value $Contract['SLACK_AGENT_CARD_DELIVERY_ENABLED']
    $legacyWorkRowsEnabled = (ConvertFrom-KakaoLiveContractBoolean -Name 'AI_WORKER_FOLLOW_UP_ITEMS_ENABLED' -Value $Contract['AI_WORKER_FOLLOW_UP_ITEMS_ENABLED']) -and
        (ConvertFrom-KakaoLiveContractBoolean -Name 'KAKAO_FOLLOW_UP_ITEMS_ENABLED' -Value $Contract['KAKAO_FOLLOW_UP_ITEMS_ENABLED'])
    $legacyP0Enabled = ConvertFrom-KakaoLiveContractBoolean -Name 'P0_SLACK_ESCALATION_ENABLED' -Value $Contract['P0_SLACK_ESCALATION_ENABLED']
    $legacyActionPollEnabled = ConvertFrom-KakaoLiveContractBoolean -Name 'SLACK_ACTION_POLL_ENABLED' -Value $Contract['SLACK_ACTION_POLL_ENABLED']
    $runtimeMode = Resolve-KakaoLiveRuntimeMode -RuntimeMode $Contract['WORK_ORCHESTRATOR_V2_RUNTIME_MODE']
    $shadowWritesEnabled = ConvertFrom-KakaoLiveContractBoolean -Name 'WORK_ORCHESTRATOR_V2_SHADOW_WRITES' -Value $Contract['WORK_ORCHESTRATOR_V2_SHADOW_WRITES']
    $immediateEnabled = ConvertFrom-KakaoLiveContractBoolean -Name 'WORK_ORCHESTRATOR_V2_IMMEDIATE_ENABLED' -Value $Contract['WORK_ORCHESTRATOR_V2_IMMEDIATE_ENABLED']
    $workItemsEnabled = ConvertFrom-KakaoLiveContractBoolean -Name 'WORK_ORCHESTRATOR_V2_WORK_ITEMS_ENABLED' -Value $Contract['WORK_ORCHESTRATOR_V2_WORK_ITEMS_ENABLED']
    $digestEnabled = ConvertFrom-KakaoLiveContractBoolean -Name 'WORK_ORCHESTRATOR_V2_DIGEST_ENABLED' -Value $Contract['WORK_ORCHESTRATOR_V2_DIGEST_ENABLED']
    $cleanupEnabled = ConvertFrom-KakaoLiveContractBoolean -Name 'WORK_ORCHESTRATOR_V2_CLEANUP_ENABLED' -Value $Contract['WORK_ORCHESTRATOR_V2_CLEANUP_ENABLED']
    $p0ReadbackEnabled = ConvertFrom-KakaoLiveContractBoolean -Name 'WORK_ORCHESTRATOR_V2_P0_READBACK_ENABLED' -Value $Contract['WORK_ORCHESTRATOR_V2_P0_READBACK_ENABLED']
    $p0CutoverEnabled = ConvertFrom-KakaoLiveContractBoolean -Name 'WORK_ORCHESTRATOR_V2_P0_CUTOVER_ENABLED' -Value $Contract['WORK_ORCHESTRATOR_V2_P0_CUTOVER_ENABLED']

    if ($p0CutoverEnabled -and -not $p0ReadbackEnabled) {
        throw 'Work Orchestrator v2 P0 cutover requires readback.'
    }
    if (-not $legacyCardsEnabled -and -not $immediateEnabled) {
        throw 'Work Orchestrator v2 cutover guard: legacy cards require v2 immediate notifications.'
    }
    if (-not $legacyWorkRowsEnabled -and -not $workItemsEnabled) {
        throw 'Work Orchestrator v2 cutover guard: legacy work rows require v2 work items.'
    }
    if (-not $legacyP0Enabled -and -not ($workItemsEnabled -and $p0ReadbackEnabled -and $p0CutoverEnabled)) {
        throw 'Work Orchestrator v2 cutover guard: legacy P0 requires v2 work items, readback, and cutover.'
    }
    if ($cleanupEnabled -and -not $immediateEnabled) {
        throw 'Work Orchestrator v2 cutover guard: cleanup requires v2 immediate notifications.'
    }
    $v2FlagsEnabled = $shadowWritesEnabled -and $immediateEnabled -and $workItemsEnabled -and $digestEnabled -and `
        $cleanupEnabled -and $p0ReadbackEnabled -and $p0CutoverEnabled
    $legacyFlagsEnabled = $legacyCardsEnabled -and $legacyWorkRowsEnabled -and $legacyP0Enabled -and $legacyActionPollEnabled
    if ($runtimeMode -eq 'legacy' -and (-not $legacyFlagsEnabled -or $shadowWritesEnabled -or $immediateEnabled -or `
        $workItemsEnabled -or $digestEnabled -or $cleanupEnabled -or $p0ReadbackEnabled -or $p0CutoverEnabled)) {
        throw 'Work Orchestrator legacy runtime mode requires the exact rollback contract.'
    }
    if ($runtimeMode -eq 'v2' -and (-not $v2FlagsEnabled -or $legacyCardsEnabled -or $legacyWorkRowsEnabled -or `
        $legacyP0Enabled -or $legacyActionPollEnabled)) {
        throw 'Work Orchestrator v2 runtime mode requires the exact cutover contract.'
    }
}

function Set-KakaoLiveRuntimeEnvironment {
    [CmdletBinding()]
    param(
        [ValidateSet('cli', 'gateway')]
        [string]$HermesTransport = 'cli',
        [System.Collections.IDictionary]$Contract = (Get-KakaoLiveRuntimeContract),
        [scriptblock]$SetEnvironmentVariable = {
            param([string]$Name, [string]$Value)
            [Environment]::SetEnvironmentVariable($Name, $Value, 'Process')
        }
    )

    Assert-KakaoLiveV2CutoverContract -Contract $Contract
    $environmentEntries = [ordered]@{}
    foreach ($entry in $Contract.GetEnumerator()) {
        $environmentEntries[[string]$entry.Key] = [string]$entry.Value
    }
    $environmentEntries['KAKAO_HERMES_TRANSPORT'] = $HermesTransport
    $prior = [ordered]@{}
    foreach ($entry in $environmentEntries.GetEnumerator()) {
        $prior[[string]$entry.Key] = [Environment]::GetEnvironmentVariable([string]$entry.Key, 'Process')
    }
    try {
        foreach ($entry in $environmentEntries.GetEnumerator()) {
            & $SetEnvironmentVariable ([string]$entry.Key) ([string]$entry.Value)
        }
    }
    catch {
        $failure = $_
        foreach ($entry in $prior.GetEnumerator()) {
            try {
                [Environment]::SetEnvironmentVariable([string]$entry.Key, $entry.Value, 'Process')
            }
            catch {}
        }
        throw $failure
    }
}

function Test-KakaoLiveHealthProperty {
    [CmdletBinding()]
    param(
        [AllowNull()]
        [psobject]$Object,
        [Parameter(Mandatory = $true)]
        [string]$Name,
        [Parameter(Mandatory = $true)]
        [object]$ExpectedValue
    )

    if ($null -eq $Object) { return $false }
    $property = $Object.PSObject.Properties[$Name]
    return $null -ne $property -and $property.Value -eq $ExpectedValue
}

function Get-KakaoFileSha256 {
    param([Parameter(Mandatory = $true)][string]$Path)

    $sha = [Security.Cryptography.SHA256]::Create()
    $stream = $null
    try {
        $stream = [IO.File]::OpenRead($Path)
        return ([BitConverter]::ToString($sha.ComputeHash($stream))).Replace('-', '')
    }
    finally {
        if ($null -ne $stream) { $stream.Dispose() }
        $sha.Dispose()
    }
}

function Get-KakaoStringSha256 {
    param([Parameter(Mandatory = $true)][string]$Value)

    $sha = [Security.Cryptography.SHA256]::Create()
    try {
        return ([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($Value)))).Replace('-', '')
    }
    finally { $sha.Dispose() }
}

function Test-KakaoPluginInstallReceipt {
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][psobject]$Receipt)

    try {
        if ($Receipt.schema -ne 'village-kakao-plugin-install/v1' -or $Receipt.pluginName -ne 'kakao_village') {
            return $false
        }
        $expectedTarget = [IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'hermes\profiles\kakaoworker\plugins\kakao_village')).TrimEnd('\', '/')
        $target = [IO.Path]::GetFullPath([string]$Receipt.targetPluginPath).TrimEnd('\', '/')
        if (-not [string]::Equals($target, $expectedTarget, [StringComparison]::OrdinalIgnoreCase) -or
            -not (Test-Path -LiteralPath $target -PathType Container)) {
            return $false
        }

        $manifest = @($Receipt.fileManifest)
        if ($manifest.Count -eq 0 -or [string]$Receipt.manifestSha256 -notmatch '^[0-9a-fA-F]{64}$') {
            return $false
        }
        $expectedRelativePaths = New-Object System.Collections.Generic.HashSet[string] ([StringComparer]::OrdinalIgnoreCase)
        $canonicalRows = New-Object System.Collections.ArrayList
        foreach ($entry in @($manifest | Sort-Object relativePath)) {
            $relative = ([string]$entry.relativePath).Replace('/', '\')
            if ([string]::IsNullOrWhiteSpace($relative) -or [IO.Path]::IsPathRooted($relative) -or
                @($relative -split '[\\/]' | Where-Object { $_ -eq '..' }).Count -gt 0 -or
                [string]$entry.sha256 -notmatch '^[0-9a-fA-F]{64}$') {
                return $false
            }
            $filePath = [IO.Path]::GetFullPath((Join-Path $target $relative))
            if (-not $filePath.StartsWith($target + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase) -or
                -not (Test-Path -LiteralPath $filePath -PathType Leaf)) {
                return $false
            }
            $file = Get-Item -LiteralPath $filePath -Force -ErrorAction Stop
            $actualSha = Get-KakaoFileSha256 -Path $filePath
            if ([Int64]$entry.bytes -ne [Int64]$file.Length -or
                -not [string]::Equals($actualSha, [string]$entry.sha256, [StringComparison]::OrdinalIgnoreCase) -or
                -not $expectedRelativePaths.Add($relative.Replace('\', '/'))) {
                return $false
            }
            [void]$canonicalRows.Add(('{0}|{1}|{2}' -f $relative.Replace('\', '/'), $file.Length, $actualSha))
        }

        $actualRelativePaths = @(
            Get-ChildItem -LiteralPath $target -File -Force -Recurse -ErrorAction Stop |
                Where-Object { $_.FullName -notmatch '[\\/]__pycache__[\\/]' } |
                ForEach-Object { $_.FullName.Substring($target.Length).TrimStart('\', '/').Replace('\', '/') }
        )
        if ($actualRelativePaths.Count -ne $expectedRelativePaths.Count -or
            @($actualRelativePaths | Where-Object { -not $expectedRelativePaths.Contains($_) }).Count -gt 0) {
            return $false
        }
        $actualManifestSha = Get-KakaoStringSha256 -Value (@($canonicalRows) -join "`n")
        return [string]::Equals($actualManifestSha, [string]$Receipt.manifestSha256, [StringComparison]::OrdinalIgnoreCase)
    }
    catch { return $false }
}

function Get-KakaoGatewayCutoverPlan {
    [CmdletBinding()]
    param(
        [string]$BenchmarkReportPath = '',
        [switch]$RollbackToCli
    )

    if ($RollbackToCli.IsPresent) {
        return [pscustomobject]@{
            schema = 'village-kakao-hermes-cutover-plan/v1'
            action = 'rollback_to_cli'
            transport = 'cli'
            requiredConfirmation = 'ConfirmKakaoGatewayCutover'
            stopTask = 'Hermes_Gateway_Kakaoworker_Native'
            leaveRootSlackGatewayUntouched = $true
            leaveHealthyChromeUntouched = $true
            steps = @(
                'verify-explicit-owner-confirmation'
                'stop-only-kakaoworker-gateway'
                'restart-only-owned-bridge-as-cli'
                'verify-cli-health-and-preserve-kakao-cdp'
            )
        }
    }

    return [pscustomobject]@{
        schema = 'village-kakao-hermes-cutover-plan/v1'
        action = 'cutover_to_gateway'
        transport = 'gateway'
        requiredConfirmation = 'ConfirmKakaoGatewayCutover'
        benchmarkReportPath = $BenchmarkReportPath
        requiredBenchmark = [pscustomobject]@{ accepted = $true; latency_status = 'pass' }
        steps = @(
            'verify-provider-backed-benchmark'
            'verify-reviewed-plugin-receipt-and-runtime-hash'
            'verify-model-contract-and-native-session-smoke'
            'verify-bridge-queue-idle'
            'verify-kakao-authenticated-and-watcher-ready'
            'restart-only-owned-bridge-as-gateway'
            'start-only-kakaoworker-gateway'
            'verify-consumer-freshness-and-zero-failed-jobs'
        )
        rollback = Get-KakaoGatewayCutoverPlan -BenchmarkReportPath $BenchmarkReportPath -RollbackToCli
    }
}

function Test-KakaoGatewayHealthContract {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][psobject]$Health,
        [Parameter(Mandatory = $true)][psobject]$RuntimeProbe,
        [Parameter(Mandatory = $true)][psobject]$GatewayRuntime,
        [Parameter(Mandatory = $true)][psobject]$SmokeEvidence,
        [Parameter(Mandatory = $true)][bool]$RequireCleanHistory
    )

    $gateway = $Health.gateway
    $queue = if ($null -ne $gateway) { $gateway.queue } else { $null }
    $config = $Health.config
    $pluginPath = [string]$GatewayRuntime.pluginPath
    $manifestSha256 = [string]$GatewayRuntime.manifestSha256
    $profile = [string]$GatewayRuntime.profile
    $pid = [int]$GatewayRuntime.pid
    $killSwitchObserved = [string]$SmokeEvidence.killSwitchObserved

    return [bool](
        $Health.ok -eq $true -and
        $null -ne $config -and $config.hermesTransport -eq 'gateway' -and
        $config.scheduleOwnerReviewRequired -eq $true -and
        $config.killSwitchPolicyEnforced -eq $true -and
        $null -ne $gateway -and $gateway.gatewayReady -eq $true -and
        $null -ne $gateway.consumer -and $gateway.consumer.fresh -eq $true -and
        $null -ne $queue -and $queue.ready -eq 0 -and
        $queue.claimed -eq 0 -and $queue.retry -eq 0 -and
        (-not $RequireCleanHistory -or (
            $queue.failed -eq 0 -and $gateway.unnotified_application_failures -eq 0
        )) -and
        (Test-KakaoLiveRuntimeProbe -Probe $RuntimeProbe) -and
        $GatewayRuntime.pluginReceiptVerified -eq $true -and
        -not [string]::IsNullOrWhiteSpace($pluginPath) -and
        $manifestSha256 -match '^[0-9a-fA-F]{64}$' -and
        $profile -eq 'kakaoworker' -and $pid -gt 0 -and
        $SmokeEvidence.nativeSessionResult -eq 'pass' -and
        $SmokeEvidence.scheduleOwnerReviewRequired -eq $true -and
        $SmokeEvidence.sendCount -eq 0 -and $SmokeEvidence.writeCount -eq 0 -and
        $killSwitchObserved -in @('active', 'price_paused')
    )
}

function Test-KakaoGatewayCutoverHealth {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][psobject]$Health,
        [Parameter(Mandatory = $true)][psobject]$RuntimeProbe,
        [Parameter(Mandatory = $true)][psobject]$GatewayRuntime,
        [Parameter(Mandatory = $true)][psobject]$SmokeEvidence
    )

    return Test-KakaoGatewayHealthContract -Health $Health -RuntimeProbe $RuntimeProbe `
        -GatewayRuntime $GatewayRuntime -SmokeEvidence $SmokeEvidence -RequireCleanHistory $true
}

function Test-KakaoGatewayWatchdogHealth {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][psobject]$Health,
        [Parameter(Mandatory = $true)][psobject]$RuntimeProbe,
        [Parameter(Mandatory = $true)][psobject]$GatewayRuntime,
        [Parameter(Mandatory = $true)][psobject]$SmokeEvidence
    )

    return [bool](
        (Test-KakaoLiveBridgeContract -Health $Health) -and
        (Test-KakaoGatewayHealthContract -Health $Health -RuntimeProbe $RuntimeProbe `
            -GatewayRuntime $GatewayRuntime -SmokeEvidence $SmokeEvidence -RequireCleanHistory $false)
    )
}

function Test-KakaoLiveBridgeContract {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [psobject]$Health
    )

    $configProperty = $Health.PSObject.Properties['config']
    $config = if ($null -ne $configProperty) { $configProperty.Value } else { $null }
    $startupCatchupSupported = Test-KakaoLiveHealthProperty -Object $config -Name 'startupCatchupSupported' -ExpectedValue $true
    $aiDomSplitEnabled = Test-KakaoLiveHealthProperty -Object $config -Name 'aiDomSplitEnabled' -ExpectedValue $true
    $aiDecisionConcurrency = Test-KakaoLiveHealthProperty -Object $config -Name 'aiDecisionConcurrency' -ExpectedValue 2
    $workOrchestratorProperty = if ($null -ne $config) { $config.PSObject.Properties['workOrchestrator'] } else { $null }
    $workOrchestrator = if ($null -ne $workOrchestratorProperty) { $workOrchestratorProperty.Value } else { $null }
    $runtimeMode = Resolve-KakaoLiveRuntimeMode
    $runtimeModeMatches = Test-KakaoLiveHealthProperty -Object $workOrchestrator -Name 'runtimeMode' -ExpectedValue $runtimeMode
    $workOrchestratorModeHealthy = $null -ne $workOrchestrator -and $runtimeModeMatches
    if ($workOrchestratorModeHealthy -and $runtimeMode -eq 'v2') {
        foreach ($propertyName in @(
            'shadowWrites', 'immediateEnabled', 'workItemsEnabled', 'digestEnabled', 'cleanupEnabled',
            'p0ReadbackEnabled', 'p0CutoverEnabled', 'storeConfigured', 'immediateLocalConfigReady',
            'p0LocalConfigReady', 'digestLocalConfigReady', 'actionLocalConfigReady', 'cleanupLocalConfigReady'
        )) {
            if (-not (Test-KakaoLiveHealthProperty -Object $workOrchestrator -Name $propertyName -ExpectedValue $true)) {
                $workOrchestratorModeHealthy = $false
                break
            }
        }
    }
    if ($workOrchestratorModeHealthy -and $runtimeMode -eq 'legacy') {
        foreach ($propertyName in @(
            'shadowWrites', 'immediateEnabled', 'workItemsEnabled', 'digestEnabled', 'cleanupEnabled',
            'p0ReadbackEnabled', 'p0CutoverEnabled'
        )) {
            if (-not (Test-KakaoLiveHealthProperty -Object $workOrchestrator -Name $propertyName -ExpectedValue $false)) {
                $workOrchestratorModeHealthy = $false
                break
            }
        }
    }
    $healthWorkOrchestratorProperty = $Health.PSObject.Properties['workOrchestrator']
    $healthWorkOrchestrator = if ($null -ne $healthWorkOrchestratorProperty) { $healthWorkOrchestratorProperty.Value } else { $null }
    $workOrchestratorInvariantHealthy = Test-KakaoLiveHealthProperty -Object $healthWorkOrchestrator -Name 'ok' -ExpectedValue $true
    $slackBotTokenPresent = Test-KakaoLiveHealthProperty -Object $config -Name 'slackBotTokenPresent' -ExpectedValue $true

    $baseHealthy = [bool](
        (Test-KakaoLiveHealthProperty -Object $Health -Name 'ok' -ExpectedValue $true) -and
        $null -ne $config -and
        (Test-KakaoLiveHealthProperty -Object $config -Name 'workerLive' -ExpectedValue $true) -and
        (Test-KakaoLiveHealthProperty -Object $config -Name 'workerDryRun' -ExpectedValue $false) -and
        (Test-KakaoLiveHealthProperty -Object $config -Name 'windowsWritesEnabled' -ExpectedValue $true) -and
        (Test-KakaoLiveHealthProperty -Object $config -Name 'autoSendEnabled' -ExpectedValue $true) -and
        $slackBotTokenPresent -and
        (Test-KakaoLiveHealthProperty -Object $config -Name 'supabaseRecoveryEnabled' -ExpectedValue $true) -and
        (Test-KakaoLiveHealthProperty -Object $config -Name 'kakaoTabCleanupEnabled' -ExpectedValue $true) -and
        $aiDomSplitEnabled -and
        $aiDecisionConcurrency -and
        $workOrchestratorModeHealthy -and
        $startupCatchupSupported
    )
    if (-not $baseHealthy) { return $false }
    if ($runtimeMode -eq 'legacy') {
        return [bool](
            (Test-KakaoLiveHealthProperty -Object $config -Name 'slackCardDeliveryEnabled' -ExpectedValue $true) -and
            (Test-KakaoLiveHealthProperty -Object $config -Name 'followUpRowsEnabled' -ExpectedValue $true) -and
            (Test-KakaoLiveHealthProperty -Object $config -Name 'slackActionPollEnabled' -ExpectedValue $true) -and
            (Test-KakaoLiveHealthProperty -Object $config -Name 'p0SlackEscalationEnabled' -ExpectedValue $true)
        )
    }
    return [bool](
        (Test-KakaoLiveHealthProperty -Object $config -Name 'slackCardDeliveryEnabled' -ExpectedValue $false) -and
        (Test-KakaoLiveHealthProperty -Object $config -Name 'followUpRowsEnabled' -ExpectedValue $false) -and
        (Test-KakaoLiveHealthProperty -Object $config -Name 'slackActionPollEnabled' -ExpectedValue $false) -and
        (Test-KakaoLiveHealthProperty -Object $config -Name 'p0SlackEscalationEnabled' -ExpectedValue $false) -and
        $workOrchestratorInvariantHealthy
    )
}

function Get-KakaoLiveRuntimeState {
    [CmdletBinding()]
    param(
        [AllowNull()]
        [psobject]$Probe
    )

    if ($null -eq $Probe) { return 'cdp_unavailable' }
    if ($Probe.PSObject.Properties.Name -contains 'state') {
        $state = [string]$Probe.state
        if (-not [string]::IsNullOrWhiteSpace($state)) { return $state }
    }
    if ($Probe.PSObject.Properties.Name -contains 'cdpReady' -and $Probe.cdpReady -ne $true) {
        return 'cdp_unavailable'
    }
    if ($Probe.PSObject.Properties.Name -contains 'authenticated' -and $Probe.authenticated -ne $true) {
        return 'login_required'
    }
    if ($Probe.PSObject.Properties.Name -contains 'watcherReady' -and $Probe.watcherReady -ne $true) {
        return 'watcher_repair_required'
    }
    return 'degraded'
}

function Test-KakaoLiveRuntimeProbe {
    [CmdletBinding()]
    param(
        [AllowNull()]
        [psobject]$Probe
    )

    if ($null -eq $Probe) { return $false }
    return [bool](
        (Get-KakaoLiveRuntimeState -Probe $Probe) -eq 'healthy' -and
        $Probe.PSObject.Properties.Name -contains 'cdpReady' -and $Probe.cdpReady -eq $true -and
        $Probe.PSObject.Properties.Name -contains 'authenticated' -and $Probe.authenticated -eq $true -and
        $Probe.PSObject.Properties.Name -contains 'watcherReady' -and $Probe.watcherReady -eq $true
    )
}

function Test-KakaoLiveHealth {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [psobject]$Health,

        [AllowNull()]
        [psobject]$RuntimeProbe = $null
    )

    if ($null -eq $RuntimeProbe -and $Health.PSObject.Properties.Name -contains 'runtime') {
        $RuntimeProbe = $Health.runtime
    }
    $runtimeReady = Test-KakaoLiveRuntimeProbe -Probe $RuntimeProbe

    return [bool]((Test-KakaoLiveBridgeContract -Health $Health) -and $runtimeReady)
}

function Get-KakaoLiveRecoveryAction {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)] [bool]$BridgeContractHealthy,
        [Parameter(Mandatory = $true)] [string]$RuntimeState,
        [Parameter(Mandatory = $true)] [bool]$BridgeBusy,
        [bool]$WatcherProbeHealthy = $true
    )

    $null = $BridgeBusy
    if (-not $BridgeContractHealthy) { return 'restart_full_runtime' }
    if ($RuntimeState -eq 'healthy' -and -not $WatcherProbeHealthy) { return 'repair_watcher_only' }
    switch ($RuntimeState) {
        'healthy' { return 'none' }
        'cdp_unavailable' { return 'restart_owned_chrome_only' }
        'login_required' { return 'recover_login' }
        'watcher_repair_required' { return 'repair_watcher_only' }
        default { return 'preserve_and_wait' }
    }
}

function Get-KakaoLiveSourceRefreshAction {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)] [DateTime]$SourceLastWriteTimeUtc,
        [Parameter(Mandatory = $true)] [DateTime]$ProcessStartTimeUtc,
        [Parameter(Mandatory = $true)] [bool]$BridgeBusy
    )

    if ($SourceLastWriteTimeUtc.ToUniversalTime() -le $ProcessStartTimeUtc.ToUniversalTime()) { return 'none' }
    if ($BridgeBusy) { return 'preserve_and_wait' }
    return 'restart_full_runtime'
}

function Get-KakaoLoginRunnerArguments {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)] [string]$LoginRunner,
        [ValidateSet('chrome_saved_autofill', 'onepassword')] [string]$CredentialMode = 'chrome_saved_autofill',
        [string]$UsernameRef = '',
        [string]$PasswordRef = '',
        [string]$OtpRef = '',
        [string]$OpPath = '',
        [switch]$SecretsStdin
    )

    $arguments = @(
        $LoginRunner,
        '--port', '9223',
        '--credential-mode', $CredentialMode,
        '--timeout-ms', '60000'
    )
    if ($CredentialMode -eq 'chrome_saved_autofill') { return ,$arguments }
    if (-not $UsernameRef.StartsWith('op://') -or -not $PasswordRef.StartsWith('op://')) {
        throw 'Kakao login references must use the op:// scheme.'
    }
    $arguments = @(
        $LoginRunner,
        '--port', '9223',
        '--credential-mode', $CredentialMode,
        '--username-ref', $UsernameRef,
        '--password-ref', $PasswordRef,
        '--timeout-ms', '60000'
    )
    if ($OtpRef.StartsWith('op://')) { $arguments += @('--otp-ref', $OtpRef) }
    if ($SecretsStdin.IsPresent) {
        $arguments += @('--secrets-stdin', '1')
    }
    elseif (-not [string]::IsNullOrWhiteSpace($OpPath)) {
        $arguments += @('--op-path', $OpPath)
    }
    return ,$arguments
}

function New-KakaoLoginStdinPayload {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)] [string]$UsernameRef,
        [Parameter(Mandatory = $true)] [string]$PasswordRef,
        [string]$OtpRef = '',
        [Parameter(Mandatory = $true)] [scriptblock]$ReadSecret
    )

    if (-not $UsernameRef.StartsWith('op://') -or -not $PasswordRef.StartsWith('op://')) {
        throw 'Kakao login references must use the op:// scheme.'
    }
    $username = [string](& $ReadSecret $UsernameRef)
    $password = [string](& $ReadSecret $PasswordRef)
    if ([string]::IsNullOrEmpty($username) -or [string]::IsNullOrEmpty($password)) {
        throw 'Kakao login secret retrieval returned an empty value.'
    }
    $otp = if ($OtpRef.StartsWith('op://')) { [string](& $ReadSecret $OtpRef) } else { '' }
    return [pscustomobject]@{
        username = $username
        password = $password
        otp = $otp
    } | ConvertTo-Json -Compress
}

function Get-KakaoLoginReference {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)] [string]$EnvFile,
        [Parameter(Mandatory = $true)] [string]$Name
    )

    $escapedName = [regex]::Escape($Name)
    foreach ($line in Get-Content -LiteralPath $EnvFile -Encoding UTF8) {
        if ($line -match "^\s*$escapedName\s*=\s*(.*)$") {
            return $Matches[1].Trim().Trim('"').Trim("'")
        }
    }
    return ''
}

function Invoke-KakaoLoginRecovery {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)] [string]$EnvFile,
        [Parameter(Mandatory = $true)] [string]$NodePath,
        [Parameter(Mandatory = $true)] [string]$LoginRunner
    )

    $credentialMode = Get-KakaoLoginReference -EnvFile $EnvFile -Name 'KAKAO_LOGIN_CREDENTIAL_MODE'
    if ([string]::IsNullOrWhiteSpace($credentialMode)) { $credentialMode = 'chrome_saved_autofill' }
    if ($credentialMode -eq 'chrome_saved_autofill') {
        $arguments = Get-KakaoLoginRunnerArguments -LoginRunner $LoginRunner -CredentialMode $credentialMode
        $loginOutput = & $NodePath @arguments 2>$null
        try {
            return (($loginOutput -join [Environment]::NewLine) | ConvertFrom-Json -ErrorAction Stop)
        }
        catch {
            return [pscustomobject]@{ ok = $false; state = 'degraded'; attempted = $false }
        }
    }
    if ($credentialMode -ne 'onepassword') {
        return [pscustomobject]@{ ok = $false; state = 'credential_configuration_required'; attempted = $false }
    }

    $usernameRef = Get-KakaoLoginReference -EnvFile $EnvFile -Name 'KAKAO_1PASSWORD_USERNAME_REF'
    $passwordRef = Get-KakaoLoginReference -EnvFile $EnvFile -Name 'KAKAO_1PASSWORD_PASSWORD_REF'
    $otpRef = Get-KakaoLoginReference -EnvFile $EnvFile -Name 'KAKAO_1PASSWORD_OTP_REF'
    $opPath = Get-KakaoLoginReference -EnvFile $EnvFile -Name 'OP_CLI_PATH'
    if (-not $usernameRef.StartsWith('op://') -or -not $passwordRef.StartsWith('op://')) {
        return [pscustomobject]@{ ok = $false; state = 'credential_configuration_required'; attempted = $false }
    }
    if ([string]::IsNullOrWhiteSpace($opPath) -or -not (Test-Path -LiteralPath $opPath -PathType Leaf)) {
        return [pscustomobject]@{ ok = $false; state = 'credential_configuration_required'; attempted = $false }
    }

    $env:OP_BIOMETRIC_UNLOCK_ENABLED = 'true'
    $readSecret = {
        param([string]$Reference)
        $value = & $opPath read --no-newline $Reference 2>$null
        if ($LASTEXITCODE -ne 0) { throw '1Password secret retrieval failed.' }
        return [string]$value
    }
    try {
        $secretPayload = New-KakaoLoginStdinPayload -UsernameRef $usernameRef -PasswordRef $passwordRef `
            -OtpRef $otpRef -ReadSecret $readSecret
    }
    catch {
        return [pscustomobject]@{ ok = $false; state = 'vault_unlock_required'; attempted = $false }
    }

    $arguments = Get-KakaoLoginRunnerArguments -LoginRunner $LoginRunner -CredentialMode $credentialMode -UsernameRef $usernameRef `
        -PasswordRef $passwordRef -OtpRef $otpRef -OpPath $opPath -SecretsStdin
    $loginOutput = $secretPayload | & $NodePath @arguments 2>$null
    $secretPayload = $null
    try {
        return (($loginOutput -join [Environment]::NewLine) | ConvertFrom-Json -ErrorAction Stop)
    }
    catch {
        return [pscustomobject]@{ ok = $false; state = 'degraded'; attempted = $false }
    }
}

function Get-KakaoLiveStartupPlan {
    [CmdletBinding()]
    param()

    return [pscustomobject]@{
        runtime = [pscustomobject](Get-KakaoLiveRuntimeContract)
        steps = @(
            'accept-already-healthy-live'
            'classify-kakao-runtime-state'
            'preserve-authentication-pages'
            'repair-only-the-failed-layer'
            'verify-full-live-health'
        )
    }
}

Export-ModuleMember -Function @(
    'Resolve-KakaoLiveRuntimeMode',
    'Get-KakaoLiveRuntimeContract',
    'Assert-KakaoLiveV2CutoverContract',
    'Set-KakaoLiveRuntimeEnvironment',
    'Test-KakaoLiveBridgeContract',
    'Get-KakaoLiveRuntimeState',
    'Test-KakaoLiveRuntimeProbe',
    'Test-KakaoLiveHealth',
    'Get-KakaoLiveRecoveryAction',
    'Get-KakaoLiveSourceRefreshAction',
    'Get-KakaoLoginRunnerArguments',
    'New-KakaoLoginStdinPayload',
    'Get-KakaoLoginReference',
    'Invoke-KakaoLoginRecovery',
    'Get-KakaoLiveStartupPlan',
    'Get-KakaoGatewayCutoverPlan',
    'Test-KakaoGatewayCutoverHealth',
    'Test-KakaoGatewayWatchdogHealth',
    'Test-KakaoPluginInstallReceipt'
)
