param(
  [Parameter(Mandatory=$true)][string]$RepoRoot,
  [Parameter(Mandatory=$true)][string]$NodePath,
  [Parameter(Mandatory=$true)][string]$StateDir
)
$ErrorActionPreference = 'Stop'
$relayScript = Join-Path (Resolve-Path -LiteralPath $RepoRoot).Path 'scripts\windows\inventory-stock-alert-relay.js'
if (-not (Test-Path -LiteralPath $NodePath)) { throw 'Inventory alert Node runtime is unavailable.' }
& $NodePath $relayScript --once --state-dir $StateDir
exit $LASTEXITCODE
