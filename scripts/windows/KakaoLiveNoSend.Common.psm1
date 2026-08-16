Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Get-KakaoLiveNoSendRuntimeContract {
    [CmdletBinding()]
    param()

    return [ordered]@{
        AI_WORKER_LIVE                    = '1'
        AI_WORKER_AUTO_SEND               = '0'
        AI_WORKER_DRY_RUN                 = '0'
        SLACK_ACTION_POLL_ENABLED         = '0'
        SLACK_AGENT_CARD_DELIVERY_ENABLED = '1'
        VILLAGE_WINDOWS_WRITES_ENABLED    = '1'
        HERMES_WORKER_COMMAND_MODE        = 'python_module'
    }
}

function Test-KakaoLiveNoSendHealth {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [psobject]$Health
    )

    return [bool](
        $Health.ok -eq $true -and
        $null -ne $Health.config -and
        $Health.config.workerLive -eq $true -and
        $Health.config.autoSendEnabled -eq $false -and
        $Health.config.slackCardDeliveryEnabled -eq $true -and
        $Health.config.slackActionPollEnabled -eq $false
    )
}

function Get-KakaoLiveNoSendStartupPlan {
    [CmdletBinding()]
    param()

    return [pscustomobject]@{
        runtime = [pscustomobject](Get-KakaoLiveNoSendRuntimeContract)
        steps = @(
            'accept-already-healthy-live-nosend'
            'stop-owned-remnants-if-unhealthy'
            'start-owned-staging-with-writes'
            'promote-bridge-to-live-nosend'
            'verify-live-nosend-health'
        )
    }
}

function Get-KakaoLiveNoSendRecoveryAction {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)] [string]$RuntimeState
    )

    switch ($RuntimeState) {
        'healthy' { return 'none' }
        'login_required' { return 'recover_login' }
        'watcher_repair_required' { return 'repair_watcher_only' }
        default { return 'preserve_and_wait' }
    }
}

function Test-KakaoNoSendTransitionAllowed {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)] [psobject]$Health,
        [Parameter(Mandatory = $true)] [bool]$AllowLiveTransition
    )

    if ($Health.state.workerRunning -eq $true) { return $false }
    $hasQueuedWork = [int]$Health.state.workerQueueLength -ne 0
    $hasLiveFlags = $Health.config.autoSendEnabled -eq $true -or $Health.config.slackActionPollEnabled -eq $true
    if (($hasQueuedWork -or $hasLiveFlags) -and -not $AllowLiveTransition) { return $false }
    return $true
}

function Set-KakaoLiveNoSendEnvironment {
    [CmdletBinding()]
    param()

    $required = Get-KakaoLiveNoSendRuntimeContract
    foreach ($entry in $required.GetEnumerator()) {
        [Environment]::SetEnvironmentVariable($entry.Key, $entry.Value, 'Process')
    }
}

Export-ModuleMember -Function @(
    'Get-KakaoLiveNoSendRuntimeContract',
    'Test-KakaoLiveNoSendHealth',
    'Test-KakaoNoSendTransitionAllowed',
    'Set-KakaoLiveNoSendEnvironment',
    'Get-KakaoLiveNoSendStartupPlan',
    'Get-KakaoLiveNoSendRecoveryAction'
)
