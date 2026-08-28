# restart-hermes-gateway.ps1 — 헤르메스 게이트웨이를 "항상 깨끗한 계보"로 재시작한다.
#
# 왜 필요한가 (2026-08-11 장애):
#   에이전트 셸(클로드/코덱스 하네스)에는 Redirection Guard 프로세스 완화 정책이 걸려 있고,
#   거기서 `hermes gateway restart`를 직접 치면 새 게이트웨이가 그 정책을 유전받는다.
#   유전된 게이트웨이는 skills 폴더의 정션(orca --global 설치가 생성)을 WinError 448로
#   통과하지 못해 village-operations 로드가 죽고, 헤이빌리가 빨간 물음표(clarify)만 쏘는
#   바보가 된다. 그록기(8/6~8/10) 게이트웨이는 깨끗한 계보(Enforce=0)라 같은 정션 위에서
#   17회 정상 로드했다 — 정션이 아니라 프로세스 혈통이 변수다.
#
# 해법: 정지는 어디서든 무해하므로 CLI로 정지하고, 시작은 반드시 Task Scheduler가
#   하게 한다(svchost 계보 = 항상 깨끗). 시작 액션은 hermes가 설치해 둔 정식
#   gateway-service vbs를 그대로 쓴다. 재시작 후 새 PID의 완화 정책을 실측해 검증한다.
#
# 사용:
#   restart-hermes-gateway.ps1                      # 실제 메시징 게이트웨이(root) 재시작
#   restart-hermes-gateway.ps1 -Target root         # 헤이빌리(슬랙) 게이트웨이만
#   restart-hermes-gateway.ps1 -Target kakaoworker  # 카카오 워커 게이트웨이만
#   restart-hermes-gateway.ps1 -HealOnly            # 워치독 모드: 오염/사망 시에만 조치, 건강하면 무음
#
# 어떤 셸에서 실행해도 안전하다. 에이전트 셸에서 불려도 결과는 항상 깨끗한 게이트웨이다.

[CmdletBinding()]
param(
    [ValidateSet('root', 'kakaoworker', 'all')]
    [string]$Target = 'all',
    [switch]$HealOnly
)

$ErrorActionPreference = 'Stop'
$HermesHome = Join-Path $env:LOCALAPPDATA 'hermes'
$AgentDir   = Join-Path $HermesHome 'hermes-agent'
$VenvPython = Join-Path $AgentDir 'venv\Scripts\python.exe'
$LogFile    = Join-Path $HermesHome 'logs\gateway-restart-wrapper.log'

function Write-Log {
    param([string]$Message)
    $line = '{0} [{1}] {2}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $PID, $Message
    try { Add-Content -Path $LogFile -Value $line -Encoding utf8 } catch {}
    Write-Host $line
}

# --- Redirection Guard(완화 정책) 실측 프로브 -------------------------------
if (-not ('VillageMit' -as [type])) {
    Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class VillageMit {
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern IntPtr OpenProcess(uint dwDesiredAccess, bool bInheritHandle, uint dwProcessId);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool GetProcessMitigationPolicy(IntPtr hProcess, int MitigationPolicy, ref uint lpBuffer, UIntPtr dwLength);
    [DllImport("kernel32.dll")]
    public static extern bool CloseHandle(IntPtr hObject);
    // 16 = ProcessRedirectionTrustPolicy. 반환: 0=깨끗, 1=오염(Enforce), -1=접근불가, -2=조회실패
    public static int RedirectionTrust(uint pid) {
        IntPtr h = OpenProcess(0x1000u, false, pid);
        if (h == IntPtr.Zero) return -1;
        uint flags = 0;
        bool ok = GetProcessMitigationPolicy(h, 16, ref flags, (UIntPtr)4);
        CloseHandle(h);
        if (!ok) return -2;
        return (int)(flags & 1u);
    }
}
"@
}

