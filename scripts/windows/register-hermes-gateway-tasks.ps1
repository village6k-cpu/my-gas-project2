# register-hermes-gateway-tasks.ps1 — 게이트웨이 예약작업 2종을 등록한다 (멱등).
#
# 카카오 워커는 8787 bridge가 필요할 때 Hermes CLI를 실행한다. 플랫폼이 하나도 없는
# 옛 AppData kakaoworker gateway는 워커가 아니므로 비활성화한다.
# Village-Hermes-Gateway-Lineage-Watchdog은 30분마다 root Slack 게이트웨이의
# Redirection Guard 오염/사망 여부를 실측하고, 문제 있을 때만 자동 치유한다.
#    누가 에이전트 셸에서 raw `hermes gateway restart`를 쳐도 30분 안에 회복된다.
#
# 실행: powershell -ExecutionPolicy Bypass -File register-hermes-gateway-tasks.ps1

$ErrorActionPreference = 'Stop'

$WrapperPs1 = 'C:\Village\my-gas-project2\scripts\windows\restart-hermes-gateway.ps1'
$HiddenDir  = Join-Path $env:LOCALAPPDATA 'Village\hidden-tasks'
$WatchVbs   = Join-Path $HiddenDir 'Village-Hermes-Gateway-Lineage-Watchdog.vbs'
$PsExe      = 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe'

if (-not (Test-Path $WrapperPs1)) { throw "래퍼 스크립트가 없다: $WrapperPs1" }
if (-not (Test-Path $HiddenDir))  { New-Item -ItemType Directory -Path $HiddenDir -Force | Out-Null }

# --- 워치독 vbs (기존 hidden-tasks 패턴 그대로: 창 깜빡임 없음) ---------------
$vbsLine = 'CreateObject("WScript.Shell").Run """' + $PsExe + '"" -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File ""' + $WrapperPs1 + '"" -Target root -HealOnly", 0, False'
Set-Content -Path $WatchVbs -Value $vbsLine -Encoding ASCII
Write-Host "워치독 vbs 작성: $WatchVbs"

# --- 1) Hermes_Gateway_Kakaoworker (root의 Hermes_Gateway 작업 설정 미러링) ---
if (Get-ScheduledTask -TaskName 'Hermes_Gateway_Kakaoworker' -ErrorAction SilentlyContinue) {
    Disable-ScheduledTask -TaskName 'Hermes_Gateway_Kakaoworker' | Out-Null
    Write-Host "비활성화: Hermes_Gateway_Kakaoworker (실제 카카오 워커는 8787 bridge가 소유)"
}

# --- 2) 혈통 워치독: 30분 간격 ------------------------------------------------
$action2  = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument ('//B //Nologo "{0}"' -f $WatchVbs)
$trigger2 = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(5) `
    -RepetitionInterval (New-TimeSpan -Minutes 30) `
    -RepetitionDuration ([TimeSpan]::MaxValue)
$settings2 = New-ScheduledTaskSettingsSet `
    -MultipleInstances IgnoreNew `
    -StartWhenAvailable `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 15)
Register-ScheduledTask -TaskName 'Village-Hermes-Gateway-Lineage-Watchdog' `
    -Description 'Detect and heal the poisoned (RedirectionTrust) or dead root Hermes Slack gateway every 30 min' `
    -Action $action2 -Trigger $trigger2 -Settings $settings2 -Force | Out-Null
Write-Host "등록: Village-Hermes-Gateway-Lineage-Watchdog (30분 간격)"

Write-Host ""
Write-Host "완료. 재시작이 필요할 때는 어디서든:"
Write-Host "  powershell -ExecutionPolicy Bypass -File $WrapperPs1 -Target root"
