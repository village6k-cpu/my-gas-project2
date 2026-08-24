# Gate 3A — 별도 Slack 직원 커넥터 결과 보고서

## 판정

- 구현·오프라인 검증: **PASS**
- 실제 Slack 앱 생성·설치·첫 회신: **NOT_RUN**
- 실제 Slack 메시지 발송: **0건**
- HomeTax 접속·로그인·조회·발급·수정: **0건**

Gate 3A는 기존 Hermes/헤이빌리와 분리된 `빌리지 세무·서류 담당` 앱이 이 Mac의 고정
읽기 전용 CUA 준비 상태를 확인할 수 있는 최소 커넥터까지 구현했다. 외부 상태를 바꾸는 Slack 앱
설치와 첫 테스트 메시지는 다음 승인 단계로 남겼다.

## 구현 결과

- 공식 Bolt Socket Mode를 사용하는 독립 실행 프로세스
- 새 앱 전용 `LOCAL_CUA_*` 설정만 허용하고 기존 Slack/Hermes 변수 fallback 금지
- `auth.test` 정체성 확인 후에만 Bolt 초기화, `app_mention` 등록, Socket Mode 시작
- 고정 team/channel/app/bot/사용자와 정확한 `상태 확인` 명령만 허용
- Gate 2의 live source 전용 진입점, 내구 원장, 원자적 claim, 중복 억제 사용
- 동일 Slack 스레드에 결정적 `client_msg_id`로 고정 결과를 한 번만 회신
- 방금 게시한 `ts`를 지정해 같은 bot/text/ts/thread를 다시 읽은 경우만 전달 완료
- 전용 `.../village-local-cua-clerk/ledger` leaf만 허용하고 기존 넓은 경로 권한은 변경하지 않음
- Slack 원문, 사용자 프로필, 토큰, 원시 오류를 원장·결과·로그에 보존하지 않음

## 검증 증거

| 검증 | 결과 |
|---|---|
| Gate 3 단위 테스트 | 20/20 PASS |
| Gate 0~3 전체 회귀 | 113/113 PASS |
| 실행 파일 구문 검사 | PASS |
| `git diff --check` | PASS |
| 잠긴 의존성 감사 | 취약점 0 |
| 토큰 패턴 검사 | 정규식·명시적 테스트 값·교체용 예시만 존재 |
| 독립 재리뷰 | CLEAN, P0/P1/P2 신규 finding 없음 |

독립 리뷰의 최초 지적 네 건은 모두 회귀 테스트와 함께 닫았다.

1. Bolt가 명시적 정체성 검사보다 먼저 인증하지 않도록 `deferInitialization`과 초기화 순서를 고정했다.
2. 답글이 많은 스레드에서도 새 회신을 찾도록 게시된 `ts`를 지정해 exact readback한다.
3. 임의의 넓은 원장 경로와 기존 비공개가 아닌 디렉터리를 권한 변경 없이 거부한다.
4. 잠긴 런타임 의존성과 맞춰 Node 최소 버전을 `20.18.1`로 올렸다.

## 외부 상태 확인과 변경 경계

2026-08-25 읽기 전용 확인에서 빌리지 워크스페이스의 `#agent-서류발송` 채널이 활성 상태임을
확인했다. 기존 헤이빌리가 사용하는 채널이므로 새 직원은 별도 앱·토큰·봇 ID로 설치해야 한다.
이번 Gate에서는 Slack 앱 생성, 설치, 채널 초대, 토큰 발급, 메시지 발송을 수행하지 않았다.

## 다음 단계

사용자 승인 후 새 Slack 앱을 manifest로 생성·설치하고 `#agent-서류발송`에 초대한 다음,
소유자 한 명이 `@세무·서류 담당 상태 확인`을 한 번 보내 동일 스레드의 검증된 회신까지 확인한다.
그 전에는 상시 실행 등록이나 HomeTax 업무 액션을 열지 않는다.

## 공식 근거

- Slack Socket Mode: https://docs.slack.dev/tools/bolt-js/concepts/socket-mode
- Slack `app_mention`: https://api.slack.com/events/app_mention
- Slack `chat.postMessage`: https://api.slack.com/methods/chat.postMessage
- Slack `conversations.replies`: https://docs.slack.dev/reference/methods/conversations.replies/
- Slack `auth.test`: https://docs.slack.dev/reference/methods/auth.test
