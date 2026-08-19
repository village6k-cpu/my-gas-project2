# Local manual quote PDF fallback

Use this when a Village 견적서 request is a **manual/new-inquiry draft** and the safe GAS preview route is unavailable or unsuitable, and the user needs a checkable file now.

## When to use

- User says `견적서 작성해줘`, `견적서 하나 만들어줘`, or provides a Kakao screenshot/list with customer, items, and period.
- The request is **draft/preview only**. Do not customer-send.
- You can calculate line items from `세트마스터` prices and known Village quote rules.

## Price/source workflow

1. OCR/parse only visible/requested fields:
   - customer name/phone, discount type such as `학생`, period, top-level item rows and quantities.
2. Match item names against `세트마스터` column A, not `목록`, for final quote spelling/prices.
   - Use broader `search` over all columns only to resolve aliases/components, then settle on a top-level `세트마스터` A-row.
   - Example aliases seen in quote screenshots:
     - `Smajjhd indie7...` / `SmallHD indie7` → `스몰HD 인디7`
     - `Smajjhd indie7DZOFILM CATTA ACE 3Lens Set` may be two items jammed together: `스몰HD 인디7` + `DZOFILM 3 Lens 세트`.
     - `홀리랜드 솔리컴 SE 인터컴 5S` → `솔리드컴 SE 5구` if present in `세트마스터`.
     - `어퓨쳐 스팟 라이트 마운트` → prefer `어퓨쳐 spotlight` / `아마란 spotlight SE` after checking `세트마스터`; note the assumption.
     - `파보튜브 30x 2 kit` → `파보튜브 II 30X` with 수량 2, not an item literally named `2 kit`.
     - `V-Mount x 3` → `V마운트 배터리` 수량 3 unless charger is explicitly requested.
3. Compute rental days with Village quote logic: `max(1, ceil((총시간-6)/24))`.
   - Example `7/16 18:00 ~ 7/19 20:00 (72h)` is 74 hours, but still **3일** by the 6-hour grace rule: `ceil((74-6)/24)=3`.
4. Calculate totals with the same quote math:
   - line amount = `수량 × 일수 × 단가`
   - discount multiplier = customer discount × long-term discount
   - `학생` = 0.7; 3~5일 장기 = 0.8; combined = 0.56
   - 공급가액 = `round(정가소계 × multiplier)`
   - 합계 VAT 포함 = `ceil(round(공급가액 × 1.1), 10원)`
   - 부가세 = 합계 - 공급가액
   - 할인 row should display a negative number.

## Local PDF generation notes

- Generate an internal draft PDF under `C:/Users/ssper/AppData/Local/Temp/village_quotes/` (Git Bash `/tmp/village_quotes/`) and attach it with `MEDIA:C:/absolute/path.pdf`.
- Use a Korean-capable font. On Windows, `C:/Windows/Fonts/malgun.ttf` works with ReportLab.
- Keep the PDF to one page when possible:
  - A4 portrait, margins around 9–11 mm.
  - Font sizes around 7.3–8.6 pt for dense item lists.
  - Compact table padding (2.5–3 pt) and summary spacing.
- Include these fields visibly:
  - VILLAGE header, 견적번호/date, supplier info, customer name/phone, rental period, discount label, item table, subtotal, discount, supply, VAT, VAT-included total, notes, signature line.
- State clearly in the final reply: `고객 발송은 아직 안 했음`.

## Verification

Before final reply:

1. Stat the file and ensure it is non-empty.
2. Count pages if possible; one-page is preferable but not mandatory.
3. Rasterize a thumbnail and inspect legibility:
   - `uv run --with PyMuPDF python -c "import fitz; doc=fitz.open('C:/Users/ssper/AppData/Local/Temp/village_quotes/<file>.pdf'); doc[0].get_pixmap(matrix=fitz.Matrix(1.75,1.75), alpha=False).save('C:/Users/ssper/AppData/Local/Temp/village_quotes/preview.png')"`
4. Verify no Korean glyph breakage, no overlapping/truncation, no literal `<br/>` leakage, and that customer/period/items/total are visible.

## Important safety

- This fallback creates a **local preview artifact only**. It is not a substitute for customer send approval.
- If item matching required assumptions, list only the assumptions that matter operationally in the final reply.
