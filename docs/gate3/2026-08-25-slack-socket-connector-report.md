# Gate 3A — 별도 Slack 직원 커넥터 결과 보고서

## 판정

- 구현·오프라인 검증: **PASS**
- 실제 Slack 앱 생성·설치·첫 회신: **PASS**
- 사용자 LaunchAgent 동일 스레드 회신·원장 완료: **PASS**
- HomeTax 접속·로그인·조회·발급·수정: **0건**

Gate 3A는 기존 Hermes/헤이빌리와 분리된 `맥에이전트` 앱이 이 Mac의 고정 읽기 전용 CUA
준비 상태를 확인하는 최소 커넥터를 실제 Slack과 사용자 LaunchAgent까지 연결했다. 현재 허용
업무는 `상태 확인` 하나이며 HomeTax 업무는 아직 열지 않았다.

## 구현 결과

- 공식 Bolt Socket Mode를 사용하는 독립 실행 프로세스
- 새 앱 전용 `LOCAL_CUA_*` 설정만 허용하고 기존 Slack/Hermes 변수 fallback 금지
- `auth.test` 정체성 확인 후에만 Bolt 초기화, `app_mention`·`message.channels` 등록,
  Socket Mode 시작
- 고정 team/channel/app/bot/사용자와 정확한 `맥에이전트 상태 확인` 한글 명령만 주 경로로 허용
- Gate 2의 live source 전용 진입점, 내구 원장, 원자적 claim, 중복 억제 사용
- 동일 Slack 스레드에 결정적 `client_msg_id`로 고정 결과를 한 번만 회신
- 방금 게시한 `ts`를 지정해 같은 bot/text/ts/thread를 다시 읽은 경우만 전달 완료
- 전용 `.../village-local-cua-clerk/ledger` leaf만 허용하고 기존 넓은 경로 권한은 변경하지 않음
- Slack 원문, 사용자 프로필, 토큰, 원시 오류를 원장·결과·로그에 보존하지 않음
- `com.village.mac-agent` 사용자 LaunchAgent에서 비밀파일 경로만 인자로 전달하고 토큰은
  plist·명령행·로그에 넣지 않음
- 전용 서비스 진입점이 재시작마다 비밀파일 소유자·정규파일·`0600`과 원장 `0700`을 재검사하고,
  파일에서 파싱한 값만 커넥터에 전달해 주변 프로세스 환경변수를 사용하지 않음
- 설치 회차별 준비 ID와 Slack 정체성 증거 4개가 모두 일치한 비공개 준비 파일을 확인한 경우만
  `RUNNING`으로 판정하고, 미확인 시 정확한 자기 LaunchAgent 라벨만 종료
- Slack의 이모지 저장 형식과 동일한 shortcode를 사용해 실제 readback 후 원장 `completed` 확정

## 검증 증거

| 검증 | 결과 |
|---|---|
| Gate 3 단위 테스트 | 27/27 PASS |
| Gate 0~3 전체 회귀 | 120/120 PASS |
| 한글 호출 경계 추가 검증 | 6/6 PASS |
| 실행 파일 구문 검사 | PASS |
| `git diff --check` | PASS |
| 잠긴 의존성 감사 | 취약점 0 |
| 토큰 패턴 검사 | 정규식·명시적 테스트 값·교체용 예시만 존재 |
| 독립 재리뷰 | CLEAN, P0/P1/P2 신규 finding 없음 |

독립 리뷰의 지적 여섯 건은 모두 회귀 테스트와 함께 닫았다.

1. Bolt가 명시적 정체성 검사보다 먼저 인증하지 않도록 `deferInitialization`과 초기화 순서를 고정했다.
2. 답글이 많은 스레드에서도 새 회신을 찾도록 게시된 `ts`를 지정해 exact readback한다.
3. 임의의 넓은 원장 경로와 기존 비공개가 아닌 디렉터리를 권한 변경 없이 거부한다.
4. 잠긴 런타임 의존성과 맞춰 Node 최소 버전을 `20.18.1`로 올렸다.
5. LaunchAgent 등록 여부만으로 성공 처리하지 않고 새 실행 회차 전용 준비 신호를 필수화했다.
6. 자동 재시작도 전용 진입점을 거쳐 비밀파일을 재검사하고 파일 기반 환경만 사용하도록 했다.

## 외부 상태 확인과 변경 경계

2026-08-25 빌리지 워크스페이스에 별도 앱 `맥에이전트`를 최소 bot scope 3개와
`connections:write` app token으로 설치하고 `#agent-서류발송`에 초대했다. 앱·설치된 bot의
사용자 표시명을 모두 `맥에이전트`로 적용했으며, 채널 화면에서 한글 작성자명을 다시 확인했다.
`com.village.mac-agent` LaunchAgent 재설치 뒤 새 실행 회차 준비 ID 일치, Slack 인증 증거 4개
참, 실제 서비스 `running`을 확인했다. 사용자 본인이 보낸 `맥에이전트 상태 확인` 요청
`4ba7d778732632f8`은 같은 스레드에 `맥에이전트 준비 상태: 정상`으로 회신됐고 원장
`completed`, `resultValidated: true`, 결과 `PASS`로 확인됐다. 재시작 직후 첫 한글 호출은
Gate 1 준비도 검사에서 `action_blocked`로 안전하게 중단됐고, 동일 준비도 직접 재검사 PASS 뒤
새 요청으로 위 최종 성공을 확인했다.

## 다음 단계

다음 단계는 `맥에이전트`가 허용할 첫 실제 HomeTax 업무의 요청·승인·중단·결과 계약을 좁게
정의하는 것이다. 현재 사용자는 `맥에이전트 상태 확인`으로 준비 상태만 확인할 수 있고,
그 밖의 한글 명령은 실행 전에 거부된다.

## 공식 근거

- Slack Socket Mode: https://docs.slack.dev/tools/bolt-js/concepts/socket-mode
- Slack `app_mention`: https://api.slack.com/events/app_mention
- Slack `message.channels`: https://docs.slack.dev/reference/events/message.channels/
- Slack `chat.postMessage`: https://api.slack.com/methods/chat.postMessage
- Slack `conversations.replies`: https://docs.slack.dev/reference/methods/conversations.replies/
- Slack `auth.test`: https://docs.slack.dev/reference/methods/auth.test
