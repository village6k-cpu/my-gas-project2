# Village Slack document-send runner

Session-derived implementation notes for customer-facing document automation across the two Village GAS repos.

## Purpose

Let staff ask in plain Korean Slack text for common customer documents without mentioning repos, sheet IDs, GAS actions, or API details.

Examples:

- `6월 1일 김태완 건 견적서 발송해줘`
- `6월 1일 김태완 건 거래명세서 보내줘`
- `6월 1일 김태완 계약서 링크 알려줘`

## Architecture

- `C:\Village\runtimes\my-gas-project2-production` is the natural-language entrypoint and reservation/schedule resolver.
- `C:\Village\my-gas-project` is the document/proof/quote/statement/agreement send system.
- This runner is document-send only; do not add payment/settlement side effects here. Use the separate 정산-agent workflow for those.
- Join/handoff key: `거래ID`.
- Runner: `C:/Village/runtimes/my-gas-project2-production/tools/village-doc-send/runner.mjs`.

## Execution pattern

Dry/parse mode:

```bash
node 'C:/Village/runtimes/my-gas-project2-production/tools/village-doc-send/runner.mjs' "6월 1일 김태완 건 견적서 발송해줘"
```

Name-only fallback caveat: the deployed `tradeCandidates` API accepts `date=` blank and can resolve a single non-cancelled candidate by name, but `runner.mjs` may still return `needs_customer_and_date` for `customer_only` parsed commands. For date-missing Slack requests, call `GET {SCHEDULE_API_URL}?key=...&action=tradeCandidates&name={고객명}&date=` directly, proceed only if exactly one candidate is returned, and otherwise ask for date/selection.

Execute mode:

```bash
set -a; . 'C:/Village/village-ai/.env.finance'; set +a
export VILLAGE_SCHEDULE_API_URL="$VILLAGE2_API_URL" \
  VILLAGE_SCHEDULE_API_KEY="$VILLAGE2_API_KEY" \
  VILLAGE_DOCUMENT_API_URL="..." VILLAGE_DOCUMENT_API_KEY="..."
node 'C:/Village/runtimes/my-gas-project2-production/tools/village-doc-send/runner.mjs' "6월 1일 김태완 건 견적서 발송해줘" --execute
```

Do not write real API keys into commands shown to the user, skills, memories, or committed files.

## Observed action mapping

- 견적서 발송 → document type `estimate`, action `sendEstimate`.
- 거래명세서 발송 → document type `statement`, action `sendStatement` for registered trades; `sendStatementManual` for manual/new-inquiry statement sends from known quote context.
- 계약서 링크 → resolve and report contract link rather than inventing a send route unless the project exposes one.

## Safety/verification lessons

- Current user preference: even if staff says “발송/보내줘”, do **not** immediately customer-send Village documents. First generate/prepare a preview or draft file, show the user the generated file/summary (customer, period, items, discounts, total), and wait for explicit approval. Only after the user approves should customer-facing send execute.
- For registered-trade quote preview, resolve the trade in `my-gas-project2`, then use the 개고생2.0 GET preview endpoint (safe/no customer contact): `GET {DOCUMENT_API_URL}?action=previewQuote&key=***&id={거래ID}`. It returns `{tradeID,fileId,sheetUrl,pdfUrl}`.
  - To inspect the generated quote contents before reporting, export the returned `sheetUrl` spreadsheet as CSV: `https://docs.google.com/spreadsheets/d/{fileId}/export?format=csv`. This gives customer, rental period, item rows, discount labels/amounts, VAT, and final total without needing browser/UI.
  - To attach the PDF for Slack preview, convert the returned Drive PDF URL/file ID to a direct download: `https://drive.google.com/uc?export=download&id={pdfFileId}` and save it to `C:/Users/ssper/AppData/Local/Temp/{거래ID}_{고객명}_견적서.pdf`, then include `MEDIA:C:/Users/ssper/AppData/Local/Temp/...` in the reply.
  - Report explicitly `고객 발송은 아직 안 했음` with 거래ID, period, subtotal, discount, final VAT-included total, PDF attachment/link, and ask for explicit approval such as “보내”.
  - **Mobile/Alimtalk pitfall:** do not put the Apps Script live quote URL (`action=quote&id=...`) directly into the Alimtalk button for registered quote sends. In Kakao/mobile in-app browsers, the Apps Script iframe can try to open Google Drive inside the sandbox and show `Google Drive 액세스 권한 필요` even when the PDF is public. Customer-facing Alimtalk buttons should use the generated public Drive PDF link (or direct download URL) from `convertSheetToPdf`/`previewQuote`; keep the live endpoint for manual browser opening only after it has a click-to-open fallback, not auto-redirect.
