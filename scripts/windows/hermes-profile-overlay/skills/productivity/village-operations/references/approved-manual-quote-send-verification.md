# Approved manual quote send verification

Use when a prior no-send manual quote preview is approved later with a short reply such as `보내`.

## Pattern

1. Recover the exact approved preview payload from the Slack thread/session: customer, phone, discount, period, items, quantities, days, and unit prices.
2. Call the deployed document API `sendEstimateManual` with the real phone **once**. For GAS web-app POSTs, do not use `curl -L`; capture the 302 `Location` and then GET that URL once for the JSON response.
3. If the POST executes but the redirected `script.googleusercontent.com` GET returns transient `404`, do **not** immediately POST again. The POST may already have generated and sent the quote before the redirect failed.
4. Retry the same payload without `force` only as a safety probe:
   - `DUPLICATE_BLOCKED` within 30 minutes means the first real-phone send was recorded by the deployed route.
   - Treat it as strong evidence that the send executed; do not bypass with `force` unless the user explicitly asks for a resend.
5. Verify with Popbill Kakao search by phone/date:
   - Query the customer phone for the send window.
   - Confirm a quote-like ATS row with customer name/content, `state=3`, `result=100`, and a `receiptNum`.
   - Extract the Drive PDF link from the content/alt message when available.
6. Verify the Drive PDF link is public/usable by checking the direct download endpoint returns `%PDF`.
7. Report briefly: sent/accepted, customer, amount/context, Popbill state/result/receipt, and PDF accessibility. Distinguish API accepted/Popbill processed from customer-device final reading.

## Pitfalls

- A failed redirect read after POST is not proof that the send failed. The side effect can already be complete.
- `DUPLICATE_BLOCKED` is useful as a non-destructive verification probe; it prevents accidental double sends.
- Never use `force=true` just to get a cleaner JSON response after an uncertain POST. That can create a duplicate customer notification.
- For manual quote sends, the API may omit `pdfUrl` even on success; Popbill content/Drive link search is often the best verification handle.
- Do not mistake the Slack approval-card attachment path for customer delivery. Slack `send_message` may omit `MEDIA:` attachments on Slack; that is only staff-facing preview/reporting, not Kakao/Alimtalk customer send. Once the user replies `보내`/`보내라고` in the preview thread, execute the official customer send route.
- When the approved preview was generated through `sendEstimateManual` with blank/invalid phone (`status: ERROR` + `fileId`), the approval-time real-phone send should call `sendEstimateManual` again with the recovered `manualData`. Expect a **new** `fileId` for the actually-sent quote; verify that fresh sheet/CSV/PDF, not only the earlier preview artifact.
- Rental-round policy mismatch guard: project2 registration/contract generation uses the current **3-hour grace** policy (introduced by commit `92f7078`), while an older registered-quote path in project1 `Quote.js` may still apply **6 hours**. For a period that falls between those boundaries, do not send the registered preview blindly. Verify the live trade `회차` and current policy, then use the official manual quote template with explicit `일수`, first blank-phone preview, CSV/PDF readback, then one real-phone send. Do not "fix" only 계약마스터 회차: `generatecontract.js` recalculates days directly from dates using the 3-hour rule.
