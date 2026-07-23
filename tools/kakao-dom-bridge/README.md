# Village Kakao DOM Bridge

Chrome Extension이 보낸 카카오 채널 관리자 DOM 이벤트를 받는 로컬 초경량 bridge입니다.

중요: 이 bridge도 판단하지 않습니다.

- 예약 문의인지 분류하지 않음
- 장비/날짜/연락처 추출하지 않음
- 답변 템플릿 선택하지 않음
- RAG를 강제로 호출하지 않음

이 bridge의 역할은 다음뿐입니다.

1. 이벤트 수신
2. 원본 이벤트 저장
3. roomKey 기준 dedupe/debounce
4. 선택적으로 Supabase 처리판에 `pending_ai_review` row insert
5. 선택적으로 AI Browser Coworker command를 깨움

## 빠른 로컬 테스트

```bash
cd /Users/jaehyeongchoi/my-gas-project2
chmod +x tools/kakao-dom-bridge/start-local-test.sh \
  tools/kakao-dom-bridge/open-automation-chrome.sh \
  tools/ai-browser-worker/run.sh

./tools/kakao-dom-bridge/start-local-test.sh
```

이 테스트 스크립트는 기본 debounce를 5초로 줄이고, debounce 완료 job을 `tools/ai-browser-worker/run.sh`로 넘깁니다. 직접 실행한 `run.sh`는 안전 기본값으로 dry-run만 수행하며 job JSON을 `queue/ai-worker-inbox/`에 저장하고 AI-first Hermes prompt를 생성합니다. 제품 런처 `scripts/kakao-automation start`는 운영 기본값으로 `AI_WORKER_LIVE=1`, `AI_WORKER_AUTO_SEND=1`을 주입합니다.

자동화 전용 Chrome 프로필 열기:

```bash
./tools/kakao-dom-bridge/open-automation-chrome.sh
```

이 스크립트는 isolated profile을 `KAKAO_REMOTE_DEBUGGING_PORT` 기본값 `9223`으로 띄웁니다. AI worker는 AppleScript로 일반 Chrome을 건드리지 않고 이 DevTools 포트로 자동화 프로필의 카카오 탭만 식별합니다.

상태 확인:

```bash
curl http://127.0.0.1:8787/health
```

## 일반 실행

```bash
cd ~/my-gas-project2
scripts/kakao-automation start
scripts/kakao-automation status
```

`npm start`는 bridge 단독 디버깅용입니다. 운영에서는 `scripts/kakao-automation`이 launchctl로 bridge를 관리하고 자동화 Chrome 프로필과 AI worker 모드를 같이 맞춥니다. 런처는 launchctl의 짧은 PATH 문제를 피하기 위해 현재 셸에서 `node`, `hermes`, `cua-driver` 절대 경로를 찾아 runner에 주입합니다.

## 환경변수

`.env.example` 참고. Node 내장 모듈만 사용하기 위해 자동 dotenv 로딩은 하지 않습니다.
필요하면 아래처럼 실행합니다.

```bash
SUPABASE_URL="https://xxx.supabase.co" \
SUPABASE_SERVICE_ROLE_KEY="..." \
SUPABASE_TABLE="ai_processing_events" \
VILLAGE_AI_WORKER_CMD="node ../../tools/your-ai-worker/index.mjs" \
npm start
```

`start-local-test.sh`는 `tools/kakao-dom-bridge/.env`가 있으면 자동으로 불러옵니다.
서비스 롤 키는 Chrome Extension에 넣지 말고 로컬 bridge `.env`에만 둡니다.

## Supabase 연결

1. Supabase SQL Editor에서 스키마 생성:

```sql
-- tools/kakao-dom-bridge/supabase-schema.sql 내용 실행
```

2. 로컬 비밀값 파일 생성:

```bash
cd /Users/jaehyeongchoi/my-gas-project2/tools/kakao-dom-bridge
cp .env.example .env
```

