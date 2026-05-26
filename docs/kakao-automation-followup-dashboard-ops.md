# Kakao automation follow-up dashboard operations

## 현재 자동화 형태

이 자동화는 아직 하나의 설치형 앱이 아니라 여러 부품이 연결된 자동화 시스템이다.

1. 네 맥의 Chrome에서 카카오톡 채널관리자 화면을 열어둔다.
2. Chrome 확장 프로그램 `tools/kakao-dom-watcher-extension`이 채팅 목록의 새 메시지를 감지한다.
3. 로컬 bridge 서버 `tools/kakao-dom-bridge`가 `http://127.0.0.1:8787`에서 확장 프로그램 이벤트를 받는다.
4. AI worker `tools/ai-browser-worker`가 Chrome의 카카오 채팅방을 열고 고객 메시지, 직원 메시지, 시트 입력 필요 여부, 후속조치 업무를 판단한다.
5. Supabase가 처리 queue, AI 처리 결과, 후속조치 업무 카드를 저장한다.
6. Vercel 대시보드 `apps/follow-up-dashboard`가 Supabase의 후속조치 업무를 모바일/다른 PC에서 볼 수 있게 보여준다.

## 어디에 존재하는가?

- Chrome 확장 프로그램: `tools/kakao-dom-watcher-extension`
- 로컬 bridge 서버: `tools/kakao-dom-bridge`
- AI worker: `tools/ai-browser-worker`
- Supabase schema: `tools/kakao-dom-bridge/supabase-schema.sql`
- 원격 후속조치 대시보드: `apps/follow-up-dashboard`

## 어디서 실행되는가?

- Chrome 확장 프로그램, bridge 서버, AI worker는 카카오 채널관리자에 로그인된 맥에서 실행된다.
- Supabase는 인터넷 DB로 실행된다.
- 후속조치 대시보드는 Vercel에 배포되어 브라우저에서 접속한다.

## 어떻게 켜는가?

1. Supabase SQL Editor에서 `tools/kakao-dom-bridge/supabase-schema.sql` 전체를 실행한다.
2. Supabase에서 `ai_processing_events`, `ai_follow_up_items` 테이블이 생성되었는지 확인한다.
3. `tools/kakao-dom-bridge/.env`에 최소 환경변수를 설정한다.

```env
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
SUPABASE_TABLE=ai_processing_events
SUPABASE_FOLLOW_UP_TABLE=ai_follow_up_items
```

4. 카카오 채널관리자에 로그인된 Chrome을 열고 `tools/kakao-dom-watcher-extension` 확장 프로그램을 로드한다.
5. bridge 서버를 실행한다.

```bash
cd tools/kakao-dom-bridge
npm run start
```

6. AI worker를 별도 터미널에서 실행한다. 운영에서는 job 처리 주기를 별도 launchd/cron/터미널 루프로 감싼다.

```bash
cd tools/ai-browser-worker
node worker.mjs --once
```

## 어떻게 끄는가?

- bridge 서버 터미널에서 `Ctrl+C`를 누른다.
- AI worker 터미널 또는 실행 루프를 종료한다.
- Chrome 확장 프로그램 관리 화면에서 watcher 확장 프로그램을 끄거나 제거한다.
- 긴급 정지는 `.env`의 Supabase 키를 제거하거나 bridge/worker 프로세스를 중지하는 방식이 가장 확실하다.

## 맥이 꺼지면 어떻게 되는가?

- 맥에서 실행되는 Chrome 확장 프로그램, bridge 서버, AI worker는 모두 멈춘다.
- Supabase와 Vercel 대시보드는 계속 살아 있지만 새 카카오 이벤트 수집과 AI 처리는 진행되지 않는다.
- 맥을 다시 켠 뒤 Chrome 카카오 로그인 상태를 확인하고 bridge 서버와 AI worker를 다시 실행해야 한다.
- 맥이 꺼져 있는 동안 이미 Supabase에 들어간 후속조치 카드는 대시보드에서 계속 볼 수 있다.

## Chrome/Kakao 로그인은 필요한가?

필요하다. AI worker는 실제 Chrome 화면의 카카오 채널관리자 대화를 읽기 때문에 해당 맥의 Chrome이 카카오 채널관리자에 로그인되어 있어야 한다. 로그아웃, 세션 만료, 권한 팝업, 개별 채팅 팝업 포커스 문제는 worker 처리를 막을 수 있다.

## 대시보드는 어디서 보는가?

