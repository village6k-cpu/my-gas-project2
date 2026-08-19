# Village manual quote send: official GAS/Alimtalk path

Use this when the user approves sending a customer quote/estimate after preview, especially for manual estimates not tied to a `거래ID`.

## Durable workflow
1. **Do not default to Kakao DOM/manual file upload if the official quote API can send it.** For customer-facing estimates, the GAS `sendEstimateManual` action generates the official quote sheet/PDF and sends the quote via the existing Popbill Alimtalk template.
2. Build `manualData` with:
   - `고객명`
   - `연락처` (resolve from customer DB if not already known)
   - `업체명`/`사업자번호` when available
   - `할인유형` such as `단골`
   - `대여기간` such as `18회차`
   - `items: [{품목, 수량, 일수, 단가}]`
3. Call the 개고생/finance GAS webapp endpoint (`my-gas-project` / `agreement.js`) with POST JSON:
   ```json
   {
     "action": "sendEstimateManual",
     "key": "<ops-key>",
     "manualData": { ... }
   }
   ```
   Current code falls back to `VILLAGE_OPS_KEY || "village2026"`; use configured ops key when present.
4. Treat a response like the following as the send confirmation:
   ```json
   {
     "status": "OK",
     "action": "sendEstimateManual",
     "message": "<고객명>님에게 견적서 발송 완료!",
     "fileId": "...",
     "url": "https://docs.google.com/spreadsheets/d/.../edit",
     "pdfUrl": "... or empty"
   }
   ```
   `pdfUrl` can be empty because `sendQuoteManual()` only returns a message on Alimtalk success; the generated `fileId`/`url` are still useful for verification.
5. Verify the generated sheet content before reporting success. If the sheet is public-readable, `https://docs.google.com/spreadsheets/d/<fileId>/gviz/tq?tqx=out:json&sheet=견적서` can confirm key tokens such as customer name, item, discount labels, subtotal, and VAT-inclusive total.

## Customer phone lookup shortcut
For Village 2.0 customer DB, the public `gviz/tq?tqx=out:json` endpoint of the spreadsheet can expose the `고객DB`-like default table with columns:
`예약자ID(휴대폰)`, `성함`, `누적이용횟수`, `할인유형`.
Use it to resolve a unique phone match by exact customer name when the task is already approved and the phone is needed for Alimtalk sending. Do not echo the full phone in the final Slack report unless necessary.

## Verification tokens from the 김세진/OSEE case
For OSEE MEGA22S4 18회차 with `할인유형=단골`, expected quote tokens included:
- `OSEE MEGA22S4`
- `18회차`
- `720,000`
- `사업자20% · 단골10% · 장기45%`
- `313,640`

These are examples only; recalculate from the actual request each time.

## Pitfalls
- Kakao DOM/CDP/manual PDF upload may be unnecessary and more fragile for estimates. Prefer official GAS Alimtalk send when the user asked for a 견적서 and has approved sending.
- A local PDF preview generated earlier may not be the artifact actually sent by `sendEstimateManual`; verify the newly generated `fileId`/sheet if possible.
- `sendQuoteManual()` returns no `pdfUrl` on success in the current implementation, so do not interpret empty `pdfUrl` as a failed send when `status: OK` and success message are present.
