# Gate 3 — 별도 Slack 직원 커넥터

이 디렉터리는 기존 헤이빌리와 분리된 `빌리지 세무·서류 담당` Slack 앱을 이 Mac의 Gate 2
원장과 Gate 1 읽기 전용 CUA 브리지에 연결한다. 현재 허용 액션은 `상태 확인` →
`desktop_readiness` 하나뿐이다.

## 현재 상태

- 구현·오프라인 테스트 가능
- 실제 Slack 앱 생성·설치·토큰 발급·채널 초대·메시지 발송은 아직 하지 않음
- 홈택스 접속·로그인·조회·발급·수정은 하지 않음

## 설치 전 준비

1. Slack 앱 관리 화면에서 `slack-app-manifest.json`으로 새 앱을 만든다.
2. App-level token은 `connections:write` 하나로 새로 발급한다.
3. 앱을 빌리지 워크스페이스에 설치하고 `#agent-서류발송` 채널에 초대한다.
4. `.env.example`을 별도 저장소 밖의 권한 `0600` 파일로 복사해 새 앱의 값만 채운다.
5. `auth.test`에서 확인한 새 bot user ID와 앱 설정의 app ID를 환경파일에 고정한다.

위 단계는 Slack 외부 상태를 바꾸므로 이 Gate 3A 구현에는 포함하지 않는다. 토큰 값은 코드,
Git, 로그, 보고서에 넣지 않는다.

## 실행

Node 20.18.1 이상에서 의존성을 설치한 뒤, Node의 env-file 기능으로 별도 비밀 파일을 읽는다.

```sh
cd tools/local-cua-clerk/gate3
npm ci
node --env-file=/absolute/path/to/local-cua-slack.env socket-mode-runner.mjs
```

시작 순서는 다음과 같다.

1. 모든 전용 환경변수와 절대 원장 경로 검사
2. `auth.test`로 팀 ID·bot user ID·bot identity 일치 확인
3. 검증된 정체성으로 Bolt 앱 초기화
4. `app_mention` 한 이벤트만 등록
5. Socket Mode 시작

기존 `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`, Hermes 설정은 fallback으로 읽지 않는다.
원장 경로는 반드시 `.../village-local-cua-clerk/ledger` 전용 leaf여야 하며, 이미 존재한다면
권한이 사전에 `0700`이어야 한다. 기존의 넓은 디렉터리 권한을 실행기가 바꾸지 않는다.

## 처리 계약

- 고정 팀·채널·앱·봇·허용 사용자와 모두 일치해야 한다.
- 직접 멘션 뒤 정확한 `상태 확인`만 허용한다.
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
