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

    [switch]$IncludeGateway,

    [switch]$EnableWrites
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

Import-Module (Join-Path $PSScriptRoot 'KakaoStaging.Common.psm1') -Force

$repoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..') -ErrorAction Stop).Path
$resolvedEnvFile = (Resolve-Path -LiteralPath $EnvFile -ErrorAction Stop).Path
$ChromePath = (Resolve-Path -LiteralPath $ChromePath -ErrorAction Stop).Path
$NodePath = (Resolve-Path -LiteralPath $NodePath -ErrorAction Stop).Path
$configScriptPath = Join-Path $PSScriptRoot 'windows-runtime-config.mjs'
$profileOverlayScriptPath = (Resolve-Path -LiteralPath (
    Join-Path $PSScriptRoot 'sync-hermes-profile-overlay.ps1'
) -ErrorAction Stop).Path

$extensionPath = (Resolve-Path -LiteralPath (Join-Path $repoRoot 'tools\kakao-dom-watcher-extension') -ErrorAction Stop).Path
$bridgeDirectory = (Resolve-Path -LiteralPath (Join-Path $repoRoot 'tools\kakao-dom-bridge') -ErrorAction Stop).Path
$bridgeScriptPath = (Resolve-Path -LiteralPath (Join-Path $bridgeDirectory 'server.mjs') -ErrorAction Stop).Path
$workerWrapperPath = (Resolve-Path -LiteralPath (Join-Path $repoRoot 'scripts\windows\windows-ai-worker.mjs') -ErrorAction Stop).Path
$workerCommand = @(
    (ConvertTo-WindowsCommandLineArgument -Value $NodePath),
    (ConvertTo-WindowsCommandLineArgument -Value $workerWrapperPath)
) -join ' '

if ($IncludeGateway.IsPresent) {
    if ([string]::IsNullOrWhiteSpace($HermesPath)) {
        throw 'HermesPath is required when IncludeGateway is supplied.'
    }
    $HermesPath = (Resolve-Path -LiteralPath $HermesPath -ErrorAction Stop).Path
}

if (-not $PSCmdlet.ShouldProcess('Windows Kakao staging runtime', 'Start owned staging processes')) {
    return
}

$startedProcesses = New-Object System.Collections.ArrayList
$startMutex = $null
$startMutexAcquired = $false

