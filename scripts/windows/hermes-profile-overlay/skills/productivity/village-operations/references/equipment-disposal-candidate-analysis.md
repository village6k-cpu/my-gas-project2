# Equipment disposal candidate analysis

Use when the user asks what Village gear has not gone out for 1+ years, what to sell, or which items are disposal candidates.

## Data sources and precedence

1. Load Brain context first for owner criteria: disposal = long no-rental + trend decline, but complementary gear can stay.
2. Use `VILLAGE_Brain/System/equipment-truth-ledger-batch-001-latest.json` as a starting shortlist only:
   - `disposal_candidates` has historic last-rental signals.
   - `zero_match_items` is **not** proof of no rentals; it can be name-matching failure.
   - Check `coverage.date_span` / `rentals_86_period`; older raw history may end before the live schedule window.
3. Pull live `장비마스터`, `스케줄상세`, `계약마스터`, and `세트마스터` before answering.
4. Join `스케줄상세.B 거래ID` to `계약마스터.A 거래ID`; exclude cancelled/held/rejected/deleted contracts and rows.

## Validation pattern

For each Brain disposal candidate:

- Verify current stock/status in `장비마스터`: total, available, repair, state, note.
- Search live schedule since the cutoff date (usually today minus 365 days) for exact/canonical `세트명`/`장비명` matches.
- Be conservative with fuzzy token matches:
  - Good: exact normalized item name in `세트명` or `장비명`.
  - Risky: broad tokens like `GM`, `100`, `PL`, `라이트돔`, `업링`, `배터리`, because they create false positives across families.
- Component rows inside active sets can disqualify a disposal candidate if the candidate is actually a component/accessory used with a current rentable set (e.g. readers, batteries, adapters, rings). Report as “재분류/구성품성” rather than sell.
- If Brain says old last-rental but live schedule shows recent use, remove it from disposal candidates and call out the source mismatch/name drift.

## Output shape

Keep the answer short and operational:

1. `바로 매각/처분 검토` — exact no-live-use candidates with stock and last rental.
2. `창고 정리/폐기/구성품 재분류` — zero-price or component-like items.
3. `보류/애매` — repair-state, strategic/complementary, or name-match uncertain items.
4. `제외` — items that looked stale in Brain but live schedule shows recent use.

Always include the basis time/window, e.g. `7/6 00:16 KST live 장비마스터·스케줄상세 + 7/5 Brain 이력`.

## Pitfalls observed

- Brain `disposal_candidates` can be stale relative to live 2026 schedule rows. In one analysis, GM 24-70 II, GM 70-200 II, TeraDek 500LT, BMPCC 6K PRO, Sigma 50-100, and other items appeared stale historically but had recent live schedule usage.
- `zero_match_items` often includes actively used items with naming drift (FX9 body, DZOFILM, Canon 5D IV, filters, V-mount charger, baby stand, mini tripod). Do not turn it into a sell list without live exact-match verification.
- Some accessory rows have price 0 and old last rental because they are bundled components; classify for physical cleanup or set/component mapping, not necessarily sale.
