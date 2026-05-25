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

이 테스트 스크립트는 기본 debounce를 5초로 줄이고, debounce 완료 job을 `tools/ai-browser-worker/run.sh`로 넘깁니다. worker는 안전 기본값으로 dry-run만 수행하며 job JSON을 `queue/ai-worker-inbox/`에 저장하고 AI-first Hermes prompt를 생성합니다. 실제 Kakao computer_use 실행과 Sheets 쓰기는 `AI_WORKER_LIVE=1`일 때만 수행합니다.

자동화 전용 Chrome 프로필 열기:

```bash
./tools/kakao-dom-bridge/open-automation-chrome.sh
```

상태 확인:

```bash
curl http://127.0.0.1:8787/health
```

## 일반 실행

```bash
cd tools/kakao-dom-bridge
npm start
```

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
- `run.sh`: bridge용 wrapper입니다. 기본은 dry-run입니다.
- live worker는 Hermes AI 실행 전에 Chrome의 Kakao Channel Manager 채팅 탭을 찾아 앞으로 가져옵니다. 탭이 없으면 `KAKAO_CHANNEL_MANAGER_URL`을 Chrome에서 엽니다. 이 단계는 판단 로직이 아니라 AI가 볼 작업장을 준비하는 plumbing입니다.
- live Hermes subprocess는 기본 180초(`HERMES_WORKER_TIMEOUT_MS`)를 넘기면 child tree를 종료하고 job을 `ai_worker_error`로 기록합니다.
- prompt에는 Supabase raw payload 전체를 넣지 않고 id/room_key/preview_text/detected_at 등 compact evidence만 넣습니다.
- 실제 실행은 명시적으로만 켭니다:

```bash
AI_WORKER_LIVE=1 ./tools/kakao-dom-bridge/start-local-test.sh
```

### Read-only GAS lookup context

worker는 Hermes를 호출하기 전에 읽기 전용 조회 컨텍스트를 생성합니다.

- 설정 시트 A1 킬 스위치를 `action=read`로 조회합니다.
- 세트마스터 검색, 확인요청 검색, 계약마스터/스케줄상세 gviz 조회 URL 템플릿을 prompt에 주입합니다.
- Hermes subprocess에는 `terminal,computer_use,vision` toolset을 켭니다. terminal은 읽기 전용 GAS GET 조회에만 허용합니다.
- 중요: AI-first 원칙상 Kakao 화면 확인/채팅방 열기/대화 읽기는 Hermes computer_use가 수행합니다. 코드가 DOM/문자열 규칙으로 예약 여부를 판단하지 않습니다.
- live test 지연 root cause는 `computer_use` 자체가 아니라 Hermes computer_use approval path가 `--yolo`를 존중하지 않아 click/focus_app에서 60초씩 대기한 버그였습니다. local Hermes Agent의 computer_use approval gate가 `HERMES_YOLO_MODE=1`을 존중하도록 패치했습니다.
- 금지 액션: `write`, `append`, `run`, `insertAndCheckRequest`, `updateRequest`, `deleteRequest`, `발송승인`, `등록`, `send`.
- AI가 lookup 결과를 근거로 safety_checks를 채우되, 최종 판단은 AI가 합니다. 코드는 safety_checks가 모두 true인지 gate만 봅니다.

실제 실행에서도 답장 전송은 금지되어 있고, Sheets에는 AI가 `should_write_to_sheet: true`로 판단한 경우에만 `확인요청`에 `AI_REVIEW`/`AI-대기` 상태의 사람검토 행을 append합니다.

### Claude Coworker 프롬프트에서 가져온 운영 규칙

현재 Hermes worker에는 기존 Claude Coworker 프롬프트 중 안전하고 MVP에 맞는 규칙만 반영합니다.

- 카톡 목록 미리보기만으로 분류하지 않고, 채팅방을 열어 실제 대화 맥락을 확인합니다.
- 최근 24시간 맥락과 직원 답변 여부를 확인합니다.
- 예약/가격/FAQ/무시/이미 답변됨 분류는 AI가 판단합니다.
- 장비명은 약어 그대로 쓰지 않고 세트마스터/목록의 정확한 이름이 확인된 경우에만 시트 후보로 씁니다.
- 할인유형은 `학생`, `개인사업자/프리랜서`, `일반`만 허용합니다. `단골`, `제휴`는 AI가 쓰지 않습니다.
- 중복 방지는 계약마스터, 스케줄상세, 확인요청 3단계 확인이 필요합니다.
- 현재 Hermes MVP에서는 카톡 자동 발송, 알림톡 발송, 예약 등록은 비활성화입니다. 답장 초안과 사람검토 시트 후보까지만 생성합니다.
- worker는 `safety_checks`가 모두 true일 때만 실제 Sheets append를 허용합니다. 하나라도 빠지면 `should_write_to_sheet: true`여도 append하지 않습니다.
