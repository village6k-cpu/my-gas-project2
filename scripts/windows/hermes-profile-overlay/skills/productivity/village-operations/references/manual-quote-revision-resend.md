# Manual quote revision/resend from prior Slack context

Use when staff replies in a thread after prior manual quote work with wording like `위 견적서`, `각각 ... 추가해서 다시 보내자`, `내용 수정해서 재발송`, or `아까 보낸 견적서 다시`.

## Trigger pattern

- The current message is a short threaded reply and omits the full customer/date/item list.
- A previous message in the same thread/session contains the full manual quote payload or sent-summary.
- The requested change modifies the quote contents before resend, e.g. add `V마운트 배터리 1개` to each of two quotes.

## Safe workflow

1. Recover the prior quote context from the Slack thread/session before asking the user to repeat it:
   - customer name/phone
   - rental period and days
   - discount type
   - each prior quote's top-level items, qty, days, unit prices
2. Resolve any new item against `세트마스터` column A and use its official unit price.
   - Example observed: `V마운트 배터리` is a top-level `세트마스터` item at 5,000원/day.
3. Rebuild `manualData.items` by copying the prior top-level line items and applying the requested change.
   - Do not copy expanded zero-price components.
   - Do not re-infer the whole quote from memory if the previous session/thread has an explicit payload.
4. Even if the user says `다시 보내자`, if the document content changed, create an approval-gated preview first:
   - Use official template generation.
   - If only `sendEstimateManual` is exposed, use the no-send preview workaround: call it with blank/invalid phone so it returns `status:"ERROR"` / `연락처가 유효하지 않습니다.` plus `fileId` and no customer contact.
5. Export and verify the generated sheet before reporting:
   - CSV: `https://docs.google.com/spreadsheets/d/{fileId}/export?format=csv&gid=0`
   - PDF: `https://docs.google.com/spreadsheets/d/{fileId}/export?format=pdf&gid=0&size=A4&portrait=true&scale=2&sheetnames=false&printtitle=false&pagenumbers=false&gridlines=false&fzr=false&top_margin=0.50&bottom_margin=0.50&left_margin=0.50&right_margin=0.50`
   - Verify customer, period, added item row, discount label, subtotal/supply/VAT/final total.
   - Optional visual check on Windows: `uv run --with PyMuPDF python -c "import fitz; doc=fitz.open('file.pdf'); doc[0].get_pixmap(matrix=fitz.Matrix(1.75,1.75),alpha=False).save('C:/Users/ssper/AppData/Local/Temp/thumbs/file.png')"` then inspect the PNG for Korean text, truncation, and total.
6. Report the revised preview with `고객 발송은 아직 안 했음` and attach the PDFs. Ask for a short explicit approval such as `보내`.
7. On explicit approval, send the exact same revised payload with the real phone.
   - Use `force:true` only when the same manual quote payload is being resent within the duplicate-guard window and the user explicitly asked to resend anyway.

## Quote issue-date correction after send

Use this when staff approves/sends a manual quote and then replies that the `견적일자` should match the revised rental date.

1. Treat `견적일자` as document content, not an implicit resend instruction. Generate or patch a corrected preview first and say customer resend has not happened until they approve.
2. If the official manual quote route has no issue-date override, use the most recent verified sent sheet/PDF as source and patch only the visible date fields:
   - `견적일자` → requested/rental start date.
   - `견적 유효기간` → 14 days from the corrected issue date when the template uses 14-day validity.
   - Do not change the item list, phone, discount, total, or customer unless explicitly requested.
3. For PDF patch fallback, prefer a real PDF-edit flow and verify visually:
   - Download/export the sent quote PDF.
   - Use PyMuPDF redactions on exact date text and reinsert the replacement date; for Korean suffixes like `까지`, patch the date substring only so the original Korean text remains intact.
   - Rasterize the final PDF and inspect: one customer-facing page, corrected issue date, corrected validity, rental period, phone, total, no redaction artifacts/overlap.
4. If the user then says `보내`, send the corrected artifact/payload through the approved customer channel and verify API acceptance or visible Kakao evidence before reporting completion.

## Calculation sanity example

Prior quote: 김민솔 / 2026-06-27 23:00 ~ 2026-06-29 23:00 / 2일 / 학생 + 장기10%.

Adding one `V마운트 배터리` at 5,000원/day for 2 days adds 10,000원 정가. With 학생30% × 장기10% = 63% supply multiplier, VAT-included increase is 6,930원.

- BURANO baseline 381,150원 → revised 388,080원
- FX9 baseline 242,550원 → revised 249,480원

Use the generated CSV/PDF as the final authority, not mental math alone.
