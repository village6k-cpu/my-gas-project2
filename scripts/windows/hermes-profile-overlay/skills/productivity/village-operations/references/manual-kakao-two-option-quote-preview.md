# Manual Kakao two-option quote preview

Use when a Kakao/customer screenshot asks for two alternative 견적서 drafts for the same customer/period, e.g. `부라노하고 FX9하고 두개 견적서`.

## Safe official-template preview flow

1. OCR/parse the visible Kakao block:
   - customer name/phone/discount type
   - pickup/return period and rental days
   - two alternative top-level camera set rows plus shared accessory rows
2. Match/prices from `세트마스터` A/G. Search broad aliases, then settle on accepted A-row names. Examples from this workflow:
   - `소니 BURANO 베이직 세트` → `소니 BURANO 베이직세트` / 200,000
   - `소니 FX9 풀세트` → 100,000
   - `소니 24-70 GM II` → `소니 GM 24-70mm II` / 25,000
   - `홀리랜드 마스 4K` → `마스 4K` / 25,000
   - `애플박스 세트` → `애플박스 풀세트(A/B/C/D)` / 5,000
   - `슈나이더 Hollywood Black Magic 필터` may map to several strength rows; if strength is unspecified, use one line such as `슈나이더 Hollywood Blackmagic 필터` at the visible/filter-row price and flag strength as unresolved before customer send.
3. For preview-only official templates, call `sendEstimateManual` with `manualData.연락처` blank/invalid. Expected response is `status:"ERROR"`, `error:"연락처가 유효하지 않습니다."`, plus `fileId`/`url`. This is the no-customer-contact preview artifact; it is not a failure if `fileId` exists.
4. Export from the returned sheet ID:
   - CSV for math/content verification: `https://docs.google.com/spreadsheets/d/{fileId}/export?format=csv&gid=0`
   - PDF for Slack attachment: `https://docs.google.com/spreadsheets/d/{fileId}/export?format=pdf&gid=0&size=A4&portrait=true&fitw=true&sheetnames=false&printtitle=false&pagenumbers=false&gridlines=false&fzr=false&top_margin=0.25&bottom_margin=0.25&left_margin=0.25&right_margin=0.25`
5. Verify CSV totals and rasterize/inspect the PDF (headless: `pdftotext -layout 'C:/...' -` for content, `uv run --with PyMuPDF python -c "import fitz; ..."` `get_pixmap` for a page-1 PNG) before replying. Long item labels can visually truncate in the official template; shorten non-essential text (e.g. remove parenthetical `강도 미지정`) and regenerate if the PDF cuts the row.
6. Final reply should attach both PDFs and state clearly: `고객 발송은 아직 안 했음`. If preview phone is blank because of the no-send workaround, say so and keep the real phone for the later approved send.

## Notes

- Do not register a reservation or update payment/ledger for a quote-only request.
- If two files are generated in the same minute, quote numbers can collide because manual quote numbers are minute-based. If distinct quote numbers matter, wait a minute or otherwise force separate generation times.
- When the user later approves (`보내`), use the actual customer phone and official send path; do not tell the user the blank-phone preview itself was sent.
