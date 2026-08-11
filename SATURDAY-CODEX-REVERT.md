# 토요일(2026-08-08) Codex 원복 절차

Codex(GPT) 사용 한도가 토요일에 복구되면, 임시로 그록(Grok)으로 돌려놓은 헤르메스를
다시 Codex로 되돌리는 절차다. 사장님이 "SATURDAY-CODEX-REVERT.md 실행해줘"라고 하면
아래를 순서대로 그대로 수행한다. (2026-08-06 그록 전환 작업의 정확한 역순)

## 배경 (무엇이 임시로 바뀌어 있나)

> **2026-08-11 갱신**: 사장님 승인으로 커밋된 기본값이 **root = sol / max**, **kakaoworker = sol / xhigh**로
> 확정됐다. 아래 표와 절차의 목표값도 그 기준이다 (terra/high는 8/8 당시의 옛 기본값).

| 항목 | 지금(그록, 임시) | 원복 목표(Codex, 2026-08-11 확정 기본값) |
|---|---|---|
| 모델 계약 root | xai-oauth / grok-4.5 / max (8/6 오후 사장님 지시) | openai-codex / gpt-5.6-sol / max |
| 모델 계약 kakaoworker | xai-oauth / grok-4.5 / max / 90 (8/6 오후 사장님 지시) | (provider 없음) gpt-5.6-sol / xhigh / 90 |
| `%LOCALAPPDATA%\hermes\config.yaml` (루트 게이트웨이) | grok-4.3 / xai-oauth | gpt-5.6-sol / openai-codex / max |
| `%LOCALAPPDATA%\hermes\profiles\kakaoworker\config.yaml` | grok-4.3 / xai-oauth / xhigh / 90 | gpt-5.6-sol / openai-codex / xhigh / 90 |
| `C:\Village\MacMiniMirror\restored\.hermes\profiles\kakaoworker\config.yaml` (카카오 워커가 실제 사용) | grok-4.3 / xai-oauth / base_url '' / xhigh | gpt-5.6-sol / openai-codex / base_url `https://chatgpt.com/backend-api/codex` / xhigh |

계약 파일 수정분은 **커밋 안 된 로컬 변경**이라 git checkout으로 되돌아간다.
config.yaml 3개는 git 밖 파일이라 직접 수정/복원한다.
원본 백업: `C:\Village\backups\2026-08-06\hermes-config\` (특히 `macmirror-kakaoworker-config.yaml`).

## ① 계약 파일 원복 (커밋된 기본값 = Codex)

```bash
git -C C:/Village/my-gas-project2 checkout -- scripts/windows/hermes-model-contract.json
git -C C:/Village/my-gas-project2-worktrees/ax2-hermes-final checkout -- scripts/windows/hermes-model-contract.json
```

두 파일 모두 root=openai-codex/gpt-5.6-sol/max, kakaoworker=gpt-5.6-sol/xhigh/90 인지 확인.

## ② 라우팅 재적용 + 프로필 정합 (Codex 값으로)

1. 라우팅 스크립트 실행 (루트 config.yaml에 계약 root 값을 적용):
   ```bash
   python C:/Village/my-gas-project2-worktrees/ax2-hermes-final/scripts/windows/configure-hermes-village-routing.py --config "$LOCALAPPDATA/hermes/config.yaml"
   ```
   출력 JSON이 `"model": "gpt-5.6-sol", "provider": "openai-codex"` 인지 확인.

2. `%LOCALAPPDATA%\hermes\profiles\kakaoworker\config.yaml` 을 계약 kakaoworker 값으로:
   ```yaml
   model:
     default: gpt-5.6-sol
     provider: openai-codex
   agent:
     reasoning_effort: xhigh
     max_turns: 90
   ```

3. `C:\Village\MacMiniMirror\restored\.hermes\profiles\kakaoworker\config.yaml` 원복 —
   **⚠️ 백업본 통째 덮어쓰기 금지.** 백업본은 2026-07-23자라서 그 뒤에 올린 운영값까지
   과거로 되돌린다 (2026-08-10 실제 사고: memory_char_limit 6000→2200으로 잘림).
   model 블록의 `default`/`provider`/`base_url`과 `agent.reasoning_effort` **키만** 수동 수정:
   ```yaml
   model:
     default: gpt-5.6-sol
     provider: openai-codex
     base_url: https://chatgpt.com/backend-api/codex
   agent:
     reasoning_effort: xhigh   # 사장님 지시 있으면 그 값
   ```
   (max_turns 등 나머지 값은 절대 건드리지 않는다.)
   (백업본이 없으면 model 블록의 default를 gpt-5.6-sol, provider를 openai-codex,
   base_url을 `https://chatgpt.com/backend-api/codex`로, agent.reasoning_effort를 high로 수동 수정.
   max_turns 90 유지.)