- For registered trade **statement** preview/send requests, use only registered-trade statement routes. Current safe flow: `GET previewStatement&key=...&id={거래ID}` to create a no-customer-contact 거래명세서 sheet/PDF, inspect that the generated title is `거래명세서` / statement wording, then after explicit approval call `POST {action:"sendStatement", key, id, fileId}` so the checked preview sheet is the one sent. Never call `previewQuote` or attach a quote PDF as a statement proxy. If route verification with a nonexistent trade ID regresses to a generic action error, stop and report the route gap.
- If `tools/village-doc-send/resolver.mjs` maps statement to `sendStatement`, cross-check `my-gas-project/agreement.js` before using execute mode. A runner mapping alone is not proof that the deployed GAS action exists.
- “발송/보내줘” means the requested final intent is customer contact, but approval gate still applies. “만들어줘/확인해줘/찾아줘” should not send.
- Batch/same-customer document sends: never send one Kakao/Alimtalk per trade/document unless explicitly requested. Combine documents into one PDF and upload/send that single file through the customer chat using Kakao DOM-level automation (CDP Runtime.evaluate / kakao-dom-bridge)/manual upload; this prevents Kakao notification bombs. Treat a bare approval like `보내` on a multi-page/batch preview as approval to send **the combined PDF once**, not approval to run per-trade Alimtalk loops.
- Mixed-recipient batch quote sends: if the user says to include another customer's registered quote but send all files to one named recipient (e.g. `김태윤 건도 ... 견적서 3개 다 최민석한테 보내자`), do not use registered `sendEstimate` for the other customer's trade because it will send to that trade's registered phone. Generate no-send official previews, merge into one PDF, then upload once to the explicitly requested recipient.
- For urgent combined-PDF sends, verify the exact customer chat is open and upload the PDF file first. Do not send explanatory text before the file unless the user specifically asks; extra text can create additional notifications. If Kakao CDP/kakao-dom-bridge access is blocked by login/auth/command approval, stop and say the Kakao upload did not happen; attach the PDF back to Slack only as a fallback artifact, not as a claim of customer delivery. See `references/village-batch-quote-kakao-send.md`.
- Multiple matching candidates must block execution and ask for disambiguation.
- A nonexistent trade ID can verify a document route without contacting a real customer: the expected safe response is an API-level “거래ID 없음”.
- After any execute-mode run, report explicitly whether a real customer send happened. For Popbill Alimtalk-backed document sends, distinguish **API accepted/접수됨** from **customer device delivery confirmed**: `sendContractAlimtalk`/`sendStatementAlimtalk` commonly returns `pending` when Popbill gives a `receiptNum`, and that should be reported as “접수됨/발송 시도 완료” rather than guaranteed arrival. If the user says the customer did not receive it, treat that as a delivery failure report, resend only after the user’s explicit resend request/approval, and state that final phone delivery still may require Popbill result lookup or direct Kakao/manual link fallback.
- Registered-trade quote sends should default to a stable live quote link, not a newly generated fixed PDF link. Send Popbill only once per `거래ID + 할인유형` marker, then on later corrections/resends append `기존 견적 링크 유지 / Popbill 재호출 생략` and rely on the same link opening the latest quote. Use direct PDF Alimtalk only for combined/mixed-recipient PDFs or an explicit `forcePdfUrl`/PDF-delivery request. See `references/registered-quote-stable-link-cost-control.md`.
- Registered quote send with an ad-hoc discount: after preview approval, prefer `POST {action:"sendEstimate", key, id, discountType:"단골"}` if the deployed route supports the override. If sheet→PDF conversion fails/stalls (`거래내역` note left at `로봇: 견적서 PDF 변환 중...` or Sheets export 500/404), do **not** recreate a local layout or blindly retry. Use the already-verified official `previewQuote&discountType=...` Drive `pdfUrl` and call `POST {action:"sendEstimate", key, id, discountType:"단골", pdfUrl:<official preview PDF>}`; then verify `거래내역` 비고 becomes `로봇: 견적서 발송 완료! ✅ (PDF 링크)`.
- Manual quote resend pitfall: `sendQuoteManual()` may return success without a `pdfUrl` in the API response even though it generated and sent a PDF. Use the returned `fileId`/sheet URL to verify contents by CSV export, and if customer receipt is disputed, resend with `force:true` to bypass the 30-minute duplicate guard only when the user explicitly asks to resend/check failed delivery.
- Approved manual-quote send verification pitfall: if the real-phone `sendEstimateManual` POST returns a 302 but the redirected `script.googleusercontent.com` GET later returns `404` or otherwise cannot be read, do **not** assume failure or immediately retry with `force:true`. The POST may already have executed. Re-call the same payload without `force`; a `DUPLICATE_BLOCKED` response is a non-destructive signal that the first send was recorded. Then verify by Popbill Kakao search for the customer phone/date (`state=3`, `result=100`, `receiptNum`) and check the Drive PDF direct download returns `%PDF`. See `references/approved-manual-quote-send-verification.md`.
- For Apps Script web-app POST calls from curl, do **not** use `curl -L` directly: the first POST may already execute and then redirect to `script.googleusercontent.com`, causing confusing HTML and dangerous retries. Capture the `Location:` header from the first POST, then `GET` that URL once to read the JSON response.
- Popbill tax invoice email correction/resend: if an already-issued tax invoice only needs the recipient email changed, do **not** issue a duplicate or correction invoice. Use Popbill `POST /Taxinvoice/SELL/{mgtKey}` with header `X-HTTP-Method-Override: EMAIL` and body `{"receiver":"..."}`; see `references/popbill-taxinvoice-email-resend.md`.
- Apps Script `UrlFetchApp` quota pitfall: official quote preview/send routes use GAS outbound HTTP both for PDF export (`convertSheetToPdf`) and Popbill/Linkhub (`getPopbillAccessToken` + ATS). If GAS returns `하루에 urlfetch 서비스를 너무 많이 호출했습니다`, the customer send likely did not happen through GAS. For urgent approved sends, a controlled direct Popbill REST fallback can reuse the same template/link outside GAS quota, but must (1) use the already-approved PDF URL, (2) verify Popbill receipt/status, and (3) append/read back a ledger note because GAS side effects may have recorded only `알림톡 실패`. Treat the direct fallback as a separate operational path from normal GAS send, not as proof the GAS route is healthy.
- Manual/new-inquiry quote creation requests such as `견적서 하나 만들어줘` are **preview/draft only**, not customer-send. Build `manualData` and use a safe create/preview route when available (for example `generateQuoteManual`/manual preview action) so the user can inspect the file first. If only `sendEstimateManual` is exposed, do not use it for `만들어줘` with a valid customer phone unless the user explicitly approves customer send; instead prepare the payload and state that a send-capable route requires approval.
  - Official-template no-send workaround: the deployed `sendEstimateManual` route generates the official quote sheet before calling `sendQuoteManual()`. If `manualData.연락처`/`body.phone` is omitted or invalid, the route returns `status:"ERROR"` / `연락처가 유효하지 않습니다.` plus `fileId`/`url`, and no customer send happens. Use this only for preview creation, then export the returned sheet directly as PDF (`/spreadsheets/d/{fileId}/export?format=pdf...`) and verify visually. Report clearly that customer send did not happen and that the contact cell may be blank in the preview.
