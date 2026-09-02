# Gate 2 — Slack 직원 인입·중복방지 셸

Gate 2는 실제 Slack에 연결하지 않고 `village-tax-document-clerk` 직원의 최소 인입 수명주기를
검증한다. 고정된 합성 이벤트 하나만 받아 Gate 1의 읽기 전용 `desktop_readiness`를 실행하고,
로컬 가짜 전달구로 결과를 전달한 뒤 같은 이벤트의 재실행을 막는다.

`heybilly-handoff-shell.mjs`는 별도 경로로, Gate 3가 헤이빌리 Slack 인계를 이 로컬에서
구조화한 task를 스튜디오맥의 단일 CUA FIFO에 넣는다. 같은 Slack 스레드의 접수
readback이 끝난 뒤에만 실행하고,
`running` 이후 재수신은 자동 재실행하지 않는다. 원장에는 고객명·전화·금액·품목·Slack 원문을
저장하지 않는다. 인계 ID는 비식별 소문자 UUIDv4만 허용하고, 재개 시 원본 작업과의 일치는
권한 `0600` 로컬 비밀키로 만든 HMAC 지문으로만 확인한다.

같은 파일의 범용 경로는 `general_local_cua` 자연어 본문을 메모리에서만 Gate 1로 전달하고,
기존 HomeTax 경로와 **같은** `studioMacQueue`를 사용한다. 따라서 두 Codex 작업이 같은 Chrome
화면을 동시에 조작하지 않는다. 범용 원장에는 instruction과 결과 summary를 저장하지 않고
HMAC 지문, 고정 상태, `mutationObserved`·`readbackVerified`만 남긴다. summary를 재구성할 수
없으므로 범용 FINAL의 전달이 명확히 확인되지 않으면 `final_delivery_unknown`으로 닫고 자동
재전송·재실행하지 않는다. 결과 원본은 persisted Codex 작업에서 확인한다.

## 현재 가능한 것

- 정확한 `gate2-slack-envelope/v1` 합성 봉투만 수용
- 허용된 팀·채널 조합과 `desktop_readiness` 액션만 수용
- 팀 ID와 이벤트 ID의 해시로 요청 ID 생성
- 이벤트 전체의 별도 해시를 원장에 묶어 스레드 등 필드가 바뀐 재생 차단
- 권한 `0700` 원장 디렉터리와 권한 `0600` 요청 파일 사용
- 원자적 최초 점유로 동시·반복 실행 억제
- 알려진 미전달은 실행 없이 전달만 재시도
- 전달 성공 여부가 불명확하거나 제한시간을 넘기면 자동 재전송 금지
- 영수증·원장에는 메시지 본문, 사용자 정보, Slack 토큰, 화면 내용, Gate 1 실행 ID를 저장하지 않음

## 합성 준비도 경로가 하지 않는 것

- Slack 앱 설치, Events API, Socket Mode, 서명 검증, OAuth 또는 실제 메시지 발송
- 홈택스 접속, 로그인, 인증서 선택, 조회, 발급·수정·취소
- 자연어 해석, 임의 프롬프트 실행, 여러 액션 또는 상시 데몬

위 제한은 `synthetic_local` 준비도 경로에만 해당한다. 실제 Slack의 범용 자연어 인계는 Gate 3가
고정 HeyBilly 정체성·새 이벤트·owner 부모 스레드를 확인한 뒤 별도 general envelope로 호출한다.

`source`는 반드시 `synthetic_local`이어야 하므로 실제 Slack 이벤트를 이 셸에 그대로 넣어도
거부된다. 실제 커넥터는 다음 게이트에서 Slack 서명·설치·채널 권한을 별도로 증명한 뒤 붙인다.

## 테스트

저장소 루트에서 실행한다.

```sh
node --test tools/local-cua-clerk/gate0/*.test.mjs \
  tools/local-cua-clerk/gate1/*.test.mjs \
  tools/local-cua-clerk/gate2/*.test.mjs
```

## 안전한 합성 실행

아래 명령은 실제 Slack이나 홈택스에 연결하지 않는다. Gate 1의 고정 읽기 전용 데스크톱 준비
상태 확인을 한 번 실행하고, 동일한 합성 이벤트를 다시 넣어 중복 억제를 검증한다. 전용 임시
원장은 실행기 안에서 삭제하며 결과에는 고정 불리언만 출력한다.

```sh
node tools/local-cua-clerk/gate2/synthetic-runner.mjs
```

`PASS` 조건은 다음과 같다.

- Gate 1 읽기 전용 확인이 `PASS`
- 첫 처리에서 실행과 로컬 가짜 전달이 각각 한 번
- 두 번째 처리에서 `DUPLICATE`이며 실행·전달이 모두 생략
- 원장이 `completed`였음을 확인
- 실행기 소유 임시 원장 디렉터리 삭제 확인
- 실제 Slack 연결과 홈택스 작업은 모두 `false`

`BLOCKED`는 성공으로 간주하지 않는다. 특히 `delivery_unknown`은 실제 커넥터에서 메시지
조회나 외부 멱등 키가 생기기 전까지 사람이 확인해야 하며 자동 재전송하지 않는다.
