# Village payment ledger map

Session-derived notes for future Village 결제/정산/미수금 work.

## Correction that matters

The first instinct to design prepayment gates was wrong. The user corrected that Village usually takes payment at:

- `반출` handoff, or
- `반납` / final settlement.

Therefore, prevention means enforcing/checking payment status at those operational moments, not blocking every reservation until prepaid.

## Two-project model

### 1. `my-gas-project2`

Local project path:

```text
C:\Village\runtimes\my-gas-project2-production
```

Role:

- Confirmation request intake
- Reservation registration
- Contract generation
- Schedule detail
- Today dashboard / timeline
- API glue to Village 2.0 / 개고생2.0

Known sheets from project docs/code:

- `확인요청`
- `계약마스터`
- `스케줄상세`
- `장비마스터`
- `세트마스터`
- `실사기록`

### 2. Village 2.0 / 개고생2.0 Google Sheets

Role:

- Actual payment/settlement ledger
- Customer/payment proof/billing state
- Must be read directly via Google Workspace OAuth for serious payment analysis.

`my-gas-project2` accesses it via Apps Script property:

```js
개고생2_URL
```

and opens sheet:

```js
거래내역
```

## Join key

Use `거래ID` to connect operational and payment data.

```text
계약마스터 A열       = 거래ID
스케줄상세 B열       = 거래ID
거래내역 E열         = 거래ID
```

## Ledger columns seen from integration code

The integration reads/writes these `거래내역` columns:

```text
A 날짜
B 예약자명
C 계약서링크
D 입금자명
E 거래ID
F 연락처
G 발행처 상호
J 결제수단
K 증빙유형
L 발행상태
M 입금상태
N 비고
```

Key code references in `checkAvailability.js` at time of discovery:

- Around `3400`: reads extra payment fields for dashboard.
- Around `3503`: opens `개고생2_URL` and `거래내역`.
- Around `3510-3517`: maps E/C/G/J/K/L/M/N-like columns.
- Around `4114`: fallback deposit statuses: `미입금`, `입금완료`, `부분입금`, `환불`.
- Around `4345`: `updateTradePaymentMethod()` writes today-dashboard payment method to J.
- Around `4397`: `카드결제` side effect can set K/L/M.

## Risk heuristics

Use schedule timing plus ledger state.

### Likely OK

```text
M 입금상태 = 입금완료
```

### Record-completion issues

```text
J 결제수단 present + M empty
M 입금완료 + J empty
```

These may be missed status entry rather than real 미수.

### 미수 candidates

```text
반납일 passed + M empty
반납일 passed + M 미입금
반납일 passed + M 부분입금
```

### Needs separate handling

```text
M 환불
K/L 증빙 상태 incomplete
N 비고 with exception text
```

These are not automatically receivables; inspect context.

## Slack 결제방 design implication

The channel should be framed as:

```text
반출/반납 결제 확인방
```

not merely:

```text
미수금 사후관리방
```

Daily automations should produce:

1. Today’s 반출 건 with current J/M status.
2. Today’s 반납 건 with current J/M status.
3. Overdue 반납 where M is blank/미입금/부분입금.
4. Inconsistent ledger rows requiring cleanup.
5. Existing long-tail 미수 queue only after prevention gates are visible.

## Auth note

The user chose **Google Workspace OAuth direct read access** over adding a GAS read-only proxy API, because Hermes needs to understand both projects directly. If auth is missing, guide through Drive + Sheets OAuth setup instead of falling back to guesses.
