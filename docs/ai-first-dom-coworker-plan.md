# AI-first DOM Coworker MVP Plan

## 목표
카카오톡 채널 관리자 브라우저 화면에 새 상담/새 메시지가 생기면, 코드가 의미 판단을 하지 않고 AI 브라우저 직원에게 "직접 확인할 일"만 만들어준다.

## 핵심 원칙

1. Chrome Extension은 초인종이다.
   - 새 메시지/unread/상담 리스트 변화만 감지한다.
   - 예약 문의인지, 어떤 답변을 할지, 시트에 넣을지는 판단하지 않는다.

2. Queue/처리판은 작업대장이다.
   - `pending_ai_review` 상태의 이벤트를 저장한다.
   - AI에게 명령하지 않고, AI가 직접 판단한 결과를 기록한다.

3. RAG는 AI의 장기기억이다.
   - RAG가 유형/템플릿을 고정 결정하지 않는다.
   - AI 브라우저 직원이 필요할 때 유사 상담/말투/과거 응대를 검색하는 도구로만 쓴다.

4. AI Browser Coworker가 판단/실행 순서의 주체다.
   - 카카오 채널 관리자 화면을 직접 본다.
   - 필요한 경우 RAG, 구글시트, 확인요청 API, 처리판 업데이트 도구를 선택적으로 사용한다.
   - 위험한 행동은 초안/제안까지만 하고 사람 승인으로 넘긴다.

## MVP 구성

```text
Kakao Channel Manager in Chrome
  ↓
Chrome Extension content script
  - DOM MutationObserver
  - unread badge / chat row / preview 변화 감지
  - 의미 판단 없음
  ↓
Local DOM Bridge http://127.0.0.1:8787/events
  - 이벤트 수신
  - 중복 제거
  - roomKey 기준 debounce
  - optional Supabase insert
  - optional AI worker command 실행
  ↓
AI Browser Coworker
  - 브라우저에서 직접 상담 확인
  - RAG는 필요할 때만 검색
  - 확인요청/스케줄/시트 도구 사용
  - 답장창에는 초안만 작성, 기본 자동 전송 금지
```

## 이번 커밋에서 만든 것

- `tools/kakao-dom-watcher-extension/`
  - Chrome Manifest V3 확장 프로그램
  - 카카오 채널 관리자 URL에서만 content script 실행
  - DOM 변화 감지 후 local bridge로 이벤트 POST
  - 팝업에서 감지 ON/OFF, bridge URL, silence window 설정 가능

- `tools/kakao-dom-bridge/`
  - Node.js 내장 모듈만 사용하는 로컬 bridge 서버
  - `/events` POST 수신
  - `/health` 상태 확인
  - `queue/events.ndjson`에 원본 이벤트 저장
  - roomKey/eventHash 기준 debounce
  - 선택적으로 Supabase REST insert
  - 선택적으로 AI worker command 실행

## AI-first 경계선

코드가 하는 일:
- 감지
- dedupe/debounce
- 이벤트 저장
- AI worker 깨우기
- 실패 로그

코드가 하지 않는 일:
- 예약 문의 분류
- 날짜/장비/연락처 최종 추출
- RAG 검색 결과를 근거로 답변 자동 선택
- 구글시트 입력 여부 결정
- 카카오 답변 자동 전송

## 다음 단계

1. Chrome에서 확장 프로그램 로드
   - `chrome://extensions`
   - Developer mode ON
   - Load unpacked
   - `tools/kakao-dom-watcher-extension` 선택

2. Local bridge 실행
   ```bash
   cd tools/kakao-dom-bridge
   npm start
   ```

3. 카카오 채널 관리자 탭을 열고 새 메시지 감지 확인
   - bridge 콘솔에 `event received` / `debounced job ready` 로그가 떠야 한다.
   - `tools/kakao-dom-bridge/queue/events.ndjson`에 이벤트가 쌓여야 한다.

4. Supabase 연결
   - `.env.example`을 참고해서 `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_TABLE` 설정
   - 이 값들은 extension에 넣지 않는다. 로컬 bridge에만 둔다.

5. AI worker 연결
   - `VILLAGE_AI_WORKER_CMD`에 실제 AI 브라우저 직원 실행 명령을 설정한다.
   - bridge는 debounce가 끝난 job payload를 stdin JSON으로 넘긴다.

## 권장 Supabase event row

```json
{
  "source": "kakao_channel_manager_dom",
  "status": "pending_ai_review",
  "room_key": "browser-derived-room-key",
  "event_hash": "sha256...",
  "preview_text": "고객 메시지 일부",
  "unread_count": 1,
  "detected_at": "2026-05-24T...+09:00",
  "payload": { "raw extension event" : true }
}
```

## AI worker에 넘길 job payload

```json
{
  "jobId": "dom-room-key-timestamp",
  "reason": "kakao_channel_manager_dom_event_debounced",
  "roomKey": "...",
  "events": ["debounce 동안 모인 이벤트들"],
  "instructions": [
    "카카오 채널 관리자 브라우저 화면을 직접 열어서 해당 상담을 확인한다.",
    "코드/queue/RAG의 추론을 믿지 말고 화면 맥락을 우선한다.",
    "RAG는 필요할 때만 장기기억 도구로 사용한다.",
    "답변 자동 전송은 하지 말고 초안/처리판 기록 중심으로 처리한다."
  ]
}
```
