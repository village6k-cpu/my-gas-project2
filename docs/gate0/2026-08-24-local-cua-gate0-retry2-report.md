# Gate 0 local CUA retry 2

## 판정

최종 판정은 **BLOCKED**다. `command_failed`의 실제 원인은 분리했고 러너의 오분류도
수정했다. 그러나 현재 터미널 `codex exec` 런타임에는 Desktop CUA에 필요한
`node_repl`/Computer Use 도구가 제공되지 않는다. 따라서 이 CLI를 그대로 Slack 로컬-CUA
직원으로 쓰는 경로는 진행하지 않는다.

## 근본 원인과 수정

- 동일한 pinned Codex에서 무도구 요청은 정상 종료했지만, 제공된 도구 목록에
  `node_repl`과 Computer Use 도구가 모두 없었다. 기존 CUA 프롬프트는 셸 대체 실행을
  시도한 뒤 시간초과됐다.
- 터미널 러너는 시간초과 TERM으로 발생한 `close` 이벤트를 일반 비정상 종료로 먼저 처리해
  `command_failed`로 오분류했다. 시간초과가 시작된 뒤의 `close`는 timeout 정리 경로만
  완료하도록 수정했다.
- CUA 프롬프트는 `node_repl` 부재 시 셸/command fallback을 금지하고 두 capability를
  `false`로 즉시 반환하도록 fail-closed 처리했다.
- restricted 러너는 Node `execFile` 시간초과를 숫자 종료코드 1로 뭉개지 않고
  `BLOCKED/timeout`으로 보존한다. Codex의 실제 JSONL 이벤트 스트림에서 정확히 한 개의
  지정 agent result만 허용하도록 파서를 수정했다.
- restricted 결과는 여전히 모델 생성 레코드일 뿐 기계적 권한 경계 증명이 아니므로 PASS로
  승격하지 않았다.

## 안전 재시험 결과

| 기준 | 결과 | redacted evidence |
|---|---|---|
| `terminal_cua` | FAIL | `not_available:capability_unavailable` / `71b2c98a40f6e3d5` |
| `restricted_profile` | BLOCKED | `timeout` / `2123d74469188d78` |
| 전체 Gate 0 단위 테스트 | PASS | 54 passed, 0 failed / `9c2e7a51d4b8063f` |

전체 9개 계약 스냅샷은
`2026-08-24-local-cua-gate0-retry2-evidence.json`에 있다. 이번 retry에서는 위 두 런타임
probe만 재실행했고, LaunchAgent·orphan·인증·resume·lease는 재실행하지 않았다. 과거
retry1 파일과 타임스탬프는 덮어쓰지 않았다.

## 안전 경계 확인

- 과거 잔존 LaunchAgent 라벨, PID, PGID는 조회·지정·제거·signal하지 않았다.
- 새 LaunchAgent, orphan child, 로그인 화면, 권한 프롬프트를 만들거나 열지 않았다.
- 재시험 payload는 클릭·입력·제출·셸 fallback을 금지했고 결과에는 고정 불리언/enum만
  남겼다.
- subprocess 원문, AX tree, screenshot, 페이지 텍스트, 자격증명, 고객정보를 저장하지 않았다.
- HomeTax·Slack·GAS·Sheets·세금 발행/수정/취소 작업은 수행하지 않았다.

## 다음 조치

Gate 1은 터미널 `codex exec`에 없는 CUA를 억지로 활성화하는 작업이 아니다. 다음 vertical
slice는 **Codex Desktop이 가진 CUA를 호출할 수 있는 로컬 직원 브리지** 또는 **명시적으로
허용한 최소 CUA 동작만 제공하는 로컬 helper/MCP** 중 실제 호출 가능한 경로를 확인하는
것이다. 먼저 Slack 없이 로컬에서 `요청 1건 → Desktop CUA 작업 생성 → 결과 반환`만
검증하고, 성공한 뒤 Slack 직원 identity를 붙인다.

## 셀프 리뷰 결과

- ✅ 통과 항목: root-cause 재현, timeout 오분류 회귀, strict JSONL, redaction, 전체 54개
  테스트, 보수적 BLOCKED 판정을 확인했다.
- 🔧 자체 수정한 항목: 셸 fallback 금지, timeout-close 경합, ETIMEDOUT 분류, restricted
  JSONL 파서를 수정했다.
- ⚠️ 사용자 확인 필요: 없음. 다음 구현은 권한 확대가 아니라 로컬 Desktop-CUA 호출 경로의
  최소 vertical slice다.
