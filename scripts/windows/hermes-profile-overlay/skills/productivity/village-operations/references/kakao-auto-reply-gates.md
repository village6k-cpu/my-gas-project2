# Kakao auto-reply gate lessons

Use this reference when debugging or modifying Village Kakao Channel Manager auto-replies in `C:/Village/runtimes/my-gas-project2-production/tools/ai-browser-worker/worker.mjs`.

## Durable lesson: business-hours FAQ must be a confirmed policy

Current confirmed Village policy includes:

- 영업시간 / 운영시간: **24시간 운영**

For simple FAQ questions like `영업시간이 어떻게 되나요?`, a safe proposed reply containing `24시간 운영` should be accepted as a current confirmed policy match before requiring RAG. RAG is read-only reference memory; it must not override `CURRENT_CONFIRMED_POLICY`.

## Live auto-send gate pitfall: Kakao date labels

Kakao chat-list previews can show a same-day date label such as `6월 5일` or a date chip near the message even for a newly arrived top-row customer message. Do **not** treat the regex `\d{1,2}월\s*\d{1,2}일` as automatically old/backfill.

Correct behavior:

1. Parse Korean month/day labels from preview/list text.
2. Compare them against current KST month/day.
3. Block auto-send only for non-current date labels or genuine old/backfill evidence.
4. If the top row has unread/live evidence and the date label is today, allow the live gate.
5. If a current date label is present but clock text is absent, it can still be accepted as top-row current-date evidence when paired with live top-row/change evidence.

## Policy collision pitfall: `24시간`

`24시간 운영` and rental-day calculation (`24시간=1일`, `6시간 초과 +1일`) share the token `24시간` but mean different things.

Do not let rental-day policy checks trigger from bare `24시간` in an operating-hours context. Rental-day policy should require rental/day context (`대여`, `렌탈`, `하루`, `1일 계산`, `6시간`, etc.) and should exclude `영업시간` / `운영시간` contexts.

## Verification pattern

After modifying auto-reply gates, run the full worker test file:

```bash
node --test 'C:/Village/runtimes/my-gas-project2-production/tools/ai-browser-worker/worker.test.mjs'
```

Add focused tests for both gate layers:

- `isAutoSendEligibleLiveJob`: same-day Kakao date label + unread/top-row evidence allows auto-send; non-current date labels still block.
- `currentConfirmedPolicyAutoReplySupport`: business-hours question + `24시간 운영` reply matches `business_hours_policy`.
- `evaluateAutoReplyRagSupport`: `classification: 'faq'` business-hours cases are allowed by current confirmed policy without invoking RAG.

Minimal direct probe shape:

```js
const now = new Date('2026-06-05T10:57:00.000Z'); // KST 2026-06-05 19:57
const liveGate = isAutoSendEligibleLiveJob({
  detected_at: '2026-06-05T10:57:00.000Z',
  preview_text: '중요 최필립 1 안녕하세요. 영업시간이 어떻게 되나요? 6월 5일',
  unread_count: 1,
  events: [{ reason: 'top_rows_backstop', unreadCount: 1 }]
}, { now });

const ragGate = await evaluateAutoReplyRagSupport({
  decision: {
    classification: 'faq',
    confidence: 'high',
    latest_customer_message_cluster: '안녕하세요. 영업시간이 어떻게 되나요?',
    conversation_turns: [{ speaker_type: 'customer', sender_label: '최필립', message: '안녕하세요. 영업시간이 어떻게 되나요?', time: '오후 7:57' }],
    visible_messages_used: [{ sender: '최필립', message: '안녕하세요. 영업시간이 어떻게 되나요?', time: '오후 7:57' }]
  },
  replyText: '안녕하세요! 빌리지는 24시간 운영합니다.',
  askRag: async () => { throw new Error('RAG should not be called for confirmed business-hours policy'); }
});
```

Expected result:

- `liveGate.eligible === true`
- `ragGate.allowed === true`
- `ragGate.reason === 'current_confirmed_policy_match'`
- `ragGate.currentPolicy.topics` includes `business_hours_policy`
