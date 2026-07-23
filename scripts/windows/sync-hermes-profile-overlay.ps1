[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'Low')]
param(
    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string]$ProfileHome,

    [ValidateNotNullOrEmpty()]
    [string]$MacHermesHome = 'C:\Village\MacMiniMirror\restored\.hermes',

    [switch]$ProfileScoped
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$excludedDirectoryNames = @(
    '.git', '.github', '.hub', '.archive', '.venv', 'venv', 'node_modules',
    'site-packages', '__pycache__', '.tox', '.nox', '.pytest_cache',
    '.mypy_cache', '.ruff_cache'
)
$supportDirectoryNames = @('references', 'templates', 'assets', 'scripts')
$rootExcludedSkills = @(
    'apple-automation',
    'minecraft-modpack-server',
    'obliteratus',
    'village-operations',
    'village-brain-first',
    'village-runtime-router',
    'village-confirm-request'
)
$retiredSkillNames = @(
    'apple-automation',
    'minecraft-modpack-server',
    'obliteratus',
    'google-workspace',
    'village-operations-windows',
    'rpa-automation-operations-windows'
)
$overlaySkillsRoot = Join-Path $PSScriptRoot 'hermes-profile-overlay\skills'
$encoding = New-Object System.Text.UTF8Encoding($false)

