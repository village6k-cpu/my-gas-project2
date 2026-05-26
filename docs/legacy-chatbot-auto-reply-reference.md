# Legacy Kakao chatbot auto-reply reference

Reference only. Do not copy this blindly into Hermes Chrome automation.

## Existing `village-kakao-ai` flow

- Kakao sends customer messages to `POST /kakao/skill`.
- The server stores the payload, then branches operator commands / board commands / reservation forms / customer profile flows.
- General customer inquiries enter `buildCustomerAiResponse()` in `src/kakao.js`.
- Answer generator priority: `answerCustomerWithAi` -> `answerCustomerWithRag` -> default customer-analysis agent.
- The default agent loads recent Kakao history from Supabase and builds `conversationCapture`; it does not answer from only the newest sentence.
- AI output is normalized to `{ text, meta, analysis, conversationCapture }`.
- `canAutoSendCustomerAnswer()` in `src/customer-reply-policy.js` decides whether the generated answer is allowed to send.
- Fast path: if the answer finishes inside the Kakao skill timeout, return `simpleText` immediately.
- Slow path: if `callbackUrl` exists, return `useCallback: true`, then later `postKakaoCallbackReply()` POSTs `simpleText` to callback URL.
- Sent auto-replies are logged to `village_customer_replies` with `status=sent`, `approvedBy=ai_auto_reply`, `source=auto_ai`.

## Borrowable ideas

Use only as support around AI judgment:

1. `conversationCapture`
   - Hermes should capture recent visible Chrome Kakao turns, speaker labels, staff/customer separation, latest customer cluster, latest staff reply.

2. Normalized answer schema
   - Future auto-reply phase can use: `{ text, confidence, replyMode, shouldCreateTask, reason, evidence }`.

3. Reply modes
   - `auto_send`: AI believes it is safe to send under kill-switch/policy.
   - `draft_only`: create dashboard/task and draft only.
   - `no_reply`: no customer reply needed.

4. Send gate
   - `confidence=no_match` => never send.
   - `replyMode=draft_only/no_reply` => never send.
   - Empty/too-short answer => never send.
   - Kill switch must be respected.
   - Follow-up tasks may still be created even if a reply is auto-sent.

5. Logging
   - If Chrome auto-send is implemented, log sent text, customer, room evidence, confidence, replyMode, source, and send result.

## Do not copy blindly

- Do not let deterministic code classify customer intent or decide reply content.
- Do not treat `canAutoSendCustomerAnswer()` as a replacement for AI judgment; it is only a safety/consistency check over AI-produced fields.
- Do not send from preview text only.
- Do not assume server-side chatbot/API conversations are visible in the Chrome Kakao Channel Manager UI.
- Do not weaken confirmation boundaries: no automatic booking confirmation, availability assertion, final price/discount assertion, refund/payment/repair commitment, or registration unless an approved flow exists.

## Hermes Chrome adaptation

Minimum future components if auto-send is implemented:

```text
captureKakaoConversationFromChrome() -> conversationCapture
generateCustomerAnswer(conversationCapture) -> { text, confidence, replyMode, shouldCreateTask, evidence }
canAutoSendCustomerAnswer(answer, policyContext) -> boolean
sendKakaoMessageViaChrome(text) -> actual Chrome/Kakao send, only when enabled
logAutoReplySent(...)
```

The Chrome send phase must be explicitly enabled/tested. Until then, produce `suggested_reply_draft` and follow-up tasks.

## Absolute principles to preserve

- AI-first: AI reads conversation evidence and makes business judgment.
- Recent conversation context matters; never answer from the latest sentence alone.
- Staff/customer turn separation is mandatory.
- Reservation-format inquiries go to `확인요청` aggressively; equipment normalization failure is not a blocker.
- Human-review rows are reversible; do not over-block them.
- Auto-send, if enabled, must respect replyMode/confidence/kill-switch and must log what was sent.
