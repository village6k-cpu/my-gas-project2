Set-StrictMode -Version Latest

function Resolve-KakaoLivenessGuardAction {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][bool]$ChromeHealthy,
        [Parameter(Mandatory = $true)][bool]$BridgeHealthy,
        [Parameter(Mandatory = $true)][bool]$GatewayHealthy,
        [Parameter(Mandatory = $true)][bool]$WatcherHealthy,
        [Parameter(Mandatory = $true)][ValidateRange(0, 1000)][int]$ConsecutiveFailures
    )

    if ($ChromeHealthy -and $BridgeHealthy -and $GatewayHealthy -and $WatcherHealthy) {
        return 'healthy'
    }
    if ($ChromeHealthy -and -not $BridgeHealthy -and $GatewayHealthy -and $WatcherHealthy) {
        return 'recover_bridge_only'
    }
    if ($ChromeHealthy -and $BridgeHealthy -and $GatewayHealthy -and -not $WatcherHealthy) {
        if ($ConsecutiveFailures -lt 3) { return 'defer' }
        return 'evaluate_live_runtime'
    }
    if ($ConsecutiveFailures -lt 2) { return 'defer' }
    return 'run_full_watchdog'
}

Export-ModuleMember -Function Resolve-KakaoLivenessGuardAction