# --- 프로필 정의 ------------------------------------------------------------
$Profiles = @{
    'root' = @{
        Task     = 'Hermes_Gateway'
        PidFile  = Join-Path $HermesHome 'gateway.pid'
        StopArgs = @('-m', 'hermes_cli.main', 'gateway', 'stop')
        # 이 프로필 소속 gateway run 프로세스 판별 (잔존 수퍼바이저 청소용)
        Match    = { param($cmd) ($cmd -match 'hermes_cli\.main') -and ($cmd -match 'gateway') -and ($cmd -match '\brun\b') -and ($cmd -notmatch '--profile') }
    }
    'kakaoworker' = @{
        Task     = 'Hermes_Gateway_Kakaoworker_Native'
        PidFile  = Join-Path $HermesHome 'profiles\kakaoworker\gateway.pid'
        StopArgs = @('-m', 'hermes_cli.main', '--profile', 'kakaoworker', 'gateway', 'stop')
        Match    = { param($cmd) ($cmd -match 'hermes_cli\.main') -and ($cmd -match 'gateway') -and ($cmd -match '\brun\b') -and ($cmd -match '--profile\s+kakaoworker') }
    }
}

function Test-GatewayScheduledTaskReady {
    param([string]$TaskName)
    try {
        $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop
        return $null -ne $task -and [string]$task.State -ne 'Disabled'
    }
    catch { return $false }
}

function Get-GatewayPidFromFile {
    param([string]$PidFile)
    try {
        $j = Get-Content -Path $PidFile -Raw -ErrorAction Stop | ConvertFrom-Json
        return [uint32]$j.pid
    } catch { return [uint32]0 }
}

function Get-OfficialGatewayPid {
    param([string]$PidFile)

    $code = 'from pathlib import Path; from gateway.status import get_running_pid; import sys; pid=get_running_pid(Path(sys.argv[1]), cleanup_stale=False); print(pid or 0)'
    Push-Location $AgentDir
    try {
        $output = & $VenvPython -c $code $PidFile 2>$null | Select-Object -Last 1
        $officialPid = [uint32]0
        if ($LASTEXITCODE -eq 0 -and [uint32]::TryParse(([string]$output).Trim(), [ref]$officialPid)) {
            return $officialPid
        }
    }
    catch {}
    finally { Pop-Location }
    return [uint32]0
}

function Get-ProfileGatewayProcs {
    param(
        [scriptblock]$Match,
        [string]$PidFile
    )
    $result = @()
    $seen = @{}
    $procs = Get-CimInstance Win32_Process -Filter "Name='python.exe'" -ErrorAction SilentlyContinue
    foreach ($p in $procs) {
        $cmd = [string]$p.CommandLine
        if ($cmd -and (& $Match $cmd)) {
            $result += $p
            $seen[[uint32]$p.ProcessId] = $true
        }
    }

    # Some Windows process lineages deny Win32_Process.CommandLine even to the
    # watchdog account. In that case, delegate liveness to Hermes' own PID,
    # runtime-lock, and process-identity validator instead of false-restarting.
    $officialPid = Get-OfficialGatewayPid -PidFile $PidFile
    if ($officialPid -ne 0 -and -not $seen.ContainsKey($officialPid)) {
        $official = Get-CimInstance Win32_Process -Filter ("ProcessId=" + $officialPid) -ErrorAction SilentlyContinue
        if ($null -ne $official) {
            $result += $official
        }
        elseif ($null -ne (Get-Process -Id $officialPid -ErrorAction SilentlyContinue)) {
            $result += [pscustomobject]@{ ProcessId = $officialPid; CommandLine = $null }
        }
    }
    return $result
}

