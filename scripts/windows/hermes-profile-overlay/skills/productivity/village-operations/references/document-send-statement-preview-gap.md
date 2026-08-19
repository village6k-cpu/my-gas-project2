# Registered-trade statement send / preview gap

Session learning from request: `[최재형] 김나영 거래명세서 발송`.

## What worked

- `my-gas-project2` `tradeCandidates` can resolve by `name` alone if no date is supplied:
  - `action=tradeCandidates&name=김나영` returned a single candidate `260605-002`.
  - Use this only when it returns exactly one non-cancelled candidate; multiple candidates still block customer-facing sends.
- Date wording in Slack may refer to the staff/request/transaction date, not the `계약마스터` 반출일 used by `tradeCandidates&date=`. Example: `6월5일 김나영 건` returned zero candidates for `date=2026-06-05`, but name-only returned `260605-002` with checkout `2026-06-06 8:00`; `date=2026-06-06` also matched. When an exact date lookup returns zero, retry `tradeCandidates` with `name` only before declaring not found; proceed only if it returns exactly one candidate and verify the returned checkout/date with `info`/ledger before any customer-facing send.
- `my-gas-project` `GET action=info&id={거래ID}` is a safe read-only verification route for registered trade/customer/date/contract link.
- `GET action=previewQuote&key=...&id={거래ID}` is a safe no-customer-contact preview route. It returns `{tradeID,fileId,sheetUrl,pdfUrl}` and the generated sheet can be exported as CSV to inspect items, discounts, VAT, and final total.
- For Apps Script POST route probing without customer contact, POST once with a nonexistent `id` using a no-redirect client, then follow the returned `Location` with GET once. A deployed API that lacks registered `sendStatement` responds with the generic allowed-action error (`action 필요 (... sendStatementManual ...)`) instead of `거래ID 없음`, proving the route is not exposed.

## Current route / pitfall

- Registered-trade **거래명세서** now has a safe preview/send path in the deployed document API:
  - `GET action=previewStatement&key=...&id={거래ID}` → creates a 거래명세서 sheet/PDF and returns `{tradeID,fileId,sheetUrl,pdfUrl}` without customer contact.
  - `POST {action:"sendStatement", key, id, fileId?}` → sends the registered-trade 거래명세서. Pass the preview `fileId` after user approval to send the exact checked sheet; without `fileId` it generates and sends a fresh statement.
- Still verify the route before customer contact when touching this workflow. A nonexistent trade ID should return `거래ID 없음`, not the generic `action 필요` / `action 파라미터 필요` route error.
- Never use `previewQuote` or a quote PDF as a registered statement stand-in.

## Safe registered statement behavior

When staff asks to send a registered-trade 거래명세서:

1. Resolve the trade with `tradeCandidates`.
2. Verify customer/date/link with `action=info`.
3. Generate `previewStatement` and inspect/export the sheet CSV or PDF to confirm title `거래명세서`, customer, period, items, supply/VAT/total.
4. Report `고객 발송은 아직 안 했음` with the preview attachment/link and ask for explicit approval.
5. Before approval send execution, verify the statement Alimtalk path will not silently SMS-fallback:
   - `STATEMENT_TEMPLATE_CODE` or script property `STATEMENT_TEMPLATE_CODE` must contain the approved 거래명세서 Alimtalk template code.
   - `sendStatementAlimtalk` must not reuse `CONTRACT_TEMPLATE_CODE` when the statement template is blank.
   - `sendStatementAlimtalk` must not set Popbill `altSendType` for 거래명세서 sends unless the user explicitly wants 문자 대체발송.
6. After approval, call `sendStatement` with the resolved `거래ID` and the preview statement `fileId`. If the approval is a later thread reply (`보내`, `발송`, etc.), recover the exact `fileId` produced by the prior preview from the same thread/session; do not silently generate/send a fresh statement unless the preview file is unavailable and you explicitly say so.
7. Verify the send in two layers before final reply: the `sendStatement` JSON response should be `status: OK`, and the 거래내역 row/note should reflect 접수/발송 state such as `로봇: 거래명세서 알림톡 발송 접수 완료 ⏳`. Report API acceptance/접수 separately from final Kakao/Alimtalk device delivery if the API only confirms receipt; `receiptNum`/`pending` is not proof that Kakao, rather than SMS, arrived.
