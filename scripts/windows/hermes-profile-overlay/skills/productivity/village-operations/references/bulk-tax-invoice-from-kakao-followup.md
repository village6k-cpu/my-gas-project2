# Bulk tax-invoice issuance from Kakao/Slack follow-up cards

Use when staff says a customer sent screenshots of paid items + a business-registration file and asks to issue tax invoices for “all of them”.

## Pattern

1. Resolve the source request from Slack/AI follow-up evidence first, not just the newest ledger rows.
   - Search `ai_follow_up_items` / Slack follow-up card evidence for the customer name plus `세금계산서`, `사업자등록증`, or the recipient email.
   - The follow-up payload may contain the decisive business info and visible Kakao messages even when local downloaded attachments are missing.
   - Example evidence shape: customer asks for 세금계산서, sends `사업자 등록증.pdf`, then sends email; staff replies “위 건 전체 오늘 중으로 발행”.
2. Resolve “all paid items” to exact `거래ID` rows before issuing.
   - Use `거래내역` by customer/phone and compare the Kakao/follow-up context (dates, amounts, quote-send history, paid screenshots) to avoid issuing old unrelated rows.
   - Do not include older failed/미입금/0원 rows unless the user’s context explicitly names them.
3. Read current proof state before each issuance.
   - Skip rows already `발행완료` with a real 관리키/proof record.
   - If `L=발행완료` but no actual 관리키 exists, treat it as not proven and verify through Popbill/Finance before deciding.
4. Business-registration data may already exist in `발행처DB`.
   - If Google Visualization CSV for `발행처DB` is malformed by header/comment weirdness, export the workbook as XLSX and inspect `xl/worksheets/*.xml` + shared strings (or use an XLSX parser) to get reliable rows.
   - Public gviz/export can show the wrong sheet or flatten labels; XLSX is safer for `발행처DB` readback.
5. For each resolved trade, call the direct route:
   - `POST action=issueTaxInvoice`, `key`, `id`, `amount`, `paymentMethod`, `depositStatus`, `invoiceeCorpNum`, `invoiceeCorpName`, `invoiceeCEOName`, `invoiceeEmail`.
   - If the customer explicitly says they paid / paid screenshots were supplied, use `depositStatus=입금완료` so the invoice purpose is `영수`. Otherwise use `미입금`/`청구` deliberately.
6. Verify after issuing:
   - Re-read `거래내역` by XLSX/CSV: G/H/I/J/K/L/M/N/O should show corp info, amount, `계좌이체(VAT포함)`, `세금계산서`, `발행완료`, `입금완료` or intended status, note, and 관리키.
   - Run `verifyTaxInvoiceNtsStatus` for each 관리키.
   - Report `Popbill 발행완료/접수` separately from HomeTax/NTS final confirmation; `stateCode 300` is still `홈택스 전송대기`.
7. Close/mark done any follow-up row created for the Slack request after real verification, so backstop scanners do not re-open the same task.

## Final report shape

Keep it short:

- 대상 거래ID + amounts + 관리키/NTS approval number
- 발행처 info used
- 거래내역 readback result
- NTS status caveat (`stateCode 300` means 전송대기)
- Whether any customer-facing reply was sent
