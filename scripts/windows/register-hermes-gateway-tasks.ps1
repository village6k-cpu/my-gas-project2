# register-hermes-gateway-tasks.ps1 — 게이트웨이 예약작업 2종을 등록한다 (멱등).
#
# 1) Hermes_Gateway_Kakaoworker — 카카오워커 게이트웨이 정식 시작 작업.
#    hermes가 만들어둔 gateway-service vbs를 그대로 실행. 로그온 자동시작 포함
#    (root용 Hermes_Gateway 작업과 대칭 — 지금까지 kakaoworker는 작업이 없어 수동 시작이었다).
# 2) Village-Hermes-Gateway-Lineage-Watchdog — 30분마다 두 게이트웨이의
#    Redirection Guard 오염/사망 여부를 실측, 문제 있을 때만 자동 치유.
#    누가 에이전트 셸에서 raw `hermes gateway restart`를 쳐도 30분 안에 회복된다.
#
# 실행: powershell -ExecutionPolicy Bypass -File register-hermes-gateway-tasks.ps1

$ErrorActionPreference = 'Stop'

$KakaoVbs   = Join-Path $env:LOCALAPPDATA 'hermes\profiles\kakaoworker\gateway-service\Hermes_Gateway_kakaoworker.vbs'
$WrapperPs1 = 'C:\Village\my-gas-project2\scripts\windows\restart-hermes-gateway.ps1'
$HiddenDir  = Join-Path $env:LOCALAPPDATA 'Village\hidden-tasks'
$WatchVbs   = Join-Path $HiddenDir 'Village-Hermes-Gateway-Lineage-Watchdog.vbs'
$PsExe      = 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe'

if (-not (Test-Path $KakaoVbs))   { throw "kakaoworker gateway-service vbs가 없다: $KakaoVbs" }
if (-not (Test-Path $WrapperPs1)) { throw "래퍼 스크립트가 없다: $WrapperPs1" }
if (-not (Test-Path $HiddenDir))  { New-Item -ItemType Directory -Path $HiddenDir -Force | Out-Null }

# --- 워치독 vbs (기존 hidden-tasks 패턴 그대로: 창 깜빡임 없음) ---------------
$vbsLine = 'CreateObject("WScript.Shell").Run """' + $PsExe + '"" -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File ""' + $WrapperPs1 + '"" -Target all -HealOnly", 0, False'
Set-Content -Path $WatchVbs -Value $vbsLine -Encoding ASCII
Write-Host "워치독 vbs 작성: $WatchVbs"

# --- 1) Hermes_Gateway_Kakaoworker (root의 Hermes_Gateway 작업 설정 미러링) ---
$action1  = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument ('//B //Nologo "{0}"' -f $KakaoVbs)
$trigger1 = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERNAME"
$trigger1.Delay = 'PT45S'   # root(PT30S)와 시차를 둬 기동 겹침 방지
$settings1 = New-ScheduledTaskSettingsSet `
    -MultipleInstances IgnoreNew `
    -StartWhenAvailable `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -RestartCount 999 `
    -RestartInterval (New-TimeSpan -Minutes 1)
Register-ScheduledTask -TaskName 'Hermes_Gateway_Kakaoworker' `
    -Description 'Hermes Agent Gateway (kakaoworker profile) - clean-lineage start via Task Scheduler' `
    -Action $action1 -Trigger $trigger1 -Settings $settings1 -Force | Out-Null
Write-Host "등록: Hermes_Gateway_Kakaoworker (로그온 자동시작 + 온디맨드)"

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
    -Description 'Detect and heal poisoned (RedirectionTrust) or dead Hermes gateways every 30 min' `
    -Action $action2 -Trigger $trigger2 -Settings $settings2 -Force | Out-Null
Write-Host "등록: Village-Hermes-Gateway-Lineage-Watchdog (30분 간격)"

Write-Host ""
Write-Host "완료. 재시작이 필요할 때는 어디서든:"
Write-Host "  powershell -ExecutionPolicy Bypass -File $WrapperPs1 -Target all"
