<#
.SYNOPSIS
Installs the reviewed Kakao Village platform plugin into the kakaoworker profile.

.DESCRIPTION
Copies only reviewed source files from a clean git worktree, verifies every
SHA-256, and atomically replaces the profile-scoped plugin. PlanOnly is strictly
read-only. The root Hermes profile and installed Hermes source are never targets.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string]$SourcePluginPath,

    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string]$HermesHome,

    [switch]$PlanOnly
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$pluginName = 'kakao_village'
$encoding = New-Object System.Text.UTF8Encoding($false)
$allowedExtensions = @('.py', '.yaml', '.yml', '.md')
$forbiddenExtensions = @('.exe', '.dll', '.com', '.bat', '.cmd', '.ps1', '.sh', '.pem', '.key', '.pfx', '.p12')
$ignoredParts = @('tests', '__pycache__', '.pytest_cache', '.mypy_cache', '.ruff_cache')
$requiredPlatformToolsets = @('skills', 'village')

function Get-FullPath {
    param([Parameter(Mandatory = $true)][string]$Path)
    return [IO.Path]::GetFullPath($Path).TrimEnd('\', '/')
}

function Test-PathInside {
    param(
        [Parameter(Mandatory = $true)][string]$Child,
        [Parameter(Mandatory = $true)][string]$Parent
    )
    $childFull = Get-FullPath -Path $Child
    $parentFull = Get-FullPath -Path $Parent
    return $childFull.Equals($parentFull, [StringComparison]::OrdinalIgnoreCase) -or
        $childFull.StartsWith($parentFull + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)
}

function Get-Sha256 {
    param([Parameter(Mandatory = $true)][string]$Path)
    $sha = [Security.Cryptography.SHA256]::Create()
    $stream = $null
    try {
        $stream = [IO.File]::OpenRead((Get-FullPath -Path $Path))
        return ([BitConverter]::ToString($sha.ComputeHash($stream))).Replace('-', '')
    }
    finally {
        if ($null -ne $stream) { $stream.Dispose() }
        $sha.Dispose()
    }
}

function Get-StringSha256 {
    param([Parameter(Mandatory = $true)][string]$Value)
    $sha = [Security.Cryptography.SHA256]::Create()
    try {
        $bytes = [Text.Encoding]::UTF8.GetBytes($Value)
        return ([BitConverter]::ToString($sha.ComputeHash($bytes))).Replace('-', '')
    }
    finally {
        $sha.Dispose()
    }
}

function Assert-NoReparsePoint {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [switch]$Recurse
    )
    $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "Unsafe reparse point: '$Path'."
    }
    if ($Recurse.IsPresent -and $item.PSIsContainer) {
        foreach ($child in @(Get-ChildItem -LiteralPath $Path -Force -Recurse -ErrorAction Stop)) {
            if (($child.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw "Unsafe source reparse point: '$($child.FullName)'."
            }
        }
    }
}

