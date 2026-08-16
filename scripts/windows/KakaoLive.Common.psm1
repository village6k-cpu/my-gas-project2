Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Get-KakaoLiveRuntimeContract {
    [CmdletBinding()]
    param()

    return [ordered]@{
        AI_WORKER_LIVE                    = '1'
        AI_WORKER_AUTO_SEND               = '1'
        AI_WORKER_DRY_RUN                 = '0'
        SLACK_ACTION_POLL_ENABLED         = '1'
        SLACK_AGENT_CARD_DELIVERY_ENABLED = '1'
        VILLAGE_WINDOWS_WRITES_ENABLED    = '1'
        SUPABASE_RECOVERY_ENABLED         = '1'
        KAKAO_TAB_CLEANUP_ENABLED         = '1'
        HERMES_WORKER_COMMAND_MODE        = 'python_module'
        HERMES_HOME                       = (Join-Path $env:LOCALAPPDATA 'hermes')
        DEBOUNCE_MS                       = '15000'
        MAX_WAIT_MS                       = '45000'
        WORKER_SLOW_ALERT_MS              = '30000'
        WORKER_TIMEOUT_MS                 = '540000'
        WORKER_CATCHUP_TIMEOUT_MS         = '540000'
        HERMES_WORKER_TIMEOUT_MS          = '480000'
        HERMES_WORKER_MAX_TURNS           = '12'
    }
}

function Set-KakaoLiveRuntimeEnvironment {
    [CmdletBinding()]
    param()

    foreach ($entry in (Get-KakaoLiveRuntimeContract).GetEnumerator()) {
        [Environment]::SetEnvironmentVariable([string]$entry.Key, [string]$entry.Value, 'Process')
    }
}

function Test-KakaoLiveBridgeContract {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [psobject]$Health
    )

    $startupCatchupSupported = $null -ne $Health.config -and
        $Health.config.PSObject.Properties.Name -contains 'startupCatchupSupported' -and
        $Health.config.startupCatchupSupported -eq $true

    return [bool](
        $Health.ok -eq $true -and
        $null -ne $Health.config -and
        $Health.config.workerLive -eq $true -and
        $Health.config.workerDryRun -eq $false -and
        $Health.config.windowsWritesEnabled -eq $true -and
        $Health.config.autoSendEnabled -eq $true -and
        $Health.config.slackCardDeliveryEnabled -eq $true -and
        $Health.config.slackActionPollEnabled -eq $true -and
        $Health.config.supabaseRecoveryEnabled -eq $true -and
        $Health.config.kakaoTabCleanupEnabled -eq $true -and
        $startupCatchupSupported
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
    'Get-KakaoLiveRuntimeContract',
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
    'Get-KakaoLiveStartupPlan'
)
