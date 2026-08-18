<#
.SYNOPSIS
Explicit Hermes skill migration and recovery import.

.DESCRIPTION
This command is not part of normal gateway, Kakao worker, bridge, restart, or
watchdog startup. It stages and atomically replaces a selected profile's skill
tree, so an operator must first create a verified backup and review the emitted
preservation/conflict report. Run it only for a manual migration or explicit
recovery; the live profile owns its native learning between imports.
#>
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
    'village-capability-development',
    'village-brain-first',
    'village-history-evidence',
    'village-runtime-router',
    'village-confirm-request'
)
$retiredSkillNames = @(
    'apple-automation',
    'minecraft-modpack-server',
    'obliteratus',
    'google-workspace',
    'village-operations-windows',
    'rpa-automation-operations-windows',
    'village-brain-first',
    'village-runtime-router'
)
$skillNameAliases = @{
    'village-brain-first' = 'village-history-evidence'
}
$ownerManagedSkillNames = @(
    'village-operations',
    'village-capability-development'
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
        [Parameter(Mandatory = $true)][string[]]$RetiredNames,
        [string[]]$OwnerManagedNames = @()
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
        if ($OwnerManagedNames -contains $package.name) {
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

    foreach ($stateFile in @(
        '.usage.json',
        '.suppressed.json',
        '.suppressed_skills.json',
        '.curator_state',
        '.curator_suppressed'
    )) {
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

function Read-JsonMetadata {
    param([string]$Path)

    if ([string]::IsNullOrWhiteSpace($Path) -or
        -not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        return $null
    }
    try {
        return [IO.File]::ReadAllText($Path, [Text.Encoding]::UTF8) |
            ConvertFrom-Json -ErrorAction Stop
    }
    catch {
        throw "Cannot read Hermes metadata '$Path': $($_.Exception.Message)"
    }
}

function Get-MetadataPropertyValue {
    param(
        $Object,
        [Parameter(Mandatory = $true)][string]$Name
    )

    if ($null -eq $Object) {
        return $null
    }
    $property = $Object.PSObject.Properties[$Name]
    if ($null -eq $property) {
        return $null
    }
    return $property.Value
}

function Convert-MetadataObjectToMap {
    param($Object)

    $result = @{}
    if ($null -eq $Object) {
        return $result
    }
    foreach ($property in @($Object.PSObject.Properties)) {
        $result[[string]$property.Name] = $property.Value
    }
    return $result
}

function Select-MetadataTimestamp {
    param(
        $SourceValue,
        $ActiveValue,
        [switch]$Earliest
    )

    $sourceText = [string]$SourceValue
    $activeText = [string]$ActiveValue
    if ([string]::IsNullOrWhiteSpace($sourceText)) {
        return $(if ([string]::IsNullOrWhiteSpace($activeText)) { $null } else { $activeText })
    }
    if ([string]::IsNullOrWhiteSpace($activeText)) {
        return $sourceText
    }

    $sourceDate = [DateTimeOffset]::MinValue
    $activeDate = [DateTimeOffset]::MinValue
    $sourceValid = [DateTimeOffset]::TryParse($sourceText, [ref]$sourceDate)
    $activeValid = [DateTimeOffset]::TryParse($activeText, [ref]$activeDate)
    if (-not $sourceValid -or -not $activeValid) {
        return $activeText
    }
    if ($Earliest.IsPresent) {
        return $(if ($sourceDate -le $activeDate) { $sourceText } else { $activeText })
    }
    return $(if ($sourceDate -ge $activeDate) { $sourceText } else { $activeText })
}

function Merge-UsageRecord {
    param(
        [Parameter(Mandatory = $true)]$SourceRecord,
        [Parameter(Mandatory = $true)]$ActiveRecord
    )

    $merged = [ordered]@{}
    foreach ($property in @($SourceRecord.PSObject.Properties)) {
        $merged[[string]$property.Name] = $property.Value
    }
    foreach ($property in @($ActiveRecord.PSObject.Properties)) {
        $merged[[string]$property.Name] = $property.Value
    }

    foreach ($counter in @('use_count', 'view_count', 'patch_count')) {
        $sourceCount = 0L
        $activeCount = 0L
        [void][Int64]::TryParse([string](Get-MetadataPropertyValue -Object $SourceRecord -Name $counter), [ref]$sourceCount)
        [void][Int64]::TryParse([string](Get-MetadataPropertyValue -Object $ActiveRecord -Name $counter), [ref]$activeCount)
        $merged[$counter] = [Math]::Max($sourceCount, $activeCount)
    }

    $merged['created_at'] = Select-MetadataTimestamp `
        -SourceValue (Get-MetadataPropertyValue -Object $SourceRecord -Name 'created_at') `
        -ActiveValue (Get-MetadataPropertyValue -Object $ActiveRecord -Name 'created_at') `
        -Earliest
    foreach ($timestamp in @('last_used_at', 'last_viewed_at', 'last_patched_at')) {
        $merged[$timestamp] = Select-MetadataTimestamp `
            -SourceValue (Get-MetadataPropertyValue -Object $SourceRecord -Name $timestamp) `
            -ActiveValue (Get-MetadataPropertyValue -Object $ActiveRecord -Name $timestamp)
    }

    $sourceCreator = [string](Get-MetadataPropertyValue -Object $SourceRecord -Name 'created_by')
    $activeCreator = [string](Get-MetadataPropertyValue -Object $ActiveRecord -Name 'created_by')
    $merged['created_by'] = if (-not [string]::IsNullOrWhiteSpace($activeCreator)) {
        $activeCreator
    }
    elseif (-not [string]::IsNullOrWhiteSpace($sourceCreator)) {
        $sourceCreator
    }
    else {
        $null
    }
    $merged['pinned'] = [bool](
        [bool](Get-MetadataPropertyValue -Object $SourceRecord -Name 'pinned') -or
        [bool](Get-MetadataPropertyValue -Object $ActiveRecord -Name 'pinned')
    )
    if ($null -ne $SourceRecord.PSObject.Properties['agent_created'] -or
        $null -ne $ActiveRecord.PSObject.Properties['agent_created']) {
        $merged['agent_created'] = [bool](
            [bool](Get-MetadataPropertyValue -Object $SourceRecord -Name 'agent_created') -or
            [bool](Get-MetadataPropertyValue -Object $ActiveRecord -Name 'agent_created')
        )
    }
    return $merged
}

function Merge-UsageMetadata {
    param(
        [string]$SourcePath,
        [string]$ActivePath,
        [Parameter(Mandatory = $true)][string]$TargetPath,
        [hashtable]$NameAliases = @{},
        [string[]]$OwnerManagedNames = @()
    )

    $sourceObject = Read-JsonMetadata -Path $SourcePath
    $activeObject = Read-JsonMetadata -Path $ActivePath
    if ($null -eq $sourceObject -and $null -eq $activeObject -and $OwnerManagedNames.Count -eq 0) {
        return 0
    }

    $sourceRecords = Convert-MetadataObjectToMap -Object $sourceObject
    $activeRecords = Convert-MetadataObjectToMap -Object $activeObject
    $names = @($sourceRecords.Keys + $activeRecords.Keys | Sort-Object -Unique)
    $mergedRecords = [ordered]@{}
    foreach ($name in $names) {
        if ($sourceRecords.ContainsKey($name) -and $activeRecords.ContainsKey($name)) {
            $mergedRecords[$name] = Merge-UsageRecord `
                -SourceRecord $sourceRecords[$name] `
                -ActiveRecord $activeRecords[$name]
        }
        elseif ($activeRecords.ContainsKey($name)) {
            $mergedRecords[$name] = $activeRecords[$name]
        }
        else {
            $mergedRecords[$name] = $sourceRecords[$name]
        }
    }
    foreach ($oldName in @($NameAliases.Keys)) {
        if (-not $mergedRecords.Contains($oldName)) {
            continue
        }
        $newName = [string]$NameAliases[$oldName]
        $oldRecord = $mergedRecords[$oldName]
        if ($mergedRecords.Contains($newName)) {
            $mergedRecords[$newName] = Merge-UsageRecord `
                -SourceRecord $oldRecord `
                -ActiveRecord $mergedRecords[$newName]
        }
        else {
            $mergedRecords[$newName] = $oldRecord
        }
        $mergedRecords.Remove($oldName)
    }
    foreach ($ownerName in $OwnerManagedNames) {
        $ownerRecord = [ordered]@{}
        if ($mergedRecords.Contains($ownerName)) {
            $record = $mergedRecords[$ownerName]
            if ($record -is [Collections.IDictionary]) {
                foreach ($key in @($record.Keys)) {
                    $ownerRecord[[string]$key] = $record[$key]
                }
            }
            else {
                foreach ($property in @($record.PSObject.Properties)) {
                    $ownerRecord[[string]$property.Name] = $property.Value
                }
            }
        }
        $ownerRecord['created_by'] = $null
        $ownerRecord['agent_created'] = $false
        $ownerRecord['pinned'] = $true
        $mergedRecords[$ownerName] = $ownerRecord
    }
    [IO.File]::WriteAllText(
        $TargetPath,
        ($mergedRecords | ConvertTo-Json -Depth 20),
        $encoding
    )
    return $mergedRecords.Count
}

function Read-BundledManifestMap {
    param([string]$Path)

    $entries = @{}
    if ([string]::IsNullOrWhiteSpace($Path) -or
        -not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        return $entries
    }
    foreach ($line in @([IO.File]::ReadAllLines($Path, [Text.Encoding]::UTF8))) {
        $trimmed = $line.Trim()
        if ([string]::IsNullOrWhiteSpace($trimmed)) {
            continue
        }
        $name = ($trimmed -split ':', 2)[0].Trim()
        if (-not [string]::IsNullOrWhiteSpace($name)) {
            $entries[$name] = $trimmed
        }
    }
    return $entries
}

function Merge-BundledManifest {
    param(
        [string]$SourcePath,
        [string]$ActivePath,
        [Parameter(Mandatory = $true)][string]$TargetPath,
        [Parameter(Mandatory = $true)][string[]]$ActiveNames
    )

    $sourceExists = -not [string]::IsNullOrWhiteSpace($SourcePath) -and
        (Test-Path -LiteralPath $SourcePath -PathType Leaf)
    $activeExists = -not [string]::IsNullOrWhiteSpace($ActivePath) -and
        (Test-Path -LiteralPath $ActivePath -PathType Leaf)
    if (-not $sourceExists -and -not $activeExists) {
        return 0
    }

    $entries = Read-BundledManifestMap -Path $SourcePath
    $activeEntries = Read-BundledManifestMap -Path $ActivePath
    foreach ($name in $activeEntries.Keys) {
        $entries[$name] = $activeEntries[$name]
    }
    $activeSet = @{}
    foreach ($name in $ActiveNames) {
        $activeSet[$name] = $true
    }
    $lines = @($entries.Keys |
        Where-Object { $activeSet.ContainsKey($_) } |
        Sort-Object |
        ForEach-Object { $entries[$_] })
    $content = if ($lines.Count -gt 0) { ($lines -join "`n") + "`n" } else { '' }
    [IO.File]::WriteAllText($TargetPath, $content, $encoding)
    return $lines.Count
}

function Merge-HubLockMetadata {
    param(
        [string]$SourcePath,
        [string]$ActivePath,
        [Parameter(Mandatory = $true)][string]$TargetPath,
        [Parameter(Mandatory = $true)][string]$StagingRoot,
        [Parameter(Mandatory = $true)][string[]]$ActiveNames
    )

    $sourceLock = Read-JsonMetadata -Path $SourcePath
    $activeLock = Read-JsonMetadata -Path $ActivePath
    if ($null -eq $sourceLock -and $null -eq $activeLock) {
        return 0
    }

    $sourceInstalled = Convert-MetadataObjectToMap -Object (
        Get-MetadataPropertyValue -Object $sourceLock -Name 'installed'
    )
    $activeInstalled = Convert-MetadataObjectToMap -Object (
        Get-MetadataPropertyValue -Object $activeLock -Name 'installed'
    )
    foreach ($name in $activeInstalled.Keys) {
        $sourceInstalled[$name] = $activeInstalled[$name]
    }

    $activeSet = @{}
    foreach ($name in $ActiveNames) {
        $activeSet[$name] = $true
    }
    $filtered = [ordered]@{}
    $stagingResolved = [IO.Path]::GetFullPath($StagingRoot).TrimEnd('\') + '\'
    foreach ($name in @($sourceInstalled.Keys | Sort-Object)) {
        if (-not $activeSet.ContainsKey($name)) {
            continue
        }
        $entry = $sourceInstalled[$name]
        $installPath = [string](Get-MetadataPropertyValue -Object $entry -Name 'install_path')
        if ([string]::IsNullOrWhiteSpace($installPath) -or [IO.Path]::IsPathRooted($installPath)) {
            continue
        }
        $installedDirectory = [IO.Path]::GetFullPath((Join-Path $StagingRoot $installPath))
        if (-not $installedDirectory.StartsWith($stagingResolved, [StringComparison]::OrdinalIgnoreCase) -or
            -not (Test-Path -LiteralPath (Join-Path $installedDirectory 'SKILL.md') -PathType Leaf)) {
            continue
        }
        $filtered[$name] = $entry
    }

    $version = Get-MetadataPropertyValue -Object $activeLock -Name 'version'
    if ($null -eq $version) {
        $version = Get-MetadataPropertyValue -Object $sourceLock -Name 'version'
    }
    if ($null -eq $version) {
        $version = 1
    }
    $targetDirectory = Split-Path -Parent $TargetPath
    [void](New-Item -ItemType Directory -Path $targetDirectory -Force -ErrorAction Stop)
    $lock = [ordered]@{
        version = $version
        installed = $filtered
    }
    [IO.File]::WriteAllText(
        $TargetPath,
        ($lock | ConvertTo-Json -Depth 20),
        $encoding
    )
    return $filtered.Count
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

function Get-HermesWorkerModelContract {
    # 모델/프로바이더 단일 소스: scripts/windows/hermes-model-contract.json (kakaoworker 항목).
    # 파일이 없으면 검증된 기본값(gpt-5.6-sol, reasoning_effort high, max_turns 90)을 쓴다.
    # 모델 교체는 계약 파일 수정으로만 하고, 이 스크립트는 계약과 프로필의 일치만 검증한다.
    $contract = [pscustomobject]@{
        provider = 'openai-codex'
        model = 'gpt-5.6-sol'
        reasoning_effort = 'high'
        max_turns = 90
        disabled_toolsets = @('computer_use')
    }
    $contractPath = Join-Path $PSScriptRoot 'hermes-model-contract.json'
    if (Test-Path -LiteralPath $contractPath -PathType Leaf) {
        $parsed = Get-Content -LiteralPath $contractPath -Raw | ConvertFrom-Json -ErrorAction Stop
        $worker = $parsed.kakaoworker
        if ($null -eq $worker -or [string]::IsNullOrWhiteSpace([string]$worker.model) -or [string]::IsNullOrWhiteSpace([string]$worker.provider)) {
            throw 'hermes-model-contract.json kakaoworker.model and kakaoworker.provider must be non-empty strings.'
        }
        $contract.provider = ([string]$worker.provider).Trim()
        $contract.model = ([string]$worker.model).Trim()
        if (-not [string]::IsNullOrWhiteSpace([string]$worker.reasoning_effort)) {
            $contract.reasoning_effort = ([string]$worker.reasoning_effort).Trim()
        }
        $contractTurns = 0
        if ([int]::TryParse([string]$worker.max_turns, [ref]$contractTurns) -and $contractTurns -ge 1) {
            $contract.max_turns = $contractTurns
        }
        $disabledToolsets = @($worker.disabled_toolsets | ForEach-Object { ([string]$_).Trim() } | Where-Object { $_ })
        if ($disabledToolsets.Count -eq 0) {
            throw 'hermes-model-contract.json kakaoworker.disabled_toolsets must contain computer_use.'
        }
        $contract.disabled_toolsets = $disabledToolsets
    }
    return $contract
}

function Assert-AiFirstProfileConfig {
    param([Parameter(Mandatory = $true)][string]$ProfileRoot)

    $configPath = Join-Path $ProfileRoot 'config.yaml'
    if (-not (Test-Path -LiteralPath $configPath -PathType Leaf)) {
        throw "Profile-scoped parity requires '$configPath'."
    }

    $config = [IO.File]::ReadAllText($configPath, [Text.Encoding]::UTF8)
    $contract = Get-HermesWorkerModelContract
    # AI-first invariant: 모델/추론강도는 계약 값과 일치, max_turns는 계약 최소값 이상.
    # 계약과 다르면 조용히 되돌리지 않고 명시적으로 실패시켜 혼합 상태를 막는다.
    $requiredSettings = @(
        [pscustomobject]@{
            name = 'model.default'
            pattern = '(?m)^\s{2}default:\s*["'']?' + [regex]::Escape([string]$contract.model) + '["'']?\s*(?:#.*)?$'
        },
        [pscustomobject]@{
            name = 'model.provider'
            pattern = '(?m)^\s{2}provider:\s*["'']?' + [regex]::Escape([string]$contract.provider) + '["'']?\s*(?:#.*)?$'
        },
        [pscustomobject]@{
            name = 'agent.reasoning_effort'
            pattern = '(?m)^\s{2}reasoning_effort:\s*["'']?' + [regex]::Escape([string]$contract.reasoning_effort) + '["'']?\s*(?:#.*)?$'
        }
    )
    foreach ($setting in $requiredSettings) {
        if (-not [regex]::IsMatch($config, $setting.pattern)) {
            throw "AI-first worker profile invariant failed for '$($setting.name)'. Expected the value from scripts/windows/hermes-model-contract.json; edit that contract (not this script) to change models, then update the profile config to match."
        }
    }
    $turnsMatch = [regex]::Match($config, '(?m)^\s{2}max_turns:\s*(\d+)\s*(?:#.*)?$')
    if (-not $turnsMatch.Success -or [int]$turnsMatch.Groups[1].Value -lt [int]$contract.max_turns) {
        throw "AI-first worker profile invariant failed for 'agent.max_turns'. It must be present and at least $($contract.max_turns); raising it is allowed, capping below the contract is not."
    }
    foreach ($toolset in @($contract.disabled_toolsets)) {
        $escapedToolset = [regex]::Escape([string]$toolset)
        $inlineDisabled = [regex]::IsMatch($config, '(?m)^\s{2}disabled_toolsets:\s*\[[^\r\n]*["'']?' + $escapedToolset + '["'']?[^\r\n]*\]\s*(?:#.*)?$')
        $blockDisabled = [regex]::IsMatch($config, '(?ms)^\s{2}disabled_toolsets:\s*(?:#.*)?\r?\n(?:(?:\s{2}-[^\r\n]*)\r?\n)*?\s{2}-\s*["'']?' + $escapedToolset + '["'']?\s*(?:#.*)?$')
        if (-not $inlineDisabled -and -not $blockDisabled) {
            throw "AI-first worker profile invariant failed for 'agent.disabled_toolsets'. It must include '$toolset'."
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
$macWorkerSkillsRoot = Join-Path $resolvedMacHermesHome 'profiles\kakaoworker\skills'
$sourceUsagePath = Join-Path $macSkillsRoot '.usage.json'
$sourceManifestPath = Join-Path $macSkillsRoot '.bundled_manifest'
$sourceHubDirectory = Join-Path $macSkillsRoot '.hub'
if ($ProfileScoped.IsPresent -and (Test-Path -LiteralPath $macWorkerSkillsRoot -PathType Container)) {
    $workerUsagePath = Join-Path $macWorkerSkillsRoot '.usage.json'
    if (Test-Path -LiteralPath $workerUsagePath -PathType Leaf) {
        $sourceUsagePath = $workerUsagePath
    }
    $workerManifestPath = Join-Path $macWorkerSkillsRoot '.bundled_manifest'
    if (Test-Path -LiteralPath $workerManifestPath -PathType Leaf) {
        $sourceManifestPath = $workerManifestPath
    }
    $workerHubDirectory = Join-Path $macWorkerSkillsRoot '.hub'
    if (Test-Path -LiteralPath $workerHubDirectory -PathType Container) {
        $sourceHubDirectory = $workerHubDirectory
    }
}
$sourceHubLockPath = Join-Path $sourceHubDirectory 'lock.json'

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
$metadata = [pscustomobject]@{ bundled = 0; hub = 0; usage = 0 }

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
            overlay = Join-Path $overlaySkillsRoot 'productivity\village-operations'
        },
        [pscustomobject]@{
            # Keep the historical folder path for lossless Mac import while the
            # SKILL.md frontmatter exposes the corrected native catalog name.
            name = 'village-history-evidence'
            source = Join-Path $macSkillsRoot 'village\village-brain-first'
            destination = Join-Path $stagingRoot 'village\village-brain-first'
            overlay = Join-Path $overlaySkillsRoot 'village\village-brain-first'
        }
    )) {
        Copy-SkillPackage -Source $port.source -Destination $port.destination
        Assert-PackageCopy -Source $port.source -Destination $port.destination -IgnoreRootSkill
        Copy-SkillPackage -Source $port.overlay -Destination $port.destination
        Assert-PackageCopy -Source $port.overlay -Destination $port.destination
        [void]$copiedNames.Add($port.name)
    }

    $confirmRequestSource = Join-Path $overlaySkillsRoot 'productivity\village-confirm-request'
    $confirmRequestDestination = Join-Path $stagingRoot 'productivity\village-confirm-request'
    Copy-SkillPackage -Source $confirmRequestSource -Destination $confirmRequestDestination
    Assert-PackageCopy -Source $confirmRequestSource -Destination $confirmRequestDestination
    [void]$copiedNames.Add('village-confirm-request')

    $capabilityDevelopmentSource = Join-Path $overlaySkillsRoot 'productivity\village-capability-development'
    $capabilityDevelopmentDestination = Join-Path $stagingRoot 'productivity\village-capability-development'
    Copy-SkillPackage -Source $capabilityDevelopmentSource -Destination $capabilityDevelopmentDestination
    Assert-PackageCopy -Source $capabilityDevelopmentSource -Destination $capabilityDevelopmentDestination
    [void]$copiedNames.Add('village-capability-development')

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
    if (Test-Path -LiteralPath $sourceHubDirectory -PathType Container) {
        Copy-SkillPackage -Source $sourceHubDirectory -Destination (Join-Path $stagingRoot '.hub')
    }
    $preservation = Copy-PreservedLearningState `
        -ActiveRoot $skillsRoot `
        -StagingRoot $stagingRoot `
        -CanonicalHashes $canonicalHashes `
        -PreviousCanonicalHashes $previousCanonicalHashes `
        -RetiredNames $retiredSkillNames `
        -OwnerManagedNames $ownerManagedSkillNames

    $rootNames = @(Get-ActiveSkillPackages -SkillsRoot $stagingRoot | ForEach-Object { $_.name })
    $metadata = [pscustomobject]@{
        bundled = Merge-BundledManifest `
            -SourcePath $sourceManifestPath `
            -ActivePath (Join-Path $skillsRoot '.bundled_manifest') `
            -TargetPath (Join-Path $stagingRoot '.bundled_manifest') `
            -ActiveNames $rootNames
        hub = Merge-HubLockMetadata `
            -SourcePath $sourceHubLockPath `
            -ActivePath (Join-Path $skillsRoot '.hub\lock.json') `
            -TargetPath (Join-Path $stagingRoot '.hub\lock.json') `
            -StagingRoot $stagingRoot `
            -ActiveNames $rootNames
        usage = Merge-UsageMetadata `
            -SourcePath $sourceUsagePath `
            -ActivePath (Join-Path $skillsRoot '.usage.json') `
            -TargetPath (Join-Path $stagingRoot '.usage.json') `
            -NameAliases $skillNameAliases `
            -OwnerManagedNames $ownerManagedSkillNames
    }
    if (@($rootNames | Select-Object -Unique).Count -ne $rootNames.Count) {
        throw 'Rebuilt Windows skill tree contains duplicate skill names.'
    }
    foreach ($required in @('village-history-evidence', 'village-operations', 'village-capability-development', 'village-confirm-request', 'productivity-integrations')) {
        if ($rootNames -notcontains $required) {
            throw "Rebuilt Windows skill tree is missing '$required'."
        }
    }
    if ($ProfileScoped.IsPresent -and $rootNames -notcontains 'rpa-automation-operations') {
        throw "Rebuilt worker profile is missing 'rpa-automation-operations'."
    }
    foreach ($forbidden in @('village-brain-first', 'village-operations-windows', 'rpa-automation-operations-windows', 'google-workspace', 'village-runtime-router')) {
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
        metadata      = $metadata
        canonical     = @('village-history-evidence', 'village-operations', 'village-capability-development', 'village-confirm-request')
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