function Convert-ToExtendedPath {
    param([Parameter(Mandatory = $true)][string]$Path)

    $fullPath = [IO.Path]::GetFullPath($Path)
    if ($fullPath.StartsWith('\\?\', [StringComparison]::Ordinal)) {
        return $fullPath
    }
    if ($fullPath.StartsWith('\\', [StringComparison]::Ordinal)) {
        return '\\?\UNC\' + $fullPath.Substring(2)
    }
    return '\\?\' + $fullPath
}

function Get-FileSha256 {
    param([Parameter(Mandatory = $true)][string]$Path)

    $sha = [Security.Cryptography.SHA256]::Create()
    $stream = $null
    try {
        $stream = [IO.File]::OpenRead((Convert-ToExtendedPath -Path $Path))
        $hash = $sha.ComputeHash($stream)
        return ([BitConverter]::ToString($hash)).Replace('-', '')
    }
    finally {
        if ($null -ne $stream) {
            $stream.Dispose()
        }
        $sha.Dispose()
    }
}

function Remove-DirectoryTree {
    param([Parameter(Mandatory = $true)][string]$Path)

    $extended = Convert-ToExtendedPath -Path $Path
    if ([IO.Directory]::Exists($extended)) {
        [IO.Directory]::Delete($extended, $true)
    }
}

function Get-FrontmatterValue {
    param(
        [Parameter(Mandatory = $true)][string]$Content,
        [Parameter(Mandatory = $true)][string]$Key
    )
    $match = [regex]::Match($Content, ('(?m)^{0}:\s*["'']?([^\r\n"'']+)' -f [regex]::Escape($Key)))
    if (-not $match.Success) {
        return $null
    }
    return $match.Groups[1].Value.Trim()
}

function Test-ExcludedPath {
    param(
        [Parameter(Mandatory = $true)][IO.FileInfo]$File,
        [Parameter(Mandatory = $true)][string]$SkillsRoot
    )
    $relative = $File.FullName.Substring($SkillsRoot.Length).TrimStart('\')
    $parts = @($relative -split '[\\/]')
    foreach ($part in $parts) {
        if ($excludedDirectoryNames -contains $part) {
            return $true
        }
    }

    $current = $File.Directory
    while ($null -ne $current -and $current.FullName.StartsWith($SkillsRoot, [StringComparison]::OrdinalIgnoreCase)) {
        if (($supportDirectoryNames -contains $current.Name) -and
            (Test-Path -LiteralPath (Join-Path $current.Parent.FullName 'SKILL.md') -PathType Leaf)) {
            return $true
        }
        $current = $current.Parent
    }
    return $false
}

function Get-ActiveSkillPackages {
    param([Parameter(Mandatory = $true)][string]$SkillsRoot)

    $seen = @{}
    $packages = New-Object System.Collections.ArrayList
    $files = @(Get-ChildItem -LiteralPath $SkillsRoot -Filter 'SKILL.md' -File -Recurse -ErrorAction Stop |
        Sort-Object FullName)
    foreach ($file in $files) {
        if (Test-ExcludedPath -File $file -SkillsRoot $SkillsRoot) {
            continue
        }
        $content = [IO.File]::ReadAllText($file.FullName, [Text.Encoding]::UTF8)
        $name = Get-FrontmatterValue -Content $content -Key 'name'
        if ([string]::IsNullOrWhiteSpace($name)) {
            $name = $file.Directory.Name
        }
        if ($seen.ContainsKey($name)) {
            continue
        }
        $seen[$name] = $true
        [void]$packages.Add([pscustomobject]@{
            name      = $name
            directory = $file.Directory.FullName
            relative  = $file.Directory.FullName.Substring($SkillsRoot.Length).TrimStart('\')
        })
    }
    return @($packages)
}

function Copy-SkillPackage {
    param(
        [Parameter(Mandatory = $true)][string]$Source,
        [Parameter(Mandatory = $true)][string]$Destination
    )

    [void](New-Item -ItemType Directory -Path $Destination -Force -ErrorAction Stop)
    $sourceRoot = (Resolve-Path -LiteralPath $Source -ErrorAction Stop).Path
    $files = @(Get-ChildItem -LiteralPath $sourceRoot -File -Recurse -ErrorAction Stop)
    foreach ($file in $files) {
        $relative = $file.FullName.Substring($sourceRoot.Length).TrimStart('\')
        $parts = @($relative -split '[\\/]')
        if (@($parts | Where-Object { $excludedDirectoryNames -contains $_ }).Count -gt 0) {
            continue
        }
        $target = Join-Path $Destination $relative
        [void][IO.Directory]::CreateDirectory((Convert-ToExtendedPath -Path (Split-Path -Parent $target)))
        [IO.File]::Copy(
            (Convert-ToExtendedPath -Path $file.FullName),
            (Convert-ToExtendedPath -Path $target),
            $true
        )
    }
}

function Add-WindowsAdapter {
    param(
        [Parameter(Mandatory = $true)][string]$SkillFile,
        [Parameter(Mandatory = $true)][string]$AdapterFile,
        [string]$Description = ''
    )

    $content = [IO.File]::ReadAllText($SkillFile, [Text.Encoding]::UTF8)
    if (-not [string]::IsNullOrWhiteSpace($Description)) {
        $escapedDescription = $Description.Replace('"', '\"')
        $content = [regex]::Replace(
            $content,
            '(?m)^description:\s*[^\r\n]*$',
            ('description: "{0}"' -f $escapedDescription),
            1
        )
        if ($content -notmatch '(?m)^description:\s*"') {
            throw "Cannot replace frontmatter description in '$SkillFile'."
        }
    }
    $content = [regex]::Replace(
        $content,
        '(?m)^platforms:\s*\[[^\]]*\]\s*$',
        'platforms: [windows]',
        1
    )
    if ($content -notmatch '(?m)^platforms:\s*\[windows\]\s*$') {
        $content = [regex]::Replace(
            $content,
            '(?m)^(license:[^\r\n]*\r?\n)',
            "`$1platforms: [windows]`r`n",
            1
        )
    }
    if ($content -notmatch '<!-- WINDOWS_EXECUTION_ADAPTER -->') {
        $frontmatterEnd = [regex]::Match($content, '(?s)^---\s*\r?\n.*?\r?\n---\s*\r?\n')
        if (-not $frontmatterEnd.Success) {
            throw "Cannot locate YAML frontmatter in '$SkillFile'."
        }
        $adapter = [IO.File]::ReadAllText($AdapterFile, [Text.Encoding]::UTF8).Trim()
        $content = $content.Insert($frontmatterEnd.Length, "`r`n$adapter`r`n`r`n")
    }
    [IO.File]::WriteAllText($SkillFile, $content, $encoding)
}

function Assert-PackageCopy {
    param(
        [Parameter(Mandatory = $true)][string]$Source,
        [Parameter(Mandatory = $true)][string]$Destination,
        [switch]$IgnoreRootSkill
    )

    $sourceRoot = (Resolve-Path -LiteralPath $Source -ErrorAction Stop).Path
    $destinationRoot = (Resolve-Path -LiteralPath $Destination -ErrorAction Stop).Path
    $sourceFiles = @{}
    foreach ($file in @(Get-ChildItem -LiteralPath $sourceRoot -File -Recurse -ErrorAction Stop)) {
        $relative = $file.FullName.Substring($sourceRoot.Length).TrimStart('\')
        $parts = @($relative -split '[\\/]')
        if (@($parts | Where-Object { $excludedDirectoryNames -contains $_ }).Count -gt 0) {
            continue
        }
        if ($IgnoreRootSkill -and $relative -eq 'SKILL.md') {
            continue
        }
        $sourceFiles[$relative] = Get-FileSha256 -Path $file.FullName
    }
    foreach ($entry in $sourceFiles.GetEnumerator()) {
        $target = Join-Path $destinationRoot $entry.Key
        if (-not [IO.File]::Exists((Convert-ToExtendedPath -Path $target))) {
            throw "Missing copied skill file '$target'."
        }
        $targetHash = Get-FileSha256 -Path $target
        if (-not [string]::Equals($entry.Value, $targetHash, [StringComparison]::OrdinalIgnoreCase)) {
            throw "Hash mismatch for copied skill file '$target'."
        }
    }
}

function Get-FileHashMap {
    param([Parameter(Mandatory = $true)][string]$Root)

    $resolvedRoot = (Resolve-Path -LiteralPath $Root -ErrorAction Stop).Path
    $hashes = @{}
    foreach ($file in @(Get-ChildItem -LiteralPath $resolvedRoot -File -Recurse -ErrorAction Stop | Sort-Object FullName)) {
        $relative = $file.FullName.Substring($resolvedRoot.Length).TrimStart('\').Replace('\', '/')
        $hashes[$relative] = Get-FileSha256 -Path $file.FullName
    }
    return $hashes
}

function Read-PreviousCanonicalHashes {
    param([Parameter(Mandatory = $true)][string]$StatePath)

    $hashes = @{}
    if (-not (Test-Path -LiteralPath $StatePath -PathType Leaf)) {
        return $hashes
    }
    try {
        $state = [IO.File]::ReadAllText($StatePath, [Text.Encoding]::UTF8) | ConvertFrom-Json
        if ($null -eq $state.canonicalFiles) {
            return $hashes
        }
        foreach ($property in $state.canonicalFiles.PSObject.Properties) {
            $hashes[[string]$property.Name] = [string]$property.Value
        }
    }
    catch {
        Write-Warning "Ignoring unreadable skill parity state '$StatePath': $($_.Exception.Message)"
    }
    return $hashes
}

function Copy-PreservedLearningState {
    param(
        [Parameter(Mandatory = $true)][string]$ActiveRoot,
        [Parameter(Mandatory = $true)][string]$StagingRoot,
        [Parameter(Mandatory = $true)][hashtable]$CanonicalHashes,
        [Parameter(Mandatory = $true)][hashtable]$PreviousCanonicalHashes,
        [Parameter(Mandatory = $true)][string[]]$RetiredNames
    )

    $preservedFiles = New-Object System.Collections.ArrayList
    $preservedSkills = New-Object System.Collections.ArrayList
    if (-not (Test-Path -LiteralPath $ActiveRoot -PathType Container)) {
        return [pscustomobject]@{ files = @(); skills = @() }
    }

    $activeResolved = (Resolve-Path -LiteralPath $ActiveRoot -ErrorAction Stop).Path
    $stagingPackages = @(Get-ActiveSkillPackages -SkillsRoot $StagingRoot)
    $stagingByName = @{}
    foreach ($package in $stagingPackages) {
        $stagingByName[$package.name] = $package.relative.Replace('\', '/')
    }

    foreach ($package in @(Get-ActiveSkillPackages -SkillsRoot $activeResolved)) {
        if ($RetiredNames -contains $package.name) {
            continue
        }
        $packageRelative = $package.relative.Replace('\', '/')
        if ($stagingByName.ContainsKey($package.name) -and
            -not [string]::Equals($stagingByName[$package.name], $packageRelative, [StringComparison]::OrdinalIgnoreCase)) {
            continue
        }

        $preservedPackage = $false
        foreach ($file in @(Get-ChildItem -LiteralPath $package.directory -File -Recurse -ErrorAction Stop)) {
            $relative = $file.FullName.Substring($activeResolved.Length).TrimStart('\').Replace('\', '/')
            $activeHash = Get-FileSha256 -Path $file.FullName
            $canonicalExists = $CanonicalHashes.ContainsKey($relative)
            $previousExists = $PreviousCanonicalHashes.ContainsKey($relative)
            $locallyChanged = if ($previousExists) {
                -not [string]::Equals($activeHash, $PreviousCanonicalHashes[$relative], [StringComparison]::OrdinalIgnoreCase)
            }
            elseif ($canonicalExists) {
                -not [string]::Equals($activeHash, $CanonicalHashes[$relative], [StringComparison]::OrdinalIgnoreCase)
            }
            else {
                $true
            }
            if (-not $locallyChanged) {
                continue
            }

            $target = Join-Path $StagingRoot ($relative.Replace('/', '\'))
            [void][IO.Directory]::CreateDirectory((Convert-ToExtendedPath -Path (Split-Path -Parent $target)))
            [IO.File]::Copy(
                (Convert-ToExtendedPath -Path $file.FullName),
                (Convert-ToExtendedPath -Path $target),
                $true
            )
            [void]$preservedFiles.Add($relative)
            $preservedPackage = $true
        }
        if ($preservedPackage) {
            [void]$preservedSkills.Add($package.name)
        }
    }

    foreach ($stateFile in @('.usage.json', '.suppressed.json', '.suppressed_skills.json')) {
        $source = Join-Path $activeResolved $stateFile
        if (-not (Test-Path -LiteralPath $source -PathType Leaf)) {
            continue
        }
        $target = Join-Path $StagingRoot $stateFile
        [IO.File]::Copy(
            (Convert-ToExtendedPath -Path $source),
            (Convert-ToExtendedPath -Path $target),
            $true
        )
        [void]$preservedFiles.Add($stateFile)
    }
    foreach ($stateDirectory in @('.archive', '.curator_backups', '.hub')) {
        $source = Join-Path $activeResolved $stateDirectory
        if (-not (Test-Path -LiteralPath $source -PathType Container)) {
            continue
        }
        Copy-SkillPackage -Source $source -Destination (Join-Path $StagingRoot $stateDirectory)
        [void]$preservedFiles.Add("$stateDirectory/")
    }

    return [pscustomobject]@{
        files = @($preservedFiles | Select-Object -Unique)
        skills = @($preservedSkills | Select-Object -Unique)
    }
}

function Write-CanonicalHashState {
    param(
        [Parameter(Mandatory = $true)][string]$StatePath,
        [Parameter(Mandatory = $true)][hashtable]$CanonicalHashes
    )

    $orderedHashes = [ordered]@{}
    foreach ($key in @($CanonicalHashes.Keys | Sort-Object)) {
        $orderedHashes[$key] = $CanonicalHashes[$key]
    }
    $state = [ordered]@{
        version = 1
        syncedAtUtc = [DateTime]::UtcNow.ToString('o')
        canonicalFiles = $orderedHashes
    }
    [IO.File]::WriteAllText(
        $StatePath,
        ($state | ConvertTo-Json -Depth 5),
        $encoding
    )
}

function Assert-AiFirstProfileConfig {
    param([Parameter(Mandatory = $true)][string]$ProfileRoot)

    $configPath = Join-Path $ProfileRoot 'config.yaml'
    if (-not (Test-Path -LiteralPath $configPath -PathType Leaf)) {
        throw "Profile-scoped parity requires '$configPath'."
    }

    $config = [IO.File]::ReadAllText($configPath, [Text.Encoding]::UTF8)
    # AI-first invariant: model default gpt-5.6-sol, agent reasoning_effort high, agent max_turns 90.
    $requiredSettings = @(
        [pscustomobject]@{
            name = 'model.default'
            pattern = '(?m)^\s{2}default:\s*["'']?gpt-5\.6-sol["'']?\s*(?:#.*)?$'
        },
        [pscustomobject]@{
            name = 'agent.reasoning_effort'
            pattern = '(?m)^\s{2}reasoning_effort:\s*["'']?high["'']?\s*(?:#.*)?$'
        },
        [pscustomobject]@{
            name = 'agent.max_turns'
            pattern = '(?m)^\s{2}max_turns:\s*90\s*(?:#.*)?$'
        }
    )
    foreach ($setting in $requiredSettings) {
        if (-not [regex]::IsMatch($config, $setting.pattern)) {
            throw "AI-first worker profile invariant failed for '$($setting.name)'."
        }
    }
}

function Set-AiFirstProfileIdentity {
    param([Parameter(Mandatory = $true)][string]$ProfileRoot)

    $profilePath = Join-Path $ProfileRoot 'profile.yaml'
    if (-not (Test-Path -LiteralPath $profilePath -PathType Leaf)) {
        throw "Profile-scoped parity requires '$profilePath'."
    }

    $identity = [IO.File]::ReadAllText($profilePath, [Text.Encoding]::UTF8)
    $description = 'description: Village Kakao worker profile. Full Hermes AI reasoning for end-to-end customer operations; deterministic code only observes, validates, executes, and verifies.'
    if ([regex]::IsMatch($identity, '(?m)^description:')) {
        $identity = [regex]::Replace(
            $identity,
            '(?m)^description:[^\r\n]*(?:\r?\n[ \t]+[^\r\n]*)*',
            $description,
            1
        )
    }
    else {
        $identity = "$description`r`n$identity"
    }

    if ([regex]::IsMatch($identity, '(?m)^description_auto:')) {
        $identity = [regex]::Replace($identity, '(?m)^description_auto:[^\r\n]*$', 'description_auto: false', 1)
    }
    else {
        $identity = $identity.TrimEnd("`r", "`n") + "`r`ndescription_auto: false`r`n"
    }
    [IO.File]::WriteAllText($profilePath, $identity, $encoding)
}

$resolvedProfileHome = (Resolve-Path -LiteralPath $ProfileHome -ErrorAction Stop).Path
$resolvedMacHermesHome = (Resolve-Path -LiteralPath $MacHermesHome -ErrorAction Stop).Path
$macSkillsRoot = (Resolve-Path -LiteralPath (Join-Path $resolvedMacHermesHome 'skills') -ErrorAction Stop).Path
$adapterRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot 'hermes-profile-overlay\adapters') -ErrorAction Stop).Path
$packages = @(Get-ActiveSkillPackages -SkillsRoot $macSkillsRoot)

$operationId = [Guid]::NewGuid().ToString('N')
$skillsRoot = Join-Path $resolvedProfileHome 'skills'
$parityStatePath = Join-Path $resolvedProfileHome '.village-skill-parity-state.json'
$stagingRoot = Join-Path $resolvedProfileHome ('.skills.parity.{0}.tmp' -f $operationId)
$previousRoot = Join-Path $resolvedProfileHome ('.skills.parity.{0}.bak' -f $operationId)
$rpaSource = Join-Path $resolvedMacHermesHome 'profiles\kakaoworker\skills\devops\rpa-automation-operations'
$rpaDestination = Join-Path $resolvedProfileHome 'profiles\kakaoworker\skills\devops\rpa-automation-operations'
$rpaParent = Split-Path -Parent $rpaDestination
$rpaTemporary = Join-Path $rpaParent ('.rpa.{0}.tmp' -f $operationId)
$rpaPrevious = Join-Path $rpaParent ('.rpa.{0}.bak' -f $operationId)
$copiedNames = New-Object System.Collections.ArrayList
$canonicalHashes = @{}
$preservation = [pscustomobject]@{ files = @(); skills = @() }

try {
    [void](New-Item -ItemType Directory -Path $stagingRoot -Force -ErrorAction Stop)
    foreach ($package in $packages) {
        if ($rootExcludedSkills -contains $package.name) {
            continue
        }
        $destination = Join-Path $stagingRoot $package.relative
        Copy-SkillPackage -Source $package.directory -Destination $destination
        Assert-PackageCopy -Source $package.directory -Destination $destination
        [void]$copiedNames.Add($package.name)
    }

    foreach ($port in @(
        [pscustomobject]@{
            name = 'village-operations'
            source = Join-Path $macSkillsRoot 'productivity\village-operations'
            destination = Join-Path $stagingRoot 'productivity\village-operations'
            adapter = Join-Path $adapterRoot 'village-operations.md'
            description = 'Primary Village action route for requested business operations: reservations, schedules, equipment changes, documents, payments, settlement, tax, Slack/Kakao, Google Sheets, and project APIs; always verify live readback.'
        },
        [pscustomobject]@{
            name = 'village-brain-first'
            source = Join-Path $macSkillsRoot 'village\village-brain-first'
            destination = Join-Path $stagingRoot 'village\village-brain-first'
            adapter = Join-Path $adapterRoot 'village-brain-first.md'
            description = 'Primary Village business intelligence route for every business question: load compiled Brain first, then use live project APIs for reservations, revenue, inventory, receivables, payments, tax, equipment, customers, and operations.'
        }
    )) {
        Copy-SkillPackage -Source $port.source -Destination $port.destination
        Add-WindowsAdapter -SkillFile (Join-Path $port.destination 'SKILL.md') -AdapterFile $port.adapter -Description $port.description
        Assert-PackageCopy -Source $port.source -Destination $port.destination -IgnoreRootSkill
        [void]$copiedNames.Add($port.name)
    }

    $routerSource = Join-Path $overlaySkillsRoot 'village\village-runtime-router'
    $routerDestination = Join-Path $stagingRoot 'village\village-runtime-router'
    Copy-SkillPackage -Source $routerSource -Destination $routerDestination
    Assert-PackageCopy -Source $routerSource -Destination $routerDestination
    [void]$copiedNames.Add('village-runtime-router')

    $confirmRequestSource = Join-Path $overlaySkillsRoot 'productivity\village-confirm-request'
    $confirmRequestDestination = Join-Path $stagingRoot 'productivity\village-confirm-request'
    Copy-SkillPackage -Source $confirmRequestSource -Destination $confirmRequestDestination
    Assert-PackageCopy -Source $confirmRequestSource -Destination $confirmRequestDestination
    [void]$copiedNames.Add('village-confirm-request')

    if ($ProfileScoped.IsPresent) {
        if (-not (Test-Path -LiteralPath (Join-Path $rpaSource 'SKILL.md') -PathType Leaf)) {
            throw "Profile-scoped parity source is missing '$rpaSource'."
        }
        $profileRpaDestination = Join-Path $stagingRoot 'devops\rpa-automation-operations'
        Copy-SkillPackage -Source $rpaSource -Destination $profileRpaDestination
        Add-WindowsAdapter -SkillFile (Join-Path $profileRpaDestination 'SKILL.md') -AdapterFile (Join-Path $adapterRoot 'rpa-automation-operations.md')
        Assert-PackageCopy -Source $rpaSource -Destination $profileRpaDestination -IgnoreRootSkill
        [void]$copiedNames.Add('rpa-automation-operations')
        Assert-AiFirstProfileConfig -ProfileRoot $resolvedProfileHome
    }

    $canonicalHashes = Get-FileHashMap -Root $stagingRoot
    $previousCanonicalHashes = Read-PreviousCanonicalHashes -StatePath $parityStatePath
    $preservation = Copy-PreservedLearningState `
        -ActiveRoot $skillsRoot `
        -StagingRoot $stagingRoot `
        -CanonicalHashes $canonicalHashes `
        -PreviousCanonicalHashes $previousCanonicalHashes `
        -RetiredNames $retiredSkillNames

    $rootNames = @(Get-ActiveSkillPackages -SkillsRoot $stagingRoot | ForEach-Object { $_.name })
    if (@($rootNames | Select-Object -Unique).Count -ne $rootNames.Count) {
        throw 'Rebuilt Windows skill tree contains duplicate skill names.'
    }
    foreach ($required in @('village-brain-first', 'village-operations', 'village-runtime-router', 'village-confirm-request', 'productivity-integrations')) {
        if ($rootNames -notcontains $required) {
            throw "Rebuilt Windows skill tree is missing '$required'."
        }
    }
    if ($ProfileScoped.IsPresent -and $rootNames -notcontains 'rpa-automation-operations') {
        throw "Rebuilt worker profile is missing 'rpa-automation-operations'."
    }
    foreach ($forbidden in @('village-operations-windows', 'rpa-automation-operations-windows', 'google-workspace')) {
        if ($rootNames -contains $forbidden) {
            throw "Rebuilt Windows skill tree still exposes retired '$forbidden'."
        }
    }

    if ($PSCmdlet.ShouldProcess($skillsRoot, 'Atomically replace the active Hermes skill tree with Mac parity build')) {
        if (Test-Path -LiteralPath $skillsRoot) {
            [IO.Directory]::Move($skillsRoot, $previousRoot)
        }
        try {
            [IO.Directory]::Move($stagingRoot, $skillsRoot)
        }
        catch {
            if ((Test-Path -LiteralPath $previousRoot) -and -not (Test-Path -LiteralPath $skillsRoot)) {
                [IO.Directory]::Move($previousRoot, $skillsRoot)
            }
            throw
        }
        if (Test-Path -LiteralPath $previousRoot) {
            Remove-DirectoryTree -Path $previousRoot
        }
        [IO.File]::WriteAllText(
            (Join-Path $resolvedProfileHome '.no-bundled-skills'),
            "mac-parity-curated`n",
            $encoding
        )
        if ($ProfileScoped.IsPresent) {
            Set-AiFirstProfileIdentity -ProfileRoot $resolvedProfileHome
        }
        Write-CanonicalHashState -StatePath $parityStatePath -CanonicalHashes $canonicalHashes
    }

    if (-not $ProfileScoped.IsPresent -and (Test-Path -LiteralPath (Join-Path $rpaSource 'SKILL.md') -PathType Leaf)) {
        [void](New-Item -ItemType Directory -Path $rpaParent -Force -ErrorAction Stop)
        Copy-SkillPackage -Source $rpaSource -Destination $rpaTemporary
        Add-WindowsAdapter -SkillFile (Join-Path $rpaTemporary 'SKILL.md') -AdapterFile (Join-Path $adapterRoot 'rpa-automation-operations.md')
        Assert-PackageCopy -Source $rpaSource -Destination $rpaTemporary -IgnoreRootSkill
        if ($PSCmdlet.ShouldProcess($rpaDestination, 'Deploy canonical RPA skill to the kakaoworker profile only')) {
            if (Test-Path -LiteralPath $rpaDestination) {
                [IO.Directory]::Move($rpaDestination, $rpaPrevious)
            }
            try {
                [IO.Directory]::Move($rpaTemporary, $rpaDestination)
                [IO.File]::WriteAllText(
                    (Join-Path (Join-Path $resolvedProfileHome 'profiles\kakaoworker') '.no-bundled-skills'),
                    "mac-parity-curated`n",
                    $encoding
                )
            }
            catch {
                if (Test-Path -LiteralPath $rpaDestination) {
                    Remove-DirectoryTree -Path $rpaDestination
                }
                if ((Test-Path -LiteralPath $rpaPrevious) -and -not (Test-Path -LiteralPath $rpaDestination)) {
                    [IO.Directory]::Move($rpaPrevious, $rpaDestination)
                }
                throw
            }
            if (Test-Path -LiteralPath $rpaPrevious) {
                Remove-DirectoryTree -Path $rpaPrevious
            }
        }
        elseif (Test-Path -LiteralPath $rpaTemporary) {
            Remove-DirectoryTree -Path $rpaTemporary
        }
    }

    [pscustomobject]@{
        ok            = $true
        scope         = if ($ProfileScoped.IsPresent) { 'worker-profile' } else { 'hermes-home' }
        macActive     = $packages.Count
        rootActive    = $rootNames.Count
        copied        = @($copiedNames).Count
        preservedSkills = @($preservation.skills)
        preservedFiles = @($preservation.files).Count
        canonical     = @('village-brain-first', 'village-operations', 'village-runtime-router', 'village-confirm-request')
        profileScoped = @('rpa-automation-operations')
        excluded      = $rootExcludedSkills
    } | ConvertTo-Json -Depth 4 -Compress
}
finally {
    if (Test-Path -LiteralPath $stagingRoot) {
        Remove-DirectoryTree -Path $stagingRoot
    }
    if (Test-Path -LiteralPath $previousRoot) {
        if (-not (Test-Path -LiteralPath $skillsRoot)) {
            [IO.Directory]::Move($previousRoot, $skillsRoot)
        }
        elseif (Test-Path -LiteralPath $previousRoot) {
            Remove-DirectoryTree -Path $previousRoot
        }
    }
    if (Test-Path -LiteralPath $rpaTemporary) {
        Remove-DirectoryTree -Path $rpaTemporary
    }
    if (Test-Path -LiteralPath $rpaPrevious) {
        if (-not (Test-Path -LiteralPath $rpaDestination)) {
            [IO.Directory]::Move($rpaPrevious, $rpaDestination)
        }
        elseif (Test-Path -LiteralPath $rpaPrevious) {
            Remove-DirectoryTree -Path $rpaPrevious
        }
    }
}
