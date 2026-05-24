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

## 실행

```bash
cd tools/kakao-dom-bridge
npm start
```

상태 확인:

```bash
curl http://127.0.0.1:8787/health
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
