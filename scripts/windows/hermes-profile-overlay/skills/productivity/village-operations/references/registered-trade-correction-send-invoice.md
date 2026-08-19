# Registered trade correction + quote send + tax-invoice verification

Use this when a registered Village reservation has a confirmed equipment correction and the user asks to update documents, send quotes, and issue/verify 세금계산서.

## Safe sequence

1. **Resolve and verify current rows first**
   - Resolve `거래ID` via `tradeCandidates` / `dashboardSearch` / `스케줄상세`.
   - Read `스케줄상세` rows and identify current top-level positive-price rows.
   - If the user confirms real carried-out equipment, use that as the source of truth before regenerating documents.

2. **Correct schedule only if needed**
   - If `스케줄상세` already matches the confirmed carried-out equipment, do not rewrite it.
   - Example learning: a prior audit thought `260518-001` had `300C`, but current `스케줄상세` already showed `어퓨쳐 300X` and `소니 GM 70-200mm II` quantity 1. The correct action was **contract regeneration**, not schedule mutation.

3. **Regenerate the contract through the schedule project**
   - Use the reservation/schedule web app `run` route with `func=regenerateContractById` and args `{tradeId}`.
   - Verify returned summary: customer, rental period, `totalBeforeDiscount`, `discountedAmount`, `finalAmount`.
   - Re-read Village 2.0 `거래내역` C/E/G:O after regeneration to confirm the contract link and amount changed.

4. **Generate/verify official quote preview before customer send**
   - Use the document web app `GET previewQuote&key=...&id={거래ID}`.
   - Export the returned `fileId` spreadsheet as CSV and verify:
     - customer / phone / period
     - item rows, especially corrected items
     - discount label and totals
     - final `합계 (VAT 포함)`
   - If the user already explicitly approved “전체 다 발송”, then customer-send may proceed after verification; otherwise keep the normal approval gate.

5. **Send official quotes**
   - Use document web app `POST {action:"sendEstimate", key, id}`.
   - Avoid `curl -L`/auto-follow retry patterns for Apps Script POSTs. POST once; if it redirects, read the returned `Location` via GET once.
   - Report API acceptance/접수 as document send completion; final device delivery may still need Popbill Kakao status lookup if disputed.

6. **Tax-invoice handling**
   - First read `거래내역` G:O for 발행처, 사업자번호, 금액, 결제수단, 증빙유형, 발행상태, 입금상태, 비고, 관리키.
   - Beware: O열 `관리키` may contain non-proof markers such as `알림톡발송완료`. For 세금계산서, `L=발행완료` + bogus O marker is not enough proof of actual invoice state.
   - Use Popbill lookup/search when needed. REST pattern observed for searching seller tax invoices:
     - `GET https://popbill.linkhub.co.kr/Taxinvoice/SELL` with bearer token and query params like `DType=W`, `SDate=YYYYMMDD`, `EDate=YYYYMMDD`, `QString={buyer business number without hyphens}`, `Page=1`, `PerPage=100`, `Order=D`.
     - Response `list` contains `invoicerMgtKey`, `invoiceeCorpName`, `invoiceeCorpNum`, `writeDate`, `issueDT`, `stateCode`, `supplyCostTotal`, `taxTotal`, `ntsconfirmNum`, and sometimes `modifyCode`.
   - For an already-issued wrong amount, do not issue a duplicate normal invoice. Issue/corroborate the appropriate 수정세금계산서 path and verify the corrected positive/negative records by Popbill search.
   - If the document API `issueProof` skips because it sees `발행완료` + any O value, manually verify whether O is a real Popbill management key before trusting the skip.

## Example math verification pattern

For confirmed 4-day 개인사업자/프리랜서 trade:

```text
정가소계 × 사업자20% × 장기20% × VAT
960,000 × 0.8 × 0.8 × 1.1 = 675,840
860,000 × 0.8 × 0.8 × 1.1 = 605,440
```

Quote CSV should show matching rows such as:

- corrected `어퓨쳐 300X`, not `아마란 300C`
- `소니 GM 70-200mm II` quantity 1 when only one lens went out
- discount label `사업자20% · 장기20%`

## Final report checklist

Keep it short:

- corrected trade IDs and final amounts
- quote-send status per trade
- tax-invoice status/Popbill correction status per trade
- ledger warnings left unresolved, especially blank `입금상태`
- explicitly mention any trade excluded by period 기준 (e.g. created in May but checkout in June)
