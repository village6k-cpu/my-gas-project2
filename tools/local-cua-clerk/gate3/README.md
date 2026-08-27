# Gate 3 — 별도 Slack 직원 커넥터

이 디렉터리는 기존 헤이빌리와 분리된 `맥에이전트` Slack 앱을 이 로컬 스튜디오맥의
Gate 2 원장과 Gate 1 CUA 워커에 연결한다. 사람의 `상태 확인`, PII 없는 HeyBilly
`studio_mac_cua_readiness`, 정확히 고정된 HeyBilly 현금영수증
`MAC_AGENT_HANDOFF_V1` 인계만 허용한다.

## 현재 상태

- `맥에이전트` Slack 앱 생성·빌리지 설치·`#agent-서류발송` 초대 완료
- 전용 `com.village.mac-agent` 사용자 LaunchAgent가 로그인 세션에서 상시 실행
- Slack에서 `맥에이전트 상태 확인` 한글 호출·한글 작성자명·동일 스레드 정상 회신과 원장
  `completed` 확인
- HeyBilly 사용자 ID와 bot ID를 별도로 고정하고 다른 봇·과거 이벤트·편집 이벤트를 선차단
- 접수 → 스튜디오맥 단일 CUA 실행 → 고정 화면 readback → 동일 스레드 최종 회신 구현
- 세금계산서, 임의 자연어, 다른 HomeTax 업무는 허용하지 않음

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
6. HeyBilly의 Slack user ID와 bot ID를 `LOCAL_CUA_SLACK_HEYBILLY_*`에 별도로 고정한다.
7. 설치 뒤 Slack Marketplace의 `맥에이전트 > 구성 > 봇 사용자 > 편집`에서 워크스페이스
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
- HeyBilly 인계는 10분 이내의 새 이벤트, 정확한 HeyBilly user+bot 쌍, 부모 스레드,
  소문자 UUIDv4 인계 ID와 고정 키의 `MAC_AGENT_HANDOFF_V1`만 수용한다. 운영 인계는
  Slack 자동 변환을 막는 단일 `text` 코드 블록으로 보내며, 파서는 앞뒤 설명이나 다른
  코드 블록 언어가 없는 정확한 한 블록만 벗겨서 검증한다. 실제 HeyBilly 출력에서 확인된
  일반 멘션·고객명 강조·전화 링크 변환은 고정 13줄 위치와 값 일치가 모두 맞을 때만
  원래 필드로 복원한다. 실측된 한 줄 공백 축약형도 고정 필드 13개·순서·구분자·값이
  전부 일치할 때만 복원하며, 다른 변형은 계속 거부한다.
- HeyBilly readiness는 별도 `[MAC_AGENT_READINESS_V1]` fenced 6줄 계약의
  `studio_mac_cua_readiness`와 `authorization: read_only`만 수용한다.
  실측된 HeyBilly 코드 블록의 여는 fence 직후 줄바꿈 생략과 정확한
  `[/MAC_..._V1]` 닫힘 표기는 나머지 5줄이 모두 일치할 때만 이 readiness 경로에서
  원래 값으로 복원하며, 금융 인계에는 적용하지 않는다.
  고객·거래·금액·전화 등 금융/PII 필드는
  허용하지 않으며 기존 Gate 2 `desktop_readiness` 원장과 Gate 1 CUA 브리지를 재사용한다.
- 고객 데이터는 실행 중 메모리에만 두고 원장에는 opaque handoff ID와 고정 상태만 남긴다.
- 동일 handoff ID는 한 번만 실행하며, `running`·전달 불명 상태는 사람 확인 없이 재실행하지 않는다.
- 현금영수증 인계 진행상황은 원 요청 스레드에 `스튜디오맥 접수`와 최종 완료/사용자 확인
  필요로 표시하고, readiness는 같은 스레드에 준비 상태 최종 결과만 표시한다.
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
