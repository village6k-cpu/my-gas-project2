# Registered rental plus non-trade repair invoice

Use when staff explicitly asks to issue one tax invoice for the customer's latest registered rental and another for a repair, extension, or other amount that has no `거래ID`.

## Resolve with bounded reads

Resolve the active runtime root through `windows-runtime-and-sources.md`, then use narrow live reads rather than session search or recursive source discovery:

```powershell
node.exe "<active-runtime-root>/scripts/windows/village-live-query.js" lookup --domain finance --sheet "거래내역" --query "<customer>" --limit 10
node.exe "<active-runtime-root>/scripts/windows/village-live-query.js" lookup --domain schedule --sheet "계약마스터" --query "<customer>" --limit 10
node.exe "<active-runtime-root>/scripts/windows/village-live-query.js" lookup --domain finance --sheet "발행처DB" --query "<business-number>" --limit 10
```

Pick the newest matching registered trade only after customer, rental dates, and amount agree; append order alone is not proof of the latest rental. If a truncated result does not contain enough dated candidates, raise `--limit` once up to 100. Read prior issued rows and `발행처DB` for the exact invoicee; do not guess missing business fields.

## Split the actions

1. Registered rental: use the bounded GAS `issueTaxInvoice` route in `direct-tax-invoice-issue-route.md` and read back the ledger/provider state.
2. Repair/extension amount without a trade: load the focused `village-tax-invoicing` skill and its `manual-popbill-orphan-invoice.md` reference, or use the Finance manual path. If neither reviewed path is available, report `BLOCKED`; do not inspect source and assemble an ad-hoc provider write. Generate a unique deterministic management key and read it back from Popbill.

Never overwrite a rental row with the combined rental-plus-repair amount or attach a repair charge to an unrelated trade merely to obtain a `거래ID`.

For an unpaid invoice, the Popbill payment split is `note=totalAmount`; `cash`, `chkBill`, and `credit` are integer zero. Open `popbill-registissue-field-pitfalls.md` before a direct provider call.

## Verification

- Registered rental: verify the exact `거래내역` row, management key, and provider/NTS status.
- Non-trade amount: verify by management key and state explicitly when it is not represented in `거래내역`.
- Customer messaging is a separate action. Do not send unless the current request explicitly authorizes the recipient and message.
