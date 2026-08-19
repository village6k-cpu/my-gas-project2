# Document-send date mismatch: day-of-month fallback

Use this when a Village document-send request gives a customer and dates, but `tradeCandidates` returns no match for the literal month/date.

## Trigger examples

Staff/user says:

```text
박지웅 5월 8일 25일 견적서 발송
```

Literal resolver calls for `2026-05-08` and `2026-05-25` return no candidates, but name-only lookup shows unique same-day-of-month trades on `2026-06-08` and `2026-06-25`.

A Kakao/customer screenshot may also omit the month entirely, e.g. under a `2026년 7월 1일` separator the customer says:

```text
감독님 5일 8일 25일 견적서 발송 부탁드립니다
```

Do **not** assume those are July dates just because the screenshot separator is July. First try the literal/current-month dates; if they return zero and name-only lookup shows unique nearby prior-month same-day trades (e.g. `6/5`, `6/8`, `6/25` for the same customer), treat it as an inferred day-of-month fallback and preview only.

## Safe workflow

1. Try the literal dates first with `tradeCandidates&name=...&date=YYYY-MM-DD`.
2. If literal dates return zero candidates, run name-only lookup.
3. Look for unique candidates with the same day-of-month as the requested dates, especially in the nearby/current operational month.
4. If those candidates are unique, you may generate official quote previews only.
5. Do **not** customer-send on this inferred match, even if the wording says `발송`.
6. Report the mismatch bluntly:
   - “5월 8일/25일로는 거래 없음”
   - “이름 기준으로 6월 8일/25일 2건이 맞아 보여 미리보기만 생성”
   - “고객 발송은 아직 안 했음”
7. For same-customer multi-trade previews, merge the official PDFs into one combined PDF for approval, not one customer notification per trade.
8. Ask for explicit correction/approval such as `6월 맞고 보내` before any Kakao/Alimtalk/customer send.

## Why this matters

Month slips are common in short Korean staff commands. Auto-sending the inferred trade is risky because the stated date did not match the system. Preview generation is safe; customer contact is not.