# Equipment investment prioritization for Village

Use when the user asks whether Village should buy/replace gear, compare purchase candidates, or decide whether a disputed used-market deal is worth pursuing.

## Data-first workflow

1. Start from live Village truth, not brand hype:
   - `스케줄상세` joined to `계약마스터` by `거래ID`.
   - `장비마스터` for owned/available/repair counts and current day rates.
   - `세트마스터` for rentable top-level set prices and canonical names.
2. Filter out cancelled/held/rejected rows (`계약상태`/row status contains 취소, 삭제, 보류, 거절).
3. For each candidate family, compute at least:
   - trade count
   - booked quantity-days (`수량 × Village rental-day rule`)
   - nominal revenue from positive `단가` rows
   - peak concurrent quantity
   - owned/available/repair count
   - recent-period trend (e.g. June+ vs whole period)
   - annualized quantity-days and annualized days per owned unit
4. Treat component rows carefully:
   - For camera/lens/light top-level demand, count representative/top-level rows (`세트명 === 장비명`) or positive-price standalone rows where possible.
   - For bottleneck accessories (monitors, batteries), component rows inside sets are meaningful; include them when the purchase target is the component.
5. Separate demand from purchase urgency:
   - If a partner/vendor can reliably supply extra units cheaply on consignment, buying more units is less urgent even if demand is high.
   - If a platform is old and a successor is expected, preserve cash for successor launch rather than buying more current bodies.
   - Lenses and durable accessories usually have lower successor risk than camera bodies.

## Interpretation pattern

- Buy first when the item is both: (a) a real schedule bottleneck and (b) durable enough that successor risk is low.
- Hold cash when demand is strong but the product line is near a refresh and external supply can cover spikes.
- Avoid “new flagship line” purchases unless live demand or a clear margin/branding test justifies it.
- For replacement cycles, compare old-stock utilization before assuming the new version solves a problem. If the old class is underutilized, replacement is branding/cosmetic, not a bottleneck fix.

## Village-specific example heuristics from the 2026-07 equipment review

- FX3/FX6 demand can be very high, but current-generation body purchases may still be lower priority when successor risk is high and Anaki/partner consignment can cover extra units.
- GM 24-70mm II is a strong first purchase candidate when 24-70 demand exceeds owned count because it directly supports Village's core FX3/GM revenue, has lower body-refresh risk, and retains value.
- GM 70-200mm II is good but lower priority if peak demand already matches owned count and 24-70 is tighter.
- For Aputure lights, check whether existing 300X utilization is actually high before replacing with STORM 400x. If 300X stock is underutilized, STORM 400x is mostly line-refresh/branding.
- If buying the new Aputure STORM line, prefer one higher-output test unit (e.g. 700x) only when it covers a real 600X/600C bottleneck, repair/reliability concern, or high-margin marketing slot.

## Disputed used-market deal overlay

When a seller breaks a confirmed used-gear deal, do not let anger drive the investment decision. First classify whether the item is a core bottleneck:

- Core bottleneck / unusually good price: preserving the deal or demanding reliance damages may be worth the effort.
- Replaceable accessory or non-bottleneck gear: pressure for actual reliance costs (adapter, cancellation fee, transport) may be reasonable, but do not over-invest time/legal energy.

Keep final recommendations blunt and business-oriented: buy/hold/sell order, not generic pros/cons.