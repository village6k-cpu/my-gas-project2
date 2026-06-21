# Village Slack Document Send Automation Implementation Plan

> **For Hermes:** Use this plan when implementing Slack-thread natural-language document sending for Village.

**Goal:** Slack에서 직원이 “김OO 6/3 건 견적서 보내줘 / 거래명세서 보내줘 / 계약서 보내줘”처럼 말하면 Hermes가 거래ID를 찾고, 필요한 문서를 생성/발송/상태보고까지 처리한다.

**Architecture:** `my-gas-project2`는 예약/스케줄/계약마스터/계약서 생성의 기준 시스템으로 사용한다. `my-gas-project`는 거래내역/증빙/견적서·거래명세서·약관/팝빌 발송의 기준 시스템으로 사용한다. 두 시스템은 `거래ID`로만 연결한다. 이 채널/도구에서는 문서발송만 다루고, 결제·정산 자동화는 별도 정산-agent 채널 작업으로 분리한다.

**Tech Stack:** Google Apps Script, Google Sheets, Drive, Popbill ATS/증빙 API, Hermes Slack gateway, local repo `/Users/village6k/my-gas-project`, `/Users/village6k/my-gas-project2`.

---

## Current facts from inspection

### `/Users/village6k/my-gas-project`

- Main ledger/document project.
- Webapp URL in `CLAUDE.md`: `https://script.google.com/macros/s/AKfycbwX2V0SqRf23DCwaVojlc5YFXKTfMNLBt68edpGmCx8j0i9hkYdP_bXHKEGIcde2iS5EA/exec`
- `agreement.js` owns `doGet/doPost`.
- `doPost` already supports document-related actions:
  - `action=sendEstimate` → `sendEstimateByTradeId_(body)` → `executeSendContract(row)`
  - `action=issueProof` → `issueProofByTradeId_(body)`
  - `action=agree`
- `Code.js` contains:
  - `executeSendContract(row)` — contract spreadsheet → PDF → Popbill 알림톡 as “견적서”.
  - `generateStatement(row)` — 거래명세서 spreadsheet generation.
  - `executeSendStatement(row)` / `sendStatementByFileId(row,fileId)` — 거래명세서 PDF + 알림톡.
  - `processEquipCheckRequests()` — `장비체크` action values `견적서발송요청`, `거래명세서발송요청`, `발행요청`.
  - `requestTaxInvoice`, `requestCashbill`, `sendAgreementAlimtalk`.
- `agreement.js` has remote API for 견적서 and 증빙, but **no remote POST action for 거래명세서 yet**.

### `/Users/village6k/my-gas-project2`

- Reservation/schedule/contract source.
- Webapp URL in `AGENTS.md`: `https://script.google.com/macros/s/AKfycbyRff4-lLXmne-iPIEf87x4-CH_5wb-Uv5dCGymELLrpiKluhg2gDdLdVP4Y0MmxnnT/exec`
- `sheetAPI.js` GET API supports search/read/run and allowed functions including `insertAndCheckRequest`, `regenerateContractById`, etc.
- `generatecontract.js` generates actual contract file and calls `updateContractLink` into the first project.
- `checkAvailability.js` has dashboard/search/guide Alimtalk logic.
- `apps/follow-up-dashboard/api/follow-ups.js` already classifies `quote_send` and `payment_docs` tasks.

## Target Slack UX

Examples staff can type:

```text
김태완 내일 건 견적서 보내줘
260601-003 거래명세서 보내줘
박희철 6/3 예약 계약서 링크 보내줘
```

Hermes should:

1. Parse intent: `quote_send | statement_send | contract_link | proof_issue`.
2. Resolve target trade:
   - If 거래ID provided: use directly.
   - Else search `my-gas-project2` dashboard/contract by name/date.
   - Cross-check `my-gas-project` 거래내역 by 거래ID.
3. Validate prerequisites:
   - customer phone exists,
   - contract link exists for quote/contract/statement item extraction,
   - proof type fields exist when needed.
4. For side effects, require explicit 발송/처리 wording. A bare “만들어줘/미리보기” should not send.
5. Call the proper GAS API.
6. Verify by reading result/status back.
7. Report very short in Slack.

## Implementation tasks

### Task 1: Add remote 거래명세서 send API to `my-gas-project`

**Files:**
- Modify: `/Users/village6k/my-gas-project/agreement.js`
- Modify: `/Users/village6k/my-gas-project/Code.js` only if a wrapper is needed.

**Steps:**
1. Add `else if (body.action === "sendStatement") output = sendStatementByTradeId_(body);` to `doPost`.
2. Implement `sendStatementByTradeId_(body)` mirroring `sendEstimateByTradeId_`:
   - `requireVillageOpsKey_(body)`
   - resolve `id/tradeID/tid`
   - `findTradeRowById_`
   - call `executeSendStatement(target.row)`
   - return `{status:"OK", action:"sendStatement", tradeID, row, message}` or `{status:"ERROR", error}`.
