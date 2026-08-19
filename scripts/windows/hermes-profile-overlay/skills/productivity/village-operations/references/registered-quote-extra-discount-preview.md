# Registered quote extra-discount preview fallback

Use when the user asks to revise/send a **registered-trade 견적서** with an extra discount that is not already represented in `계약마스터` 할인유형, e.g. `견적서에서 단골 10% 할인 추가해서 보내`.

## Safe workflow

1. Resolve the customer/trade normally through `tradeCandidates` / `dashboardSearch` and verify it is a single non-cancelled trade.
2. Generate/read the current registered quote preview for the trade (`previewQuote`) only as the baseline for items, dates, customer info, and current totals.
3. Before customer contact, apply the requested extra discount to the math and produce an approval-gated preview. Do **not** send the existing cached preview if it does not include the new discount.
4. Prefer the official GAS quote template even for ad-hoc discount previews. If the deployed document app supports a safe override such as `GET previewQuote&key=...&id={거래ID}&discountType=단골`, use that route: it renders the existing `Quote.js` template without editing `계약마스터` and without customer contact.
5. Do **not** recreate the quote layout locally just because the ad-hoc discount is awkward. Local PDF recreation is allowed only if the user explicitly asks for a non-official draft or the official route is completely unavailable and the final clearly says it is not the official Village template.
6. State clearly: `고객 발송은 아직 안 했음`. Send only after explicit approval.

## Calculation example

Existing registered quote had `학생30%` only:

- 정가소계: `726,000`
- 학생30%: multiplier `0.7` → 공급가액 `508,200`, VAT포함 `559,020`

User requested `단골10%` 추가:

- combined multiplier: `0.7 × 0.9 = 0.63`
- 공급가액: `round(726,000 × 0.63) = 457,380`
- VAT 포함: `ceil(round(457,380 × 1.1), 10원) = 503,120`
- 할인액: `726,000 - 457,380 = 268,620`

## Verification

- Stat the generated PDF and confirm page count.
- Rasterize a page-1 thumbnail with `uv run --with PyMuPDF python -c "import fitz; ..."` (fitz `get_pixmap`, ephemeral — no global install) and inspect for Korean glyph breakage, overlaps, truncation, customer name, discount label, and final total.
- Final user reply should include the preview artifact and the exact total, but must not imply customer send completion unless a send route actually ran after approval.