function Assert-TargetAncestorsSafe {
    param(
        [Parameter(Mandatory = $true)][string]$Target,
        [Parameter(Mandatory = $true)][string]$ProfileRoot
    )
    if (-not (Test-PathInside -Child $Target -Parent $ProfileRoot)) {
        throw "Plugin target escapes kakaoworker profile: '$Target'."
    }
    $cursor = Get-FullPath -Path $ProfileRoot
    if (Test-Path -LiteralPath $cursor) {
        Assert-NoReparsePoint -Path $cursor
    }
    $relative = (Get-FullPath -Path $Target).Substring($cursor.Length).TrimStart('\', '/')
    foreach ($part in @($relative -split '[\\/]')) {
        if ([string]::IsNullOrWhiteSpace($part)) { continue }
        $cursor = Join-Path $cursor $part
        if (Test-Path -LiteralPath $cursor) {
            Assert-NoReparsePoint -Path $cursor
        }
    }
}

function Get-ReviewedManifest {
    param([Parameter(Mandatory = $true)][string]$SourceRoot)
    $rows = New-Object System.Collections.ArrayList
    foreach ($file in @(Get-ChildItem -LiteralPath $SourceRoot -File -Force -Recurse -ErrorAction Stop | Sort-Object FullName)) {
        $relative = $file.FullName.Substring($SourceRoot.Length).TrimStart('\', '/').Replace('\', '/')
        $parts = @($relative -split '/')
        if (@($parts | Where-Object { $ignoredParts -contains $_ }).Count -gt 0) {
            continue
        }
        $leafLower = $file.Name.ToLowerInvariant()
        $extension = $file.Extension.ToLowerInvariant()
        if ($leafLower -eq '.env' -or $leafLower -match '(secret|token|credential)' -or $forbiddenExtensions -contains $extension) {
            throw "Unsafe secret, binary, or executable plugin source file: '$relative'."
        }
        if ($allowedExtensions -notcontains $extension) {
            throw "Unexpected plugin source file type: '$relative'."
        }
        [void]$rows.Add([pscustomobject]@{
            relativePath = $relative
            bytes = [Int64]$file.Length
            sha256 = Get-Sha256 -Path $file.FullName
        })
    }
    $manifest = @($rows | Sort-Object relativePath)
    foreach ($required in @('__init__.py', 'plugin.yaml')) {
        if ($manifest.relativePath -notcontains $required) {
            throw "Required plugin descriptor '$required' is missing."
        }
    }
    return $manifest
}

function Assert-CleanGitSource {
    param([Parameter(Mandatory = $true)][string]$SourceRoot)
    $repoOutput = @(& git -C $SourceRoot rev-parse --show-toplevel 2>&1)
    $repoExit = $LASTEXITCODE
    $repoRoot = @($repoOutput | Where-Object { -not [string]::IsNullOrWhiteSpace([string]$_) } | Select-Object -First 1)
    if ($repoExit -ne 0 -or $repoRoot.Count -eq 0) {
        throw "Reviewed plugin source is not inside a resolved git worktree: '$SourceRoot'."
    }
    $repoRoot = Get-FullPath -Path ([string]$repoRoot[0])
    if (-not (Test-PathInside -Child $SourceRoot -Parent $repoRoot)) {
        throw "Reviewed plugin source escapes its git worktree."
    }
    $relative = (Get-FullPath -Path $SourceRoot).Substring($repoRoot.Length).TrimStart('\', '/')
    $status = @(& git -C $repoRoot status --porcelain --untracked-files=all -- $relative 2>&1)
    $statusExit = $LASTEXITCODE
    if ($statusExit -ne 0) {
        throw "Cannot inspect reviewed plugin source git status."
    }
    $unsafeStatus = @($status | Where-Object {
        $line = [string]$_
        if ([string]::IsNullOrWhiteSpace($line)) { return $false }
        if ($line -match '^\?\?\s+(.+)$') {
            $untrackedPath = $matches[1].Trim('"').Replace('\', '/')
            if (@($untrackedPath -split '/' | Where-Object { $_ -eq '__pycache__' }).Count -gt 0) {
                return $false
            }
        }
        return $true
    })
    if ($unsafeStatus.Count -gt 0) {
        throw "Reviewed plugin source is dirty or contains untracked files."
    }
    return $repoRoot
}

function Insert-StringLines {
    param(
        [string[]]$Lines,
        [int]$Index,
        [string[]]$NewLines
    )
    $result = New-Object System.Collections.ArrayList
    for ($i = 0; $i -lt $Index; $i++) { [void]$result.Add($Lines[$i]) }
    foreach ($line in $NewLines) { [void]$result.Add($line) }
    for ($i = $Index; $i -lt $Lines.Count; $i++) { [void]$result.Add($Lines[$i]) }
    return [string[]]$result.ToArray()
}

function Replace-StringLines {
    param(
        [string[]]$Lines,
        [int]$Start,
        [int]$End,
        [string[]]$NewLines
    )
    $result = New-Object System.Collections.ArrayList
    for ($i = 0; $i -lt $Start; $i++) { [void]$result.Add($Lines[$i]) }
    foreach ($line in $NewLines) { [void]$result.Add($line) }
    for ($i = $End; $i -lt $Lines.Count; $i++) { [void]$result.Add($Lines[$i]) }
    return [string[]]$result.ToArray()
}

function Find-TopSection {
    param([string[]]$Lines, [string]$Name)
    $start = -1
    for ($i = 0; $i -lt $Lines.Count; $i++) {
        if ($Lines[$i] -match ('^{0}:\s*$' -f [regex]::Escape($Name))) { $start = $i; break }
    }
    if ($start -lt 0) { return [pscustomobject]@{ start = -1; end = -1 } }
    $end = $Lines.Count
    for ($i = $start + 1; $i -lt $Lines.Count; $i++) {
        if ($Lines[$i] -match '^\S[^:]*:\s*') { $end = $i; break }
    }
    return [pscustomobject]@{ start = $start; end = $end }
}

function Get-ConfigPlan {
    param([string]$Content)
    $normalized = ([string]$Content).Replace("`r`n", "`n").Replace("`r", "`n")
    $lines = [string[]]($normalized -split "`n")
    $enabled = New-Object System.Collections.ArrayList
    $plugins = Find-TopSection -Lines $lines -Name 'plugins'
    if ($plugins.start -ge 0) {
        for ($i = $plugins.start + 1; $i -lt $plugins.end; $i++) {
            if ($lines[$i] -match '^\s{2}enabled:\s*\[(.*)\]\s*$') {
                foreach ($value in @($matches[1] -split ',')) {
                    $clean = $value.Trim().Trim("'", '"')
                    if ($clean) { [void]$enabled.Add($clean) }
                }
            }
            elseif ($lines[$i] -match '^\s{4}-\s*(.+?)\s*$') {
                $clean = $matches[1].Trim().Trim("'", '"')
                if ($clean) { [void]$enabled.Add($clean) }
            }
        }
    }
    if ($enabled -notcontains $pluginName) { [void]$enabled.Add($pluginName) }

    $platformMap = [ordered]@{}
    $platforms = Find-TopSection -Lines $lines -Name 'platforms'
    if ($platforms.start -ge 0) {
        for ($i = $platforms.start + 1; $i -lt $platforms.end; $i++) {
            if ($lines[$i] -match '^\s{2}([A-Za-z0-9_-]+):\s*$') {
                $name = $matches[1]
                $isEnabled = $false
                for ($j = $i + 1; $j -lt $platforms.end; $j++) {
                    if ($lines[$j] -match '^\s{2}[A-Za-z0-9_-]+:\s*$') { break }
                    if ($lines[$j] -match '^\s{4}enabled:\s*(true|false)\s*$') {
                        $isEnabled = $matches[1] -eq 'true'
                        break
                    }
                }
                $platformMap[$name] = [ordered]@{ enabled = $isEnabled }
            }
        }
    }
    $platformMap[$pluginName] = [ordered]@{ enabled = $true }

    $toolsetMap = [ordered]@{}
    $platformToolsets = Find-TopSection -Lines $lines -Name 'platform_toolsets'
    if ($platformToolsets.start -ge 0) {
        for ($i = $platformToolsets.start + 1; $i -lt $platformToolsets.end; $i++) {
            if ($lines[$i] -match '^\s{2}([A-Za-z0-9_-]+):\s*\[(.*)\]\s*$') {
                $values = @($matches[2] -split ',' | ForEach-Object { $_.Trim().Trim("'", '"') } | Where-Object { $_ })
                $toolsetMap[$matches[1]] = $values
            }
        }
    }
    $toolsetMap[$pluginName] = @($requiredPlatformToolsets)
    return [pscustomobject]@{
        pluginsEnabled = @($enabled | Select-Object -Unique)
        platforms = [pscustomobject]$platformMap
        platformToolsets = [pscustomobject]$toolsetMap
    }
}

function Merge-ProfileConfig {
    param([string]$Content)
    $normalized = ([string]$Content).Replace("`r`n", "`n").Replace("`r", "`n").TrimEnd("`n")
    $lines = if ($normalized) { [string[]]($normalized -split "`n") } else { [string[]]@() }

    $plugins = Find-TopSection -Lines $lines -Name 'plugins'
    if ($plugins.start -lt 0) {
        if ($lines.Count -gt 0) { $lines = Insert-StringLines -Lines $lines -Index $lines.Count -NewLines @('') }
        $lines = Insert-StringLines -Lines $lines -Index $lines.Count -NewLines @('plugins:', '  enabled:', "    - $pluginName")
    }
    else {
        $enabledIndex = -1
        for ($i = $plugins.start + 1; $i -lt $plugins.end; $i++) {
            if ($lines[$i] -match '^\s{2}enabled:\s*(.*)$') { $enabledIndex = $i; break }
        }
        if ($enabledIndex -lt 0) {
            $lines = Insert-StringLines -Lines $lines -Index ($plugins.start + 1) -NewLines @('  enabled:', "    - $pluginName")
        }
        elseif ($lines[$enabledIndex] -match '^\s{2}enabled:\s*\[(.*)\]\s*$') {
            $values = @($matches[1] -split ',' | ForEach-Object { $_.Trim().Trim("'", '"') } | Where-Object { $_ })
            if ($values -notcontains $pluginName) { $values += $pluginName }
            $lines[$enabledIndex] = '  enabled: [' + ($values -join ', ') + ']'
        }
        else {
            $section = Find-TopSection -Lines $lines -Name 'plugins'
            $exists = $false
            $insert = $section.end
            for ($i = $enabledIndex + 1; $i -lt $section.end; $i++) {
                if ($lines[$i] -match '^\s{2}\S[^:]*:\s*') { $insert = $i; break }
                if ($lines[$i] -match '^\s{4}-\s*(.+?)\s*$' -and $matches[1].Trim().Trim("'", '"') -eq $pluginName) { $exists = $true }
            }
            if (-not $exists) { $lines = Insert-StringLines -Lines $lines -Index $insert -NewLines @("    - $pluginName") }
        }
    }

    $platforms = Find-TopSection -Lines $lines -Name 'platforms'
    if ($platforms.start -lt 0) {
        if ($lines.Count -gt 0) { $lines = Insert-StringLines -Lines $lines -Index $lines.Count -NewLines @('') }
        $lines = Insert-StringLines -Lines $lines -Index $lines.Count -NewLines @('platforms:', "  ${pluginName}:", '    enabled: true')
    }
    else {
        $platformStart = -1
        for ($i = $platforms.start + 1; $i -lt $platforms.end; $i++) {
            if ($lines[$i] -match ('^\s{{2}}{0}:\s*$' -f [regex]::Escape($pluginName))) { $platformStart = $i; break }
        }
        if ($platformStart -lt 0) {
            $lines = Insert-StringLines -Lines $lines -Index $platforms.end -NewLines @("  ${pluginName}:", '    enabled: true')
        }
        else {
            $platforms = Find-TopSection -Lines $lines -Name 'platforms'
            $platformEnd = $platforms.end
            for ($i = $platformStart + 1; $i -lt $platforms.end; $i++) {
                if ($lines[$i] -match '^\s{2}[A-Za-z0-9_-]+:\s*$') { $platformEnd = $i; break }
            }
            $enabledIndex = -1
            for ($i = $platformStart + 1; $i -lt $platformEnd; $i++) {
                if ($lines[$i] -match '^\s{4}enabled:\s*') { $enabledIndex = $i; break }
            }
            if ($enabledIndex -ge 0) { $lines[$enabledIndex] = '    enabled: true' }
            else { $lines = Insert-StringLines -Lines $lines -Index ($platformStart + 1) -NewLines @('    enabled: true') }
        }
    }

    $platformToolsets = Find-TopSection -Lines $lines -Name 'platform_toolsets'
    $requiredToolsetLine = "  ${pluginName}: [" + ($requiredPlatformToolsets -join ', ') + ']'
    if ($platformToolsets.start -lt 0) {
        if ($lines.Count -gt 0) { $lines = Insert-StringLines -Lines $lines -Index $lines.Count -NewLines @('') }
        $lines = Insert-StringLines -Lines $lines -Index $lines.Count -NewLines @('platform_toolsets:', $requiredToolsetLine)
    }
    else {
        $entryStart = -1
        $entryEnd = $platformToolsets.end
        for ($i = $platformToolsets.start + 1; $i -lt $platformToolsets.end; $i++) {
            if ($lines[$i] -match ('^\s{{2}}{0}:\s*' -f [regex]::Escape($pluginName))) {
                $entryStart = $i
                for ($j = $i + 1; $j -lt $platformToolsets.end; $j++) {
                    if ($lines[$j] -match '^\s{2}[A-Za-z0-9_-]+:\s*') { $entryEnd = $j; break }
                }
                break
            }
        }
        if ($entryStart -lt 0) {
            $lines = Insert-StringLines -Lines $lines -Index $platformToolsets.end -NewLines @($requiredToolsetLine)
        }
        else {
            $lines = Replace-StringLines -Lines $lines -Start $entryStart -End $entryEnd -NewLines @($requiredToolsetLine)
        }
    }
    return (($lines -join "`r`n").TrimEnd() + "`r`n")
}

function Get-InstalledManifest {
    param([string]$TargetRoot)
    if (-not (Test-Path -LiteralPath $TargetRoot -PathType Container)) { return @() }
    return @(Get-ReviewedManifest -SourceRoot (Get-FullPath -Path $TargetRoot))
}

function Get-ManifestDigest {
    param([object[]]$Manifest)
    $canonical = @($Manifest | Sort-Object relativePath | ForEach-Object {
        '{0}|{1}|{2}' -f $_.relativePath, $_.bytes, $_.sha256
    }) -join "`n"
    return Get-StringSha256 -Value $canonical
}

$sourceRoot = Get-FullPath -Path (Resolve-Path -LiteralPath $SourcePluginPath -ErrorAction Stop).Path
$resolvedHermesHome = Get-FullPath -Path $HermesHome
$profileRoot = Join-Path $resolvedHermesHome 'profiles\kakaoworker'
$pluginsRoot = Join-Path $profileRoot 'plugins'
$targetRoot = Join-Path $pluginsRoot $pluginName
$configPath = Join-Path $profileRoot 'config.yaml'
$stateRoot = Join-Path $profileRoot 'plugin-state'
$statePath = Join-Path $stateRoot "$pluginName.json"

Assert-NoReparsePoint -Path $sourceRoot -Recurse
[void](Assert-CleanGitSource -SourceRoot $sourceRoot)
Assert-TargetAncestorsSafe -Target $targetRoot -ProfileRoot $profileRoot
$manifest = @(Get-ReviewedManifest -SourceRoot $sourceRoot)
$manifestSha = Get-ManifestDigest -Manifest $manifest
$configContent = if (Test-Path -LiteralPath $configPath -PathType Leaf) {
    [IO.File]::ReadAllText($configPath, [Text.Encoding]::UTF8)
} else { '' }
$mergedConfig = Merge-ProfileConfig -Content $configContent
$configPlan = Get-ConfigPlan -Content $mergedConfig
$installedManifest = @(Get-InstalledManifest -TargetRoot $targetRoot)
$installedSha = if ($installedManifest.Count -gt 0) { Get-ManifestDigest -Manifest $installedManifest } else { '' }
$wouldChange = $installedSha -ne $manifestSha -or $mergedConfig -ne $configContent

$result = [ordered]@{
    ok = $true
    mode = if ($PlanOnly.IsPresent) { 'plan' } else { 'apply' }
    changed = $false
    wouldChange = $wouldChange
    pluginName = $pluginName
    sourcePluginPath = $sourceRoot
    profileRoot = $profileRoot
    targetPluginPath = $targetRoot
    configPath = $configPath
    manifestSha256 = $manifestSha
    fileManifest = $manifest
    configPlan = $configPlan
}

if ($PlanOnly.IsPresent) {
    [pscustomobject]$result | ConvertTo-Json -Depth 8 -Compress
    exit 0
}

[void][IO.Directory]::CreateDirectory($profileRoot)
[void][IO.Directory]::CreateDirectory($pluginsRoot)
Assert-TargetAncestorsSafe -Target $targetRoot -ProfileRoot $profileRoot

$stagingRoot = Join-Path $pluginsRoot ('.kakao_village.staging.' + [Guid]::NewGuid().ToString('N'))
$rollbackRoot = Join-Path $pluginsRoot '.kakao_village.rollback'
$configTemp = Join-Path $profileRoot ('.config.kakao_village.' + [Guid]::NewGuid().ToString('N') + '.tmp')
$configRollback = Join-Path $profileRoot '.config.kakao_village.rollback'
try {
    if ($installedSha -ne $manifestSha) {
        [void][IO.Directory]::CreateDirectory($stagingRoot)
        foreach ($entry in $manifest) {
            $source = Join-Path $sourceRoot ($entry.relativePath.Replace('/', '\'))
            $destination = Join-Path $stagingRoot ($entry.relativePath.Replace('/', '\'))
            [void][IO.Directory]::CreateDirectory((Split-Path -Parent $destination))
            [IO.File]::Copy($source, $destination, $false)
            if ((Get-Sha256 -Path $destination) -ne $entry.sha256) {
                throw "Copied plugin hash mismatch: '$($entry.relativePath)'."
            }
        }
        if (Test-Path -LiteralPath $rollbackRoot) { [IO.Directory]::Delete($rollbackRoot, $true) }
        if (Test-Path -LiteralPath $targetRoot) { [IO.Directory]::Move($targetRoot, $rollbackRoot) }
        try { [IO.Directory]::Move($stagingRoot, $targetRoot) }
        catch {
            if ((Test-Path -LiteralPath $rollbackRoot) -and -not (Test-Path -LiteralPath $targetRoot)) {
                [IO.Directory]::Move($rollbackRoot, $targetRoot)
            }
            throw
        }
    }

    if ($mergedConfig -ne $configContent) {
        [IO.File]::WriteAllText($configTemp, $mergedConfig, $encoding)
        if (Test-Path -LiteralPath $configRollback) { [IO.File]::Delete($configRollback) }
        if (Test-Path -LiteralPath $configPath) { [IO.File]::Move($configPath, $configRollback) }
        try { [IO.File]::Move($configTemp, $configPath) }
        catch {
            if ((Test-Path -LiteralPath $configRollback) -and -not (Test-Path -LiteralPath $configPath)) {
                [IO.File]::Move($configRollback, $configPath)
            }
            throw
        }
    }

    [void][IO.Directory]::CreateDirectory($stateRoot)
    $receipt = [ordered]@{
        schema = 'village-kakao-plugin-install/v1'
        pluginName = $pluginName
        sourcePluginPath = $sourceRoot
        targetPluginPath = $targetRoot
        manifestSha256 = $manifestSha
        fileManifest = $manifest
        installedAt = [DateTimeOffset]::UtcNow.ToString('o')
    } | ConvertTo-Json -Depth 6
    [IO.File]::WriteAllText($statePath, $receipt, $encoding)
    $result.changed = $wouldChange
}
finally {
    if (Test-Path -LiteralPath $stagingRoot) { [IO.Directory]::Delete($stagingRoot, $true) }
    if (Test-Path -LiteralPath $configTemp) { [IO.File]::Delete($configTemp) }
}

[pscustomobject]$result | ConvertTo-Json -Depth 8 -Compress