대시보드는 `apps/follow-up-dashboard`를 Vercel에 배포한 URL에서 본다.

예:

```text
https://your-project.vercel.app
```

Vercel 환경변수:

```env
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
SUPABASE_FOLLOW_UP_TABLE=ai_follow_up_items
DASHBOARD_TOKEN=choose-a-private-dashboard-token
```

브라우저에서 처음 접속하면 `Dashboard token` 입력칸에 `DASHBOARD_TOKEN` 값을 넣고 저장한다.

## 문제 생기면 어디를 확인하는가?

- Chrome 확장 프로그램: `chrome://extensions`의 service worker/콘솔 로그, 확장 프로그램 권한, 카카오 채널관리자 탭 상태
- bridge 서버: `tools/kakao-dom-bridge` 터미널 로그, `http://127.0.0.1:8787/health`
- AI worker: `tools/ai-browser-worker` 터미널 로그, Hermes 실행 가능 여부, Chrome 접근 권한, Kakao 로그인 상태
- Supabase queue: `ai_processing_events.status`, `error_message`, `payload.ai_worker_result`
- 후속조치 카드: `ai_follow_up_items.status`, `priority`, `type`, `follow_up_key`
- Vercel 대시보드: Vercel Function logs, `/api/follow-ups` 응답, `DASHBOARD_TOKEN` 불일치 여부

## Supabase SQL 적용

적용 파일:

```text
tools/kakao-dom-bridge/supabase-schema.sql
```

SQL Editor에서 전체 실행한다. 이 파일은 다음을 생성/갱신한다.

- `ai_processing_events`: 카카오 DOM 이벤트와 AI 처리 상태 queue
- `ai_follow_up_items`: AI가 만든 후속조치 업무 카드
- 상태/우선순위/고객명 조회용 index
- `updated_at`, `completed_at` 자동 갱신 trigger
- 두 테이블의 RLS 활성화

서비스 역할 키는 bridge, AI worker, Vercel 서버 함수에서만 사용한다. Chrome 확장 프로그램이나 브라우저 JS에 노출하지 않는다.

## Fake decision smoke test

Supabase SQL 적용 후 follow-up insert만 확인할 때는 시트 쓰기를 끈 fake decision을 사용한다.

```bash
cd tools/ai-browser-worker
cat > /tmp/village-fake-followup-decision.json <<'JSON'
{
  "classification": "reservation_inquiry",
  "confidence": "high",
  "reason": "Smoke test for follow-up insert only.",
  "should_write_to_sheet": false,
  "customer": { "name": "스모크테스트" },
  "follow_up_items": [
    {
      "type": "reply_needed",
      "priority": "high",
      "status": "open",
      "title": "스모크테스트 답변 필요",
      "summary": "follow-up dashboard insert 확인용 카드",
      "recommended_action": "대시보드에서 카드가 보이는지 확인",
      "evidence": ["fake decision smoke test"]
    }
  ]
}
JSON

printf '%s\n' '{"id":"00000000-0000-0000-0000-000000000001","room_key":"followup-smoke-test","preview_text":"follow-up smoke test","payload":{"customerName":"스모크테스트"}}' \
  | node worker.mjs --stdin-job --fake-decision /tmp/village-fake-followup-decision.json
```

성공 기준:

- 명령 결과의 `followUpResult.inserted`가 `1` 이상이다.
- Supabase `ai_follow_up_items`에 `customer_name = '스모크테스트'` 행이 생긴다.
- Vercel 대시보드의 열린 업무 목록에 해당 카드가 보인다.

## Vercel 배포

```bash
cd apps/follow-up-dashboard
npm install
npx vercel
npx vercel env add SUPABASE_URL
npx vercel env add SUPABASE_SERVICE_ROLE_KEY
npx vercel env add SUPABASE_FOLLOW_UP_TABLE
npx vercel env add DASHBOARD_TOKEN
npx vercel --prod
```

배포 후 확인:

1. Vercel이 출력한 production URL에 접속한다.
2. `Dashboard token`에 `DASHBOARD_TOKEN` 값을 입력하고 저장한다.
3. 열린 업무 목록이 로드되는지 확인한다.
4. 모바일/다른 PC에서 같은 URL로 접속해 목록과 상태 변경 버튼이 동작하는지 확인한다.

## 로컬 검증 명령

```bash
cd tools/ai-browser-worker
npm test
npm run check

cd ../kakao-dom-bridge
npm run check

cd ../../apps/follow-up-dashboard
npm run check
```
