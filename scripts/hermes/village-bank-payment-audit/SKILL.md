---
name: village-bank-payment-audit
description: "Look up authoritative Village bank receipt originals for 입금 확인, 대체 입금자, or reconciling a staff payment request."
---

# Village bank receipt lookup

For a bank payment confirmation, run the scoped lookup before asking for the
amount or concluding that the original cannot be found.

```sh
node "$HERMES_HOME/skills/productivity/village-bank-payment-audit/scripts/audit.cjs" --payer '입금자명' --date YYYY-MM-DD
```

Use the actual alternate payer from the conversation and the Korean date of
the transfer. Add `--amount 254961` only when the transfer amount is already
known. The existing `VILLAGE_FINANCE_ENV` supplies server credentials.

- The bank's primary sender display is matched separately from the bank channel
  and transaction type. Do not compare the concatenated payer label by equality.
- A single receipt can verify the bank transfer. Confirm the separate
  reservation, billing basis, and allocation before calling it fully paid.
- Zero results means no matching original was present for that date at read
  time. A recent SMS or customer report may arrive before bank collection.
  Recheck when staff follows up. Transport errors are lookup failures, never
  evidence of no payment.
- For a staff-authorized allocation, use the canonical receipt allocation and
  projection workflow in `village-receivables-audit`. Do not use this read
  helper to issue documents, change balances, or send a message.
