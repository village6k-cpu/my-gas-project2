# Schedule correction: exact trade restore and narrow mutation

Use this when a staff correction targets an already-registered trade and the user is frustrated about unintended edits.

## Lessons

- If the user names an exact 거래ID (including Slack auto-link text such as `<tel:260624-006|260624-006>`), that ID wins over date/status inference. Do not switch to another same-customer trade because wording says `지난 건`, `이미 반출`, or `결제까지 됨`.
- Before mutation, read the whole `스케줄상세` group for that 거래ID and preserve all unrelated rows. A correction such as `라오와 12 빼고 16-35 추가해서 GM 줌렌즈 세트` means: replace/cancel only the named lens row or restore the known set representation; it does not authorize dropping FX6, gimbal, accessories, or other unrelated top-level rows.
- If a mistake already happened, first restore the user-named trade to its prior known complete state. Then undo any unintended edits to other trades. Report both separately and tersely.
- Useful recovery source: past session/tool output and Slack/document previews may contain a complete prior dashboard snapshot. For `260624-006`, the prior complete headers were: `소니 FX6 바디세트`, `소니 GM 렌즈 세트(16-35, 24-70, 70-200)`, `로닌 RS4 프로`, `로닌 듀얼 그립`, `반사판`, with expanded rows `-01..-13`.
- When the deployed API cannot insert/delete arbitrary row counts directly, a practical restore path is: use existing schedule add APIs to recreate rows in order, then `write` exact A:M values over the inserted rows to restore set/component metadata and prices; finish with `formatScheduleSheet` and a harmless status update/cache invalidation.

## Verification checklist

1. `스케줄상세` search by exact 거래ID shows the expected full row count and names.
2. `dashboardSearch` by exact 거래ID shows the expected header items.
3. Any wrongly-touched other trade is restored and verified separately.
4. `거래내역` payment/proof columns remain unchanged unless explicitly requested.
5. If contract regeneration happens incidentally from schedule repair, verify the ledger amount/link, but do not customer-send documents unless explicitly approved.
