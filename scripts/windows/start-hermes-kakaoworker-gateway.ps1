<#
.SYNOPSIS
Starts the profile-scoped kakaoworker Gateway after verifying its plugin receipt.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][ValidateNotNullOrEmpty()][string]$HermesHome,
    [Parameter(Mandatory = $true)][ValidateNotNullOrEmpty()][string]$HermesPythonPath,
    [Parameter(Mandatory = $true)][ValidateNotNullOrEmpty()][string]$EnvFile,
    [switch]$VerifyOnly
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Get-FullPath {
    param([Parameter(Mandatory = $true)][string]$Path)
    return [IO.Path]::GetFullPath($Path).TrimEnd('\', '/')
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
        return ([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($Value)))).Replace('-', '')
    }
    finally { $sha.Dispose() }
}

function Import-SafeEnvironmentFile {
    param([Parameter(Mandatory = $true)][string]$Path)
    $allowed = @(
        'VILLAGE_KAKAO_BRIDGE_URL', 'VILLAGE_KAKAO_BRIDGE_TOKEN', 'VILLAGE_KAKAO_CONSUMER_ID',
        'KAKAO_HERMES_BRIDGE_TOKEN'
    )
    foreach ($raw in @(Get-Content -LiteralPath $Path -ErrorAction Stop)) {
        $line = ([string]$raw).Trim()
        if (-not $line -or $line.StartsWith('#') -or $line -notmatch '^([A-Za-z_][A-Za-z0-9_]*)=(.*)$') { continue }
        $name = $matches[1]
        if ($allowed -notcontains $name) { continue }
        $value = $matches[2].Trim()
        if (($value.StartsWith('"') -and $value.EndsWith('"')) -or ($value.StartsWith("'") -and $value.EndsWith("'"))) {
            $value = $value.Substring(1, $value.Length - 2)
        }
        [Environment]::SetEnvironmentVariable($name, $value, 'Process')
    }
}

$resolvedHermesHome = Get-FullPath -Path $HermesHome
$resolvedPython = Get-FullPath -Path (Resolve-Path -LiteralPath $HermesPythonPath -ErrorAction Stop).Path
$resolvedEnvFile = Get-FullPath -Path (Resolve-Path -LiteralPath $EnvFile -ErrorAction Stop).Path
$expectedPython = Get-FullPath -Path (Join-Path $resolvedHermesHome 'hermes-agent\venv\Scripts\python.exe')
if (-not $resolvedPython.Equals($expectedPython, [StringComparison]::OrdinalIgnoreCase)) {
    throw "kakaoworker Gateway must use the complete hermes-agent\venv\Scripts\python.exe runtime."
}

$profileRoot = Join-Path $resolvedHermesHome 'profiles\kakaoworker'
$pluginRoot = Join-Path $profileRoot 'plugins\kakao_village'
$receiptPath = Join-Path $profileRoot 'plugin-state\kakao_village.json'
$configPath = Join-Path $profileRoot 'config.yaml'
if (-not (Test-Path -LiteralPath $receiptPath -PathType Leaf)) { throw "Missing plugin receipt '$receiptPath'." }
if (-not (Test-Path -LiteralPath $pluginRoot -PathType Container)) { throw "Missing installed plugin '$pluginRoot'." }
if (-not (Test-Path -LiteralPath $configPath -PathType Leaf)) { throw "Missing kakaoworker config '$configPath'." }

$receipt = [IO.File]::ReadAllText($receiptPath, [Text.Encoding]::UTF8) | ConvertFrom-Json -ErrorAction Stop
if ([string]$receipt.schema -ne 'village-kakao-plugin-install/v1' -or [string]$receipt.pluginName -ne 'kakao_village') {
    throw 'Invalid kakaoworker plugin receipt.'
}
$rows = New-Object System.Collections.ArrayList
foreach ($entry in @($receipt.fileManifest)) {
    $relative = [string]$entry.relativePath
    if ([string]::IsNullOrWhiteSpace($relative) -or $relative -match '(^|[\\/])\.\.([\\/]|$)') {
        throw 'Invalid plugin receipt relative path.'
    }
    $file = Join-Path $pluginRoot ($relative.Replace('/', '\'))
    if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw "Installed plugin file missing: '$relative'." }
    $hash = Get-Sha256 -Path $file
    if ($hash -ne ([string]$entry.sha256).ToUpperInvariant()) { throw "Installed plugin hash mismatch: '$relative'." }
    [void]$rows.Add(('{0}|{1}|{2}' -f $relative, ([IO.FileInfo]$file).Length, $hash))
}
$manifestSha256 = Get-StringSha256 -Value (@($rows | Sort-Object) -join "`n")
if ($manifestSha256 -ne ([string]$receipt.manifestSha256).ToUpperInvariant()) {
    throw 'Installed plugin manifestSha256 does not match its receipt.'
}
$config = [IO.File]::ReadAllText($configPath, [Text.Encoding]::UTF8)
if ($config -notmatch '(?ms)^plugins:\s*.*?kakao_village' -or
    $config -notmatch '(?ms)^platforms:\s*.*?^\s{2}kakao_village:\s*.*?^\s{4}enabled:\s*true\s*$') {
    throw 'kakaoworker config does not enable the kakao_village plugin/platform.'
}

Import-SafeEnvironmentFile -Path $resolvedEnvFile
if ([string]::IsNullOrWhiteSpace($env:VILLAGE_KAKAO_BRIDGE_URL)) {
    $env:VILLAGE_KAKAO_BRIDGE_URL = 'http://127.0.0.1:8787'
}
if ([string]::IsNullOrWhiteSpace($env:VILLAGE_KAKAO_BRIDGE_TOKEN) -and
    -not [string]::IsNullOrWhiteSpace($env:KAKAO_HERMES_BRIDGE_TOKEN)) {
    $env:VILLAGE_KAKAO_BRIDGE_TOKEN = $env:KAKAO_HERMES_BRIDGE_TOKEN
}
if ([string]::IsNullOrWhiteSpace($env:VILLAGE_KAKAO_BRIDGE_TOKEN)) {
    throw 'VILLAGE_KAKAO_BRIDGE_TOKEN is required outside git.'
}
if ([string]::IsNullOrWhiteSpace($env:VILLAGE_KAKAO_CONSUMER_ID)) {
    $env:VILLAGE_KAKAO_CONSUMER_ID = 'kakaoworker-gateway'
}
$env:HERMES_HOME = $resolvedHermesHome

if ($VerifyOnly.IsPresent) {
    [pscustomobject]@{
        ok = $true
        profile = 'kakaoworker'
        pythonPath = $resolvedPython
        pluginPath = $pluginRoot
        manifestSha256 = $manifestSha256
        consumerId = $env:VILLAGE_KAKAO_CONSUMER_ID
    } | ConvertTo-Json -Compress
    exit 0
}

$agentDir = Join-Path $resolvedHermesHome 'hermes-agent'
Push-Location $agentDir
try {
    & $resolvedPython '-m' 'hermes_cli.main' '--profile' 'kakaoworker' 'gateway' 'run'
    exit $LASTEXITCODE
}
finally {
    Pop-Location
}
