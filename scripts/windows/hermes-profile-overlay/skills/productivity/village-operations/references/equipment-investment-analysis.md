# Village equipment investment / capex analysis notes

Use this when the user asks whether to buy camera, lens, monitor, or lighting gear for Village.

## Evidence to pull

- Read live `장비마스터`, `세트마스터`, `스케줄상세`, and `계약마스터`.
- Join `스케줄상세.B 거래ID` to `계약마스터.A 거래ID`; exclude cancelled/held/rejected/deleted contracts and rows.
- For each candidate item/class, calculate:
  - current stock / available / repair notes from `장비마스터`
  - day rate from `세트마스터` or positive-price `스케줄상세` rows
  - trade count, row count, quantity rental-days, nominal scheduled revenue
  - peak concurrent quantity over the inspected period
  - recent-period count, usually last month/current month
  - annualized rental-days per owned unit, but label it as rough
- Treat expanded set component rows with zero price as dependency/availability evidence, not direct revenue.
- If the candidate is new and has no history, compare against the closest existing substitute class.

## Durable heuristics from July 2026 analysis

- The strongest buy signal is **persistent peak demand above owned stock** plus high rental-days per unit, not “new product hype.”
- For Village, Sony small-body + GM lens demand is structurally stronger than speculative lighting upgrades.
- `소니 GM 24-70mm II` is a clean capex candidate when short: directly supports the FX3/A7S3 revenue core, has lower model-cycle risk than bodies, and keeps resale value.
- Additional current-generation FX3/FX6 bodies are less attractive when successor bodies are near and Village can source temporary units via trusted consignment; preserve cash for successors unless a very cheap unit appears.
- A new A7-series body such as A7M5/A7 V can be bought as **one test unit** to refresh A7S3/FX3 substitution, but do not buy multiple units until rental demand is proven.
- For Aputure STORM upgrades, distinguish:
  - `400x`: mostly a 300X refresh; weak if existing 300X stock is underutilized.
  - `700x`: better first test unit because it can absorb 600X/600C/600D demand and create a new high-output Aputure option.
  - `1200x`: only if strong discount or repeated 1200-class requests exist; Village already having a 1200-class unit means it may cannibalize rather than open a new class.
- For customer-dispute/purchase-opportunity situations, only escalate/legal-pressure a broken seller promise if the item is a clear priority/bargain. If it is just a monitor/accessory/substitutable item, limit pressure to actual reliance costs such as adapter cancellation/return fees.

## Report shape

Keep the answer blunt and business-oriented:

1. `결론` — buy / do not buy / one test unit only.
2. `왜` — 3–5 bullets from actual Village schedule/inventory evidence.
3. `우선순위` — rank against other active candidates.
4. `조건` — price ceiling, one-unit limit, or resale/consignment caveat.
5. Avoid long generic camera-spec essays unless specs materially affect Village rental demand or pricing.
