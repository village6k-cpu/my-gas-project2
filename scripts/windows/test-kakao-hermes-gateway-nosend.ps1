[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][ValidateNotNullOrEmpty()][string]$PluginSourcePath,
    [string]$HermesPythonPath = (Join-Path $env:LOCALAPPDATA 'hermes\hermes-agent\venv\Scripts\python.exe')
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$fixturePath = Join-Path $repoRoot 'tools\kakao-dom-bridge\fixtures\hermes-gateway-replay.json'
$runnerPath = Join-Path $PSScriptRoot 'kakao-hermes-gateway-nosend-runner.py'
$resolvedPlugin = (Resolve-Path -LiteralPath $PluginSourcePath -ErrorAction Stop).Path
$resolvedPython = (Resolve-Path -LiteralPath $HermesPythonPath -ErrorAction Stop).Path
foreach ($required in @($fixturePath, $runnerPath, (Join-Path $resolvedPlugin 'plugin.yaml'))) {
    if (-not (Test-Path -LiteralPath $required -PathType Leaf)) { throw "Offline replay input is missing: '$required'." }
}

$profileHome = Join-Path ([IO.Path]::GetTempPath()) ('kakao-hermes-nosend-' + [Guid]::NewGuid().ToString('N'))
$stdoutPath = Join-Path $profileHome 'evidence.json'
$stderrPath = Join-Path $profileHome 'runner.stderr.log'
$owned = @()
$saved = @{}
$safeEnvironment = [ordered]@{
    AI_WORKER_LIVE = '0'
    AI_WORKER_AUTO_SEND = '0'
    AI_WORKER_DRY_RUN = '1'
    VILLAGE_WINDOWS_WRITES_ENABLED = '0'
    SLACK_AGENT_CARD_DELIVERY_ENABLED = '0'
    SLACK_ACTION_POLL_ENABLED = '0'
    HERMES_HOME = $profileHome
    HERMES_PROFILE = 'kakaoworker-offline'
}

try {
    [void](New-Item -ItemType Directory -Path $profileHome -Force)
    foreach ($entry in $safeEnvironment.GetEnumerator()) {
        $saved[$entry.Key] = [Environment]::GetEnvironmentVariable($entry.Key, 'Process')
        [Environment]::SetEnvironmentVariable($entry.Key, $entry.Value, 'Process')
    }

    $arguments = @(
        $runnerPath,
        '--fixture', $fixturePath,
        '--plugin-source', $resolvedPlugin,
        '--profile-home', $profileHome
    )
    $ownedProcess = Start-Process -FilePath $resolvedPython -ArgumentList $arguments -NoNewWindow -PassThru `
        -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath
    $owned += $ownedProcess
    if (-not $ownedProcess.WaitForExit(30000)) { throw 'Offline Kakao Gateway replay exceeded 30 seconds.' }
    $ownedProcess.WaitForExit()
    $ownedProcess.Refresh()
    $output = Get-Content -Raw -LiteralPath $stdoutPath
    if ([string]::IsNullOrWhiteSpace($output)) {
        $errorText = if (Test-Path -LiteralPath $stderrPath) { Get-Content -Raw -LiteralPath $stderrPath } else { '' }
        throw "Offline Kakao Gateway replay produced no evidence: $errorText"
    }
    [void]($output | ConvertFrom-Json -ErrorAction Stop)
    [Console]::Out.Write($output.Trim())
}
finally {
    foreach ($ownedProcess in $owned) {
        if ($null -ne $ownedProcess -and -not $ownedProcess.HasExited) { Stop-Process -Id $ownedProcess.Id -Force -ErrorAction SilentlyContinue }
    }
    foreach ($entry in $safeEnvironment.GetEnumerator()) {
        [Environment]::SetEnvironmentVariable($entry.Key, $saved[$entry.Key], 'Process')
    }
    if (Test-Path -LiteralPath $profileHome) { Remove-Item -LiteralPath $profileHome -Recurse -Force -ErrorAction SilentlyContinue }
}
