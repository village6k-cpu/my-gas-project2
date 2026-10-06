# Registered trade selected set components and custom daily pricing

Use this branch only when all requested equipment is an exact subset of one
existing `세트마스터` catalog set and staff has approved an exact daily unit
price. Truly unknown or unregistered equipment remains blocked; this route does
not create catalog entries or guess component aliases.

## Required evidence

- Read the current trade and preserve its exact `expectedPeriod`.
- Resolve the set name, current catalog price, and each component name and
  quantity from live `세트마스터` data.
- Preserve explicit staff approval as `staffApproval`. Slack evidence uses
  `source: "slack_staff_confirmed"` plus the exact `sourceMessageId`; Kakao staff
  evidence uses `source: "kakao_staff_confirmed"` plus its conversation revision.
- Keep `sendEstimate:false` unless a separate customer-delivery approval exists.

## Add-entry contract

Supply one `add` entry with this exact shape inside the normal one-call
`village-registered-trade-correction.js` request:

```json
{
  "name": "exact catalog set name",
  "qty": 1,
  "expectedCatalogUnitPrice": 200000,
  "unitPrice": 150000,
  "pricingBasis": "daily_unit_price",
  "selectedComponents": [
    { "name": "exact catalog component name", "qty": 1 },
    { "name": "another exact catalog component name", "qty": 2 }
  ]
}
```

`expectedCatalogUnitPrice` is a stale-state fence, not the approved price.
`unitPrice` is the approved one-day price written only on the new set header.
Every selected component name and quantity must exactly match that set's current
catalog definition; omitted components are intentionally not scheduled.

## Completion gate

Execute once. Authoritative readback must prove the new set header has the
approved `unitPrice`, the component multiset is exactly `selectedComponents`,
the regenerated contract amount equals the ledger amount, and
`customerNotificationSent` is false. On timeout or uncertain outcome, read back
the same trade before any retry.
