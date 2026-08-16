[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'Medium')]
param(
    [string]$RunId,
    [ValidateRange(1, 8)][int]$CaseLimit = 8,
    [switch]$KeepProfiles,
    [ValidateSet('generic', 'kakaoworker')][string]$BenchmarkMode = 'generic',
    [string]$WorkerRepo
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Get-NormalizedFullPath {
    param([Parameter(Mandatory = $true)][string]$Path)
    $providerPath = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Path)
    return [System.IO.Path]::GetFullPath($providerPath).TrimEnd('\')
}

function Assert-IsolatedBenchmarkProfile {
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
        throw 'Refusing the live Hermes root for a benchmark arm.'
    }
    if ([string]::Equals($resolvedCandidate, $workerHome, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw 'Refusing the live kakaoworker profile for a benchmark arm.'
    }
    if (-not [string]::Equals((Split-Path -Parent $resolvedCandidate), $resolvedProfilesRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Benchmark profiles must be direct isolated children of $resolvedProfilesRoot."
    }
    if ((Split-Path -Leaf $resolvedCandidate) -notmatch '^native-lifecycle-bench-[a-z0-9-]+-(?:legacy|candidate)$') {
        throw 'Benchmark profile names must use the native-lifecycle-bench-*-legacy/candidate envelope.'
    }
    return $resolvedCandidate
}

function Assert-IsolatedBenchmarkRoot {
    param(
        [Parameter(Mandatory = $true)][string]$Candidate,
        [Parameter(Mandatory = $true)][string]$BenchmarksRoot
    )

    $resolvedCandidate = Get-NormalizedFullPath -Path $Candidate
    $resolvedRoot = Get-NormalizedFullPath -Path $BenchmarksRoot
    if (-not [string]::Equals((Split-Path -Parent $resolvedCandidate), $resolvedRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Benchmark results must be a direct child of $resolvedRoot."
    }
    if ((Split-Path -Leaf $resolvedCandidate) -notmatch '^native-lifecycle-[a-z0-9-]+$') {
        throw 'Benchmark result directories must begin with native-lifecycle-.'
    }
    return $resolvedCandidate
}

function Write-Utf8NoBom {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][AllowEmptyString()][string]$Content
    )
    $encoding = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($Path, $Content, $encoding)
}

function Invoke-HermesManagement {
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
    if ($exitCode -ne 0) {
        throw "Hermes management command failed (${exitCode}): $($Arguments -join ' ')"
    }
    return ($output -join "`n")
}

function Get-SkillContentManifest {
    param([Parameter(Mandatory = $true)][string]$ProfileRoot)

    $records = New-Object System.Collections.Generic.List[object]
    foreach ($package in @(
        (Join-Path $ProfileRoot 'skills\productivity\village-operations'),
        (Join-Path $ProfileRoot 'skills\village\village-brain-first')
    )) {
        foreach ($file in Get-ChildItem -LiteralPath $package -Recurse -File | Sort-Object FullName) {
            $records.Add([ordered]@{
                path = $file.FullName.Substring($ProfileRoot.Length).TrimStart('\').Replace('\', '/')
                bytes = [int64]$file.Length
                sha256 = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash
            })
        }
    }
    return @($records | Sort-Object path)
}

function Test-ManifestsEqual {
    param(
        [Parameter(Mandatory = $true)]$Before,
        [Parameter(Mandatory = $true)]$After
    )
    $left = @($Before | ForEach-Object { "$($_.path)|$($_.bytes)|$($_.sha256)" } | Sort-Object)
    $right = @($After | ForEach-Object { "$($_.path)|$($_.bytes)|$($_.sha256)" } | Sort-Object)
    return @(Compare-Object -ReferenceObject $left -DifferenceObject $right).Count -eq 0
}

function Get-ProtectedHashes {
    param([Parameter(Mandatory = $true)][string[]]$Paths)
    $hashes = [ordered]@{}
    foreach ($path in $Paths) {
        $normalized = Get-NormalizedFullPath -Path $path
        $hashes[$normalized] = if (Test-Path -LiteralPath $normalized -PathType Leaf) {
            (Get-FileHash -LiteralPath $normalized -Algorithm SHA256).Hash
        }
        else {
            $null
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
            throw "A protected live Hermes file changed during the isolated benchmark: $path"
        }
    }
}

function Get-Percentile {
    param(
        [Parameter(Mandatory = $true)][double[]]$Values,
        [Parameter(Mandatory = $true)][double]$Percentile
    )
    if ($Values.Count -eq 0) { return $null }
    $sorted = @($Values | Sort-Object)
    $index = [Math]::Ceiling(($Percentile / 100.0) * $sorted.Count) - 1
    $index = [Math]::Max(0, [Math]::Min($sorted.Count - 1, $index))
    return [Math]::Round([double]$sorted[$index], 3)
}

if (-not $env:LOCALAPPDATA) {
    throw 'LOCALAPPDATA is required for the native Windows Hermes benchmark.'
}
if ([string]::IsNullOrWhiteSpace($RunId)) {
    $RunId = Get-Date -Format 'yyyyMMdd-HHmmss'
}
$RunId = $RunId.Trim().ToLowerInvariant()
if ($RunId -notmatch '^[a-z0-9][a-z0-9-]{0,29}$') {
    throw 'RunId must be 1-30 lowercase alphanumeric or hyphen characters.'
}

$repoRoot = Get-NormalizedFullPath -Path (Join-Path $PSScriptRoot '..\..')
$hermesRoot = Get-NormalizedFullPath -Path (Join-Path $env:LOCALAPPDATA 'hermes')
$profilesRoot = Get-NormalizedFullPath -Path (Join-Path $hermesRoot 'profiles')
$benchmarksRoot = Get-NormalizedFullPath -Path (Join-Path $hermesRoot 'benchmarks')
$legacyProfile = Assert-IsolatedBenchmarkProfile -Candidate (Join-Path $profilesRoot "native-lifecycle-bench-$RunId-legacy") -ProfilesRoot $profilesRoot -HermesRoot $hermesRoot
$candidateProfile = Assert-IsolatedBenchmarkProfile -Candidate (Join-Path $profilesRoot "native-lifecycle-bench-$RunId-candidate") -ProfilesRoot $profilesRoot -HermesRoot $hermesRoot
$resultsRoot = Assert-IsolatedBenchmarkRoot -Candidate (Join-Path $benchmarksRoot "native-lifecycle-$RunId") -BenchmarksRoot $benchmarksRoot
$resolvedWorkerRepo = $null
$modelContractPath = Join-Path $PSScriptRoot 'hermes-model-contract.json'
if ($BenchmarkMode -eq 'kakaoworker') {
    if ([string]::IsNullOrWhiteSpace($WorkerRepo)) {
        throw 'WorkerRepo is required for a kakaoworker benchmark.'
    }
    $resolvedWorkerRepo = Get-NormalizedFullPath -Path $WorkerRepo
    $modelContractPath = Join-Path $resolvedWorkerRepo 'scripts\windows\hermes-model-contract.json'
}

foreach ($target in @($legacyProfile, $candidateProfile, $resultsRoot)) {
    if (Test-Path -LiteralPath $target) {
        throw "Refusing to overwrite an existing benchmark target: $target"
    }
}

if (-not $PSCmdlet.ShouldProcess($resultsRoot, 'run isolated legacy/candidate Hermes A/B benchmark')) {
    Write-Output "WHATIF preview legacy=$legacyProfile"
    Write-Output "WHATIF preview candidate=$candidateProfile"
    Write-Output "WHATIF preview results=$resultsRoot"
    Write-Output "WHATIF benchmarkMode=$BenchmarkMode"
    Write-Output "WHATIF modelContract=$modelContractPath"
    return
}

$script:HermesPython = Join-Path $hermesRoot 'hermes-agent\venv\Scripts\python.exe'
$fixturesPath = if ($BenchmarkMode -eq 'kakaoworker') {
    Join-Path $repoRoot 'test\fixtures\hermes-kakaoworker-native-benchmark.json'
}
else {
    Join-Path $repoRoot 'test\fixtures\hermes-village-native-benchmark.json'
}
$analyzerPath = Join-Path $PSScriptRoot 'hermes-village-benchmark-analyze.py'
$invokerPath = Join-Path $PSScriptRoot 'hermes-village-benchmark-invoke.py'
$promptBuilderPath = $null
$workerModulePath = $null
$nodeCommand = $null
if ($BenchmarkMode -eq 'kakaoworker') {
    $workerModulePath = Join-Path $resolvedWorkerRepo 'tools\ai-browser-worker\worker.mjs'
    $promptBuilderPath = Join-Path $PSScriptRoot 'hermes-kakaoworker-benchmark-prompt.mjs'
    $node = Get-Command node.exe -ErrorAction Stop
    $nodeCommand = $node.Source
}
$requiredPaths = @($script:HermesPython, $modelContractPath, $fixturesPath, $analyzerPath, $invokerPath)
if ($BenchmarkMode -eq 'kakaoworker') {
    $requiredPaths += @($workerModulePath, $promptBuilderPath, $nodeCommand)
}
foreach ($required in $requiredPaths) {
    if (-not (Test-Path -LiteralPath $required -PathType Leaf)) {
        throw "Benchmark dependency is missing: $required"
    }
}

$contract = Get-Content -LiteralPath $modelContractPath -Raw -Encoding UTF8 | ConvertFrom-Json
$workerContract = $contract.kakaoworker
$provider = [string]$workerContract.provider
$model = [string]$workerContract.model
$reasoning = [string]$workerContract.reasoning_effort
$maxTurns = [int]$workerContract.max_turns
foreach ($value in @($provider, $model, $reasoning)) {
    if ([string]::IsNullOrWhiteSpace($value)) {
        throw 'The kakaoworker model contract is incomplete.'
    }
}

$fixtures = Get-Content -LiteralPath $fixturesPath -Raw -Encoding UTF8 | ConvertFrom-Json
$cases = @($fixtures.cases | Select-Object -First $CaseLimit)
if ($cases.Count -ne $CaseLimit) {
    throw "Fixture set has fewer than $CaseLimit cases."
}

$protectedLivePaths = @(
    (Join-Path $hermesRoot 'config.yaml'),
    (Join-Path $hermesRoot 'skills\productivity\village-operations\SKILL.md'),
    (Join-Path $hermesRoot 'skills\village\village-brain-first\SKILL.md'),
    (Join-Path $profilesRoot 'kakaoworker\config.yaml'),
    (Join-Path $profilesRoot 'kakaoworker\skills\productivity\village-operations\SKILL.md'),
    (Join-Path $profilesRoot 'kakaoworker\skills\village\village-brain-first\SKILL.md')
)
$mutableLiveUsagePaths = @(
    (Join-Path $hermesRoot 'skills\.usage.json'),
    (Join-Path $profilesRoot 'kakaoworker\skills\.usage.json')
)
$protectedBefore = Get-ProtectedHashes -Paths $protectedLivePaths
$mutableUsageBefore = Get-ProtectedHashes -Paths $mutableLiveUsagePaths

$environmentNames = @(
    'HERMES_HOME',
    'VILLAGE_WINDOWS_WRITES_ENABLED',
    'AI_WORKER_LIVE',
    'AI_WORKER_AUTO_SEND',
    'AI_WORKER_DRY_RUN'
)
$savedEnvironment = [ordered]@{}
foreach ($name in $environmentNames) {
    $savedEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
}

$completed = $false
try {
    [Environment]::SetEnvironmentVariable('VILLAGE_WINDOWS_WRITES_ENABLED', '0', 'Process')
    [Environment]::SetEnvironmentVariable('AI_WORKER_LIVE', '0', 'Process')
    [Environment]::SetEnvironmentVariable('AI_WORKER_AUTO_SEND', '0', 'Process')
    [Environment]::SetEnvironmentVariable('AI_WORKER_DRY_RUN', '1', 'Process')

    [Environment]::SetEnvironmentVariable('HERMES_HOME', $hermesRoot, 'Process')
    Invoke-HermesManagement profile create (Split-Path -Leaf $legacyProfile) --no-alias --no-skills | Out-Null
    Invoke-HermesManagement profile create (Split-Path -Leaf $candidateProfile) --no-alias --no-skills | Out-Null

    New-Item -ItemType Directory -Path $resultsRoot -Force | Out-Null
    Write-Utf8NoBom -Path (Join-Path $resultsRoot '.village-benchmark-results') -Content $RunId

    $arms = [ordered]@{
        legacy = $legacyProfile
        candidate = $candidateProfile
    }
    foreach ($armName in $arms.Keys) {
        $profileRoot = $arms[$armName]
        Write-Utf8NoBom -Path (Join-Path $profileRoot '.village-benchmark-profile') -Content (([ordered]@{
            runId = $RunId
            arm = $armName
            createdAt = [DateTimeOffset]::UtcNow.ToString('o')
        }) | ConvertTo-Json)
        $workspaceRoot = Join-Path $profileRoot 'workspace'
        New-Item -ItemType Directory -Path $workspaceRoot -Force | Out-Null
        $workspaceYaml = $workspaceRoot.Replace('\', '/')
        $config = @"
model:
  default: $model
  provider: $provider
agent:
  reasoning_effort: $reasoning
  max_turns: $maxTurns
curator:
  enabled: false
terminal:
  cwd: "$workspaceYaml"
  home_mode: profile
"@
        Write-Utf8NoBom -Path (Join-Path $profileRoot 'config.yaml') -Content $config
    }

    $liveSkillRoot = if ($BenchmarkMode -eq 'kakaoworker') {
        Join-Path $profilesRoot 'kakaoworker\skills'
    }
    else {
        Join-Path $hermesRoot 'skills'
    }
    $liveOperations = Join-Path $liveSkillRoot 'productivity\village-operations'
    $liveBrain = Join-Path $liveSkillRoot 'village\village-brain-first'
    $candidateSkills = Join-Path $repoRoot 'scripts\windows\hermes-profile-overlay\skills'
    $candidateOperations = Join-Path $candidateSkills 'productivity\village-operations'
    $candidateBrain = Join-Path $candidateSkills 'village\village-brain-first'
    foreach ($requiredPackage in @($liveOperations, $liveBrain, $candidateOperations, $candidateBrain)) {
        if (-not (Test-Path -LiteralPath $requiredPackage -PathType Container)) {
            throw "Benchmark skill package is missing: $requiredPackage"
        }
    }

    foreach ($profileRoot in @($legacyProfile, $candidateProfile)) {
        New-Item -ItemType Directory -Path (Join-Path $profileRoot 'skills\productivity'), (Join-Path $profileRoot 'skills\village') -Force | Out-Null
    }
    if ($BenchmarkMode -eq 'kakaoworker') {
        Get-ChildItem -LiteralPath $liveSkillRoot -Force |
            Copy-Item -Destination (Join-Path $legacyProfile 'skills') -Recurse -Force
        Get-ChildItem -LiteralPath (Join-Path $legacyProfile 'skills') -Force |
            Copy-Item -Destination (Join-Path $candidateProfile 'skills') -Recurse -Force

        foreach ($relativeTarget in @('skills\productivity\village-operations', 'skills\village\village-brain-first')) {
            $target = Get-NormalizedFullPath -Path (Join-Path $candidateProfile $relativeTarget)
            $candidatePrefix = $candidateProfile + '\'
            if (-not $target.StartsWith($candidatePrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
                throw "Refusing candidate package replacement outside the isolated profile: $target"
            }
            if (Test-Path -LiteralPath $target) {
                Remove-Item -LiteralPath $target -Recurse -Force
            }
        }
        Copy-Item -LiteralPath $candidateOperations -Destination (Join-Path $candidateProfile 'skills\productivity') -Recurse
        Copy-Item -LiteralPath $candidateBrain -Destination (Join-Path $candidateProfile 'skills\village') -Recurse
    }
    else {
        Copy-Item -LiteralPath $liveOperations -Destination (Join-Path $legacyProfile 'skills\productivity') -Recurse
        Copy-Item -LiteralPath $liveBrain -Destination (Join-Path $legacyProfile 'skills\village') -Recurse
        Copy-Item -LiteralPath $candidateOperations -Destination (Join-Path $candidateProfile 'skills\productivity') -Recurse
        Copy-Item -LiteralPath $candidateBrain -Destination (Join-Path $candidateProfile 'skills\village') -Recurse
    }

    $armBaselines = [ordered]@{
        legacy = @(Get-SkillContentManifest -ProfileRoot $legacyProfile)
        candidate = @(Get-SkillContentManifest -ProfileRoot $candidateProfile)
    }
    $results = New-Object System.Collections.Generic.List[object]

    for ($caseIndex = 0; $caseIndex -lt $cases.Count; $caseIndex += 1) {
            $fixture = $cases[$caseIndex]
        $armOrder = if (($caseIndex % 2) -eq 0) { @('legacy', 'candidate') } else { @('candidate', 'legacy') }
        foreach ($armName in $armOrder) {
            $profileRoot = $arms[$armName]
            $caseId = [string]$fixture.id
            $runRoot = Join-Path $resultsRoot "runs\$armName\$caseId"
            New-Item -ItemType Directory -Path $runRoot -Force | Out-Null
            $usageFile = Join-Path $runRoot 'usage.json'
            $promptFile = Join-Path $runRoot 'prompt.txt'
            $responseFile = Join-Path $runRoot 'response.txt'
            $stderrFile = Join-Path $runRoot 'stderr.txt'
            $metricsFile = Join-Path $runRoot 'metrics.json'

            if ($BenchmarkMode -eq 'kakaoworker') {
                & $nodeCommand $promptBuilderPath `
                    --worker-module $workerModulePath `
                    --fixtures $fixturesPath `
                    --case-id $caseId `
                    --output $promptFile
                if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $promptFile -PathType Leaf)) {
                    throw "Kakaoworker benchmark prompt generation failed for $caseId."
                }
            }
            else {
                $requiredOperationLabel = [string]$fixture.expected.operation
                $requiredResultKeys = @($fixture.expected.result.PSObject.Properties.Name) -join ', '
                $requiredStatusLabel = [string]$fixture.expected.result.status
                $prompt = @"
This is a fixed, anonymous, reasoning-only Village benchmark. No live business fact is needed beyond the mock facts below.

Safety contract:
- Do not write, register, update, schedule, send, or contact anyone.
- Use only native skill catalog/read behavior. Never call skill_manage.
- Use native skill discovery normally and open only the minimum necessary skill set whose catalog descriptions match this case.
- Treat all supplied facts as authoritative mock readback.

Case ID: $caseId
$($fixture.prompt)

Response contract:
- Required operation label: $requiredOperationLabel
- Required result keys: $requiredResultKeys
- Required status label: $requiredStatusLabel

Return exactly one JSON object and no prose or Markdown. Use this shape:
{"case_id":"$caseId","operation":"normalized_operation","brain_needed":false,"write_or_send":false,"result":{},"reason":"short evidence-based reason"}
"@
                Write-Utf8NoBom -Path $promptFile -Content $prompt
            }

            [Environment]::SetEnvironmentVariable('HERMES_HOME', $profileRoot, 'Process')
            $stopwatch = [System.Diagnostics.Stopwatch]::StartNew()
            try {
                & $script:HermesPython $invokerPath `
                    --hermes-python $script:HermesPython `
                    --prompt-file $promptFile `
                    --usage-file $usageFile `
                    --stdout-file $responseFile `
                    --stderr-file $stderrFile `
                    --model $model `
                    --provider $provider `
                    --reasoning $reasoning
                $exitCode = $LASTEXITCODE
            }
            finally {
                $stopwatch.Stop()
            }
            $responseText = if (Test-Path -LiteralPath $responseFile -PathType Leaf) {
                Get-Content -LiteralPath $responseFile -Raw -Encoding UTF8
            }
            else {
                ''
            }
            if (-not (Test-Path -LiteralPath $usageFile -PathType Leaf)) {
                throw "Hermes did not write usage evidence for $armName/$caseId (exit=$exitCode)."
            }
            $usage = Get-Content -LiteralPath $usageFile -Raw -Encoding UTF8 | ConvertFrom-Json
            if ([string]::IsNullOrWhiteSpace([string]$usage.session_id)) {
                throw "Hermes usage evidence has no session_id for $armName/$caseId."
            }
            $dbPath = Join-Path $profileRoot 'state.db'
            $analysisText = @(& $script:HermesPython $analyzerPath --db $dbPath --session-id ([string]$usage.session_id) --fixtures $fixturesPath --case-id $caseId --response $responseFile 2>&1) -join "`n"
            if ($LASTEXITCODE -ne 0) {
                throw "Benchmark analyzer failed for $armName/${caseId}: $analysisText"
            }
            $analysis = $analysisText | ConvertFrom-Json
            $afterManifest = @(Get-SkillContentManifest -ProfileRoot $profileRoot)
            $manifestUnchanged = Test-ManifestsEqual -Before $armBaselines[$armName] -After $afterManifest
            $requiredSkillSource = if (
                $armName -eq 'candidate' -and
                $null -ne $fixture.PSObject.Properties['candidateRequiredSkills']
            ) {
                $fixture.candidateRequiredSkills
            }
            else {
                $fixture.requiredSkills
            }
            $requiredSkills = @($requiredSkillSource | ForEach-Object { [string]$_ })
            $selectedSkills = @($analysis.selectedSkills | ForEach-Object { [string]$_ })
            $missingRequiredSkills = @($requiredSkills | Where-Object { $_ -notin $selectedSkills })
            $brainSelectionCorrect = ([bool]$analysis.brainSelected) -eq ([bool]$fixture.brainExpected)
            $attempts = @($analysis.attemptedMutationsOrSends)
            $assertions = @($analysis.correctnessAssertions)
            $assertions += [pscustomobject]@{
                path = '$.selectedSkills'
                expected = $requiredSkills
                actual = $selectedSkills
                passed = $missingRequiredSkills.Count -eq 0
            }
            $assertions += [pscustomobject]@{
                path = '$.brainSelected'
                expected = [bool]$fixture.brainExpected
                actual = [bool]$analysis.brainSelected
                passed = $brainSelectionCorrect
            }
            $assertions += [pscustomobject]@{
                path = '$.contentManifestUnchanged'
                expected = $true
                actual = $manifestUnchanged
                passed = $manifestUnchanged
            }

            $modelLatencyMs = [double]$analysis.modelLatencyMs
            $toolLatencyMs = [double]$analysis.toolLatencyMs
            $wallLatencyMs = [Math]::Round($stopwatch.Elapsed.TotalMilliseconds, 3)
            $startupAndPersistenceMs = [Math]::Round([Math]::Max(0, $wallLatencyMs - $modelLatencyMs - $toolLatencyMs), 3)
            $runPassed = (
                $exitCode -eq 0 -and
                -not [bool]$usage.failed -and
                [bool]$analysis.correctness -and
                $missingRequiredSkills.Count -eq 0 -and
                $brainSelectionCorrect -and
                $attempts.Count -eq 0 -and
                $manifestUnchanged
            )
            $record = [ordered]@{
                arm = $armName
                caseId = $caseId
                provider = $provider
                model = $model
                reasoning = $reasoning
                exitCode = $exitCode
                passed = $runPassed
                selectedSkills = $selectedSkills
                selectedReferences = @($analysis.selectedReferences)
                brainExpected = [bool]$fixture.brainExpected
                brainSelected = [bool]$analysis.brainSelected
                inputTokens = [int64]$usage.input_tokens
                outputTokens = [int64]$usage.output_tokens
                reasoningTokens = [int64]$usage.reasoning_tokens
                totalTokens = [int64]$usage.total_tokens
                modelCallCount = [int]$usage.api_calls
                toolCallCount = [int]$analysis.toolCallCount
                toolCallNames = @($analysis.toolCallNames)
                supportReadBytes = [int64]$analysis.supportReadBytes
                modelLatencyMs = $modelLatencyMs
                toolLatencyMs = $toolLatencyMs
                wallLatencyMs = $wallLatencyMs
                startupAndPersistenceMs = $startupAndPersistenceMs
                correctness = [bool]$analysis.correctness
                correctnessAssertions = $assertions
                attemptedMutationsOrSends = $attempts
                contentManifestUnchanged = $manifestUnchanged
                responseParsed = [bool]$analysis.responseParsed
                usageFile = $usageFile
                responseFile = $responseFile
                stderrFile = $stderrFile
            }
            Write-Utf8NoBom -Path $metricsFile -Content ($record | ConvertTo-Json -Depth 10)
            $results.Add([pscustomobject]$record)
            Write-Output ("BENCHMARK_RUN " + ([ordered]@{
                arm = $armName
                caseId = $caseId
                passed = $runPassed
                wallLatencyMs = $wallLatencyMs
                inputTokens = [int64]$usage.input_tokens
                selectedSkills = $selectedSkills
            } | ConvertTo-Json -Compress))
        }
    }

    $resultsArray = [object[]]$results
    $summaries = [ordered]@{}
    foreach ($armName in @('legacy', 'candidate')) {
        $armResults = @($resultsArray | Where-Object { $_.arm -eq $armName })
        $latencies = [double[]]@($armResults | ForEach-Object { [double]$_.wallLatencyMs })
        $inputTokens = @($armResults | ForEach-Object { [double]$_.inputTokens })
        $readBytes = @($armResults | ForEach-Object { [double]$_.supportReadBytes })
        $irrelevantBrainLoads = @($armResults | Where-Object { -not $_.brainExpected -and $_.brainSelected }).Count
        $summaries[$armName] = [ordered]@{
            runs = $armResults.Count
            passed = @($armResults | Where-Object { $_.passed }).Count
            medianWallLatencyMs = Get-Percentile -Values $latencies -Percentile 50
            p95WallLatencyMs = Get-Percentile -Values $latencies -Percentile 95
            averageInputTokens = if ($inputTokens.Count) { [Math]::Round(($inputTokens | Measure-Object -Average).Average, 3) } else { $null }
            averageSupportReadBytes = if ($readBytes.Count) { [Math]::Round(($readBytes | Measure-Object -Average).Average, 3) } else { $null }
            irrelevantBrainLoads = $irrelevantBrainLoads
            attemptedMutationsOrSends = @(
                foreach ($armResult in $armResults) {
                    foreach ($attempt in @($armResult.attemptedMutationsOrSends)) {
                        $attempt
                    }
                }
            ).Count
        }
    }

    $candidateResults = @($resultsArray | Where-Object { $_.arm -eq 'candidate' })
    $allNoMutation = @($resultsArray | Where-Object { @($_.attemptedMutationsOrSends).Count -ne 0 }).Count -eq 0
    $candidateAllPassed = @($candidateResults | Where-Object { -not $_.passed }).Count -eq 0
    $latencyImproved = (
        [double]$summaries.candidate.medianWallLatencyMs -lt [double]$summaries.legacy.medianWallLatencyMs -and
        [double]$summaries.candidate.p95WallLatencyMs -lt [double]$summaries.legacy.p95WallLatencyMs
    )
    $mutableUsageAfter = Get-ProtectedHashes -Paths $mutableLiveUsagePaths
    $mutableLiveUsageTelemetry = @(
        foreach ($path in $mutableUsageBefore.Keys) {
            [ordered]@{
                path = $path
                beforeSha256 = $mutableUsageBefore[$path]
                afterSha256 = $mutableUsageAfter[$path]
                changedConcurrently = $mutableUsageBefore[$path] -ne $mutableUsageAfter[$path]
            }
        }
    )
    $benchmark = [ordered]@{
        schemaVersion = 1
        runId = $RunId
        generatedAt = [DateTimeOffset]::UtcNow.ToString('o')
        safety = [ordered]@{
            noLiveBusinessWrites = $true
            noCustomerSends = $true
            toolsets = @('skills')
            liveProtectedFilesUnchanged = $true
            mutableLiveUsageTelemetry = $mutableLiveUsageTelemetry
        }
        contract = [ordered]@{
            provider = $provider
            model = $model
            reasoning = $reasoning
            maxTurns = $maxTurns
            benchmarkMode = $BenchmarkMode
        }
        profiles = [ordered]@{
            legacy = $legacyProfile
            candidate = $candidateProfile
        }
        results = $resultsArray
        summaries = $summaries
        gates = [ordered]@{
            candidateJudgmentAndCorrectnessPreserved = $candidateAllPassed
            noMutationOrSendAttempts = $allNoMutation
            medianAndP95LatencyImproved = $latencyImproved
            readyForOwnerCutoverReview = $candidateAllPassed -and $allNoMutation -and $latencyImproved
        }
    }

    $protectedAfter = Get-ProtectedHashes -Paths $protectedLivePaths
    Assert-ProtectedHashesEqual -Before $protectedBefore -After $protectedAfter
    Write-Utf8NoBom -Path (Join-Path $resultsRoot 'results.json') -Content ($benchmark | ConvertTo-Json -Depth 12)
    Write-Output ("BENCHMARK_OK " + ([ordered]@{
        results = (Join-Path $resultsRoot 'results.json')
        legacy = $summaries.legacy
        candidate = $summaries.candidate
        gates = $benchmark.gates
    } | ConvertTo-Json -Depth 6 -Compress))
    $completed = $true
}
finally {
    foreach ($name in $environmentNames) {
        [Environment]::SetEnvironmentVariable($name, $savedEnvironment[$name], 'Process')
    }
}

if ($completed -and -not $KeepProfiles) {
    foreach ($profileRoot in @($legacyProfile, $candidateProfile)) {
        $validated = Assert-IsolatedBenchmarkProfile -Candidate $profileRoot -ProfilesRoot $profilesRoot -HermesRoot $hermesRoot
        $marker = Join-Path $validated '.village-benchmark-profile'
        if (-not (Test-Path -LiteralPath $marker -PathType Leaf)) {
            throw "Refusing benchmark cleanup because its marker is missing: $validated"
        }
        Remove-Item -LiteralPath $validated -Recurse -Force
    }
    Write-Output 'BENCHMARK_PROFILES_CLEANED'
}
