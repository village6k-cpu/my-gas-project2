# Follow-up Slack routing guards

Use this when Village DOM watcher / ai-browser-worker follow-up cards are routed to the wrong Slack agent channel.

## Durable routing lessons

- Treat `type` as the primary route signal. Reservation/schedule classes such as `reservation_review`, `schedule_check`, and `sheet_duplicate_check` should default to `스케쥴-agent`.
- Do not let internal lookup evidence hijack routing. Phrases like `계약마스터 조회`, `계약마스터 최근 예약 조회`, `스케줄상세 조회`, or other sheet/table names are operational evidence, not customer intent.
- Document routing should require explicit document-send intent, e.g. `계약서`, `견적서`, `서류 발송/요청/작성/생성`, `거래명세`, `세금계산서`, `현금영수증`, or `증빙 발송/요청/작성/생성`. The document channel is not a catch-all for words like `견적` inside operational cards.
- Avoid broad regexes like `/계약|견적|서류/` over the full combined title/summary/evidence text. They misclassify reservation cards because `계약마스터` contains `계약`, and damage/schedule cards because they may mention `견적서 확인` as a secondary follow-up.
- Same-conversation follow-ups should update the existing active row or post as a Slack thread reply under the prior card. Do not create another top-level standalone card for each follow-up fragment.
- 카카오 target-mismatch diagnostic cards should stay in `기타문의` even if the preview text mentions `입금` or other settlement words; preview text in mismatch diagnostics is not the actual active customer request.

## Regression pattern

Add or keep route-level tests around `routeFollowUpToSlack()`:

```js
assert.deepEqual(routeFollowUpToSlack({
  type: 'reservation_review',
  title: '김정혜 DJI 무선마이크 당일 예약 확인요청 입력 및 18시 수령 안내',
  summary: '확인요청 RQ-260609-004 가용확인 결과...',
  evidence: ['계약마스터 조회: 거래ID ..., 예약 상태']
}), { route: 'schedule', channel: '스케쥴-agent' });
```

Also keep a mismatch diagnostic case:

```js
assert.deepEqual(routeFollowUpToSlack({
  type: 'reply_needed',
  title: '대상 카카오 대화 확인 불가',
  summary: "잡 프리뷰는 '입금드릴게요'였지만 현재 열린 카카오 대화가 다름"
}), { route: 'other', channel: '기타문의' });
```

## Investigation checklist for “why did this land in X channel?”

1. Search the Slack thread/message text first to capture the exact title, `type`, summary, and misleading keywords. For example, a card titled `대상 카카오 대화 확인 불가` with a quoted job preview containing `입금드릴게요` is a mismatch diagnostic, not a settlement request.
2. Inspect `tools/ai-browser-worker/worker.mjs::routeFollowUpToSlack()` and nearby guard helpers (`isKakaoTargetMismatchDiagnostic`, document/payment route regexes). Fix the deterministic route guard before blaming the LLM or Slack.
3. Add a route regression that reproduces the exact misroute class, not only the specific customer. For mismatch diagnostics, include settlement/payment words in the preview and assert `{ route: 'other', channel: '기타문의' }`.
4. If the live bridge was down, restarting it may be part of an “improve system now” request; otherwise avoid starting live automation for a pure code inspection because it can enable live worker/auto-send.

## Verification and deployment checks

1. Run syntax and focused route tests first:
   - `node --check tools/ai-browser-worker/worker.mjs`
   - `node --test tools/ai-browser-worker/worker.test.mjs --test-name-pattern 'routeFollowUpToSlack'`
2. Run bridge/static checks that cover Slack follow-up actions when routing touches Slack cards:
   - `node --check tools/kakao-dom-bridge/server.mjs`
   - `node --test test/slack-follow-up-actions.static.test.js`
3. Run the broader focused suite when the fix touches watcher/bridge/Slack-card behavior:
   - `node --test test/kakao-dom-noise-guards.static.test.js test/slack-follow-up-actions.static.test.js tools/ai-browser-worker/worker.test.mjs`
4. For live reflection, use `scripts/kakao-automation status` before restarting. If the bridge is not running, do not start live automation just to deploy a pure code fix unless the user explicitly asks or the request is to improve the running system immediately, because startup may enable live worker/auto-send.
5. Remember: Slack `chat.update` updates an existing message in its current channel; it does not move a card between channels. Already-misrouted cards need separate repost/delete/migration handling if the user wants cleanup.
