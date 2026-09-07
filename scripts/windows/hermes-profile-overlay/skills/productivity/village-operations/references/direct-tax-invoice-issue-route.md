# Direct registered-trade tax-invoice issue route

Use this when a staff/user asks to issue a 세금계산서 for a single already-registered Village trade and provides a business-registration PDF/image plus recipient email.

## Route

`POST https://script.google.com/macros/s/AKfycbwX2V0SqRf23DCwaVojlc5YFXKTfMNLBt68edpGmCx8j0i9hkYdP_bXHKEGIcde2iS5EA/exec`

JSON body:

```json
{
  "action": "issueTaxInvoice",
  "key": "village2026",
  "id": "거래ID",
  "amount": 26400,
  "paymentMethod": "계좌이체(VAT포함)",
  "depositStatus": "미입금",
  "invoiceeCorpNum": "490-88-02913",
  "invoiceeCorpName": "주식회사 알티스트레이블(RTSTLABEL Inc.)",
  "invoiceeCEOName": "김중구",
  "invoiceeEmail": "ivan@example.com",
  "invoiceeAddr": "주소",
  "invoiceeBizType": "업태",
  "invoiceeBizClass": "종목"
}
```

The route:

1. Requires `id`, positive `amount`, 10-digit 사업자번호, 상호, 대표자, 이메일.
2. Upserts `발행처DB` with business number/name/대표자/email/address/업태/종목.
3. Writes `거래내역` G/H/I/J/K/L/M/N/O:
   - G 상호
   - H 사업자번호
   - I 금액
   - J 결제수단
   - K `세금계산서`
   - L `발행요청` then `발행완료` on Popbill success
   - M 입금상태 from payload
   - O 관리키
4. Calls Popbill `requestTaxInvoice(row)` immediately.
5. Returns Popbill receipt fields and a summarized NTS status.

## Verification sequence

After the POST succeeds, verify both:

1. `거래내역` CSV/readback by 거래ID: business fields, amount, proof type, issue status, deposit status, note, 관리키.
2. `verifyTaxInvoiceNtsStatus` POST with the returned `mgtKey`:

```json
{
  "action": "verifyTaxInvoiceNtsStatus",
  "key": "village2026",
  "mgtKey": "관리키"
}
```

Report carefully:

- `stateCode: 300` + Popbill `code:1` means **Popbill 발행접수 / 홈택스 전송대기**, not final HomeTax confirmed.
- Only call HomeTax/국세청 confirmed when `stateCode >= 304`, `ntssendErrCode=SUC001`, and `ntsresultDT` is present.

## Practical notes

- For a request like `하현준 6월 9일 건 ... 아래 정보로 계산서 발행하자`, resolve trade first via `tradeCandidates`/dashboard and confirm the amount against the contract CSV before issuing.
- If the ledger has no payment method/status yet, choose the payload deliberately. `미입금` makes the invoice purpose `청구`; `입금완료` makes it `영수`.
- OCR/vision from a business-registration PDF is acceptable when the representative name is clear. Do not guess 대표자명.
- Apps Script POST redirects can be misleading with this route. A `curl -L`/POST attempt may return a Google Drive “현재 파일을 열 수 없습니다” HTML page even though `doPost` already executed and Popbill issuance succeeded. If the response is Drive/HTML or otherwise non-JSON after a POST, **do not immediately retry issuance**. First read back `거래내역` by 거래ID and `발행처DB` by 사업자번호; if `L=발행완료` and `O=관리키` exist, proceed directly to `verifyTaxInvoiceNtsStatus` with that 관리키. This prevents accidental duplicate issuance.
