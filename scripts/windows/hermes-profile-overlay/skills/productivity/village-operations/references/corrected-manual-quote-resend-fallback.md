# Corrected manual quote resend after failed Kakao attachment

Use this when a manual quote/견적서 was previewed, then corrected (date/period/items), and a later Kakao attachment send is disputed or not visible.

## Core lesson

Do **not** treat local Kakao CUA/manual-send attachment results as final delivery proof. A result such as `sent_via_chrome_verified_with_cua_attachments`, `files_selected_and_send_clicked_via_cua`, or `file_selected_return_pressed_via_cua` can still fail to produce a customer-visible file bubble. If the user says it did not send, accept that as ground truth and retry via an official/traceable route.

## Safer fallback: official GAS/Popbill Alimtalk route

1. Rebuild the exact corrected manual quote payload from the prior preview:
   - customer name/phone
   - corrected quote date and validity date if requested
   - corrected rental period
   - same top-level items, qty, days, unit prices, and discount type
2. Generate the official quote sheet with `generateQuoteManual(manualData)`.
3. Patch the generated sheet cells, not a local PDF only, when the customer-facing document date must differ from today:
   - `A2:D2` = quote number, e.g. `No. Q-260625-1027`
   - `E2:I2` = `견적일자: YYYY-MM-DD`
   - For the current template, row mapping is:
     - `G8:I8` = 대여 기간
     - `G9:I9` = 견적 유효기간
   - Verify by CSV export after the patch; do not guess cell rows from the visual PDF.
4. Convert the patched sheet via the existing official `convertSheetToPdf(fileId, quoteNo, customerName, 2)` so Drive sharing is set by Apps Script.
5. Send with `sendContractAlimtalk(phoneDigits, customerName, '', pdfLink)`.
6. Treat `pending` as Popbill/Alimtalk 접수, not guaranteed device receipt. Report `접수됨` and include the corrected PDF back to Slack if useful.
7. Verify:
   - CSV contains corrected quote date, rental period, validity, phone, discount, and total.
   - Drive direct-download URL (`https://drive.google.com/uc?export=download&id=<pdfFileId>`) returns `%PDF`.

## Implementation caution

If you temporarily expose a web-app action or helper to run this fallback, remove the route/file and redeploy immediately after success. Do not leave one-off customer-specific routes in `agreement.js` or the GAS project.

## Reporting pattern

- Start by acknowledging the prior overclaim if the user challenged delivery.
- Separate `직접 카카오 첨부 실패/미확인` from `알림톡 접수 완료`.
- Do not say “고객 수신 확인” unless Popbill delivery result or visible Kakao evidence proves it.