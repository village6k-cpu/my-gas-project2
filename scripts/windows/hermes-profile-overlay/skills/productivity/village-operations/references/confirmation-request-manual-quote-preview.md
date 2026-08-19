# Confirmation-request manual quote preview

Use this when staff asks for a quote from an unregistered inquiry/`확인요청` row such as `공강혁 6월 19일 문의들어온 건 견적서 작성해서 보내주자 개인사업자 20프로 할인`.

## Flow

1. Try registered-trade resolution first only if the wording implies an existing reservation. For `문의들어온 건` / pending inquiry, search `확인요청` by customer name and/or date.
2. Read back the full request group by `요청ID` to identify top-level requested items. Use rows where `결과` is `세트` or where the row is the initial top-level item; ignore expanded component rows for pricing.
3. Look up top-level item prices from `세트마스터` column G. Do not price expanded zero-price components.
4. Apply the requested discount explicitly. For confirmation-request rows, the dropdown value may be `개인사업자`, while the quote generator's discount label/multiplier may expect `개인사업자/프리랜서`; verify the generated CSV/PDF says `할인 (사업자20%)`.
5. If helpful for downstream consistency, update the first `확인요청` row's 할인유형 to the requested value (e.g. `개인사업자`) and read it back.
6. Create a no-customer-contact preview using the manual quote route. Current safe workaround:
   - POST `sendEstimateManual` with `manualData` and an omitted/blank `연락처`.
   - The route returns `status:"ERROR"` / `연락처가 유효하지 않습니다.` but includes `fileId`/`url`; this means the official quote sheet was generated and no customer send happened.
   - Export CSV from `https://docs.google.com/spreadsheets/d/{fileId}/export?format=csv` to verify customer, period, item rows, discount label, VAT, and total.
   - Export PDF from the same spreadsheet and attach it for approval.
   - **Important:** include the quote sheet `gid` (usually `gid=0` for this generated file) when exporting PDF. Without `gid`, Google exports the whole workbook and may include the hidden/reference equipment-price list (`장비명/단가`) as extra pages.
   - Verify the exported approval PDF page count/text before attaching; it should contain only the customer-facing quote sheet, not internal equipment-list pages.
7. Final report must say `고객 발송은 아직 안 했음` and ask for explicit approval before sending to the real phone number.

## Example calculation pattern

For 1-day inquiry:

- FX6 바디세트 60,000
- 로닌 RS4 프로 35,000
- GM 렌즈 세트 70,000
- 정가 소계 165,000
- 사업자20% 할인 33,000
- 공급가액 132,000
- VAT 13,200
- 합계 145,200

## Pitfalls

- `tradeCandidates` can return zero because the inquiry is not registered yet. Do not stop there if a pending `확인요청` exists.
- If a customer has both a registered reservation and a later/pending same-conversation `확인요청` for a different date (e.g. staff says “25일 건” but `tradeCandidates` only finds a 24–26 registered trade with earlier items), do **not** preview/send the registered quote blindly. Search `확인요청` by customer/date, read the full RQ group, and build a manual no-send preview from the pending top-level rows. Report that the registered quote would be incomplete/mismatched.
- If the request arrives as a follow-up Kakao screenshot, resolve the actual customer/name/phone from the screenshot and pending RQ, not the Slack/staff bracket label. If the customer mentions a document date that differs from the visible/RQ rental period, use the rental period for pricing and treat the other date as context only. See `references/pending-rq-kakao-quote-from-followup-screenshot.md`.
- For pending `확인요청` quotes, availability blockers are approval blockers: if a requested top-level item shows shortage or registration-blocking model-selection/unmatched rows, still create a preview when useful, but explicitly mark `고객 발송은 아직 안 했음` and surface the blocker before asking for send approval.
- The manual preview route's `ERROR` can be the expected no-send preview path when the only error is invalid/missing phone and `fileId` is present.
- Do not use `curl -L` on GAS POST redirects. POST once, capture the `Location`, then GET that URL once for the JSON response.
- If availability shows missing components such as readers/plates, report them separately as availability/system warnings; do not let those expanded components affect quote totals unless they are priced top-level items.