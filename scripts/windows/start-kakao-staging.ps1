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

    [string]$HermesPythonPath,

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
if (-not [string]::IsNullOrWhiteSpace($HermesPythonPath)) {
    $HermesPythonPath = (Resolve-Path -LiteralPath $HermesPythonPath -ErrorAction Stop).Path
}
$configScriptPath = Join-Path $PSScriptRoot 'windows-runtime-config.mjs'

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
    if (-not [string]::IsNullOrWhiteSpace($HermesPythonPath)) {
        [Environment]::SetEnvironmentVariable('HERMES_WORKER_COMMAND', $HermesPythonPath, 'Process')
        [Environment]::SetEnvironmentVariable('HERMES_WORKER_COMMAND_MODE', 'python_module', 'Process')
    }
    if ($EnableWrites.IsPresent) {
        Set-KakaoStagingSafeEnvironment -EnableWrites
    }
    else {
        Set-KakaoStagingSafeEnvironment
    }
    [Environment]::SetEnvironmentVariable('VILLAGE_AI_WORKER_CMD', $workerCommand, 'Process')

    if ([string]::IsNullOrWhiteSpace($env:HERMES_HOME)) {
        throw 'HERMES_HOME is required to resolve the active worker profile.'
    }
    $resolvedHermesHome = (Resolve-Path -LiteralPath $env:HERMES_HOME -ErrorAction Stop).Path
    $workerProfileHome = (Resolve-Path -LiteralPath (
        Join-Path (Join-Path $resolvedHermesHome 'profiles') $env:HERMES_WORKER_PROFILE
    ) -ErrorAction Stop).Path
    # The live profile is the sole owner of its native Hermes skills and
    # learning metadata. Migration imports are explicit recovery operations;
    # a normal start must never replace this directory.
    [void](Resolve-Path -LiteralPath (Join-Path $workerProfileHome 'skills') -ErrorAction Stop)

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
        # 최신 Chromium은 공개 사이트(카카오 페이지)에서 127.0.0.1(브리지)로의 요청을
        # Local Network Access 권한으로 막는다. 자동화 전용 프로필이므로 이 검사를 끄지
        # 않으면 감시자 이벤트가 브리지에 도달하지 못해 파이프라인이 조용히 죽는다.
        (ConvertTo-WindowsCommandLineArgument -Value '--disable-features=LocalNetworkAccessChecks,PrivateNetworkAccessChecks,PrivateNetworkAccessSendPreflights'),
        # 최소화/백그라운드 탭은 Chromium이 타이머·렌더링을 절전 처리해서 카카오 채팅
        # 목록이 밤새 갱신되지 않는 동결이 발생한다(2026-08-07 새벽 감지 전멸 사건).
        # 하트비트는 살아있어도 화면이 얼어 새 메시지가 DOM에 안 들어오므로 반드시 끈다.
        (ConvertTo-WindowsCommandLineArgument -Value '--disable-background-timer-throttling'),
        (ConvertTo-WindowsCommandLineArgument -Value '--disable-backgrounding-occluded-windows'),
        (ConvertTo-WindowsCommandLineArgument -Value '--disable-renderer-backgrounding'),
        (ConvertTo-WindowsCommandLineArgument -Value $chromeProfileArgument),
        (ConvertTo-WindowsCommandLineArgument -Value $extensionArgument),
        (ConvertTo-WindowsCommandLineArgument -Value $loadExtensionArgument),
        (ConvertTo-WindowsCommandLineArgument -Value $kakaoStartUrl)
    )
    $chromeCommandLine = $chromeArguments -join ' '
    # Chromium can relaunch itself and normalize --user-data-dir quoting.  The
    # unique profile path is stable while the full argument spelling is not.
    $chromeCommandMarker = $chromeProfilePath
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
    # 브리지 stdout/stderr를 파일로 남긴다. 이게 없으면 브리지가 죽어도 유서가 0바이트다
    # (2026-08-11 사망 원인 추적 불가 실측). Start-Process 리다이렉트는 시작마다 덮어쓰므로
    # 직전 세대 로그를 .prev로 한 세대 보존해 사망 직후 재기동돼도 증거가 남게 한다.
    $bridgeLogRoot = Get-KakaoStagingRoot
    foreach ($stream in @('out', 'err')) {
        $cur = Join-Path $bridgeLogRoot ("bridge.{0}.log" -f $stream)
        if (Test-Path -LiteralPath $cur) {
            Move-Item -LiteralPath $cur -Destination (Join-Path $bridgeLogRoot ("bridge.{0}.prev.log" -f $stream)) -Force -ErrorAction SilentlyContinue
        }
    }
    $bridgeProcess = Start-Process -FilePath $NodePath -ArgumentList $bridgeCommandLine -WorkingDirectory $bridgeDirectory -PassThru -ErrorAction Stop `
        -RedirectStandardOutput (Join-Path $bridgeLogRoot 'bridge.out.log') `
        -RedirectStandardError (Join-Path $bridgeLogRoot 'bridge.err.log')
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

    # 이 머신의 Chromium 빌드는 --load-extension을 조용히 무시한다 (프로필 확장 등록 0개로 확인).
    # 확장 인자는 이를 지원하는 빌드용으로 유지하되, 감시자는 CDP 주입으로 보장한다.
    # 주입이 없으면 chrome/bridge가 떠 있어도 DOM 이벤트가 0건이라 파이프라인이 조용히 죽는다.
    $watcherInjectorPath = (Resolve-Path -LiteralPath (Join-Path $repoRoot 'tools\kakao-dom-bridge\inject-watcher-cdp.py') -ErrorAction Stop).Path
    $watcherPythonPath = $HermesPythonPath
    if ([string]::IsNullOrWhiteSpace($watcherPythonPath)) {
        $pythonCommand = Get-Command python -ErrorAction SilentlyContinue
        if ($null -ne $pythonCommand) { $watcherPythonPath = $pythonCommand.Source }
    }
    if ([string]::IsNullOrWhiteSpace($watcherPythonPath)) {
        Write-Warning 'python not found; Kakao watcher CDP injection skipped - the DOM watcher will not run.'
    }
    else {
        $watcherInjectionOutput = & $watcherPythonPath $watcherInjectorPath --port $devToolsPort --wait 45 2>&1
        $watcherInjectionExitCode = $LASTEXITCODE
        try {
            $watcherInjection = ($watcherInjectionOutput -join [Environment]::NewLine) | ConvertFrom-Json -ErrorAction Stop
        }
        catch {
            throw 'Watcher injection did not return valid JSON.'
        }
        if ($watcherInjectionExitCode -ne 0 -or -not $watcherInjection.ok) {
            throw 'Watcher injection failed.'
        }
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
