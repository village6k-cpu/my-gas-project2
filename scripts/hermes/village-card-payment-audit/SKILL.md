---
name: village-card-payment-audit
description: Read actual Village card approvals, cancellations and duplicate charges (카드 결제 두 번, 중복 결제, 승인번호, 취소 확인).
platforms: [macos, windows, linux]
metadata:
  hermes:
    tags: [village, payments, card, audit]
---

# Village card payment audit

For card payment/duplicate charge questions, run this read-only command first.
It reads the current GAS billed amount and the canonical `village` payment
schema over HTTPS, including allocations, distinct receipts, processor aliases
and cancellation events. It does not refund, change records, or send messages.

```sh
node "$HERMES_HOME/skills/productivity/village-card-payment-audit/scripts/audit.cjs" --customer "CUSTOMER" --checkout-date YYYY-MM-DD
node "$HERMES_HOME/skills/productivity/village-card-payment-audit/scripts/audit.cjs" --trade-id YYMMDD-NNN
```

The runtime already sets `VILLAGE_FINANCE_ENV`. If absent, supply `--env-file`
with the existing finance configuration file from the current runtime. Never
print/copy credentials into commands or answers. No package installation or
direct PostgreSQL connection is required.

- `--checkout-date` means the rental checkout date, not the payment date. All
  associated approvals are returned even if paid on another date.
- Names can match multiple trades. Check each returned customer/date/trade ID;
  never merge them or assume the first is correct. Empty results are not proof
  of no card payment; use the existing reservation lookup to resolve the trade.
- Report the current charge, each distinct approval number, amount, approval
  time in Korea, cancellation status, and excess received. Use `receipt_id` to
  deduplicate terminal/Toss aliases; two aliases are not two payments.
- `providerVerified` means a matching stored Toss approval identity exists.
  Cancellation state is the current ingested ledger state, not a new query to
  the card issuer. State that distinction if freshness is disputed.
- `activeCardAllocated` is the amount assigned to this trade; an approval may
  be shared across trades. `activeCardReceiptTotal` is not automatically the
  amount owed for this reservation. `openingPaid` is historical balance evidence,
  not an observed approval. Do not manufacture missing approvals.
- `billingChanged`, `reviewRequired`, receipt `reviewReason`, or mismatch
  warnings require reconciliation before a definitive overpayment conclusion.
- Two distinct active processor-backed approvals attributable to one intended
  charge plus excess received support a duplicate-charge finding. Different
  amounts or unresolved associations require further reconciliation.
- Lead the reply with the finding. Do not request customer screenshots before
  trying this command. On failure, report the specific unavailable source and
  request only the evidence still missing. Do not call the generic finance
  Sheet search: the reservation API has no `거래내역` or `발행처DB` sheets.
- Never cancel/refund or send a customer/Slack message as part of this audit.
  A separate explicit instruction is required for those actions.