function Invoke-OneRestart {
    param([string]$Name, [switch]$HealMode)
    $info  = $Profiles[$Name]
    # Never stop a healthy gateway until its clean-lineage start task is
    # proven present and enabled. A retired/no-op task previously turned an
    # otherwise recoverable Kakao restart into a full worker outage.
    if (-not (Test-GatewayScheduledTaskReady -TaskName $info.Task)) {
        Write-Log ("{0}: FAIL - 예약작업 {1} 없음 또는 비활성; 실행 중 게이트웨이는 보존" -f $Name, $info.Task)
        return $false
    }
    $procs = @(Get-ProfileGatewayProcs -Match $info.Match -PidFile $info.PidFile)
    $poisoned = @($procs | Where-Object { [VillageMit]::RedirectionTrust([uint32]$_.ProcessId) -eq 1 })

    if ($HealMode) {
        if ($procs.Count -gt 0 -and $poisoned.Count -eq 0) { return $true }  # 건강: 무음 종료
        Write-Log ("HEAL {0}: 실행중={1} 오염={2} -> 조치 시작" -f $Name, $procs.Count, $poisoned.Count)
    }

    $oldPid = Get-GatewayPidFromFile -PidFile $info.PidFile

    # 1) 정지 (프로세스가 있을 때만). 정지는 새 프로세스를 만들지 않으므로 어느 계보에서든 무해.
    if ($procs.Count -gt 0) {
        Write-Log ("{0}: 정지 요청 (pidfile={1}, 실행중 {2}개, 오염 {3}개)" -f $Name, $oldPid, $procs.Count, $poisoned.Count)
        Push-Location $AgentDir
        try {
            $out = & $VenvPython @($info.StopArgs) 2>$null | Out-String
            Write-Log ("{0}: gateway stop exit={1} {2}" -f $Name, $LASTEXITCODE, $out.Trim())
        } finally { Pop-Location }

        $deadline = (Get-Date).AddSeconds(210)   # restart_drain_timeout 180s + 여유
        while ((Get-Date) -lt $deadline) {
            $procs = @(Get-ProfileGatewayProcs -Match $info.Match -PidFile $info.PidFile)
            if ($procs.Count -eq 0) { break }
            Start-Sleep -Seconds 3
        }
        # graceful 실패분 강제 정리 (수퍼바이저 쌍 포함)
        $procs = @(Get-ProfileGatewayProcs -Match $info.Match -PidFile $info.PidFile)
        foreach ($p in $procs) {
            Write-Log ("{0}: 강제 종료 pid={1}" -f $Name, $p.ProcessId)
            Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
        }
        if ($procs.Count -gt 0) { Start-Sleep -Seconds 2 }
    } else {
        Write-Log ("{0}: 실행 중인 게이트웨이 없음 -> 시작만 수행" -f $Name)
    }

    # 2) Task Scheduler 경유 시작 — 항상 깨끗한 계보
    schtasks /Run /TN $info.Task | Out-Null
    if ($LASTEXITCODE -ne 0) {
        Write-Log ("{0}: FAIL - schtasks /Run /TN {1} 실패 (exit={2})" -f $Name, $info.Task, $LASTEXITCODE)
        return $false
    }
    Write-Log ("{0}: 예약작업 {1} 트리거됨, 기동 대기" -f $Name, $info.Task)

    # 3) 새 게이트웨이 대기 + 검증
    $deadline = (Get-Date).AddSeconds(120)
    $newPid = [uint32]0
    while ((Get-Date) -lt $deadline) {
        Start-Sleep -Seconds 3
        $candidate = Get-GatewayPidFromFile -PidFile $info.PidFile
        if ($candidate -ne 0 -and $candidate -ne $oldPid) {
            $alive = Get-Process -Id $candidate -ErrorAction SilentlyContinue
            if ($null -ne $alive) { $newPid = $candidate; break }
        }
    }
    if ($newPid -eq 0) {
        Write-Log ("{0}: FAIL - 새 게이트웨이가 120초 내에 뜨지 않음" -f $Name)
        return $false
    }
    Start-Sleep -Seconds 3   # 안착 대기 후 생존 재확인
    if ($null -eq (Get-Process -Id $newPid -ErrorAction SilentlyContinue)) {
        Write-Log ("{0}: FAIL - 새 게이트웨이 pid={1}가 기동 직후 사망" -f $Name, $newPid)
        return $false
    }
    $mit = [VillageMit]::RedirectionTrust($newPid)
    Write-Log ("{0}: 재시작 완료 pid={1} EnforceRedirectionTrust={2}" -f $Name, $newPid, $mit)
    if ($mit -ne 0) {
        Write-Log ("{0}: 경고! 새 게이트웨이가 여전히 오염 상태 - Task Scheduler 경유가 아닌 경로로 시작됐는지 확인 필요" -f $Name)
        return $false
    }
    return $true
}

# --- 실행 -------------------------------------------------------------------
$targets = @()
if ($Target -eq 'all') { $targets = @('root') } else { $targets = @($Target) }

$ok = $true
foreach ($t in $targets) {
    if (-not (Invoke-OneRestart -Name $t -HealMode:$HealOnly)) { $ok = $false }
}
if ($ok) { exit 0 } else { exit 1 }