- Manual/new-inquiry quote sends can use the 개고생2.0 web app action `sendEstimateManual` after it is deployed: POST `{action:"sendEstimateManual", key, manualData:{고객명,연락처,업체명,사업자번호,할인유형,대여기간,items:[{품목,수량,일수,단가}]}}`; it calls `generateQuoteManual` then `sendQuoteManual`. Deployed version @57 adds a 30-minute duplicate-send guard (`DUPLICATE_BLOCKED`) keyed by customer phone/name/period/items; only bypass with `force=true` when the user explicitly wants a resend.
- Manual/new-inquiry statement sends can use the 개고생2.0 web app action `sendStatementManual` after deployed version @60: POST `{action:"sendStatementManual", key, force, manualData:{고객명,연락처,업체명,사업자번호,할인유형,대여기간,items:[{품목,수량,일수,단가}]}}`. It reuses the manual quote context for item math, rewrites the generated sheet title/labels to `거래명세서 / STATEMENT`, converts it with `convertStatementToPdf`, then sends through `sendStatementAlimtalk`. It has its own 30-minute duplicate-send guard; use `force=true` only after explicit approval for a resend.
- Manual quote/statement pitfall: if the staff-provided/listed item amounts are already student-discounted prices, leave `manualData.할인유형` blank. Do **not** put `학생` again, or the generated quote/statement double-applies the student discount. Long-term discount still applies from each item's `일수`.
  - Use this for Slack replies like “기간/회차 바꿔서 견적서 다시 보내줘” or “내용 똑같이 해서 거래명세서 보내줘” when there is no registered `거래ID` or when a previous manual quote/statement must be regenerated from known Kakao/session context.
  - Build `manualData.items` from top-level priced `세트마스터`/quote items only, not expanded zero-price 구성품. Each item needs `품목`, `수량`, `일수`, `단가`.
  - `대여기간` is display text only in the generated document; the amount comes from each item’s `일수` and `단가`, with Quote.js applying customer discount + long-term discount + VAT rounding.
  - For 3회차/manual examples, set every item’s `일수:3`. Set `할인유형:"학생"` only when the item 단가 is pre-discount list price and the generated document should apply student discount. If staff/user says the listed 금액 or 단가 already has student discount included, leave `할인유형` blank so only the intended long-term/VAT logic applies. Do not infer payment/settlement or create reservation rows as part of this document send.
  - Apps Script POST redirects to `script.googleusercontent.com`; avoid `curl -L` retries that can double-execute. If using a script, POST once and read the redirected JSON response exactly once.
  - For manual statements, verify the generated spreadsheet/CSV after send or preview: title should be `거래명세서\nSTATEMENT`, No. should use `S-`, date label should be `발행일자`, right-side row 9 should be `발행 구분 / 거래명세서`, and old quote validity/student-proof language should be cleared/replaced with statement notes. If a draft with quote wording accidentally went out, immediately generate/send a corrected statement and report the corrected final file distinctly.

## Preferred final response style

Short Korean bullets:

- `완료/실패/보류`
- resolved customer/date/trade ID
- document type
- whether real customer contact happened
- next required choice only if ambiguous
