# Registered quote schedule-item correction before send

Use when a registered-trade 견적서 request turns out to require changing the visible quoted items, e.g. `GM 렌즈 세트 빼고 24-70, 70-200, 라오와 12 추가`.

## Key lesson

For registered-trade quotes, the official quote route (`previewQuote` / `sendEstimate`) builds from `스케줄상세` top-level/price rows. Do **not** hand-send a local PDF or rely on an old preview when the requested item list differs from the registered schedule. First make the schedule match the intended quote, verify raw `스케줄상세`, then generate/send the official quote.

## Safe workflow

1. Resolve the registered trade (`tradeCandidates`, `dashboardSearch`) and identify the exact `거래ID`.
2. Read raw `스케줄상세` by `거래ID` via the sheet API (`action=search&sheet=스케줄상세&col=B&query={거래ID}`), not only the dashboard/search UI cache.
3. Compare the user-requested visible quote items against **price/top-level rows**:
   - Include rows with positive `단가`.
   - Include top-level standalone/representative rows (`세트명 == 장비명` or no set name).
   - Exclude zero-price set components from quote expectations unless the user explicitly wants schedule contents audited.
4. If a set must be replaced by individual items:
   - Remove the set representative row by `scheduleId` using `removeEquip`; this also removes its components.
   - Add the individual top-level items with `addEquips`/`scheduleAddEquips` using exact `세트마스터` names where possible.
   - Let the route run availability. If add fails after remove, immediately restore the removed set before reporting.
5. Verify raw `스케줄상세` again. The desired top-level rows and prices must be present before document generation.
6. Generate official preview: `GET {DOCUMENT_API_URL}?action=previewQuote&key=...&id={거래ID}`. If the schedule signature changed, it should return `cached:false`; if it returns cached, export the sheet CSV and verify the visible items/totals anyway.
7. Export the preview sheet CSV and verify customer, period, item rows, discount, and final total. Attach/download the PDF for approval. State `고객 발송은 아직 안 했음`.
8. After explicit approval, send with one POST only: `{action:"sendEstimate", key, id}`. For Apps Script web-app POSTs, do **not** use `curl -L`; capture the first `302 Location` and `GET` that URL once for JSON. This avoids confusing/dangerous double execution.
9. After send, call `previewQuote&reuse=1` or export the sent/cached quote sheet to verify the customer-facing link now points at the corrected item list and total.

## Example pattern

Replacing `소니 GM 렌즈 세트(16-35, 24-70, 70-200)` with:

- `소니 GM 24-70mm`
- `소니 GM 70-200mm`
- `라오와 12mm T2.9 Zero-D Cine`

Correct verification was raw `스케줄상세` showing the old set rows removed and new positive-price rows added; official preview then showed the updated rows and total. Customer send happened only after the user replied `보내`.

## Pitfalls

- If the user says they already edited `스케줄상세`, still verify raw rows. The edit may have affected components/notes, another trade, or may not have propagated.
- `dashboardSearch` can be enough for context, but raw `스케줄상세` search is the decisive source for quote item rows.
- `previewQuote` caches by a signature of quote-visible fields. If the signature does not change (or the prior preview is still returned), the customer may see the old quote. Always inspect CSV before approval/send.
- `sendEstimate` regenerates/sends an official live quote link; report API acceptance/OK, quote URL, and checked total, not just “sent”.
