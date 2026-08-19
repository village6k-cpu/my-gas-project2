# Registered quote: 개인사업자 + 단골 할인 preview

Use when staff says to resend a quote with `개인사업자에 단골 할인`, `사업자 할인까지 넣고 단골 할인`, or similar for an already-registered Village trade.

## Durable pattern

1. Resolve the target by phone/name/date, but let the phone number win over small name drift in screenshots.
   - Example: Kakao title/screenshot may show `강용목`, while sheets/customer history store `강용묵` for the same phone. Search by phone, then verify the matching trade/date/equipment before proceeding.
2. If the matching reservation is already registered, use the official registered-trade quote path, not a manual local quote.
3. For `개인사업자 + 단골` in the current official quote code, pass `discountType=단골` to `previewQuote`.
   - `Quote.js` maps `단골` to `사업자20% × 단골10%` and labels it `사업자20% · 단골10%`.
   - Do not pass only `개인사업자/프리랜서`; that would omit the loyal-customer 10%.
4. Generate approval-gated preview only first:
   - `GET agreement?action=previewQuote&key=...&id={거래ID}&discountType=단골`
   - Export the generated sheet CSV from `https://docs.google.com/spreadsheets/d/{fileId}/export?format=csv&gid=0` and verify item rows, discount label, and total.
   - For the returned Drive `pdfUrl`, `drive.google.com/file/d/.../view` is a preview HTML page. For local attachment verification/download, use `https://drive.google.com/uc?export=download&id={driveFileId}` and confirm the bytes start with `%PDF`.
5. Visually inspect a thumbnail when possible. Confirm it is a one-page official Village quote with legible customer name, period, discount label, item rows, and total.
6. Final report must state `고객 발송은 아직 안 했음`; send only after explicit approval.

## Calculation check

For a one-day registered quote, the combined multiplier is `0.8 × 0.9 = 0.72`; VAT total is the official template's `ceil(round(supply × 1.1), 10원)` result. Example verified in this workflow: 정가소계 115,000 → 할인 32,200 → 공급가액 82,800 → VAT 8,280 → 합계 91,080.

## Pitfalls

- Some registered schedules include top-level C-stands expanded/added separately; price visible positive-단가 schedule rows exactly as official preview CSV shows, not only the customer's shorthand list from Kakao.
- Do not report the Drive `/view` URL download as a verified PDF until a direct-download URL returns `%PDF`.
