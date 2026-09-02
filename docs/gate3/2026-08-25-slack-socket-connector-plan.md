# Gate 3 — 별도 Slack 직원 Socket Mode 커넥터 계획

## 사용자에게 보이는 결과

빌리지 Slack의 승인된 문서 채널에서 **기존 헤이빌리와 다른 별도 봇**을 멘션해
`상태 확인`이라고 쓰면, 이 Mac에서 Gate 1의 읽기 전용 `desktop_readiness`를 한 번 실행하고
같은 Slack 스레드에 고정 형식 결과를 한 번 회신하는 수직 슬라이스를 만든다.

이번 구현은 새 Slack 앱을 실제로 만들거나 설치하지 않고, 메시지도 보내지 않는다. 앱 설치와 첫
실제 회신은 코드·테스트·설치 manifest를 검증한 뒤 별도 외부 변경 게이트에서 진행한다.

## 확인한 현재 상태

- Gate 2는 `village-tax-document-clerk`의 고정 액션, 내구 원장, 동시 실행 방지, 전달 재개와
  애매한 전달의 자동 재시도 금지를 이미 제공한다.
- 2026-08-25 읽기 전용 확인에서 빌리지 워크스페이스와 공개 채널
  `#agent-서류발송`이 존재하고 보관되지 않은 상태임을 확인했다.
- 같은 채널은 현재 기존 헤이빌리를 멘션하는 운영 채널이다. 새 직원은 기존 토큰·봇 ID·프로세스를
  재사용하거나 fallback하지 않는다.
- 저장소에는 HTTP Slack 서명 검증, Slack Web API JSON POST, 결정적 `client_msg_id`, 원장 claim,
  동일 스레드 회신 패턴이 있으나 독립 Node Socket Mode 수신기는 없다.

## 최소 범위

1. `app_mention` 한 이벤트만 수신한다.
2. 설치 후 고정할 `team_id + channel_id + api_app_id + bot_user_id + allowed_user_id`가 모두
   일치해야 한다. 하나라도 없거나 다르면 실행하지 않는다.
3. 멘션 뒤 명령은 정확히 `상태 확인` 하나만 허용하고 `desktop_readiness`로 매핑한다.
4. 원문 메시지·사용자 프로필·토큰·화면 내용은 원장과 결과에 보존하지 않는다.
5. Gate 2의 요청 claim과 결과 상태머신을 그대로 사용하되 live source는
   `slack_socket_mode`로 명시한다.
6. `chat.postMessage`는 원래 요청의 루트 `thread_ts`에만 고정 형식으로 회신한다.
7. 결정적 `client_msg_id`를 사용하고, 응답의 `ts`를 `conversations.replies`에서 같은 봇·같은
   스레드·같은 본문으로 다시 확인한 뒤에만 전달 성공으로 확정한다.
8. 쓰기 결과가 애매하거나 readback이 실패하면 `delivery_unknown`으로 멈추고 자동 재전송하지 않는다.

## 구조

```text
Slack 별도 직원 봇 멘션
        |
        v
공식 Bolt Socket Mode 수신기
  - xapp 토큰으로 outbound WebSocket
  - xoxb 토큰 auth.test로 팀/봇 정체성 preflight
        |
        v
Gate 3 이벤트 어댑터
  - team/channel/app/bot/user 고정 검사
  - 정확한 "상태 확인"만 desktop_readiness로 매핑
  - 원문은 여기서 폐기
        |
        v
Gate 2 내구 실행 원장
  - event_id 중복 claim
  - 동일 이벤트/스레드 digest 결합
        |
        v
Gate 1 읽기 전용 desktop_readiness
        |
        v
Gate 3 Slack 결과 sink
  - 동일 thread_ts에 고정 결과 post
  - conversations.replies exact readback
        |
        v
Gate 2 completed 또는 delivery_unknown
```

## 설치 manifest와 최소 권한

- App-level token: `connections:write`
- Bot scopes: `app_mentions:read`, `chat:write`, `channels:history`
- Bot event: `app_mention`
- Socket Mode: enabled
- 공개 Request URL, slash command, DM 수신, 사용자 토큰, 관리자 범위는 사용하지 않는다.

비밀값은 `LOCAL_CUA_SLACK_APP_TOKEN`과 `LOCAL_CUA_SLACK_BOT_TOKEN` 두 환경변수로만 받고,
기존 `SLACK_BOT_TOKEN`이나 Hermes 설정으로 fallback하지 않는다. 팀·채널·앱·봇·허용 사용자 ID와
원장 경로도 모두 필수이며 누락 시 시작을 거부한다. 원장은 반드시
`.../village-local-cua-clerk/ledger` 전용 leaf이고, 기존 디렉터리는 이미 `0700`이어야 한다.
로그에는 토큰이나 이벤트 원문을 출력하지 않는다.

## 실패 처리

| 실패 | 결과 | 외부 재시도 |
|---|---|---|
| 이벤트/명령 형식 오류 | `REJECTED` | 없음 |
| 팀·채널·앱·봇·사용자 불일치 | `REJECTED` | 없음 |
| 같은 Slack `event_id` 처리 중 | `BLOCKED/in_progress` | Slack 재전달은 원장이 억제 |
| 완료 이벤트 재수신 | `DUPLICATE` | 실행·회신 없음 |
| 명시적 `chat.postMessage ok:false` | `BLOCKED/post_failed` | 전달만 재개 가능 |
| 네트워크 예외·post 성공 후 readback 실패 | `BLOCKED/delivery_unknown` | 자동 재전송 금지 |
| Gate 1 실패/형식 오류 | 고정된 `BLOCKED` 결과 1회 회신 | 실행 재시도 없음 |

## 검증

- 이벤트의 정상·타팀·타채널·타앱·타봇·타사용자·봇 이벤트·임의 명령 테스트
- live source가 합성 source와 섞이지 않는 테스트
- 첫 실행 1회, 완료 중복 0회, 동시 claim 1회 테스트
- 동일 스레드·결정적 `client_msg_id`·고정 메시지 테스트
- post 실패, 예외, readback 누락·변조·다른 봇 테스트
- `auth.test` 팀·봇 불일치 및 필수 설정 누락 fail-closed 테스트
- Gate 0~3 전체 테스트, 구문 검사, dependency audit, 비밀 문자열/원문 비보존 검사

## 범위 밖

- Slack 앱 실제 생성·설치·채널 초대·첫 메시지 발송
- 상시 LaunchAgent 등록 또는 자동 시작
- 홈택스 접속·로그인·조회·발급·수정·취소
- 자연어 해석, 첨부파일/OCR, 임의 Codex 프롬프트, 복수 업무 액션
- Hermes/헤이빌리 토큰·프로세스·장기 세션 재사용

## 중단 조건

오프라인 계약 테스트와 전체 회귀 검증, 독립 리뷰가 통과하고 feature 브랜치가 깨끗하게 푸시되면
이번 Gate 3A를 종료한다. 다음 단계는 사용자가 Slack의 새 앱 생성·설치와 첫 테스트 회신을
명시적으로 진행할 때만 시작한다.

## 공식 근거

- Slack Socket Mode: https://docs.slack.dev/tools/bolt-js/concepts/socket-mode
- Slack `app_mention`: https://api.slack.com/events/app_mention
- Slack `chat.postMessage`: https://api.slack.com/methods/chat.postMessage
- Slack `conversations.replies`: https://docs.slack.dev/reference/methods/conversations.replies/
- Slack `auth.test`: https://docs.slack.dev/reference/methods/auth.test
