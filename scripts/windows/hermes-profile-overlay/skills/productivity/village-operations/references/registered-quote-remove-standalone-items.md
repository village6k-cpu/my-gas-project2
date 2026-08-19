# Registered quote correction: remove standalone items, regenerate, preview

Use when the user/customer asks for a revised 견적서 after removing standalone quote items from an already-registered reservation, e.g. `ND필터 빼고 다시 견적서`.

## Safe workflow

1. Resolve the single active/upcoming trade by customer/name/date using `tradeCandidates`; verify with `dashboardSearch`.
2. Read raw `스케줄상세` rows by `거래ID` before mutation.
3. Identify the exact schedule IDs for the standalone items to remove. For filter rows, search both `ND` and `IRND` names.
4. Remove by `scheduleId`, not by loose equipment name, using the dashboard/schedule remove API.
   - If removing multiple rows, avoid regenerating after every row. Remove earlier rows with no direct regeneration, then run the final removal with `directRegenerate=true` / `regenerateNow=true` so the contract amount refreshes once.
5. Verify raw `스케줄상세` again: removed item names must be absent and remaining positive-price top-level rows must match the intended quote.
6. Generate a no-send registered quote preview with `previewQuote&id={거래ID}`.
   - Prefer a fresh preview (`cached:false`) after schedule edits.
   - Export the returned sheet CSV and inspect item rows, discount rows, VAT, and final total.
   - Download the returned PDF and verify it is a real PDF before attaching.
7. Report clearly: customer, 거래ID, removed rows/items, new total, preview file attached, and `고객 발송은 아직 안 했음` unless explicit approval was already given.

## Pitfalls

- A screenshot may say `ND`, while sheet rows may be named `VAXIS IRND 원형(0.6)` / `VAXIS IRND 원형(0.9)`. Search both spellings before concluding no rows exist.
- `dashboardSearch.actualAmount` is a useful quick sanity check, but final document approval should be based on exported quote CSV/PDF after `previewQuote`.
- Do not send the old quote just because an earlier `issueNote` says quote already sent; after item removal the existing sent quote is stale.
