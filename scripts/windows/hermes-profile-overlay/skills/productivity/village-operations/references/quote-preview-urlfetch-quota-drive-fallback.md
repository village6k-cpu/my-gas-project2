# Quote preview fallback when Apps Script UrlFetch quota is exhausted

Use this when `previewQuote`/`generateQuotePreview` returns `하루에 urlfetch 서비스를 너무 많이 호출했습니다.` during a registered-trade quote preview.

## Key lesson

The quota error can happen **after** the official quote spreadsheet has already been generated, because the failing step is often the GAS `convertSheetToPdf()` UrlFetch PDF export. Do not immediately retry the send/preview route or switch to a local recreation. First look for the official generated sheet in Drive, then export it yourself.

## Safe fallback flow

1. Resolve the single `거래ID` as usual via `tradeCandidates`/dashboard.
2. Call safe `previewQuote` once. If it returns the UrlFetch quota error, stop retrying the route.
3. Use the local clasp OAuth token (`~/.clasprc.json`, token value never report or save) or another authenticated Drive method to search Drive for the generated sheet name, e.g. `name contains '{거래ID}' and trashed=false`.
   - Expected match pattern: `{거래ID}_{고객명}_견적서` as a Google Sheets file.
4. Export and inspect the official sheet CSV via the public/Drive export URL:
   - `https://docs.google.com/spreadsheets/d/{sheetId}/export?format=csv`
   - Confirm customer, rental period, item rows, discount, VAT, and total.
5. Export the PDF with the same parameters as `convertSheetToPdf()` so it remains a clean one-page quote instead of exporting every sheet/tab:
   - `https://docs.google.com/spreadsheets/d/{sheetId}/export?format=pdf&gid=0&size=A4&portrait=true&scale=2&top_margin=0.50&bottom_margin=0.50&left_margin=0.50&right_margin=0.50&sheetnames=false&printtitle=false&pagenumbers=false&gridlines=false&fzr=false`
6. Verify the PDF starts with `%PDF` and, if possible, thumbnail/visually inspect it. A naive `export?format=pdf` may produce many pages (including hidden/support sheets) and is not the artifact to send.
7. If a customer-facing Drive PDF link is needed, upload the verified PDF to the normal document folder, set `anyoneWithLink` read permission, then verify `https://drive.google.com/uc?export=download&id={pdfId}` returns `%PDF`.
8. Keep the normal approval gate: post/attach the preview and state clearly `고객 발송은 아직 안 했음`. Only after approval call `sendEstimate` with `pdfUrl=<verified public PDF URL>` so the Alimtalk button uses the known-good PDF and does not trigger GAS PDF generation again.

## Reporting checklist

- 거래ID, customer, period
- top-level item summary
- VAT-included total from CSV
- verified PDF link/attachment
- explicit customer-send state: not sent vs API accepted

## Pitfalls

- Do not use `curl -L` against send-capable POST routes; redirects can mask an already-executed send.
- Do not treat the quota error as proof no artifact exists.
- Do not attach/send a naive multi-page Drive export if the official route normally exports only the first sheet with PDF layout parameters.
