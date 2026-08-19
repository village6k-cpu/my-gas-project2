# Approved month-slip batch quote: send one combined PDF

Use this when a prior document-date-mismatch quote preview was generated for multiple same-customer trades, and the user later replies with approval such as `보내라고` / `보내` in the same Slack thread.

## Pattern observed

Original staff request may have a month slip, e.g. `박지웅 5월 8일 25일 견적서 발송`, while resolver finds no May trades but unique June same-day-of-month trades. The safe first step is preview-only with a combined PDF. If the user later explicitly approves the inferred dates, customer contact is now allowed.

## Safe send workflow

1. Recover the exact approved preview context from the Slack thread/session:
   - trade IDs, customer, totals, and the combined PDF path/link from the prior preview.
   - If the local combined PDF still exists under `/tmp/...`, verify it is a real multi-page PDF and inspect text/pages enough to confirm the included trade IDs/totals.
2. Do **not** run per-trade `sendEstimate` in a loop. That would create multiple customer notifications.
3. Upload the combined PDF to Drive and make it public/link-readable.
   - If no higher-level helper exists, the clasp OAuth token in `~/.clasprc.json` can be used with Drive API `files.create` multipart upload and `permissions.create {type:anyone, role:reader}`.
   - Verify the direct download URL returns `%PDF` before sending.
4. Send the combined PDF once using a registered trade send route against one of the target customer's trades:
   - `POST {action:"sendEstimate", key, id:<first trade ID>, pdfUrl:<combined public PDF URL>}`
   - This uses that trade row only to resolve the registered customer phone/name, while the button/link points to the combined PDF.
5. Verify:
   - API response `status:"OK"` / message says the customer send was accepted.
   - `거래내역` note on the trade used for sending changes to `로봇: 견적서 발송 완료! ✅ (PDF 링크)`.
   - Do not expect every included trade row to get a ledger note when only one combined notification was sent; report this clearly if relevant.
6. Final report should say `합본 PDF 1개로 발송 처리`, list included trade IDs, and distinguish Popbill/API acceptance from final device delivery if not separately audited.

## Pitfalls

- A bare later approval like `보내라고` applies to the previously shown combined preview in that thread; do not re-resolve to a different trade set unless the prior artifact is missing or ambiguous.
- If the prior mismatch was only inferred and the later approval does not explicitly restate the corrected month, the approval can still be accepted when it is a direct reply to the mismatch-preview thread and the preview text clearly asked for approval such as `6월 맞고 보내`.
- Sending through the first trade ID means only that row's `거래내역` note may show the send. This is expected for a combined one-notification send, not evidence that the other included PDF was omitted.
- If customer receipt is disputed, audit Popbill Kakao history by phone/name/date rather than relying on Kakao Channel Manager placeholder bubbles.