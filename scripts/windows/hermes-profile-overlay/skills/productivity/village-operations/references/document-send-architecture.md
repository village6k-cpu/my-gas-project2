# Village document-send architecture (my-gas-project + my-gas-project2)

Use this when the user wants Slack/Hermes to send customer-facing Village documents: 견적서, 거래명세서, 계약서 링크/약관, or proof-document follow-up.

Important boundary: this workflow is document-send only. 결제/정산 side effects such as payment method changes belong in the separate 정산-agent workflow.

## Two-repo split

- `C:\Village\runtimes\my-gas-project2-production` is the reservation/schedule/contract-generation source of truth.
  - Key sheets: `확인요청`, `스케줄상세`, `계약마스터`, `세트마스터`.
  - Key files: `sheetAPI.js`, `checkAvailability.js`, `generatecontract.js`.
  - Webapp API in AGENTS.md supports `search`, dashboard/operations data, and `run` functions such as `insertAndCheckRequest`, `regenerateContractById`.
- `C:\Village\my-gas-project` is the ledger/document-send/Popbill source of truth.
  - Key sheet: `거래내역`.
  - Key files: `Code.js`, `agreement.js`, `StatementSidebar.html`, `Sidebar.html`.
  - `agreement.js` owns `doGet/doPost` for external calls; `Code.js` owns the actual sheet/PDF/Popbill logic.

Join the two systems by `거래ID` only.

## Current document capabilities found in code

In `my-gas-project/Code.js`:

- `executeSendContract(row)` converts the contract spreadsheet to PDF and sends it as the customer-facing `견적서` Alimtalk.
- `generateStatement(row)` creates a 거래명세서 spreadsheet.
- `executeSendStatement(row)` / `sendStatementByFileId(row, fileId)` create/send 거래명세서 PDF + Alimtalk.
- `requestTaxInvoice(row)` and `requestCashbill(row, idType)` issue proof documents through Popbill.
- `sendAgreementAlimtalk()` sends the 약관 동의 Alimtalk from the selected row.
- `processEquipCheckRequests()` also consumes `장비체크` action values: `견적서발송요청`, `거래명세서발송요청`, `발행요청`.

In `my-gas-project/agreement.js`:

- `POST action=sendEstimate` already calls `sendEstimateByTradeId_()` → `executeSendContract(row)`.
- `POST action=issueProof` calls `issueProofByTradeId_()`.
- `GET action=info&id=거래ID` returns agreement/contract-link info.
- If `sendStatement` is absent, add a wrapper mirroring `sendEstimateByTradeId_()` that calls `executeSendStatement(target.row)`.

## Slack/Hermes routing pattern

1. Parse intent:
   - `견적서 보내줘/발송` → quote send (`sendEstimate`).
   - `거래명세서 보내줘/발송` → statement send (`sendStatement`, if deployed).
   - `계약서 링크 알려줘` → info/link only, not customer send.
   - `세금계산서/현금영수증 발행` → proof issue (`issueProof`) after proof type/status check.
2. Resolve trade:
   - Direct `YYMMDD-NNN` 거래ID wins.
   - Otherwise search `my-gas-project2` by customer/date via dashboard/search/계약마스터.
   - Cross-check `my-gas-project` `거래내역` by 거래ID before document side effects.
3. Validate prerequisites before sending:
   - customer phone exists,
   - contract link exists when PDF extraction or contract-link send is needed,
   - proof type/payment status are set for proof issuing,
   - no multiple ambiguous candidate trades.
4. Side-effect safety:
   - Only send to customers when the user explicitly says `보내줘`, `발송`, `카톡`, etc.
   - A request to `만들어줘`, `작성`, or `링크 알려줘` is not permission to send.
5. Report in very short Korean: customer/tradeID, document, result, unresolved warning.

## Deployment caution

For `my-gas-project`, never `clasp push` before `clasp pull` because GAS editor changes may be overwritten. If `clasp` is unavailable, leave the local change un-deployed and report that clearly; do not invent a deployment path.
