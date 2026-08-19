# Reservation financial audit: schedule vs contract vs ledger

Use when the user asks to check whether registered reservations have wrong amounts, missing charges, duplicated charges, or omitted payment/proof records.

## Core principle

Do **not** trust a single source:

- `스케줄상세` = current operational schedule/equipment rows.
- Generated contract Google Sheet = what the customer/document amount was based on at generation time.
- `거래내역` = settlement/proof/payment ledger.
- `세트마스터` = current daily prices and set names.

A mismatch between current `스케줄상세` and an already-generated contract can mean either:

1. the contract/ledger over- or under-billed, **or**
2. the schedule was later edited after contract generation.

Therefore, never immediately rewrite financial records from the current schedule alone. First identify the discrepancy and ask/verify what was actually carried out.

## Recommended workflow

1. Resolve candidate trades:
   - Specific customer/date: `tradeCandidates&name={name}&date=YYYY-MM-DD`.
   - Whole-month customer audit: search `계약마스터` by customer name, then filter by checkout month, excluding cancelled rows unless the user explicitly wants cancelled cases.
2. For each trade, read:
   - `계약마스터` by 거래ID.
   - `스케줄상세` by 거래ID.
   - `거래내역` CSV/public sheet by 거래ID.
   - Generated contract URL from `거래내역` C column if present.
3. Recalculate from `스케줄상세`:
   - Count only positive-`단가` rows as billable rows.
   - Daily subtotal = sum(`수량 × 단가`) on positive-price rows.
   - Rental days use Village rule: `ceil((totalHours - 6) / 24)`, minimum 1.
   - Discount stack is multiplicative: e.g. 개인사업자/프리랜서20% × 장기20% = `0.8 × 0.8`, not additive.
   - VAT total follows the contract formula: discount-applied subtotal × 1.1, rounded up to 10원. In integer math: `ceil(discounted * 11 / 100) * 10`.
4. Export/read the generated contract sheet when a contract link exists:
   - Extract sheet ID from `/d/{id}/`.
   - Try `https://docs.google.com/spreadsheets/d/{id}/export?format=csv`.
   - Inspect item rows, `합계`, discount rows (`사전 할인`, `장기 할인`, `추가 할인`, `쿠폰 할인`), `할인 적용 금액`, and `총 결제 금액 (VAT 10% 포함)`.
5. Compare three totals:
   - current schedule recalculation
   - contract total
   - `거래내역` amount
6. Report clearly:
   - `정상`: all three agree.
   - `금액 정상 / 상태 누락`: amount agrees but ledger payment/proof/issue/deposit fields are blank or inconsistent.
   - `장비·금액 불일치`: schedule and contract/ledger differ; list the exact rows that explain the difference.
7. Do not perform corrections, tax-invoice edits, ledger updates, or regenerated sends unless the user explicitly approves the exact side effect.

## Example discrepancy pattern

If contract/ledger show a higher total than current schedule:

- Compare contract item rows against current positive-price schedule rows.
- Look for duplicated charge rows in the contract, e.g. the same lens appearing twice.
- Look for schedule rows currently at 0원 because the set currently has no price, e.g. a set replaced by a zero-priced item after contract generation.
- State both possibilities bluntly: “계약/거래내역 과다” **or** “현재 스케줄이 나중에 바뀜”; actual carried-out equipment must decide.

## Final report style

For this user, lead with the verdict table and only then details. Good labels:

- `✅ 금액 정상`
- `⚠️ 금액/장비 불일치`
- `⚠️ 금액 정상, 증빙/입금상태 기록 누락`
- `ℹ️ 경계건: 거래 생성월과 실제 반출월 다름`

Always explicitly say whether any live mutation was performed. For audits, default is: `수정/재발행/거래내역 변경은 아직 안 했음.`