## ③ 게이트웨이 재시작 + 카카오 재시작

**⚠️ 에이전트 셸(클로드/코덱스)에서 raw `hermes gateway restart` 금지.** 에이전트 셸의
Redirection Guard 완화 정책이 새 게이트웨이에 유전돼 skills 정션 통과가 448로 죽고
village-operations 로드가 실패한다 (2026-08-11 장애 실측). 반드시 래퍼 경유:

```powershell
powershell -ExecutionPolicy Bypass -File C:\Village\my-gas-project2\scripts\windows\restart-hermes-gateway.ps1 -Target all
```

(정지 후 예약작업 `Hermes_Gateway` / `Hermes_Gateway_Kakaoworker`로 재점화 — 항상 깨끗한
계보로 태어나고, 새 PID의 오염도를 실측 검증한다. 어떤 셸에서 실행해도 안전.)

카카오 프로덕션 재시작 (PowerShell에서):
```powershell
cd C:\Village\my-gas-project2-worktrees\ax2-hermes-final\scripts\windows
.\restart-kakao-staging.ps1 -EnvFile "$env:LOCALAPPDATA\hermes\profiles\kakaoworker\.env.windows-production" -ChromePath 'C:\Users\ssper\AppData\Local\ms-playwright\chromium-1228\chrome-win64\chrome.exe' -NodePath 'C:\Users\ssper\AppData\Local\Microsoft\WinGet\Packages\OpenJS.NodeJS.LTS_Microsoft.Winget.Source_8wekyb3d8bbwe\node-v24.18.0-win-x64\node.exe' -EnableWrites
```

## ④ 확인

1. `hermes -z "핑 테스트. OK만 답해"` → Codex 모델로 응답하는지 (`hermes status`에서 Model: gpt-5.6-sol 확인).
2. `http://127.0.0.1:8787/health` → `ok:true`, `workerLive:true`, `autoSendEnabled:false`.
3. `hermes cron list` → `Slack 단톡방 → 헤이빌리 직접 동기화` active + 최근 실행 ok.
4. 슬랙 #후속업무 채널에서 사장님이 헤이빌리 멘션으로 간단한 질문 1건.

## 참고 (이번 전환 때의 기타 상태 — 토요일에 건드릴 필요 없음)

- 카카오 프로덕션 env: `%LOCALAPPDATA%\hermes\profiles\kakaoworker\.env.windows-production`
  (AI_WORKER_AUTO_SEND=1 — 2026-08-06 저녁 사장님 승인으로 자동응대 활성화됨. 토요일 원복과 무관하게 유지.)
- 상시가동 태스크: `Village-Kakao-Production-Start` / `-Watchdog` (ENABLED 유지)
- 옛 자동시작 `Village-Kakao-Live-Start`는 비활성화해둠 (재활성 금지 — 프로덕션 태스크와 충돌)
- rescue 브랜치(2026-08-06 작업분 보존): `rescue/2026-08-06-my-gas-project2`,
  `rescue/2026-08-06-ax2-hermes-final` — 삭제 금지
