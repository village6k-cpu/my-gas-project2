# Gate 0 local CUA retry 1

## 판정

최종 판정은 **BLOCKED**다. 데스크톱 Codex 앱에서는 Chrome 접근성·스크린샷 기능이
확인됐지만, unattended 실행에 필요한 terminal, LaunchAgent, restricted profile, orphan
복구가 승인 기준을 충족하지 못했다. Slack 로컬-CUA 직원 구현으로 넘어가지 않는다.

## 실행 순서와 결과

| 순서 | 기준 | 결과 | redacted evidence |
|---:|---|---|---|
| 1 | Desktop baseline | PASS | `2026-08-24-local-cua-gate0-retry1-desktop-preflight.json` / `5a9dd8070a7cea62` |
| 2 | `terminal_cua` | BLOCKED | `command_failed` / `52df94fc4b8dd747` |
| 3 | `launchagent_cua` | BLOCKED | `timeout:bounded_wait` / `5920a82ffd319df4` |
| 4 | `human_auth_boundary` | NOT_RUN | HomeTax 로그인 화면을 열지 않음 / `ce4bc54d4bdcc903` |
| 5 | `restricted_profile` | BLOCKED | `command_failed` / `8e6e179bba39f25b` |
| 6 | `human_resume` | NOT_RUN | 실제 2단계 중단·재개 미구현 / `08b914edecd3d5c4` |
| 7 | `orphan_recovery` | BLOCKED | `identity_mismatch:cleanup_attempted` / `b103849fcdde26b6` |

전체 9개 계약 레코드는
`2026-08-24-local-cua-gate0-retry1-evidence.json`에 있다. `typed_evidence`만 PASS,
`single_instance_lease`는 NOT_RUN이다. 기존 잔존 LaunchAgent의 현재 소유권·상태를 안전하게
증명할 수 없어 `launchagent_security`는 `BLOCKED/residual_label_unavailable`로 유지했다.

## 안전 경계 확인

- 이번 LaunchAgent는 새 UUID 라벨만 생성했다. 결과가 cleanup override가 아닌
  `launchagent_probe_timeout`으로 반환됐으므로 그 새 라벨의 exact bootout 확인과 자기 임시
  디렉터리 제거 경로를 통과했다.
- 과거 잔존 라벨, PID, PGID는 조회·지정·제거·signal하지 않았다.
- orphan probe는 이번 실행이 만든 disposable child만 사용했다. 정확한 프로세스 그룹 부재를
  증명하지 못해 PASS로 올리지 않았고, 별도 수동 signal을 보내지 않았다.
- TCC, Accessibility, Screen Recording, Keychain 등 권한 프롬프트를 승인하지 않았다.
- HomeTax 페이지·로그인·자격증명·Chrome autofill을 열거나 읽지 않았다.
- 화면 텍스트, AX tree, screenshot, subprocess 원문, 고객정보를 저장하지 않았다.
- 세금 발행·수정·취소, Slack 전송, GAS·Sheets 변경, 지속 LaunchAgent 설치는 없었다.

## 다음 조치

`terminal_cua`와 restricted normal invocation이 `command_failed`가 되는 실제 런타임 원인을
redacted 진단으로 분리해 고친 뒤 다시 Gate 0를 실행해야 한다. 그 전에는 권한을 넓히거나
과거 잔존 라벨을 수동 정리하지 않는다.

## 셀프 리뷰 결과

- ✅ 통과 항목: 지정된 live 순서를 준수했고, 9개 레코드 strict serialization과 보수적
  BLOCKED 판정을 확인했다.
- ✅ 통과 항목: 새 LaunchAgent 자기 정리 외의 라벨·프로세스·권한·HomeTax·Slack·GAS·Sheets를
  건드리지 않았다.
- 🔧 자체 수정한 항목: 재시험 전 `launchagent_cua` 실패 기준 매핑과 identity/spawn 예외 누출을
  수정하고 회귀 테스트를 49개로 늘렸다.
- ⚠️ 사용자 확인 필요: 없음. 다음 단계는 권한 추가가 아니라 `command_failed` 원인 진단이다.