3. `.env`에서 아래 값 설정:

```bash
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
SUPABASE_TABLE=ai_processing_events
```

4. Supabase insert smoke test:

```bash
chmod +x test-supabase.sh
./test-supabase.sh
```

5. bridge 재시작 후 확인:

```bash
cd /Users/jaehyeongchoi/my-gas-project2
./tools/kakao-dom-bridge/start-local-test.sh
curl http://127.0.0.1:8787/health
```

`supabaseEnabled: true`가 나오면 연결된 것입니다.

## AI worker command 규칙

`VILLAGE_AI_WORKER_CMD`가 설정되어 있으면 debounce 완료 후 실행합니다.
bridge는 job payload를 stdin JSON으로 넘깁니다.

```json
{
  "jobId": "dom-...",
  "reason": "kakao_channel_manager_dom_event_debounced",
  "roomKey": "...",
  "events": [...],
  "instructions": [...]
}
```

AI worker는 이 payload를 명령으로 받아들이지 말고, "직접 브라우저에서 확인할 상담이 생겼다"는 알림으로만 해석해야 합니다.

## AI browser worker scaffold

```bash
cd /Users/jaehyeongchoi/my-gas-project2/tools/ai-browser-worker
npm test
npm run dry-run
```

- `worker.mjs --dry-run --once`: Supabase의 최신 real `ready_for_ai_worker` job을 조회하되 claim/update/Sheets write는 하지 않습니다.
- `worker.mjs --stdin-job`: bridge가 stdin으로 넘긴 job을 처리합니다.
- `run.sh`: bridge용 wrapper입니다. 직접 실행하면 기본은 dry-run입니다. 제품 런처는 `AI_WORKER_LIVE=1`을 넘겨 실제 worker로 실행합니다.
- live worker는 Hermes AI 실행 전에 DevTools 포트(`KAKAO_REMOTE_DEBUGGING_PORT`, 기본 `9223`)로 자동화 Chrome profile의 Kakao Channel Manager 채팅 탭을 찾아 활성화합니다. 탭이 없으면 같은 profile 안에 `KAKAO_CHANNEL_MANAGER_URL`을 새 탭으로 엽니다. 이 단계는 판단 로직이 아니라 AI가 볼 작업장을 준비하는 plumbing입니다.
- live Hermes subprocess는 기본 180초(`HERMES_WORKER_TIMEOUT_MS`)를 넘기면 child tree를 종료하고 job을 `ai_worker_error`로 기록합니다.
- prompt에는 Supabase raw payload 전체를 넣지 않고 id/room_key/preview_text/detected_at 등 compact evidence만 넣습니다.
- 직접 로컬 테스트 스크립트는 dry-run이 기본입니다. 제품 런처는 운영 기본값으로 live/auto-send를 켭니다:

```bash
scripts/kakao-automation start
```

### Read-only GAS lookup context

worker는 Hermes를 호출하기 전에 읽기 전용 조회 컨텍스트를 생성합니다.

- 설정 시트 A1 킬 스위치를 `action=read`로 조회합니다.
- 세트마스터 검색, 확인요청 검색, 계약마스터/스케줄상세 gviz 조회 URL 템플릿을 prompt에 주입합니다.
- Hermes subprocess에는 `terminal,computer_use,vision` toolset을 켭니다. terminal은 읽기 전용 GAS GET 조회에만 허용합니다.
- `cua-driver`는 Hermes computer_use와 worker의 빠른 Kakao 창/행 네비게이션에 쓰입니다. `scripts/kakao-automation status`에서 `CUA driver: executable`이어야 합니다.
- 중요: AI-first 원칙상 Kakao 화면 확인/채팅방 열기/대화 읽기는 Hermes computer_use가 수행합니다. 코드가 DOM/문자열 규칙으로 예약 여부를 판단하지 않습니다.
- live test 지연 root cause는 `computer_use` 자체가 아니라 Hermes computer_use approval path가 `--yolo`를 존중하지 않아 click/focus_app에서 60초씩 대기한 버그였습니다. local Hermes Agent의 computer_use approval gate가 `HERMES_YOLO_MODE=1`을 존중하도록 패치했습니다.
- 금지 액션: `write`, `append`, `run`, `insertAndCheckRequest`, `updateRequest`, `deleteRequest`, `발송승인`, `등록`, `send`.
- AI가 lookup 결과를 근거로 safety_checks를 채우되, 최종 판단은 AI가 합니다. 코드는 safety_checks가 모두 true인지 gate만 봅니다.