try {
    $startMutex = [System.Threading.Mutex]::new($false, 'Local\Village.KakaoStaging.Start.v1')
    try {
        $startMutexAcquired = $startMutex.WaitOne(0)
    }
    catch [System.Threading.AbandonedMutexException] {
        $startMutexAcquired = $true
    }
    if (-not $startMutexAcquired) {
        throw 'Another manual or scheduled Windows Kakao staging start is already in progress.'
    }

    $chromeFile = Get-Item -LiteralPath $ChromePath -ErrorAction Stop
    $chromeProductName = [string]$chromeFile.VersionInfo.ProductName
    $chromeFileVersion = $null
    if (-not [version]::TryParse([string]$chromeFile.VersionInfo.FileVersion, [ref]$chromeFileVersion)) {
        throw 'ChromePath does not expose a valid browser file version.'
    }
    if ($chromeProductName -eq 'Google Chrome' -and $chromeFileVersion.Major -ge 137) {
        throw 'Google Chrome 137+ blocks command-line extension loading. Use Chrome for Testing or Chromium for the Kakao staging runtime.'
    }

    if ($EnableWrites.IsPresent) {
        $validationOutput = & $NodePath $configScriptPath --env $resolvedEnvFile --worker-command $workerCommand --enable-writes 2>&1
    }
    else {
        $validationOutput = & $NodePath $configScriptPath --env $resolvedEnvFile --worker-command $workerCommand 2>&1
    }
    $validationExitCode = $LASTEXITCODE

    try {
        $validation = ($validationOutput -join [Environment]::NewLine) | ConvertFrom-Json -ErrorAction Stop
    }
    catch {
        throw 'Windows staging configuration validation did not return valid JSON.'
    }
    if ($validationExitCode -ne 0 -or -not $validation.valid) {
        $missingNames = @($validation.missing) -join ', '
        $invalidNames = if ($null -ne $validation.PSObject.Properties['invalid']) {
            @($validation.invalid) -join ', '
        }
        else {
            ''
        }
        if ([string]::IsNullOrWhiteSpace($missingNames) -and [string]::IsNullOrWhiteSpace($invalidNames)) {
            throw 'Windows staging configuration validation failed.'
        }
        throw "Windows staging configuration validation failed. Missing setting names: $missingNames. Invalid setting names: $invalidNames."
    }

    Import-DotEnvFile -Path $resolvedEnvFile
    if ($EnableWrites.IsPresent) {
        Set-KakaoStagingSafeEnvironment -EnableWrites
    }
    else {
        Set-KakaoStagingSafeEnvironment
    }
    [Environment]::SetEnvironmentVariable('VILLAGE_AI_WORKER_CMD', $workerCommand, 'Process')

    if ([string]::IsNullOrWhiteSpace($env:HERMES_HOME)) {
        throw 'HERMES_HOME is required to synchronize the active worker profile.'
    }
    $resolvedHermesHome = (Resolve-Path -LiteralPath $env:HERMES_HOME -ErrorAction Stop).Path
    $workerProfileHome = (Resolve-Path -LiteralPath (
        Join-Path (Join-Path $resolvedHermesHome 'profiles') $env:HERMES_WORKER_PROFILE
    ) -ErrorAction Stop).Path
    & $profileOverlayScriptPath `
        -ProfileHome $workerProfileHome `
        -MacHermesHome $resolvedHermesHome `
        -ProfileScoped `
        -Confirm:$false | Out-Null

    $devToolsPort = 0
    $bridgePort = 0
    if (-not [int]::TryParse($env:KAKAO_REMOTE_DEBUGGING_PORT, [ref]$devToolsPort) -or
        $devToolsPort -lt 1 -or $devToolsPort -gt 65535) {
        throw 'KAKAO_REMOTE_DEBUGGING_PORT must be a valid localhost TCP port.'
    }
    if (-not [int]::TryParse($env:PORT, [ref]$bridgePort) -or
        $bridgePort -lt 1 -or $bridgePort -gt 65535) {
        throw 'PORT must be a valid localhost TCP port.'
    }
    $chromeProfilePath = Join-Path (Join-Path $env:LOCALAPPDATA 'Village') 'chrome-kakao'

    foreach ($ownedName in @('chrome', 'bridge', 'gateway')) {
        if ($null -ne (Read-OwnedProcessRecord -Name $ownedName)) {
            throw "An ownership record already exists for '$ownedName'; refusing to overwrite it."
        }
    }
    if (Test-LocalTcpPort -Port $devToolsPort) {
        throw 'The localhost DevTools port is already in use by an unowned process.'
    }
    if (Test-LocalTcpPort -Port $bridgePort) {
        throw 'The localhost bridge port is already in use by an unowned process.'
    }

    Initialize-KakaoStagingRuntimeStorage
    [void](New-Item -ItemType Directory -Path $chromeProfilePath -Force -ErrorAction Stop)

    $chromeProfileArgument = "--user-data-dir=$chromeProfilePath"
    $extensionArgument = "--disable-extensions-except=$extensionPath"
    $loadExtensionArgument = "--load-extension=$extensionPath"
    $kakaoStartUrl = 'https://business.kakao.com/_xhPMls/chats?t_src=business_partnercenter&t_ch=lnb&t_obj=%EB%82%B4%EC%B1%84%ED%8C%85_%ED%81%B4%EB%A6%AD'
    $chromeArguments = @(
        (ConvertTo-WindowsCommandLineArgument -Value '--remote-debugging-address=127.0.0.1'),
        (ConvertTo-WindowsCommandLineArgument -Value "--remote-debugging-port=$devToolsPort"),
        (ConvertTo-WindowsCommandLineArgument -Value '--no-first-run'),
        (ConvertTo-WindowsCommandLineArgument -Value '--start-minimized'),
        (ConvertTo-WindowsCommandLineArgument -Value $chromeProfileArgument),
        (ConvertTo-WindowsCommandLineArgument -Value $extensionArgument),
        (ConvertTo-WindowsCommandLineArgument -Value $loadExtensionArgument),
        (ConvertTo-WindowsCommandLineArgument -Value $kakaoStartUrl)
    )
    $chromeCommandLine = $chromeArguments -join ' '
    $chromeCommandMarker = ConvertTo-WindowsCommandLineArgument -Value $chromeProfileArgument
    $chromeProcess = Start-Process -FilePath $ChromePath -ArgumentList $chromeCommandLine -PassThru -ErrorAction Stop
    $chromeStarted = [pscustomobject]@{
        Name           = 'chrome'
        Process        = $chromeProcess
        ExecutablePath = $ChromePath
        CommandMarker  = $chromeCommandMarker
        Recorded       = $false
    }
    [void]$startedProcesses.Add($chromeStarted)
    Write-OwnedProcessRecord -Name 'chrome' -Process $chromeProcess -ExecutablePath $ChromePath -CommandMarker $chromeCommandMarker -Port $devToolsPort
    $chromeStarted.Recorded = $true

    $chromeDeadline = [DateTime]::UtcNow.AddSeconds(20)
    while (-not (Test-LocalTcpPort -Port $devToolsPort)) {
        if ([DateTime]::UtcNow -ge $chromeDeadline -or $chromeProcess.HasExited) {
            throw 'Owned Chrome did not make its localhost DevTools port ready.'
        }
        Start-Sleep -Milliseconds 250
    }

    $bridgeCommandLine = ConvertTo-WindowsCommandLineArgument -Value $bridgeScriptPath
    $bridgeProcess = Start-Process -FilePath $NodePath -ArgumentList $bridgeCommandLine -WorkingDirectory $bridgeDirectory -PassThru -ErrorAction Stop
    $bridgeStarted = [pscustomobject]@{
        Name           = 'bridge'
        Process        = $bridgeProcess
        ExecutablePath = $NodePath
        CommandMarker  = $bridgeCommandLine
        Recorded       = $false
    }
    [void]$startedProcesses.Add($bridgeStarted)
    Write-OwnedProcessRecord -Name 'bridge' -Process $bridgeProcess -ExecutablePath $NodePath -CommandMarker $bridgeCommandLine -Port $bridgePort -WorkerEnabled $true
    $bridgeStarted.Recorded = $true

    $bridgeDeadline = [DateTime]::UtcNow.AddSeconds(20)
    while (-not (Test-LocalTcpPort -Port $bridgePort)) {
        if ([DateTime]::UtcNow -ge $bridgeDeadline -or $bridgeProcess.HasExited) {
            throw 'Owned bridge did not make its localhost port ready.'
        }
        Start-Sleep -Milliseconds 250
    }

    if ($IncludeGateway) {
        $gatewayProfileArgument = ConvertTo-WindowsCommandLineArgument -Value $env:HERMES_WORKER_PROFILE
        $gatewayCommandLine = "--profile $gatewayProfileArgument gateway run"
        $gatewayProfileHome = (Resolve-Path -LiteralPath (Join-Path (Join-Path $env:HERMES_HOME 'profiles') $env:HERMES_WORKER_PROFILE) -ErrorAction Stop).Path
        $brainContextPath = Join-Path (Join-Path $env:VILLAGE_VAULT_ROOT 'Ops') 'brain-context-latest.md'
        $brainContextFile = Get-Item -LiteralPath $brainContextPath -ErrorAction Stop
        if ($brainContextFile.Length -le 0) {
            throw 'The compiled Village Brain context is empty; refusing to start Hermes gateway.'
        }
        $gatewayPidPath = Join-Path $gatewayProfileHome 'gateway.pid'
        $gatewayStatePath = Join-Path $gatewayProfileHome 'gateway_state.json'
        $gatewayLaunchUtc = [DateTime]::UtcNow
        $gatewayProcess = Start-Process -FilePath $HermesPath -ArgumentList $gatewayCommandLine -PassThru -ErrorAction Stop
        $gatewayStarted = [pscustomobject]@{
            Name           = 'gateway'
            Process        = $gatewayProcess
            ExecutablePath = $HermesPath
            CommandMarker  = $gatewayCommandLine
            Recorded       = $false
        }
        [void]$startedProcesses.Add($gatewayStarted)

        $gatewayDeadline = [DateTime]::UtcNow.AddSeconds(150)
        $gatewayReady = $false
        while ([DateTime]::UtcNow -lt $gatewayDeadline) {
            $gatewayProcess.Refresh()
            if ($gatewayProcess.HasExited) {
                throw 'Owned Hermes gateway exited during startup.'
            }

            if ((Test-Path -LiteralPath $gatewayPidPath -PathType Leaf) -and
                (Test-Path -LiteralPath $gatewayStatePath -PathType Leaf)) {
                try {
                    $gatewayPidFile = Get-Item -LiteralPath $gatewayPidPath -ErrorAction Stop
                    $gatewayStateFile = Get-Item -LiteralPath $gatewayStatePath -ErrorAction Stop
                    $gatewayPidRecord = Get-Content -LiteralPath $gatewayPidPath -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop
                    $gatewayState = Get-Content -LiteralPath $gatewayStatePath -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop
                }
                catch {
                    $gatewayPidFile = $null
                    $gatewayStateFile = $null
                    $gatewayPidRecord = $null
                    $gatewayState = $null
                }

                $runtimePid = 0
                $pidFilePid = 0
                $stateUpdatedAt = [DateTimeOffset]::MinValue
                $stateUpdatedAtValid = $null -ne $gatewayState -and
                    [DateTimeOffset]::TryParse([string]$gatewayState.updated_at, [ref]$stateUpdatedAt)
                $stateFresh = $null -ne $gatewayStateFile -and
                    $gatewayStateFile.LastWriteTimeUtc -ge $gatewayLaunchUtc -and
                    $stateUpdatedAtValid -and
                    $stateUpdatedAt.UtcDateTime -ge $gatewayLaunchUtc
                $pidFresh = $null -ne $gatewayPidFile -and
                    $gatewayPidFile.LastWriteTimeUtc -ge $gatewayLaunchUtc

                if ($stateFresh -and [string]$gatewayState.gateway_state -eq 'startup_failed') {
                    throw 'Owned Hermes gateway reported startup_failed.'
                }

                $runtimePidValid = $null -ne $gatewayState -and
                    [int]::TryParse([string]$gatewayState.pid, [ref]$runtimePid)
                $pidFilePidValid = $null -ne $gatewayPidRecord -and
                    [int]::TryParse([string]$gatewayPidRecord.pid, [ref]$pidFilePid)
                $gatewayStateCandidateReady = $stateFresh -and $pidFresh -and
                    [string]$gatewayState.kind -eq 'hermes-gateway' -and
                    [string]$gatewayPidRecord.kind -eq 'hermes-gateway' -and
                    [string]$gatewayState.gateway_state -eq 'running' -and
                    $runtimePidValid -and $pidFilePidValid -and
                    $runtimePid -eq $pidFilePid
                if ($gatewayStateCandidateReady) {
                    $runtimeProcess = $null
                    $runtimeOwnedByLauncher = $false
                    $runtimeProcess = Get-Process -Id $runtimePid -ErrorAction SilentlyContinue
                    if ($null -ne $runtimeProcess) {
                        if ($runtimePid -eq $gatewayProcess.Id) {
                            $runtimeOwnedByLauncher = $true
                        }
                        else {
                            try {
                                $runtimeOwnedByLauncher = @(Get-DescendantProcessIds -ParentId $gatewayProcess.Id) -contains $runtimePid
                            }
                            catch {
                                $runtimeOwnedByLauncher = $false
                            }
                        }
                    }
                    if ($null -ne $runtimeProcess -and $runtimeOwnedByLauncher) {
                        $gatewayReady = $true
                        break
                    }
                }
            }

            Start-Sleep -Milliseconds 250
        }

        if (-not $gatewayReady) {
            throw 'Owned Hermes gateway did not reach a fresh running state before the startup deadline.'
        }

        Write-OwnedProcessRecord -Name 'gateway' -Process $gatewayProcess -ExecutablePath $HermesPath -CommandMarker $gatewayCommandLine
        $gatewayStarted.Recorded = $true
    }
}
catch {
    for ($index = $startedProcesses.Count - 1; $index -ge 0; $index -= 1) {
        $started = $startedProcesses[$index]
        try {
            if ($started.Recorded) {
                Stop-OwnedProcess -Name $started.Name -Confirm:$false | Out-Null
            }
            else {
                Stop-VerifiedProcess -Process $started.Process -ExecutablePath $started.ExecutablePath -CommandMarker $started.CommandMarker -Confirm:$false | Out-Null
            }
        }
        catch {
            Write-Warning ("Cleanup refused for started component '{0}'." -f $started.Name)
        }
    }
    throw
}
finally {
    if ($startMutexAcquired -and $null -ne $startMutex) {
        $startMutex.ReleaseMutex()
    }
    if ($null -ne $startMutex) {
        $startMutex.Dispose()
    }
}
