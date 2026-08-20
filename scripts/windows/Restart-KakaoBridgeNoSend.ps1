[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'Medium')]
param(
  [Parameter(Mandatory = $true)]
  [string]$EnvFile,

  [Parameter(Mandatory = $true)]
  [string]$HermesPythonPath,

  [switch]$AllowLiveTransition
)

$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..')).Path
Import-Module (Join-Path $PSScriptRoot 'KakaoStaging.Common.psm1') -Force
Import-Module (Join-Path $PSScriptRoot 'KakaoLiveNoSend.Common.psm1') -Force

$pre = Invoke-RestMethod -Uri 'http://127.0.0.1:8787/health' -TimeoutSec 5
if (-not (Test-KakaoNoSendTransitionAllowed -Health $pre -AllowLiveTransition $AllowLiveTransition.IsPresent)) {
  throw 'No-send transition precondition failed.'
}

$record = Read-OwnedProcessRecord -Name 'bridge'
if ($null -eq $record -or -not (Test-OwnedProcessRecord -Record $record)) {
  throw 'Bridge ownership validation failed.'
}

Import-DotEnvFile -Path $EnvFile
$resolvedHermesPythonPath = (Resolve-Path -LiteralPath $HermesPythonPath -ErrorAction Stop).Path
[Environment]::SetEnvironmentVariable('HERMES_WORKER_COMMAND', $resolvedHermesPythonPath, 'Process')
[Environment]::SetEnvironmentVariable('HERMES_WORKER_COMMAND_MODE', 'python_module', 'Process')
Set-KakaoStagingSafeEnvironment -EnableWrites
Set-KakaoLiveNoSendEnvironment
$required = @{
  AI_WORKER_LIVE = '1'
  AI_WORKER_AUTO_SEND = '0'
  AI_WORKER_DRY_RUN = '0'
  SLACK_ACTION_POLL_ENABLED = '0'
  SLACK_AGENT_CARD_DELIVERY_ENABLED = '1'
  VILLAGE_WINDOWS_WRITES_ENABLED = '1'
  HERMES_WORKER_COMMAND_MODE = 'python_module'
}
foreach ($name in $required.Keys) {
  if ([Environment]::GetEnvironmentVariable($name, 'Process') -ne $required[$name]) {
    throw "Unsafe runtime setting: $name"
  }
}
if ($env:VILLAGE_AI_URL -ne 'https://village-ai-six.vercel.app') {
  throw 'VILLAGE_AI_URL mismatch.'
}

$oldPid = [int]$record.Pid
$executable = [string]$record.ExecutablePath
$commandMarker = [string]$record.CommandMarker
$port = [int]$record.Port
$bridgeDirectory = Join-Path $repoRoot 'tools\kakao-dom-bridge'

if (-not $PSCmdlet.ShouldProcess("owned bridge PID $oldPid", 'Restart with verified no-send environment')) {
  return
}

Stop-OwnedProcess -Name 'bridge' -Confirm:$false | Out-Null
$newProcess = Start-Process -FilePath $executable -ArgumentList $commandMarker `
  -WorkingDirectory $bridgeDirectory -WindowStyle Hidden -PassThru

try {
  $deadline = [DateTime]::UtcNow.AddSeconds(20)
  $post = $null
  do {
    Start-Sleep -Milliseconds 250
    try {
      $post = Invoke-RestMethod -Uri 'http://127.0.0.1:8787/health' -TimeoutSec 2
    }
    catch {
      $post = $null
    }
  } while ($null -eq $post -and [DateTime]::UtcNow -lt $deadline -and -not $newProcess.HasExited)

  if ($null -eq $post) {
    throw 'Restarted bridge did not become healthy.'
  }
  if (-not $post.config.workerLive -or $post.config.autoSendEnabled -or
      $post.config.slackActionPollEnabled -or -not $post.config.slackCardDeliveryEnabled) {
    throw 'Restarted bridge safety/runtime settings mismatch.'
  }

  Write-OwnedProcessRecord -Name 'bridge' -Process $newProcess -ExecutablePath $executable `
    -CommandMarker $commandMarker -Port $port -WorkerEnabled $true

  [pscustomobject]@{
    OldPid = $oldPid
    NewPid = $newProcess.Id
    HealthOk = [bool]$post.ok
    WorkerLive = [bool]$post.config.workerLive
    AutoSend = [bool]$post.config.autoSendEnabled
    SlackDelivery = [bool]$post.config.slackCardDeliveryEnabled
    ActionPoll = [bool]$post.config.slackActionPollEnabled
    QueueLength = [int]$post.state.workerQueueLength
    ChromePort9223 = Test-NetConnection -ComputerName 127.0.0.1 -Port 9223 -InformationLevel Quiet
  }
}
catch {
  if (-not $newProcess.HasExited) {
    Stop-VerifiedProcess -Process $newProcess -ExecutablePath $executable `
      -CommandMarker $commandMarker -Confirm:$false | Out-Null
  }
  throw
}
