# Post-checkout / post-payment schedule record corrections

Use when staff says an already-checked-out or already-paid reservation needs the schedule corrected only for operational/history accuracy, e.g. `이미반출 결제까지 됐는데 기록상 정확해야`, `실제로는 A 빼고 B 들고 나감`, or `세트처럼 반출함`.

## Safe workflow

1. Resolve the unique trade first.
   - Start with `tradeCandidates&name=...` and, if multiple, pick the matching active/recent checkout context.
   - Verify with `dashboardSearch` and raw `스케줄상세` search by 거래ID.
2. Treat this as a **schedule record correction**, not a fresh add-on, quote resend, or payment mutation.
   - Do **not** contact the customer.
   - Do **not** change `거래내역` payment/proof fields unless the user explicitly asks for settlement correction.
   - Do **not** regenerate/send documents by default when the user says payment is already done and the purpose is record accuracy.
3. If the real-world change is a swap of one standalone row for another, prefer updating that schedule row's `세트명` and `장비명` rather than add/remove routes that may regenerate contracts or repricing side effects.
   - Example: `라오와 12 빼고 16-35 GM 추가해서 소니 GM 줌렌즈 세트로 반출함` on an existing 24-70/70-200/라오와 record → change the 라오와 row to `소니 GM 16-35mm` so the visible top-level equipment becomes 16-35/24-70/70-200.
   - If preserving already-settled amount is part of the request, leave `단가`/ledger untouched unless specifically instructed otherwise; mention that payment/ledger was not changed.
4. Add a concise `스케줄상세` 비고 on the corrected row naming the actual correction and requester, e.g. `기록정정: 실제 반출은 라오와12 제외, 16-35GM 추가(GM 줌렌즈 구성) / 최재형 요청`.
5. Invalidate/sync the changed schedule after direct cell updates.
   - A harmless `updateStatus` call on the corrected row with its current status can mark the row dirty and refresh dashboard/timeline caches.
   - Run `formatScheduleSheet` if visual grouping/format may need refresh.
6. Verify both sides:
   - Raw `스케줄상세` rows show the corrected item names/memo.
   - `dashboardSearch` shows the corrected visible equipment.
   - Public/readable `거래내역` still shows the original payment status/amount if no financial mutation was requested.

## Report pattern

Keep it short:

- `거래ID`
- row/scheduleId changed
- before → after equipment
- final top-level equipment list
- explicit note: `결제/거래내역은 안 건드림` (or state exact financial change if user requested one)
