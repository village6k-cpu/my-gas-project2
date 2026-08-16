# Manual Kakao single-quote preview

Use when the user provides a Kakao/customer screenshot with a manual rental list and asks for a 견적서 draft/preview, possibly with an extra item to add (e.g. `여기에 스크림세트 추가해서 견적서`). This is a **document preview** workflow, not reservation registration and not customer send.

## Flow

1. Parse only the visible/requested facts:
   - customer name/phone and discount type
   - rental period
   - top-level item rows and quantities
   - requested add-ons from the user's instruction
2. Match final item names against `세트마스터` column A and use column G prices. Use broad searches only to resolve aliases, then settle on exact `세트마스터` spellings.
   - Start with **one raw catalog read for the whole quote**:
     `node.exe "C:/Village/my-gas-project2-worktrees/ax2-hermes-final/scripts/windows/village-live-query.js" catalog --sheet "세트마스터"`
   - Give the returned live rows to the model and let the AI choose the exact names and column-G prices. The runner transports source data only; it must not decide aliases or equipment matches.
   - Do not use `village-confirm-request.js resolve` for manual quote pricing: it searches the `목록` sheet for confirmation-request entry, not the priced `세트마스터`. Do not issue one GAS `action=search` request per alias or retry alias lists serially.
   - Only when a requested line is absent from `세트마스터`, run the same `catalog` command once for `장비마스터` as supporting evidence. Do not query `확인요청`, `계약마스터`, trade candidates, or customer history for a standalone manual preview unless the screenshot/thread actually indicates a pending/registered trade or an approved send needs contact resolution.
3. Build a `sendEstimateManual` payload with `manualData` and **blank/omitted 연락처** for no-customer-contact preview.
4. POST once to the document webapp (`my-gas-project` agreement API). Do not `curl -L` POST redirects; capture `Location`, then GET that URL once.
5. Expected no-send result: `status:"ERROR"`, `error:"연락처가 유효하지 않습니다."`, plus `fileId`/`url`. Treat this as successful preview generation because no customer contact happened.
6. Export and verify:
   - CSV: `https://docs.google.com/spreadsheets/d/{fileId}/export?format=csv&gid=0`
   - PDF: `https://docs.google.com/spreadsheets/d/{fileId}/export?format=pdf&gid=0&size=A4&portrait=true&fitw=true&sheetnames=false&printtitle=false&pagenumbers=false&gridlines=false&fzr=false&top_margin=0.25&bottom_margin=0.25&left_margin=0.25&right_margin=0.25`
   - Check PDF page count, rasterize/inspect thumbnail, and confirm no Korean glyph breakage, truncation, overlap, or hidden/internal pages.
   - Long `대여기간` text in the official template can silently clip at the right edge even when the CSV is correct. If thumbnail inspection shows truncation, regenerate with a compact period string such as `7/4 12:00~7/6 02:00 / 일부 1일` and keep the full period/item-day explanation in the staff report, not the narrow PDF cell.
7. Final reply must attach the PDF and say **고객 발송은 아직 안 했음**. Ask for explicit approval before using the real phone number.
   - Even when the user includes a real phone number, wording like `견적서 써줘` means **create the quote/preview**, not send. Only send when the user says `보내`, `발송`, `전송` or equivalent explicit approval.
8. If the user later approves with a short reply like `보내`, recover the exact most-recent approved preview payload/fileId/PDF link from the thread/session. If no real phone number is visible in the screenshot or customer record lookup, do **not** attempt 알림톡. Send the official PDF/export link into the already-identified Kakao room via the local Kakao manual-send bridge, then verify from Kakao chat/list evidence before reporting completion.
9. For Kakao manual-send verification, the bridge may return `send_not_verified_in_conversation` even after the text/link appears in the latest Kakao chat-list preview because the conversation DOM/tree text is normalized/truncated differently. Do not blindly report failure from that single bridge result. Check the actual Kakao conversation or chat-list preview; if the just-sent customer, text/link, and timestamp are visible, report it as sent with a verification caveat. If no visible evidence appears, report failure and do not claim delivery.
10. If direct file attachment through Kakao file chooser is flaky, fall back to a verified public Drive PDF link rather than stalling:
   - Upload/copy the exact approved PDF as a standalone Drive file.
   - Set `anyone reader` sharing via Drive API if available, then verify the public `https://drive.google.com/uc?export=download&id=<fileId>` returns `%PDF` before sending the view link.
   - If an existing Drive-synced local file cannot be permissioned because the OAuth app lacks write access to that file, create/upload a new file through the same authorized Drive API client and permission that new file.
