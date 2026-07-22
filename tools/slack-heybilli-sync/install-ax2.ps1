[CmdletBinding()]
param(
  [ValidateSet('DryRun', 'Live')]
  [string]$Mode = 'DryRun',
  [string]$RepoRoot = 'C:\Village\my-gas-project2',
  [string]$BackfillCutoffTs = '',
  [switch]$RegisterCron
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

if ($env:COMPUTERNAME -ne 'AX2') {
  throw "이 설치기는 AX2에서만 실행할 수 있습니다. 현재: $($env:COMPUTERNAME)"
}

$repo = (Resolve-Path -LiteralPath $RepoRoot).Path
$source = Join-Path $repo 'tools\slack-heybilli-sync'
$worker = Join-Path $source 'slack-heybilli-sync.mjs'
if (-not (Test-Path -LiteralPath $worker -PathType Leaf)) {
  throw "동기화 worker가 없습니다: $worker"
}
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'node가 PATH에 없습니다' }
if (-not (Get-Command hermes -ErrorAction SilentlyContinue)) { throw 'hermes가 PATH에 없습니다' }

$hermesHome = Join-Path $env:USERPROFILE '.hermes'
$scriptsDir = Join-Path $hermesHome 'scripts'
$skillDir = Join-Path $hermesHome 'skills\slack-heybilli-sync'
New-Item -ItemType Directory -Force -Path $scriptsDir, $skillDir | Out-Null

Copy-Item -LiteralPath (Join-Path $source 'hermes-cron-runner.py') -Destination (Join-Path $scriptsDir 'slack_heybilli_sync.py') -Force
Copy-Item -LiteralPath (Join-Path $source 'slack-image-ocr.py') -Destination (Join-Path $scriptsDir 'slack_image_ocr.py') -Force

$repoSkill = Join-Path $source 'SKILL.md'
if (Test-Path -LiteralPath $repoSkill -PathType Leaf) {
  Copy-Item -LiteralPath $repoSkill -Destination (Join-Path $skillDir 'SKILL.md') -Force
}
if (-not (Test-Path -LiteralPath (Join-Path $skillDir 'SKILL.md') -PathType Leaf)) {
  throw 'slack-heybilli-sync SKILL.md가 없습니다. 번들의 skill을 먼저 설치하세요.'
}

$mainEnv = Join-Path $hermesHome '.env'
if (-not (Test-Path -LiteralPath $mainEnv -PathType Leaf)) { throw 'Hermes .env가 없습니다' }
$hasSlackToken = Select-String -LiteralPath $mainEnv -Pattern '^\s*(?:export\s+)?SLACK_BOT_TOKEN\s*=' -Quiet
if (-not $hasSlackToken) { throw 'Hermes .env에 SLACK_BOT_TOKEN 키가 없습니다' }

function Set-DotEnvValue {
  param([string]$Path, [string]$Key, [string]$Value)
  $lines = [System.Collections.Generic.List[string]]::new()
  if (Test-Path -LiteralPath $Path) {
    Get-Content -LiteralPath $Path | ForEach-Object { [void]$lines.Add([string]$_) }
  }
  $pattern = '^\s*(?:export\s+)?' + [regex]::Escape($Key) + '\s*='
  $updated = $false
  for ($index = 0; $index -lt $lines.Count; $index++) {
    if ($lines[$index] -match $pattern) {
      $lines[$index] = "$Key=$Value"
      $updated = $true
      break
    }
  }
  if (-not $updated) { $lines.Add("$Key=$Value") }
  [System.IO.File]::WriteAllLines($Path, $lines, [System.Text.UTF8Encoding]::new($false))
}

$syncEnv = Join-Path $hermesHome 'slack-heybilli.env'
Set-DotEnvValue $syncEnv 'SLACK_HEYBILLI_API_URL' 'https://today-dashboard-ten.vercel.app/api/internal/slack-ops'
Set-DotEnvValue $syncEnv 'SLACK_HEYBILLI_CHANNEL_ID' 'C0B6ZJZ2XU3'
Set-DotEnvValue $syncEnv 'SLACK_HEYBILLI_LOOKBACK_HOURS' '72'
Set-DotEnvValue $syncEnv 'SLACK_HEYBILLI_MAX_MESSAGES' '300'
if ($BackfillCutoffTs) { Set-DotEnvValue $syncEnv 'SLACK_HEYBILLI_BACKFILL_CUTOFF_TS' $BackfillCutoffTs }
Set-DotEnvValue $syncEnv 'SLACK_HEYBILLI_WRITE_ENABLED' $(if ($Mode -eq 'Live') { '1' } else { '0' })
Set-DotEnvValue $syncEnv 'SLACK_HEYBILLI_OCR_BIN' (Join-Path $scriptsDir 'slack_image_ocr.py')

$env:AI_WORKER_LIVE = '0'
$env:AI_WORKER_AUTO_SEND = '0'
$env:SLACK_HEYBILLI_REPO_ROOT = $repo

if ($RegisterCron) {
  $jobsPath = Join-Path $hermesHome 'cron\jobs.json'
  $existing = $null
  if (Test-Path -LiteralPath $jobsPath -PathType Leaf) {
    $store = Get-Content -LiteralPath $jobsPath -Raw | ConvertFrom-Json
    $jobs = if ($store.jobs) { @($store.jobs) } else { @($store) }
    $existing = @($jobs | Where-Object { $_.name -eq 'Slack 단톡방 → 헤이빌리 직접 동기화' })
    if ($existing.Count -gt 1) { throw '동일 이름의 cron이 여러 개라 등록을 차단했습니다' }
    if ($existing.Count -eq 1) { $existing = $existing[0] } else { $existing = $null }
  }
  if ($existing) {
    & hermes cron edit $existing.id --schedule '*/10 * * * *' --script 'slack_heybilli_sync.py' --no-agent --workdir $repo --deliver local | Out-Host
    if ($LASTEXITCODE -ne 0) { throw '기존 AX2 cron 갱신 실패' }
  } else {
    & hermes cron create '*/10 * * * *' --name 'Slack 단톡방 → 헤이빌리 직접 동기화' --deliver local --script 'slack_heybilli_sync.py' --no-agent --workdir $repo | Out-Host
    if ($LASTEXITCODE -ne 0) { throw 'AX2 cron 등록 실패' }
  }
  $store = Get-Content -LiteralPath $jobsPath -Raw | ConvertFrom-Json
  $installedJobs = @($store.jobs | Where-Object { $_.name -eq 'Slack 단톡방 → 헤이빌리 직접 동기화' })
  if ($installedJobs.Count -ne 1) { throw '등록 후 AX2 cron을 하나로 확정하지 못했습니다' }
  if (-not $installedJobs[0].enabled -or $installedJobs[0].state -eq 'paused') {
    & hermes cron resume $installedJobs[0].id | Out-Host
    if ($LASTEXITCODE -ne 0) { throw 'AX2 cron 활성화 실패' }
  }
}

[pscustomobject]@{
  host = $env:COMPUTERNAME
  mode = $Mode
  repo = $repo
  runnerInstalled = Test-Path -LiteralPath (Join-Path $scriptsDir 'slack_heybilli_sync.py')
  skillInstalled = Test-Path -LiteralPath (Join-Path $skillDir 'SKILL.md')
  slackTokenKeyPresent = [bool]$hasSlackToken
  cronRequested = [bool]$RegisterCron
  generalWorkerLive = $env:AI_WORKER_LIVE
  generalWorkerAutoSend = $env:AI_WORKER_AUTO_SEND
} | ConvertTo-Json
