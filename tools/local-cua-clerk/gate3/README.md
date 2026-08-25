# Gate 3 — 별도 Slack 직원 커넥터

이 디렉터리는 기존 헤이빌리와 분리된 `맥에이전트` Slack 앱을 이 Mac의 Gate 2
원장과 Gate 1 읽기 전용 CUA 브리지에 연결한다. 현재 허용 액션은 `상태 확인` →
`desktop_readiness` 하나뿐이다.

## 현재 상태

- `맥에이전트` Slack 앱 생성·빌리지 설치·`#agent-서류발송` 초대 완료
- 전용 `com.village.mac-agent` 사용자 LaunchAgent가 로그인 세션에서 상시 실행
- Slack에서 `맥에이전트 상태 확인` 한글 호출·한글 작성자명·동일 스레드 정상 회신과 원장
  `completed` 확인
- 홈택스 접속·로그인·조회·발급·수정은 하지 않음

## 설치 구성

1. Slack 앱 관리 화면에서 `slack-app-manifest.json`으로 새 앱을 만든다.
   사용자에게 보이는 앱 이름과 설치된 bot 표시명은 `맥에이전트`다. Slack manifest와
   기본 멘션 ID가 요구하는 내부 이름만 ASCII `mac-agent`/`macagent`로 남기며 사용자가
   입력하는 명령에는 사용하지 않는다.
2. App-level token은 `connections:write` 하나로 새로 발급한다.
3. 앱을 빌리지 워크스페이스에 설치하고 `#agent-서류발송` 채널에 초대한다.
4. `.env.example`의 값은 저장소 밖
   `~/Library/Application Support/village-local-cua-clerk/slack.env` 권한 `0600`에만 둔다.
5. `auth.test`에서 확인한 새 bot user ID와 앱 설정의 app ID를 환경파일에 고정한다.
6. 설치 뒤 Slack Marketplace의 `맥에이전트 > 구성 > 봇 사용자 > 편집`에서 워크스페이스
   표시명을 `맥에이전트`로 저장한다. 이 단계는 ASCII 내부 이름을 바꾸지 않는다.

토큰 값은 코드, Git, plist, 명령행, 로그, 보고서에 넣지 않는다. 원장은 같은 전용 디렉터리의
`ledger` leaf이며 권한은 `0700`이다.

## 실행

Node 20.18.1 이상에서 의존성을 설치한다. 수동 진단 실행은 Node의 env-file 기능을 사용할 수 있다.

```sh
cd tools/local-cua-clerk/gate3
npm ci
node --env-file=/absolute/path/to/local-cua-slack.env socket-mode-runner.mjs
```

운영 설치·재시작은 사용자가 명령을 외울 필요 없이 에이전트가 아래 스크립트를 실행한다.

```sh
cd tools/local-cua-clerk/gate3
npm run install-service
```

런처는 비밀파일의 소유자·정규파일·`0600`, 원장의 `0700`, 고정 실행 경로를 확인한 뒤
`gui/$UID/com.village.mac-agent` 정확한 라벨만 종료 확인·등록한다. 상시 서비스 진입점은
Node의 주변 환경변수를 사용하지 않고 비밀파일을 매 시작마다 다시 검증·파싱한다. 새 실행 회차와
일치하는 비공개 준비 파일에 Slack 정체성 증거 4개가 모두 참으로 기록된 뒤에만 설치 성공을
반환한다. 준비 신호가 없으면 정확한 자기 라벨만 종료하고 실패한다. PID나 다른 LaunchAgent
라벨은 대상으로 삼지 않는다.

시작 순서는 다음과 같다.

1. 비밀파일 정규파일·소유자·`0600` 및 전용 원장 `0700` 재검사
2. 파일에서 파싱한 전용 환경값만 사용하고 주변 프로세스 환경값은 무시
3. `auth.test`로 팀 ID·bot user ID·bot identity 일치 확인
4. 검증된 정체성으로 Bolt 앱 초기화
5. 호환용 `app_mention`과 한글 호출용 `message.channels` 이벤트를 등록하고 Socket Mode 시작
6. 새 실행 회차 전용 준비 신호 기록

기존 `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`, Hermes 설정은 fallback으로 읽지 않는다.
원장 경로는 반드시 `.../village-local-cua-clerk/ledger` 전용 leaf여야 하며, 이미 존재한다면
권한이 사전에 `0700`이어야 한다. 기존의 넓은 디렉터리 권한을 실행기가 바꾸지 않는다.

## 처리 계약

- 고정 팀·채널·앱·봇·허용 사용자와 모두 일치해야 한다.
- 사용자는 채널에 정확히 `맥에이전트 상태 확인`을 입력한다. 기존 직접 멘션 방식은
  호환용으로만 유지한다.
- Slack 원문은 Gate 2 envelope로 매핑한 직후 폐기하며 원장에 저장하지 않는다.
- 최상위 메시지는 그 메시지의 `ts`, 기존 스레드는 부모 `thread_ts`로 회신한다.
- `chat.postMessage` 결과를 `conversations.replies`에서 같은 봇·같은 본문·같은 `ts`로 다시
  확인해야만 전달 완료로 기록한다.
- 쓰기 결과가 애매하거나 readback이 없으면 `delivery_unknown`으로 멈추고 자동 재발송하지 않는다.

## 테스트

```sh
npm test
npm run check
```

저장소 전체 Gate 0~3 회귀 테스트는 저장소 루트에서 실행한다.

```sh
node --test tools/local-cua-clerk/gate0/*.test.mjs \
  tools/local-cua-clerk/gate1/*.test.mjs \
  tools/local-cua-clerk/gate2/*.test.mjs \
  tools/local-cua-clerk/gate3/*.test.mjs
```