11. When driving Kakao with CDP/manual-send, confirm the active tab is the customer conversation and that the message target is the **chat message textarea**, not the chat-list search field. A common failure mode is the worker typing the outgoing text/link into `채팅방 이름 검색 폼`; if that happens, click the customer conversation tab again, verify `채팅 메시지 입력 폼` + `textarea` DOM element are visible, type into that textarea, then click an enabled `전송` button.
12. Do not report internal automation/tool iteration limits to the user as a blocker before trying a concrete fallback. For customer-facing document sends, continue with the next safe delivery route (official link, verified Drive link, or manual Kakao send) and only report failure if no verified customer-visible evidence can be produced.

## Matching notes from this workflow

- `Video Fast` / `비디오패스트` → `울란지 비디오패스트`.
- `F210C` in customer text is often a typo for `아마란 F21C` if `F210C` has no match.
- `DJI SDR Transmission` → `DJI SDR 트랜스미션`.
- `소니 UWP-D21 3개` should be a single line with 수량 3, not three duplicate rows.
- IR ND strengths should be separate rows when the customer confirmed `0.3 / 0.6 / 0.9`: `NiSi IR ND 사각(0.3)`, `(0.6)`, `(0.9)`.
- If a requested item such as `슬레이트` is not in `세트마스터`/장비마스터/목록 and no price is known, include it as a 0원/manual line only if the user clearly requested it, and report the assumption before send approval.
- `스크림세트` exists as a priced row in `세트마스터` (also may appear as `스크림 세트`); prefer the exact priced top-level spelling that matches current sheet data and use its G열 price.
- If the customer asks for `무선송수신기 1:2` without a separate monitor and staff/customer explicitly removed the `듀얼/17~19인치 모니터`, do **not** price it as `무선세트(17인치)` because that includes a monitor. Match the top-level wireless video transmitter/receiver set, typically `테라덱 볼트 1000XT (1:2)` when the request says `1:2`, and report the assumption before customer send.
- If the customer says only `테라덱 볼트 1000XT` and the visible list does not specify `1:2`, default the manual-quote match to the exact `세트마스터` row `테라덱 볼트 1000XT (1:1)` and report the assumption before customer send approval.
- For `PL 어댑터`, search `세트마스터`/`장비마스터` and choose the sheet’s exact adapter row only when the mount direction is clear from context. If it is just “pl 어댑터” and the camera is Sony E-mount (e.g. FX6), `매타본즈 PL(E-PL)` is the normal E-mount PL adapter candidate; if RF/other mount is implied, use `Nisi PL Mount` or stop for confirmation rather than inventing a generic adapter.
- `셔틀러 에이스 XL (75볼)` may not exist as an exact Village sheet row; search `세트마스터` and `장비마스터`. If only `셔틀러에이스 M (75볼)` exists and the context is simply a 75볼 셔틀러/에이스 tripod quote, use `셔틀러에이스 M (75볼)` as the priced row and explicitly flag the XL→M assumption before customer send approval. The same `셔틀러에이스 M (75볼)` row is also the normal match for shorthand `에이스 M`.
- Common production/stage support aliases: `노바 300` → `어퓨쳐 노바 P300C`; `콤보 스탠드` → use an exact priced stand row such as `KUPO 콤보 스탠드` when no size is specified; `C붐` / `씨붐` → `C Boom AVENGER D600`; `어퓨처/어퓨쳐 스팟라이트` in a 600-series light accessory list often means the priced `어퓨처 스팟마운트`, not `아마란 스팟라이트 SE`.
- Lighting-package quote aliases from Kakao screenshots: `STORM 80C` / `스톰 80C` → exact priced row `어퓨쳐 스톰 80C` (searching English `STORM 80C` alone may return no `세트마스터` match; retry Korean `스톰 80C`); `600C 프로 세트 (RGBWW)` → `어퓨쳐 600C`; `MC4 트래블 KIT` → prefer `어퓨쳐 MC4 트래블 KIT` when the customer explicitly says 트래블; `PT4C 4KIT` → `아마란 PT4C 4KIT`; `C Boom` → `C Boom AVENGER D600`. For this class of 4-day student quote, use the official manual preview route with omitted/invalid phone for no-send preview, verify CSV/PDF, and remember the preview contact cell will be blank until regenerating with the real phone after send approval.
- For manual Kakao quote requests where the customer says “글리머 없는 견적”, do not include a 0원 unavailable item just to mention the omission. Exclude it from line items and state the exclusion in the final report.
- Korean shorthand aliases seen in Kakao quote screenshots:
  - `알육막투` / `R6 막투` → `캐논 R6 Mark 2`.
  - `알백오` / `백오백` / `100-500` → `캐논 100-500mm`.
  - `모포` in a camera/lens support list usually means monopod → `맨프로토(모노포드)` after checking `세트마스터`.
  - `에칠백` in a Sony camera request context can mean `소니 A7S3 바디세트`; verify against `세트마스터`/context before using.

