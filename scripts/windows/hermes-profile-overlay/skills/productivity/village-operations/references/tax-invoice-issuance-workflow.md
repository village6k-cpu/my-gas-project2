# Village tax-invoice issuance workflow notes

Use when a customer/staff asks for `세금계산서`, `계산서 발행`, `발행요청`, or says payment depends on tax-invoice issuance.

## Safe operating sequence

1. **Resolve the customer request and trade first**
   - Open/read the customer thread or supplied text if the request came from Kakao/Slack.
   - Extract exact request facts: invoice email, requested business name, business registration number, and any attached business-registration image.
   - Resolve the registered reservation by `계약마스터`/`거래내역` using name, phone, dates, and equipment; do not assume the Kakao display suffix such as `김예지2` is the sheet name.
   - Verify the `거래ID`, customer, period, and amount before any write.

2. **Check current proof state before mutating**
   - Read `거래내역` row for the trade: G 발행처상호, H 사업자번호, I 금액, J 결제수단, K 증빙유형, L 발행상태, M 입금상태, N 비고, O 관리키.
   - If `L=발행완료` and O/관리키 indicates an actual proof record, report already done instead of reissuing.
   - If amount differs between conversation/quote/contract/거래내역, stop and report the discrepancy before issuing.

3. **Business info requirements**
   - For Popbill `requestTaxInvoice`, `발행처DB` is required: 사업자번호 → 상호, 대표자, 이메일.
   - If the row has only G/H but `발행처DB` lacks that 사업자번호, the API path can fail with `발행처DB에 사업자번호 없음`.
   - OCR from a business-registration image is acceptable for 사업자번호/상호/email when clear, but **대표자명 must be confidently read** or obtained from another reliable source before final issuance.
   - Do not invent or guess representative names from a blurry image.

4. **Two supported issuance paths**
   - **거래내역/GAS path**: fill business fields/proof type/status on `거래내역`, ensure `발행처DB` exists, then set 발행상태 to `발행요청` or call the safe issue route.
   - **Village Finance app path**: use `https://village-finance.vercel.app/invoices` for trade-based or manual issuance when logged in; it exposes trade search and `issue-from-trade` style actions. Treat UI/API confirmation dialog as the final destructive gate.
   - **Aggregate/manual Popbill path**: if staff explicitly asks for one/two tax invoices that intentionally combine multiple rental dates and there is no single safe `거래ID` row to overwrite, do not force the registered-trade `issueTaxInvoice` route onto a representative row just to satisfy the API. Use a manual/aggregate issuing path (Finance app when available, or direct Popbill API using the existing GAS Popbill constants without printing secrets), generate deterministic 관리키 values, include the dates/discounts in `detailList.remark`, and verify each key with Popbill status readback. State clearly whether `거래내역` was updated; if it was not, report the 관리키 so finance can backfill/annotate later.

5. **Customer-message separation**
   - Sending Village bankbook/business-registration files is not the same as issuing the customer’s tax invoice.
   - If a customer says `세금계산서도 요청했습니다`, do not answer by resending standard documents; handle the invoice workflow.

## Report format

Keep the report short and state exact side-effect level:

- `요청 확인`: customer request facts extracted
- `거래 매칭`: 거래ID/customer/period/amount verified
- `시트 업데이트`: which columns changed, if any
- `발행`: API/Finance issuance result, 관리키/receipt if available
- `미완료/확인 필요`: missing representative, amount mismatch, login gate, or approval gate

Never say 발행 완료 unless a real API/UI result was read back and `거래내역`/Finance state confirms completion.
