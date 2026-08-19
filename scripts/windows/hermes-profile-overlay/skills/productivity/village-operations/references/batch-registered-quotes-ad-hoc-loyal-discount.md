# Batch registered quotes with ad-hoc loyal discount

Use when the user asks for many already-registered reservations to be quoted again with an extra discretionary discount, e.g. `4월 13일부터 최신까지 개인사업자/프리랜서 20%에 단골 10% 추가해서 견적서 전부 작성`.

## Key lesson

The deployed registered `previewQuote` route reads the trade's current `계약마스터` 할인유형. If existing trades are marked `개인사업자/프리랜서`, the official preview will not include the extra `단골10%` unless the underlying trade discount is changed. Do **not** mutate all historical contracts just to make a one-off collection/preview.

Instead, use official registered preview only as source data, then generate an approval-gated local quote bundle with the requested ad-hoc discount stack.

## Safe workflow

1. Resolve the customer trades from `계약마스터` by name/phone, starting date, and status.
   - Exclude `취소` unless the user explicitly asks to include it.
   - Keep `반납완료`, `반출`, and `예약` when the user says “부터 최신까지”.
2. For each trade, call document `previewQuote` to generate/read the official quote sheet without customer contact.
3. Export the returned quote sheet as CSV and parse:
   - customer / phone / rental period
   - visible top-level item rows
   - quantities, days, unit prices, and row amounts
4. Recalculate locally with the requested stack:
   - `단골` in Quote.js means `사업자20% × 단골10%` → multiplier `0.8 * 0.9`.
   - Still apply existing long-term discount from item `일수` the same way as Quote.js (`2일10% / 3~5일20% / ...`) unless the user explicitly says to ignore it.
   - `공급가액 = round(정가소계 * multiplier)`, `합계 = CEILING(round(공급가액 * 1.1), 10)`.
5. Generate a local PDF bundle and a summary CSV/JSON. Recommended outputs:
   - one combined PDF for quick review
   - individual PDFs per `거래ID`
   - a zip containing individual PDFs + summary CSV
6. Verify before reporting:
   - PDF page count equals included trade count.
   - zip integrity passes.
   - extract PDF text with `pdftotext -layout 'C:/...' -` or render a page-1 PNG thumbnail with `uv run --with PyMuPDF python` (fitz `get_pixmap`); visually verify Korean glyphs, table fit, discount label, and final total.
7. Report clearly: `고객 발송은 아직 안 했음`.

## Parsing pitfall

Official quote CSV has both supplier and buyer `연락처` labels. When parsing the customer phone, take the buyer-side/right-half `연락처`, not the supplier contact (`0507-1487-3114`). If a local PDF accidentally shows the supplier phone as the customer phone, regenerate before sending/reporting.

## Formatting pitfall

If generating local PDFs with ReportLab `Paragraph`, do not escape intentional markup like `<br/>` or `<font>`; escaped markup appears literally in the PDF. Use a raw paragraph helper only for trusted internal template markup, and escape user/customer/item text normally.

## Final-report checklist

- Included trade count and excluded cancel count.
- Total before discount, total discount, and final VAT-included total.
- Attach combined PDF and zip.
- Mention that this is a no-send preview/bundle unless a customer-facing send route was actually called after approval.
