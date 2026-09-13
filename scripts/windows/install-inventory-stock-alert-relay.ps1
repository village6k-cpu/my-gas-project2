param(
  [string]$RepoRoot = (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)),
  [string]$StateDir = (Join-Path $env:LOCALAPPDATA 'VillageInventoryAlerts')
)
$ErrorActionPreference = 'Stop'
$taskName = 'Village Inventory Stock Alert Relay'
$ownerMarker = 'village-inventory-stock-relay-v1'
$resolvedRepo = (Resolve-Path -LiteralPath $RepoRoot).Path
$runner = Join-Path $resolvedRepo 'scripts\windows\run-inventory-stock-alert-relay.ps1'
$configPath = Join-Path $StateDir 'config.json'
if (-not (Test-Path -LiteralPath $runner) -or -not (Test-Path -LiteralPath $configPath)) {
  throw 'Run the inventory relay --setup and verify its Slack connection first.'
}
$existing = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($existing -and $existing.Description -notlike "*$ownerMarker*") {
  throw 'An unrelated scheduled task already uses the inventory relay name.'
}
$nodePath = Join-Path $env:LOCALAPPDATA 'Microsoft\WinGet\Links\node.exe'
if (-not (Test-Path -LiteralPath $nodePath)) { $nodePath = (Get-Command node.exe -ErrorAction Stop).Source }
$psPath = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$arguments = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "{0}" -RepoRoot "{1}" -NodePath "{2}" -StateDir "{3}"' -f $runner,$resolvedRepo,$nodePath,$StateDir
$action = New-ScheduledTaskAction -Execute $psPath -Argument $arguments -WorkingDirectory $resolvedRepo
$account = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$triggers = @(
  (New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 1)),
  (New-ScheduledTaskTrigger -AtLogOn -User $account)
)
$principal = New-ScheduledTaskPrincipal -UserId $account -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 3)
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $triggers -Principal $principal -Settings $settings -Description "$ownerMarker - Deliver verified inventory shortage notices; no customer or reservation writes." -Force | Out-Null
$saved = Get-ScheduledTask -TaskName $taskName
if ($saved.Actions.Execute -ne $psPath -or $saved.Actions.Arguments -ne $arguments -or $saved.State -eq 'Disabled') {
  throw 'Inventory relay scheduled-task readback failed.'
}
[pscustomobject]@{taskName=$taskName;state=[string]$saved.State;interval='PT1M';logon=$account;runner=$runner;node=$nodePath;stateDir=$StateDir} | ConvertTo-Json
