Set-StrictMode -Version Latest

function Resolve-HermesRootLivenessAction {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][bool]$PidRecordPresent,
        [Parameter(Mandatory = $true)][bool]$ProcessAlive,
        [Parameter(Mandatory = $true)][bool]$ProcessMatchesRoot,
        [Parameter(Mandatory = $true)][string]$GatewayState,
        [Parameter(Mandatory = $true)][ValidateRange(0, 86400)][double]$StateAgeSeconds,
        [Parameter(Mandatory = $true)][ValidateRange(0, 1000)][int]$ActiveAgents,
        [ValidateRange(10, 900)][int]$StartupGraceSeconds = 120
    )

    if ($ProcessAlive) {
        if ($PidRecordPresent -and $ProcessMatchesRoot) { return 'healthy' }
        return 'blocked_process_mismatch'
    }

    $normalizedState = $GatewayState.Trim().ToLowerInvariant()
    if ($StateAgeSeconds -lt $StartupGraceSeconds -and $normalizedState -in @('starting', 'running', 'restarting')) {
        return 'defer_startup'
    }

    return 'start'
}

Export-ModuleMember -Function Resolve-HermesRootLivenessAction
