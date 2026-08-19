# Village payment / 미수금 prevention notes

Session learning: do **not** assume a generic 선결제 rental model for Village.

## Correct operational model

Village mostly takes payment at one of two operational gates:

1. **반출 시 결제** — customer pays when picking up / receiving equipment.
2. **반납 시 결제** — customer pays at return after final rental duration and any additions are known.

Therefore, 미수금 prevention should not start with “예약 확정 전 결제 없으면 확정 금지.” That framing mismatches the business. The root prevention point is making payment state visible and actionable at the actual handoff/return moments.

## Current system evidence from `my-gas-project2`

- `확인요청` captures requested reservation details: 반출일/시간, 반납일/시간, equipment, customer/contact/company, registration state, 거래ID.
- Registration writes `계약마스터` A~L with: 거래ID, 예약자명, 연락처, 업체명/별명 blank, 반출일/시간, 반납일/시간, 회차, 상태=`예약`, 할인유형, 비고.
- Registration writes `스케줄상세` rows with: 스케줄ID, 거래ID, 세트명/장비명, 수량, 반출일/시간, 반납일/시간, 상태, 비고, 단가, 예약자명.
- Registration also writes to 개고생2.0 `거래내역`: 날짜=반출일, 예약자명, 거래ID, 연락처.
- Existing dashboards and follow-up logic already classify text containing `입금|결제|미수|환불` as `payment_check` and `결제|계약|견적|정산|서류|거래명세|세금계산|계산서` as payment/docs.

## Design principle for future work

Treat **빌리지 2.0 / 개고생2.0 `거래내역` as the payment and settlement source of truth first**, not a side note. `my-gas-project2` provides the reservation/반출/반납 operational schedule; `거래내역` provides the actual 결제수단, 입금상태, 증빙, 발행상태, 비고.

Join key:

- `계약마스터` A열: 거래ID
- `스케줄상세` B열: 거래ID
- `거래내역` E열: 거래ID(자동)

Known `거래내역` columns from the Village 2.0 sheet:

- A 날짜
- B 예약자명
- C 계약서 링크
- D 입금자명
- E 거래ID(자동)
- F 예약자ID(자동) / 연락처
- G 발행처 상호
- H 발행처ID(사업자번호)
- I 금액
- J 결제 수단
- K 증빙 유형
- L 발행요청 / 발행상태
- M 입금 상태
- N 비고
- O 관리키
- P 약관동의일시
- Q 소개자이름
- R ID

Only add a separate **결제관리 / payment tracking layer keyed by 거래ID** if the existing `거래내역` cannot safely represent the needed workflow. Avoid casually changing existing `계약마스터` or `스케줄상세` columns; they are hot operational sheets.

## Google Drive / Sheets access pattern

Village systems are heavily Google Drive/Sheets backed. Treat these as first-class project data, like repo files or operational DB tables.

Do **not** start by saying OAuth is required. First try the existing project-native routes:

1. Search repo/manual/code for `docs.google.com/spreadsheets/d/`, `SpreadsheetApp.openByUrl`, `SpreadsheetApp.openById`, `*_URL`, and sheet names.
2. For read access, try CSV export:
   - `https://docs.google.com/spreadsheets/d/{spreadsheetId}/export?format=csv&gid={gid}`
3. For write access, prefer existing safe project paths:
   - `sheetAPI.js` actions
   - GAS webapp `run` functions
   - AppSheet/GAS functions already used by the dashboard
   - narrowly scoped update functions that preserve side effects/validations
4. Use Google Workspace OAuth only if no project-native read/write path exists.

Known Village 2.0 / 개고생2.0 `거래내역` read route:

- spreadsheet ID: `1ssb6EyuRRCU04Zf4UAtdbpYYkWcseGqnhWVONdrqol8`
- gid: `186038316`
- CSV export is readable and exposes the payment ledger.

Writing should not be done by blind cell edits if an existing function carries side effects. Example from `my-gas-project2`: `updateTradePaymentMethod(tid, method)` writes `거래내역` J열 and, for `카드결제`, also sets K/L/M follow-up values.

## Slack 결제방 behavior

When operating in a Slack channel dedicated to payment/미수금:

- Treat it as a **반출/반납 결제 확인방**, not a generic receivables report room.
- Daily or on request, derive queues from actual dates:
  - 오늘 반출 예정 건
  - 오늘 반납 예정 건
  - 반출/반납 시간이 지났는데 결제 상태가 미확인인 건
  - 반납 이후 최종결제상태가 미수/대기인 건
- Report states in operational language:
  - `오늘 반출 예정`
  - `반출 결제 예정`
  - `반출 결제 확인 완료`
  - `반출 결제 미확인`
  - `결제 미확인 반출됨`
  - `오늘 반납 예정`
  - `반납 정산 필요`
  - `추가금 확인 필요`
  - `반납 결제 확인 완료`
  - `반납 결제 미확인`
  - `미수 발생`
  - `회수 완료`

## Pitfall

If the user asks for “근본적인 미수금 해결,” do not jump to after-the-fact collection lists **or** to generic upfront payment gates. First inspect/anchor to Village’s real process: payment usually happens at 반출 or 반납, so the structural fix is payment-confirmation gates at those moments plus exception tracking.
