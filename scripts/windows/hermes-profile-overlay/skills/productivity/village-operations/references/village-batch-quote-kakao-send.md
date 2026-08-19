# Village batch quote Kakao send pitfall

Use when a staff/user asks to send many quote documents for one customer (e.g. months of unpaid registered trades).

## Correct workflow

1. Generate/verify the quote files with the official GAS quote template, not a recreated local layout.
2. If multiple trades belong to the same customer, merge them into one combined PDF and get/recognize approval for that single artifact.
3. On approval (`보내`, `업로드해`, etc.), upload exactly one combined PDF to the customer Kakao chat via Kakao/CUA/manual file upload.
4. Do not call registered-trade `sendEstimate` or Popbill Alimtalk in a loop unless the user explicitly says to send each trade separately.
5. If a batch includes a quote whose registered customer differs from the requested recipient (e.g. include `김태윤` quote but send all 3 PDFs to `최민석`), **never** use the registered send route for that quote: it will target the registered customer/phone. Generate a no-send official preview for each registered trade, generate no-send manual previews for pending RQ/unregistered items, merge the PDFs, then upload the combined PDF once to the explicitly requested recipient's Kakao room.
6. For pending-RQ/manual quote corrections inside the batch, keep using the official manual template/no-send workaround. Example durable case: replace `셔틀러 비디오20` with the exact `세트마스터` item `셔틀러에이스 M (75볼)` and recalculate before merging; do not just rename a prior PDF.
7. Verify customer-facing delivery from the Kakao chat body: new file placeholder/`저장하기` count/file row in the exact customer chat. Helper success or a Slack attachment is not proof the customer received the file.

## Failure handling

- If automation Chrome is on a Kakao login screen, login/auth/2FA is a blocker. Do not type secrets or try staff-only Chrome. Report that Kakao upload did not happen and attach the PDF to Slack only as a fallback for the user to use.
- If a previous mistaken per-trade send already happened, do not send apology/follow-up text without explicit instruction; it adds more notifications.
- Prefer file-first, text-second. For urgent correction uploads, file-only is usually safest.

## Regression guard

For any future same-customer batch document task, ask yourself before sending: “Will this create more than one customer notification?” If yes, stop and combine/upload once unless explicitly requested otherwise.
