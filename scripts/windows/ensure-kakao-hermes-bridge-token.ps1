<#
.SYNOPSIS
Ensures the profile-scoped Kakao bridge has a shared loopback bearer token.

.DESCRIPTION
Creates one cryptographically random token only when the reviewed environment
file has no usable KAKAO_HERMES_BRIDGE_TOKEN entry. The token is never written
to stdout, stderr, Git, or the install receipt.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][ValidateNotNullOrEmpty()][string]$ProfileRoot,
    [Parameter(Mandatory = $true)][ValidateNotNullOrEmpty()][string]$EnvFile,
    [switch]$PlanOnly
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Get-FullPath {
    param([Parameter(Mandatory = $true)][string]$Path)
    return [IO.Path]::GetFullPath($Path).TrimEnd('\', '/')
}

$resolvedProfileRoot = Get-FullPath -Path (Resolve-Path -LiteralPath $ProfileRoot -ErrorAction Stop).Path
$resolvedEnvFile = Get-FullPath -Path (Resolve-Path -LiteralPath $EnvFile -ErrorAction Stop).Path
if (-not $resolvedEnvFile.StartsWith(
    $resolvedProfileRoot + [IO.Path]::DirectorySeparatorChar,
    [StringComparison]::OrdinalIgnoreCase
)) {
    throw 'Gateway token environment file escapes kakaoworker profile.'
}
foreach ($path in @($resolvedProfileRoot, $resolvedEnvFile)) {
    $item = Get-Item -LiteralPath $path -Force -ErrorAction Stop
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw 'Gateway token paths must not be reparse points.'
    }
}

$content = [IO.File]::ReadAllText($resolvedEnvFile, [Text.Encoding]::UTF8)
$entries = [regex]::Matches($content, '(?m)^KAKAO_HERMES_BRIDGE_TOKEN=([^\r\n]*)\r?$')
if ($entries.Count -gt 1) { throw 'Duplicate KAKAO_HERMES_BRIDGE_TOKEN entries are not allowed.' }
$tokenEntryPresent = $entries.Count -eq 1 -and -not [string]::IsNullOrWhiteSpace($entries[0].Groups[1].Value)
$wouldChange = -not $tokenEntryPresent

$result = [ordered]@{
    ok = $true
    mode = if ($PlanOnly.IsPresent) { 'plan' } else { 'apply' }
    changed = $false
    wouldChange = $wouldChange
    tokenEntryPresent = $tokenEntryPresent
}
if ($PlanOnly.IsPresent -or -not $wouldChange) {
    [pscustomobject]$result | ConvertTo-Json -Compress
    exit 0
}

$bytes = New-Object byte[] 32
$rng = New-Object Security.Cryptography.RNGCryptoServiceProvider
try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
$token = [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
$line = "KAKAO_HERMES_BRIDGE_TOKEN=$token"
if ($entries.Count -eq 1) {
    $nextContent = $content.Substring(0, $entries[0].Index) + $line +
        $content.Substring($entries[0].Index + $entries[0].Length)
}
else {
    $nextContent = $content.TrimEnd("`r", "`n") + "`r`n$line`r`n"
}

$suffix = [Guid]::NewGuid().ToString('N')
$temporary = "$resolvedEnvFile.tmp.$suffix"
$backup = "$resolvedEnvFile.backup.$suffix"
$encoding = New-Object Text.UTF8Encoding($false)
try {
    [IO.File]::WriteAllText($temporary, $nextContent, $encoding)
    [IO.File]::Replace($temporary, $resolvedEnvFile, $backup, $true)
    if (Test-Path -LiteralPath $backup) { [IO.File]::Delete($backup) }
}
finally {
    if (Test-Path -LiteralPath $temporary) { [IO.File]::Delete($temporary) }
}

$result.changed = $true
$result.tokenEntryPresent = $true
[pscustomobject]$result | ConvertTo-Json -Compress