3. Verify with a safe test row or dry-run wrapper before real customer send.
4. Deploy only after `clasp pull` per repo rule.

### Task 2: Add remote contract-link info endpoint if needed

**Files:**
- Modify: `/Users/village6k/my-gas-project/agreement.js`

**Steps:**
1. Existing `GET action=info&id=` returns contract link and agreement status. Reuse this if enough.
2. If Slack needs richer details, add `POST action=getTradeDocInfo` with key auth, returning name/phone/date/tradeID/contractLink/amount/payment/proof statuses.
3. Verify no sensitive fields beyond operational needs are exposed.

### Task 3: Build Hermes local workflow helper

**Files:**
- Create: `/Users/village6k/my-gas-project2/tools/village-doc-send/intent.mjs`
- Create: `/Users/village6k/my-gas-project2/tools/village-doc-send/resolver.mjs`
- Create: `/Users/village6k/my-gas-project2/tools/village-doc-send/runner.mjs`

**Steps:**
1. Implement intent parser for Korean command patterns.
   - Staff-friendly primary UX is **not** 거래ID input.
   - Required natural form: `6월 1일 김태완 건 견적서 발송해줘`.
   - Parser must extract: document type, send-vs-preview wording, customer name, Korean date, optional 거래ID.
2. Implement trade resolver:
   - direct 거래ID regex `\d{6}-\d{3}` only as a shortcut,
   - otherwise call my-gas-project2 `action=tradeCandidates&name={고객명}&date={YYYY-MM-DD}`,
   - if exactly one candidate exists, use its `tradeId`,
   - if zero or multiple candidates exist, **do not send**; report candidates for selection.
3. Implement actions:
   - quote → `my-gas-project` POST `sendEstimate`,
   - statement → POST `sendStatement`,
   - contract link → GET/POST info, no customer send unless requested,
   - proof → POST `issueProof` after proof type check.
4. Print compact JSON result for Hermes to summarize.

**Current implementation status:**
- `intent.mjs`, `resolver.mjs`, `runner.mjs` created.
- Verified example: `6월 1일 김태완 건 견적서 발송해줘` resolves to one candidate `260528-005` via `tradeCandidates` and plans `sendEstimate`.
- `runner.mjs --execute` now performs the full pipeline: parse → resolve unique trade → call `my-gas-project` document API.
- Safety verified: `6월 1일 김태완 건 견적서 만들어줘 --execute` resolves `260528-005` but returns `not_send_request` without calling document send, because the wording is preview/create rather than 발송/보내줘.
- Added support for relative dates (`오늘/내일/모레`) so staff can say `김태완 내일 건 견적서 보내줘`.
- Added safe contract-link route: `계약서 링크 보내줘` resolves the trade and calls `GET action=info` rather than trying an unsupported customer-send action.
- Added proof issue routing: `증빙/세금계산서/현금영수증 발행/처리/요청` maps to `issueProof`; `증빙 확인해줘` remains non-side-effect preview/blocked.
- 결제수단/입금/정산 변경은 이 문서발송 도구 범위에서 제외한다. 문서발송 명령에 결제 표현이 섞여도 `setPayment` 같은 결제 side effect는 실행하지 않는다.

### Task 4: Add tests for parsing/resolution safety

**Files:**
- Create: `/Users/village6k/my-gas-project2/test/village-doc-send-parser.test.js` or Python unittest.

**Cases:**
- `260601-003 견적서 보내줘` → quote + send + tradeID.
- `김태완 내일 건 거래명세서 보내줘` → statement + needs resolver.
- `김태완 계약서 링크 알려줘` → contract_link + no customer send.
- `견적서 만들어줘` → preview/create only, no send.
- Ambiguous multiple trade candidates → do not send; report candidates.

### Task 5: Deploy GAS changes safely

**Rules:**
- For `my-gas-project`: `clasp pull` before any `clasp push`.
- For `my-gas-project2`: use scripts/worktree rules in `AGENTS.md`; do not deploy from feature branch.

**Verification:**
- Call `sendEstimate` on a known test trade only if approved.
- Call `sendStatement` on a test trade only if approved.
- Read back `거래내역 N열 비고` / returned message.

## Slack final response format

```text
✅ 처리 완료
- 고객/거래ID: 김OO / 260601-003
- 문서: 견적서
- 결과: 알림톡 접수 완료
- 주의: 계약서 링크 없음/전화번호 없음 등
```

## Safety

- Never send to customer unless the staff command explicitly includes `보내줘/발송/카톡`.
- If multiple candidate trades match, stop and ask one short choice question.
- Do not use `목록` for final equipment names; use `세트마스터` in my-gas-project2.
- Do not reshape sheet columns.
- Do not expose Popbill keys/secrets in Slack output.
