# Follow-up Slack calculation pitfalls

Use this when debugging Village Slack follow-up cards that show impossible `계산` amounts for reservation/document/tax-invoice tasks.

## Z90 / expanded component double-count pattern

Symptom example:

- Slack card shows `RQ ... · 110,010원` for a same-day `소니 Z90` 1대 request.
- Card lists both:
  - `소니 Z90 x1: 세트`
  - `메모리*1 / 배터리*2 / 앞캡 / 렌즈 후드 x1: 미등록 장비`

Root cause:

1. The 확인요청 / availability result contains an expanded component bundle row for the set.
2. The operational calculation enrichment searches `세트마스터` with that component-bundle string.
3. GAS search is substring-like and may return the parent set row (`소니 Z90`, 단가 50,000).
4. If the calculator accepts non-exact search hits, it prices the component bundle as another parent set, double-counting the set.

Correct behavior:

- Only price a 확인요청 row from `세트마스터` when the returned `세트명` exactly equals the queried row name.
- Treat expanded component bundle rows as unresolved/zero-price support rows, not billable parent sets.
- For registered schedules, use `스케줄상세` positive `단가` rows only; zero-price component rows are not separate billable items.

## VAT +10 floating-point tail

Symptom:

- Exact amounts such as `50,000 × 1.1` display as `55,010원`, or `100,000 × 1.1` displays as `110,010원`.

Root cause:

- JavaScript floating-point math can produce `55000.00000000001`; then `Math.ceil(vat / 10) * 10` rounds up by an extra 10원.

Correct behavior:

```js
const vatIncludedRaw = discountedAmount * 1.1;
const finalVatIncluded = Math.ceil((vatIncludedRaw - 1e-6) / 10) * 10;
```

## Triage checklist

When a user says a Slack-card amount is impossible:

1. Read the thread/card text: identify whether the card is using RQ calculation or registered 거래ID calculation.
2. Verify the real schedule/contract source:
   - `계약마스터` by `거래ID` for customer, period, status, 할인유형.
   - `스케줄상세` by `거래ID`; only rows with positive `단가` are billable.
   - `세트마스터` exact `세트명` for pre-registration RQ rows.
3. Check for duplicate RQ IDs in the card. Do not sum stale duplicate RQs as the customer-facing amount without verifying which one is current.
4. Compare customer-stated payment amount against system discount state. Example: `소니 Z90` 50,000원 same-day with 20% discount + VAT = 44,000원, even if 계약마스터 still says `일반`.
5. If fixing code, add a regression test with an expanded component row that substring-matches its parent set and assert it is not double-counted.
