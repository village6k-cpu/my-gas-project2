# Bulk Kakao confirmation-request triage

Use when the user gives several customer names and asks to check Kakao/Slack/sheets and enter `확인요청` only if needed.

## Goal
Avoid both false duplicate RQs and false “done” reports. The durable pattern is to cross-check live-ish Kakao evidence, prior worker decisions, and sheet registration state before mutating.

## Recommended sequence

1. **Start from operational tasks and worker results**
   - In `C:\Village\village-kakao-ai`, run `scripts/list-operation-tasks.js list --all --q <name>` to find unresolved historical cards.
   - In `tools/kakao-dom-bridge/queue/worker-results.ndjson`, stream/filter by name and parse the nested `result.stdout` JSON when possible. Worker decisions often contain the important reason: existing `거래ID`, already answered, or unable to open chat.

2. **Use Kakao DOM queue as evidence, not as proof of reservation**
   - `events.ndjson` top-row entries are useful for latest preview/unread state (`중요 성치훈 1 감사합니다!`, `백운찬 네~!`, etc.).
   - A short preview like `네`, `감사합니다`, `네~!` is not enough to create an RQ. It only tells you the room needs/needed inspection.
   - If the full conversation cannot be opened/read, report `본문 미확인 → 임의 입력 보류` rather than guessing reservation details from a preview.

3. **Resolve existing registrations before inserting**
   - Query `계약마스터`/`스케줄상세` by customer name and, when known, phone/date/trade ID.
   - If a matching registered trade exists for the same customer/date/equipment context, do not create a confirmation request. Report the `거래ID` as the reason for no mutation.
   - If the only sheet evidence is an unrelated component-row warning mentioning the customer (e.g. an availability conflict detail names another customer), do not treat that as the target customer’s RQ.

4. **Check `확인요청`, but do not over-trust one query shape**
   - Search by request ID/trade ID when known, and by customer/phone when possible.
   - If gviz label mapping or API read ranges are confusing, inspect raw rows/column positions: A=reqID, K=예약자명, L=연락처. Some read routes may return data without a header row; do not assume row 1 is headers.

5. **Mutation rule**
   - Only insert `확인요청` when there is enough reservation-format data (customer + phone/unique DB match + period + equipment) and duplicate checks are clear.
   - For names with only preview evidence or already-registered trades, final answer should explicitly say `신규 입력 없음` and why for each name.

## Report pattern

Keep it short:

- `신규 입력한 건 없음/입력함: RQ-...`
- Per customer: `✅ 거래ID 이미 있음`, `⚠️ 본문 미확인/미리보기뿐`, or `📝 RQ 입력`.
- Distinguish `시트에 없음` from `카카오 본문 못 열어서 보류`.