## One-off flat 20% manual quote discounts

When a Kakao/manual quote request says “20% 할인 넣어서 견적서” and the discount is an ad-hoc/d량렌탈/customer-service discount rather than a formal `학생`/`사업자` category:

1. Use the official-template preview route first if possible. For exact 20% math, `할인유형: "개인사업자/프리랜서"` produces the correct 0.8 multiplier in the current route, but its generated label is `사업자20%` and the bottom note mentions student/business proof.
2. If the customer-facing PDF label must not say `사업자20%`, create the no-send preview with blank/invalid phone, export CSV/PDF, then patch only the PDF text layer/visual label to the neutral reason such as `할인 (다량렌탈20%)` and replace the proof note with `다량 렌탈 20% 할인이 적용된 견적입니다.`.
3. Use a real Korean-capable overlay method for PDF patches. PyMuPDF `insert_text(fontfile=...)` may render Korean as boxes in some PDF viewers; a reliable workaround is: redact the old text with PyMuPDF, create a small ReportLab overlay PDF using `C:/Windows/Fonts/malgun.ttf`, then merge it back with `show_pdf_page`.
4. Re-rasterize the final PDF (`uv run --with PyMuPDF python -c "import fitz; ...get_pixmap..."`) and visually verify the patched label/note, item rows, and VAT total before attaching. Do not attach a PDF whose overlay text appears as boxes.
5. Clearly report `고객 발송은 아직 안 했음`; this remains a preview/draft until explicit approval.

## Calculation reminder

Manual quote route applies Village quote math itself:

- line amount = 수량 × 일수 × 단가
- discount label/multiplier from `할인유형` (e.g. `학생` = 학생30%) plus long-term discount by max item days
- VAT included total = `CEILING(ROUND(공급가액 × 1.1, 0), 10원)`

Verify the exported CSV total rather than trusting mental math.

### Operator-specified flat line totals / no automatic discount

When staff says a line should be a specific total such as `솔리드컴 2S 150일 120만원` and another line `2일 10만원`, treat those as final customer-facing line amounts unless they explicitly ask for additional discount. Convert to per-day unit price only to satisfy the template math (e.g. 1,200,000 / 150 = 8,000), then verify each line total in CSV/PDF.

Pitfall: `generateQuoteManual` automatically applies long-term discounts based on max item days even when `할인유형` is blank. For manually agreed flat totals, override the rendered quote formulas to no discount before PDF export:

- set the discount label row to plain `할인`
- set supply amount to equal subtotal (`H46:I46 = H44`)
- recalc VAT/total (`H48:I48 = CEILING(ROUND(H46*1.1,0),10)`, `H47:I47 = H48-H46`)
- verify CSV has `할인 0`, expected VAT, and expected `합계 (VAT 포함)`

For one-off previews that must use the official template but not send to the customer, add a temporary guarded GAS action that calls `generateQuoteManual`, patches formulas/notes if needed, calls `convertSheetToPdf`, returns `fileId/sheetUrl/pdfUrl/csvUrl`, then immediately remove the route/file and redeploy after verification. This is a preview workflow; do not call `sendQuoteManual` or `sendContractAlimtalk` unless the user explicitly says to send.