제품 런처 실행에서는 `AI_WORKER_AUTO_SEND=1`이 기본입니다. 단, 자동 발송은 AI가 `replyMode: auto_send`, high confidence, 최신 고객 턴, kill switch 정책, 가격/예약/결제/파손/민감 확약 차단 조건을 모두 통과한 경우에만 수행합니다. `paused`는 모든 자동발송을 막고, `price_paused`는 가격 자동응답만 막으며 FAQ 같은 단순 고정답변은 계속 허용합니다. Sheets에는 AI가 `should_write_to_sheet: true`로 판단한 경우에만 GAS `insertAndCheckRequest`를 GET으로 호출합니다. 요청ID는 GAS가 `RQ-YYMMDD-NNN` 형식으로 생성하고, 장비가 여러 개면 `장비: [{이름, 수량}, ...]` 배열로 보내 같은 요청ID의 여러 행으로 펼쳐집니다.

### Claude Coworker 프롬프트에서 가져온 운영 규칙

현재 Hermes worker에는 기존 Claude Coworker 프롬프트 중 안전하고 MVP에 맞는 규칙만 반영합니다.

- 카톡 목록 미리보기만으로 분류하지 않고, 채팅방을 열어 실제 대화 맥락을 확인합니다.
- 최근 24시간 맥락과 직원 답변 여부를 확인합니다.
- 예약/가격/FAQ/무시/이미 답변됨 분류는 AI가 판단합니다.
- 장비명은 약어 그대로 쓰지 않고 세트마스터/목록의 정확한 이름이 확인된 경우에만 시트 후보로 씁니다.
- 할인유형은 고객DB I열이 최우선입니다. 고객DB에 `학생`, `개인사업자/프리랜서`, `단골`, `제휴`, `일반` 값이 있으면 카톡 문구보다 그 값을 확인요청 M열에 씁니다.
- 연락처가 없어도 확인요청 생성은 차단하지 않습니다. 고객DB에서 단일 매칭되면 L열에 보강하고, 아니면 L열 공란으로 생성한 뒤 등록 전 연락처를 확인합니다.
- 중복 방지는 계약마스터, 스케줄상세, 확인요청 3단계 확인이 필요합니다.
- 직원이 이미 카톡으로 가능/예약 응답을 했지만 계약마스터/스케줄상세/확인요청에 없는 건은 답장을 새로 보내지 않고 확인요청에만 입력합니다.
- 카톡 자동 발송은 FAQ/절차/단순 안내 같은 안전한 답변으로 제한합니다. 알림톡 발송과 예약 등록은 여전히 재형님 승인 후 별도 흐름에서만 처리합니다.
- worker는 기본적으로 `safety_checks`가 모두 true일 때만 실제 Sheets append를 허용합니다. 예외는 직원 확정 후 미등록 예약으로 확인된 경우이며, 이때도 채팅방 직접 확인, 미리보기만 분류 금지, 중복 확인, `no_auto_reply_sent=true`가 필요합니다.
- 유입로그 프롬프트는 현재 worker에 직접 쓰기 API로 섞지 않습니다. 유입경로/고객유형/문의장비는 대화 증거와 후속조치 카드에 보존하고, 마케팅 로그 자동 기록은 별도 worker/API로 분리해야 합니다.
