[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'Medium')]
param(
    [string]$ProfileHome,
    [ValidateSet('compact', 'kakaoworker')]
    [string]$ProfileShape = 'compact',
    [string]$WorkerRepo,
    [switch]$Cleanup
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Get-NormalizedFullPath {
    param([Parameter(Mandatory = $true)][string]$Path)

    $providerPath = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Path)
    return [System.IO.Path]::GetFullPath($providerPath).TrimEnd('\')
}

function Assert-IsolatedProfileHome {
    param(
        [Parameter(Mandatory = $true)][string]$Candidate,
        [Parameter(Mandatory = $true)][string]$ProfilesRoot,
        [Parameter(Mandatory = $true)][string]$HermesRoot
    )

    $resolvedCandidate = Get-NormalizedFullPath -Path $Candidate
    $resolvedProfilesRoot = Get-NormalizedFullPath -Path $ProfilesRoot
    $resolvedHermesRoot = Get-NormalizedFullPath -Path $HermesRoot
    $workerHome = Get-NormalizedFullPath -Path (Join-Path $resolvedProfilesRoot 'kakaoworker')

    if ([string]::Equals($resolvedCandidate, $resolvedHermesRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing the live Hermes root. Use a new isolated native-lifecycle-* profile."
    }
    if ([string]::Equals($resolvedCandidate, $workerHome, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing the live kakaoworker profile. Use a new isolated native-lifecycle-* profile."
    }

    $parent = Split-Path -Parent $resolvedCandidate
    if (-not [string]::Equals($parent, $resolvedProfilesRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "The lifecycle profile must be a direct isolated child of $resolvedProfilesRoot."
    }

    $name = Split-Path -Leaf $resolvedCandidate
    if ($name -notmatch '^native-lifecycle-[a-z0-9_-]+$') {
        throw "The isolated profile name must begin with native-lifecycle-."
    }
    return $resolvedCandidate
}

function Write-Utf8NoBom {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Content
    )

    $encoding = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($Path, $Content, $encoding)
}

function Copy-DirectoryContents {
    param(
        [Parameter(Mandatory = $true)][string]$SourceRoot,
        [Parameter(Mandatory = $true)][string]$DestinationRoot
    )

    $resolvedSource = Get-NormalizedFullPath -Path $SourceRoot
    $resolvedDestination = Get-NormalizedFullPath -Path $DestinationRoot
    if (-not (Test-Path -LiteralPath $resolvedSource -PathType Container)) {
        throw "Directory copy source is missing: $resolvedSource"
    }
    New-Item -ItemType Directory -Path $resolvedDestination -Force | Out-Null

    foreach ($directory in Get-ChildItem -LiteralPath $resolvedSource -Recurse -Directory -Force | Sort-Object FullName) {
        $relative = $directory.FullName.Substring($resolvedSource.Length).TrimStart('\')
        New-Item -ItemType Directory -Path (Join-Path $resolvedDestination $relative) -Force | Out-Null
    }
    foreach ($file in Get-ChildItem -LiteralPath $resolvedSource -Recurse -File -Force | Sort-Object FullName) {
        $relative = $file.FullName.Substring($resolvedSource.Length).TrimStart('\')
        $target = Join-Path $resolvedDestination $relative
        New-Item -ItemType Directory -Path (Split-Path -Parent $target) -Force | Out-Null
        Copy-Item -LiteralPath $file.FullName -Destination $target -Force
    }
}

function Remove-IsolatedDirectory {
    param(
        [Parameter(Mandatory = $true)][string]$Candidate,
        [Parameter(Mandatory = $true)][string]$ProfileRoot
    )

    $resolvedCandidate = Get-NormalizedFullPath -Path $Candidate
    $resolvedProfileRoot = Get-NormalizedFullPath -Path $ProfileRoot
    $requiredPrefix = $resolvedProfileRoot + '\'
    if (-not $resolvedCandidate.StartsWith($requiredPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to remove a directory outside the isolated lifecycle profile: $resolvedCandidate"
    }
    if (Test-Path -LiteralPath $resolvedCandidate) {
        Remove-Item -LiteralPath $resolvedCandidate -Recurse -Force
    }
}

function Get-FileManifest {
    param([Parameter(Mandatory = $true)][string]$ProfileRoot)

    $normalizedHome = Get-NormalizedFullPath -Path $ProfileRoot
    $files = New-Object System.Collections.Generic.List[object]
    $skillsRoot = Join-Path $normalizedHome 'skills'
    if (Test-Path -LiteralPath $skillsRoot -PathType Container) {
        foreach ($file in Get-ChildItem -LiteralPath $skillsRoot -Recurse -File | Sort-Object FullName) {
            $relative = $file.FullName.Substring($normalizedHome.Length).TrimStart('\')
            if ($relative -like 'skills\.curator_backups\*') {
                continue
            }
            $files.Add([ordered]@{
                relativePath = $relative.Replace('\', '/')
                bytes = [int64]$file.Length
                sha256 = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash
            })
        }
    }

    foreach ($relativeName in @('config.yaml', 'profile.yaml', '.no-bundled-skills', '.lifecycle-test-profile')) {
        $filePath = Join-Path $normalizedHome $relativeName
        if (-not (Test-Path -LiteralPath $filePath -PathType Leaf)) {
            continue
        }
        $item = Get-Item -LiteralPath $filePath
        $files.Add([ordered]@{
            relativePath = $relativeName
            bytes = [int64]$item.Length
            sha256 = (Get-FileHash -LiteralPath $item.FullName -Algorithm SHA256).Hash
        })
    }

    return @($files | Sort-Object relativePath)
}

function Write-Manifest {
    param(
        [Parameter(Mandatory = $true)][string]$ProfileRoot,
        [Parameter(Mandatory = $true)][string]$Destination
    )

    $manifest = [ordered]@{
        profileHome = $ProfileRoot
        generatedAt = [DateTimeOffset]::UtcNow.ToString('o')
        files = @(Get-FileManifest -ProfileRoot $ProfileRoot)
    }
    Write-Utf8NoBom -Path $Destination -Content ($manifest | ConvertTo-Json -Depth 6)
    return $manifest
}

function Assert-ManifestsEqual {
    param(
        [Parameter(Mandatory = $true)]$Expected,
        [Parameter(Mandatory = $true)]$Actual
    )

    $expectedRows = @($Expected.files | ForEach-Object { "$($_.relativePath)|$($_.bytes)|$($_.sha256)" } | Sort-Object)
    $actualRows = @($Actual.files | ForEach-Object { "$($_.relativePath)|$($_.bytes)|$($_.sha256)" } | Sort-Object)
    $difference = @(Compare-Object -ReferenceObject $expectedRows -DifferenceObject $actualRows)
    if ($difference.Count -ne 0) {
        throw "Native rollback did not restore the pre-curator manifest: $($difference | ConvertTo-Json -Compress)"
    }
}

function Get-ProtectedHashes {
    param([Parameter(Mandatory = $true)][string[]]$Paths)

    $hashes = [ordered]@{}
    foreach ($path in $Paths) {
        $normalized = Get-NormalizedFullPath -Path $path
        if (Test-Path -LiteralPath $normalized -PathType Leaf) {
            $hashes[$normalized] = (Get-FileHash -LiteralPath $normalized -Algorithm SHA256).Hash
        }
        else {
            $hashes[$normalized] = $null
        }
    }
    return $hashes
}

function Assert-ProtectedHashesEqual {
    param(
        [Parameter(Mandatory = $true)]$Before,
        [Parameter(Mandatory = $true)]$After
    )

    foreach ($path in $Before.Keys) {
        if ($Before[$path] -ne $After[$path]) {
            throw "A protected live Hermes file changed during isolated testing: $path"
        }
    }
}

function Invoke-Hermes {
    param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Arguments)

    $previousErrorActionPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        $output = @(& $script:HermesPython -m hermes_cli.main @Arguments 2>&1)
        $exitCode = $LASTEXITCODE
    }
    finally {
        $ErrorActionPreference = $previousErrorActionPreference
    }
    foreach ($line in $output) {
        Write-Host $line
    }
    if ($exitCode -ne 0) {
        throw "Hermes command failed with exit code ${exitCode}: $($Arguments -join ' ')"
    }
    return ($output -join "`n")
}

function Invoke-NativePython {
    param([Parameter(Mandatory = $true)][string]$Code)

    $encodedCode = [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($Code))
    $launcher = "import base64;exec(base64.b64decode('$encodedCode'))"
    $previousErrorActionPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        $output = @(& $script:HermesPython -c $launcher 2>&1)
        $exitCode = $LASTEXITCODE
    }
    finally {
        $ErrorActionPreference = $previousErrorActionPreference
    }
    foreach ($line in $output) {
        Write-Host $line
    }
    if ($exitCode -ne 0) {
        throw "Native Hermes Python probe failed with exit code $exitCode."
    }
    return ($output -join "`n")
}

function Assert-NativeSkillRediscovery {
    param(
        [Parameter(Mandatory = $true)][string[]]$SkillNames,
        [Parameter(Mandatory = $true)][string]$Phase,
        [Parameter(Mandatory = $true)][string]$EvidencePath
    )

    $namesJson = $SkillNames | ConvertTo-Json -Compress
    $namesBase64 = [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($namesJson))
    $probeCode = @"
import base64
import json
from tools.skills_tool import _skill_view_with_bump as skill_view

names = json.loads(base64.b64decode("$namesBase64").decode("utf-8"))
results = {}
missing = []
for name in names:
    viewed = json.loads(skill_view({"name": name}))
    found = bool(viewed.get("success"))
    results[name] = {"found": found, "error": viewed.get("error")}
    if not found:
        missing.append(name)
print(json.dumps({"success": not missing, "missing": missing, "results": results}, ensure_ascii=False))
"@
    $raw = Invoke-NativePython -Code $probeCode
    Write-Utf8NoBom -Path $EvidencePath -Content $raw
    $result = $raw | ConvertFrom-Json
    if (-not $result.success) {
        throw "Hermes failed direct native skill rediscovery during ${Phase}: $($result.missing -join ', ')"
    }
    return $result
}

if (-not $env:LOCALAPPDATA) {
    throw 'LOCALAPPDATA is required for a native Windows Hermes profile test.'
}

$repoRoot = Get-NormalizedFullPath -Path (Join-Path $PSScriptRoot '..\..')
$hermesRoot = Get-NormalizedFullPath -Path (Join-Path $env:LOCALAPPDATA 'hermes')
$profilesRoot = Get-NormalizedFullPath -Path (Join-Path $hermesRoot 'profiles')
$resolvedWorkerProfileHome = Get-NormalizedFullPath -Path (Join-Path $profilesRoot 'kakaoworker')
if ([string]::IsNullOrWhiteSpace($WorkerRepo)) {
    $WorkerRepo = $repoRoot
}
$resolvedWorkerRepo = Get-NormalizedFullPath -Path $WorkerRepo
$defaultName = 'native-lifecycle-' + (Get-Date -Format 'yyyyMMdd-HHmmss')
if ([string]::IsNullOrWhiteSpace($ProfileHome)) {
    $ProfileHome = Join-Path $profilesRoot $defaultName
}
$resolvedProfileHome = Assert-IsolatedProfileHome -Candidate $ProfileHome -ProfilesRoot $profilesRoot -HermesRoot $hermesRoot
$profileName = Split-Path -Leaf $resolvedProfileHome

if (Test-Path -LiteralPath $resolvedProfileHome) {
    throw "Refusing to overwrite an existing lifecycle profile: $resolvedProfileHome"
}

if ($ProfileShape -eq 'kakaoworker') {
    if (-not (Test-Path -LiteralPath (Join-Path $resolvedWorkerProfileHome 'skills') -PathType Container)) {
        throw "The live kakaoworker skill source is missing: $resolvedWorkerProfileHome"
    }
    if (-not (Test-Path -LiteralPath (Join-Path $resolvedWorkerRepo 'scripts\windows') -PathType Container)) {
        throw "The worker runtime repository is missing Windows launchers: $resolvedWorkerRepo"
    }
}

if (-not $PSCmdlet.ShouldProcess($resolvedProfileHome, 'create and exercise an isolated Hermes native skill lifecycle')) {
    Write-Output "WHATIF preview profileHome=$resolvedProfileHome"
    Write-Output "WHATIF profileShape=$ProfileShape"
    if ($ProfileShape -eq 'kakaoworker') {
        Write-Output "WHATIF workerProfileHome=$resolvedWorkerProfileHome"
        Write-Output "WHATIF workerRepo=$resolvedWorkerRepo"
    }
    Write-Output 'WHATIF no profile, worker, gateway, send, or business write will be started.'
    return
}

$script:HermesPython = Join-Path $hermesRoot 'hermes-agent\venv\Scripts\python.exe'
$fixtureServerScript = Join-Path $PSScriptRoot 'hermes-native-curator-fixture-server.py'
if (-not (Test-Path -LiteralPath $script:HermesPython -PathType Leaf)) {
    throw "Hermes Python was not found: $script:HermesPython"
}
if (-not (Test-Path -LiteralPath $fixtureServerScript -PathType Leaf)) {
    throw "Local curator fixture server was not found: $fixtureServerScript"
}

$protectedLivePaths = @(
    (Join-Path $hermesRoot 'auth.json'),
    (Join-Path $hermesRoot 'config.yaml'),
    (Join-Path $hermesRoot 'active_profile'),
    (Join-Path $hermesRoot 'skills\productivity\village-operations\SKILL.md'),
    (Join-Path $hermesRoot 'skills\village\village-brain-first\SKILL.md'),
    (Join-Path $profilesRoot 'kakaoworker\config.yaml'),
    (Join-Path $profilesRoot 'kakaoworker\skills\productivity\village-operations\SKILL.md'),
    (Join-Path $profilesRoot 'kakaoworker\skills\village\village-brain-first\SKILL.md')
)
if ($ProfileShape -eq 'kakaoworker') {
    $protectedLivePaths += @(
        (Join-Path $resolvedWorkerRepo 'scripts\windows\start-kakao-live.ps1'),
        (Join-Path $resolvedWorkerRepo 'scripts\windows\start-kakao-staging.ps1'),
        (Join-Path $resolvedWorkerRepo 'scripts\windows\restart-kakao-staging.ps1'),
        (Join-Path $resolvedWorkerRepo 'scripts\windows\watch-kakao-production.ps1')
    )
}
$protectedBefore = Get-ProtectedHashes -Paths $protectedLivePaths

$environmentNames = @(
    'HERMES_HOME',
    'AI_WORKER_LIVE',
    'AI_WORKER_AUTO_SEND',
    'AI_WORKER_DRY_RUN',
    'VILLAGE_WINDOWS_WRITES_ENABLED'
)
$savedEnvironment = [ordered]@{}
foreach ($name in $environmentNames) {
    $savedEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
}

$fixtureProcess = $null
$completed = $false
try {
    [Environment]::SetEnvironmentVariable('AI_WORKER_LIVE', '0', 'Process')
    [Environment]::SetEnvironmentVariable('AI_WORKER_AUTO_SEND', '0', 'Process')
    [Environment]::SetEnvironmentVariable('AI_WORKER_DRY_RUN', '1', 'Process')
    [Environment]::SetEnvironmentVariable('VILLAGE_WINDOWS_WRITES_ENABLED', '0', 'Process')

    [Environment]::SetEnvironmentVariable('HERMES_HOME', $hermesRoot, 'Process')
    Invoke-Hermes profile create $profileName --no-alias --no-skills | Out-Null
    if (-not (Test-Path -LiteralPath $resolvedProfileHome -PathType Container)) {
        throw "Hermes did not create the isolated profile: $resolvedProfileHome"
    }

    $markerPath = Join-Path $resolvedProfileHome '.lifecycle-test-profile'
    Write-Utf8NoBom -Path $markerPath -Content (([ordered]@{
        profileName = $profileName
        profileHome = $resolvedProfileHome
        createdAt = [DateTimeOffset]::UtcNow.ToString('o')
        purpose = 'isolated-native-skill-lifecycle'
        profileShape = $ProfileShape
    }) | ConvertTo-Json)

    $evidenceRoot = Join-Path $resolvedProfileHome 'lifecycle-evidence'
    $workspaceRoot = Join-Path $resolvedProfileHome 'workspace'
    New-Item -ItemType Directory -Path $evidenceRoot, $workspaceRoot -Force | Out-Null
    $portFile = Join-Path $evidenceRoot 'fixture-port.txt'
    $requestLog = Join-Path $evidenceRoot 'fixture-requests.ndjson'
    $fixtureProcess = Start-Process -FilePath $script:HermesPython -ArgumentList @(
        $fixtureServerScript,
        '--port-file',
        $portFile,
        '--request-log',
        $requestLog
    ) -PassThru -WindowStyle Hidden

    for ($attempt = 0; $attempt -lt 100 -and -not (Test-Path -LiteralPath $portFile -PathType Leaf); $attempt += 1) {
        Start-Sleep -Milliseconds 100
        if ($fixtureProcess.HasExited) {
            throw "The local curator fixture server exited with code $($fixtureProcess.ExitCode)."
        }
    }
    if (-not (Test-Path -LiteralPath $portFile -PathType Leaf)) {
        throw 'The local curator fixture server did not publish a port.'
    }
    $fixturePort = [int](Get-Content -LiteralPath $portFile -Raw).Trim()
    $fixtureBaseUrl = "http://127.0.0.1:$fixturePort/v1"
    $workspaceYaml = $workspaceRoot.Replace('\', '/')

    $config = @"
model:
  default: lifecycle-fixture-model
  provider: custom
  base_url: "$fixtureBaseUrl"
  api_key: isolated-fixture-key
agent:
  reasoning_effort: low
  max_turns: 12
curator:
  enabled: true
  consolidate: false
  stale_after_days: 3650
  archive_after_days: 7300
  backup:
    enabled: true
auxiliary:
  curator:
    provider: custom
    model: lifecycle-fixture-model
    base_url: "$fixtureBaseUrl"
    api_key: isolated-fixture-key
terminal:
  cwd: "$workspaceYaml"
  home_mode: profile
"@
    Write-Utf8NoBom -Path (Join-Path $resolvedProfileHome 'config.yaml') -Content $config

    $overlaySkillsRoot = Join-Path $repoRoot 'scripts\windows\hermes-profile-overlay\skills'
    $operationsSource = Join-Path $overlaySkillsRoot 'productivity\village-operations'
    $brainSource = Join-Path $overlaySkillsRoot 'village\village-brain-first'
    foreach ($requiredSource in @($operationsSource, $brainSource)) {
        if (-not (Test-Path -LiteralPath $requiredSource -PathType Container)) {
            throw "Candidate skill package is missing: $requiredSource"
        }
    }
    $operationsParent = Join-Path $resolvedProfileHome 'skills\productivity'
    $brainParent = Join-Path $resolvedProfileHome 'skills\village'
    if ($ProfileShape -eq 'kakaoworker') {
        Copy-DirectoryContents `
            -SourceRoot (Join-Path $resolvedWorkerProfileHome 'skills') `
            -DestinationRoot (Join-Path $resolvedProfileHome 'skills')
        Remove-IsolatedDirectory `
            -Candidate (Join-Path $operationsParent 'village-operations') `
            -ProfileRoot $resolvedProfileHome
        Remove-IsolatedDirectory `
            -Candidate (Join-Path $brainParent 'village-brain-first') `
            -ProfileRoot $resolvedProfileHome
    }
    New-Item -ItemType Directory -Path $operationsParent, $brainParent -Force | Out-Null
    Copy-Item -LiteralPath $operationsSource -Destination $operationsParent -Recurse
    Copy-Item -LiteralPath $brainSource -Destination $brainParent -Recurse

    [Environment]::SetEnvironmentVariable('HERMES_HOME', $resolvedProfileHome, 'Process')
    $beforeManifestPath = Join-Path $evidenceRoot 'before-manifest.json'
    Write-Manifest -ProfileRoot $resolvedProfileHome -Destination $beforeManifestPath | Out-Null

    $createFixtureCode = @'
import json
from tools.skill_manager_tool import skill_manage
from tools.skill_provenance import BACKGROUND_REVIEW, reset_current_write_origin, set_current_write_origin

content = """---
name: native-lifecycle-marker
description: Record isolated lifecycle restart evidence.
---

# Native lifecycle marker

Created through Hermes native skill_manage in an isolated profile.
"""
token = set_current_write_origin(BACKGROUND_REVIEW)
try:
    result = json.loads(skill_manage(action="create", name="native-lifecycle-marker", content=content, category="testing"))
finally:
    reset_current_write_origin(token)
if not result.get("success"):
    raise SystemExit(json.dumps(result, ensure_ascii=False))
print(json.dumps({"success": True, "name": "native-lifecycle-marker"}))
'@
    Invoke-NativePython -Code $createFixtureCode | Out-Null

    Invoke-Hermes curator adopt village-operations --dry-run | Out-Null
    Invoke-Hermes curator adopt village-operations | Out-Null
    $unmanaged = Invoke-Hermes curator list-unmanaged
    if ($unmanaged -notmatch 'village-history-evidence') {
        throw 'Village Brain must remain user-managed in the isolated lifecycle test.'
    }

    $usagePath = Join-Path $resolvedProfileHome 'skills\.usage.json'
    $usage = Get-Content -LiteralPath $usagePath -Raw | ConvertFrom-Json
    if ($usage.'village-operations'.created_by -ne 'agent') {
        throw 'village-operations was not explicitly adopted into curator management.'
    }
    if ($usage.'native-lifecycle-marker'.created_by -ne 'agent') {
        throw 'The native background-review skill was not marked agent-managed.'
    }
    $brainUsageProperty = $usage.PSObject.Properties['village-history-evidence']
    if ($null -ne $brainUsageProperty -and $brainUsageProperty.Value.created_by -eq 'agent') {
        throw 'village-history-evidence was adopted unexpectedly.'
    }

    # Initialize Hermes' native .hub ownership metadata before the rollback
    # baseline. Native rollback deliberately preserves .hub rather than
    # replacing upstream ownership state from a curator snapshot.
    $initialCatalog = Invoke-Hermes skills list
    Write-Utf8NoBom -Path (Join-Path $evidenceRoot 'skills-list-before-backup.txt') -Content $initialCatalog

    Invoke-Hermes curator run --dry-run --consolidate | Out-Null
    Invoke-Hermes curator backup --reason native-lifecycle-isolated-test | Out-Null
    $backupRoot = Join-Path $resolvedProfileHome 'skills\.curator_backups'
    $backup = Get-ChildItem -LiteralPath $backupRoot -Directory |
        Where-Object { $_.Name -notlike 'pre-rollback-*' } |
        Sort-Object LastWriteTimeUtc -Descending |
        Select-Object -First 1
    if ($null -eq $backup) {
        throw 'Hermes curator backup did not create a restorable snapshot.'
    }
    $backupId = $backup.Name

    $preCuratorManifestPath = Join-Path $evidenceRoot 'pre-curator-manifest.json'
    $preCuratorManifest = Write-Manifest -ProfileRoot $resolvedProfileHome -Destination $preCuratorManifestPath
    $fixtureSkillPath = Join-Path $resolvedProfileHome 'skills\testing\native-lifecycle-marker\SKILL.md'
    $preRestartHash = (Get-FileHash -LiteralPath $fixtureSkillPath -Algorithm SHA256).Hash

    $restartLearningCode = @'
import json
from tools.skill_manager_tool import skill_manage
from tools.skill_provenance import BACKGROUND_REVIEW, reset_current_write_origin, set_current_write_origin
from tools.skills_tool import _skill_view_with_bump as skill_view

token = set_current_write_origin(BACKGROUND_REVIEW)
try:
    viewed = json.loads(skill_view({"name": "native-lifecycle-marker"}))
    if not viewed.get("success"):
        raise SystemExit(json.dumps(viewed, ensure_ascii=False))
    changed = json.loads(skill_manage(
        action="patch",
        name="native-lifecycle-marker",
        old_string="Created through Hermes native skill_manage in an isolated profile.",
        new_string="Created through Hermes native skill_manage in an isolated profile.\n\nRestart learning marker: retained by a new Hermes process.",
    ))
finally:
    reset_current_write_origin(token)
if not changed.get("success"):
    raise SystemExit(json.dumps(changed, ensure_ascii=False))
print(json.dumps({"success": True, "viewed": True, "patched": True}))
'@
    Invoke-NativePython -Code $restartLearningCode | Out-Null
    $postRestartHash = (Get-FileHash -LiteralPath $fixtureSkillPath -Algorithm SHA256).Hash
    if ($preRestartHash -eq $postRestartHash) {
        throw 'The native restart learning marker did not change through skill_manage.'
    }
    $postRestartSource = Get-Content -LiteralPath $fixtureSkillPath -Raw
    $restartMarkerPresent = $postRestartSource -match 'Restart learning marker: retained by a new Hermes process\.'
    if (-not $restartMarkerPresent) {
        throw 'The fresh-process learning patch was not present after native skill_manage.'
    }
    $restartLearningProofPath = Join-Path $evidenceRoot 'restart-learning-proof.json'
    $restartLearningProof = [ordered]@{
        preRestartSha256 = $preRestartHash
        postRestartSha256 = $postRestartHash
        changedByFreshProcess = $preRestartHash -ne $postRestartHash
        restartMarkerPresent = $restartMarkerPresent
        rollbackSha256 = $null
        explicitRollbackRestoredBaseline = $null
    }
    Write-Utf8NoBom -Path $restartLearningProofPath -Content ($restartLearningProof | ConvertTo-Json)

    $catalogAfterRestart = Invoke-Hermes skills list
    Write-Utf8NoBom -Path (Join-Path $evidenceRoot 'skills-list-after-restart.txt') -Content $catalogAfterRestart
    $expectedSkills = @('village-operations', 'village-history-evidence', 'native-lifecycle-marker')
    Assert-NativeSkillRediscovery `
        -SkillNames $expectedSkills `
        -Phase 'fresh process restart' `
        -EvidencePath (Join-Path $evidenceRoot 'native-skill-view-after-restart.json') | Out-Null

    $startupScriptRoot = if ($ProfileShape -eq 'kakaoworker') {
        Join-Path $resolvedWorkerRepo 'scripts\windows'
    }
    else {
        $PSScriptRoot
    }
    $startupScriptNames = @('start-kakao-staging.ps1', 'restart-kakao-staging.ps1', 'watch-kakao-production.ps1')
    if ($ProfileShape -eq 'kakaoworker') {
        $startupScriptNames += 'start-kakao-live.ps1'
    }
    foreach ($startupScriptName in $startupScriptNames) {
        $startupScriptPath = Join-Path $startupScriptRoot $startupScriptName
        if (-not (Test-Path -LiteralPath $startupScriptPath -PathType Leaf)) {
            throw "Required startup script is missing: $startupScriptPath"
        }
        $startupSource = Get-Content -LiteralPath $startupScriptPath -Raw
        if ($startupSource -match 'sync-hermes-profile-overlay\.ps1') {
            throw "Normal startup still imports a skill snapshot: $startupScriptName"
        }
    }

    Invoke-Hermes curator run --consolidate | Out-Null
    Invoke-Hermes curator rollback --id $backupId --yes | Out-Null

    $afterManifestPath = Join-Path $evidenceRoot 'after-manifest.json'
    $afterManifest = Write-Manifest -ProfileRoot $resolvedProfileHome -Destination $afterManifestPath
    Assert-ManifestsEqual -Expected $preCuratorManifest -Actual $afterManifest
    $postRollbackHash = (Get-FileHash -LiteralPath $fixtureSkillPath -Algorithm SHA256).Hash
    $restartLearningProof.rollbackSha256 = $postRollbackHash
    $restartLearningProof.explicitRollbackRestoredBaseline = $postRollbackHash -eq $preRestartHash
    Write-Utf8NoBom -Path $restartLearningProofPath -Content ($restartLearningProof | ConvertTo-Json)

    $catalogAfterRollback = Invoke-Hermes skills list
    Write-Utf8NoBom -Path (Join-Path $evidenceRoot 'skills-list-after-rollback.txt') -Content $catalogAfterRollback
    Assert-NativeSkillRediscovery `
        -SkillNames $expectedSkills `
        -Phase 'native rollback' `
        -EvidencePath (Join-Path $evidenceRoot 'native-skill-view-after-rollback.json') | Out-Null

    $requests = @()
    if (Test-Path -LiteralPath $requestLog -PathType Leaf) {
        $requests = @(Get-Content -LiteralPath $requestLog | Where-Object { $_.Trim() })
    }
    if ($requests.Count -lt 2) {
        throw 'The isolated curator dry-run and real run did not both reach the local fixture model.'
    }

    $protectedAfter = Get-ProtectedHashes -Paths $protectedLivePaths
    Assert-ProtectedHashesEqual -Before $protectedBefore -After $protectedAfter

    $finalUsage = Get-Content -LiteralPath $usagePath -Raw | ConvertFrom-Json
    $finalBrainUsageProperty = $finalUsage.PSObject.Properties['village-history-evidence']
    $report = [ordered]@{
        ok = $true
        profileHome = $resolvedProfileHome
        profileShape = $ProfileShape
        backupId = $backupId
        localCuratorRequests = $requests.Count
        liveProtectedFilesUnchanged = $true
        startupScriptsChecked = $startupScriptNames
        restartLearningChanged = $restartLearningProof.changedByFreshProcess
        restartMarkerPresentBeforeExplicitRollback = $restartLearningProof.restartMarkerPresent
        explicitRollbackRestoredBaseline = $restartLearningProof.explicitRollbackRestoredBaseline
        operationsCreatedBy = $finalUsage.'village-operations'.created_by
        brainCreatedBy = if ($null -eq $finalBrainUsageProperty) { $null } else { $finalBrainUsageProperty.Value.created_by }
        markerCreatedBy = $finalUsage.'native-lifecycle-marker'.created_by
        evidenceRoot = $evidenceRoot
    }
    Write-Utf8NoBom -Path (Join-Path $evidenceRoot 'lifecycle-report.json') -Content ($report | ConvertTo-Json -Depth 4)
    Write-Output ("LIFECYCLE_OK " + ($report | ConvertTo-Json -Compress))
    $completed = $true
}
finally {
    if ($null -ne $fixtureProcess -and -not $fixtureProcess.HasExited) {
        Stop-Process -Id $fixtureProcess.Id -Force -ErrorAction SilentlyContinue
        $fixtureProcess.WaitForExit(5000) | Out-Null
    }
    foreach ($name in $environmentNames) {
        [Environment]::SetEnvironmentVariable($name, $savedEnvironment[$name], 'Process')
    }
}

if ($Cleanup -and $completed) {
    $resolvedAgain = Assert-IsolatedProfileHome -Candidate $resolvedProfileHome -ProfilesRoot $profilesRoot -HermesRoot $hermesRoot
    if (-not [string]::Equals($resolvedAgain, $resolvedProfileHome, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw 'Cleanup target changed after validation.'
    }
    $cleanupMarker = Join-Path $resolvedProfileHome '.lifecycle-test-profile'
    if (-not (Test-Path -LiteralPath $cleanupMarker -PathType Leaf)) {
        throw 'Refusing cleanup because the lifecycle marker is missing.'
    }
    Remove-Item -LiteralPath $resolvedProfileHome -Recurse -Force
    Write-Output "CLEANUP_OK $resolvedProfileHome"
}
