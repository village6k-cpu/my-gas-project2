# Manual quote draft fallback

Use when staff asks for a one-off/manual quote such as:

- `솔리드컴 5S 45일 900,000원 / 솔리드컴 2S 추가 150일 150 / 솔리드컴 8S 2일 100,000원 / 이렇게 3개 항목 넣은 견적서 하나 만들어줘`

## Classification

- `견적서 하나 만들어줘` = create/preview draft only, not customer contact.
- If the text contains direct priced item rows and lacks customer/date/trade ID, do **not** force the registered-trade document runner or stop at `needs_customer_and_date`.
- Treat it as a manual/internal quote draft. Customer fields may be left as `미지정` unless the user/customer context supplies them.

## Parsing rules

1. Split top-level rows on `/` or line breaks.
2. For each row capture:
   - 품목
   - 수량 if explicit, otherwise `1`
   - 기간/일수 shown in the text
   - stated amount or unit/agreed price
3. Keep the stated amount exactly as the user corrected it. If a shorthand number is ambiguous (`150`), ask once or use the user correction (`150만원` → `1,500,000원`).
4. Do not apply extra 할인유형 (학생/사업자/단골/제휴) when the user already supplied final/agreed amounts.
5. Sum the stated amounts with a calculation tool before reporting totals.

## Output / approval gate

- Generate or show a draft/preview file when possible.
- State clearly: `고객 발송은 안 했음`.
- If customer name/phone is absent, label the draft as internal confirmation (`고객명: 미지정`) rather than blocking creation.
- Before finalizing, visually verify the generated PDF/image when possible. Korean PDF generation can appear blank or overlapped if the font path/font type is wrong; verify legibility, item rows, and total before sending the file.

## Local fallback when GAS safe manual-preview route is unavailable

If the deployed GAS only exposes send-capable manual actions and the user only asked to create a quote, do not call `sendEstimateManual`. A safe temporary fallback is to generate a local internal PDF draft and attach it for approval. Use a Korean-capable TTF/OTF font; on macOS `/System/Library/Fonts/Supplemental/AppleGothic.ttf` worked with ReportLab, while CID font rendering may look blank/illegible when rasterized.

For dense camera-rental quotes from Kakao screenshots, use the detailed one-page fallback in `references/local-manual-quote-pdf-fallback.md`: match against `세트마스터`, calculate Village rental days with the 6-hour grace rule, generate under `C:/Users/ssper/AppData/Local/Temp/village_quotes/` (Git Bash `/tmp/village_quotes/`; convert with `cygpath -w` before handing the path to native exes), rasterize with `uv run --with PyMuPDF python` (fitz `get_pixmap` page-1 PNG), and visually verify Korean/text/total before attaching.
