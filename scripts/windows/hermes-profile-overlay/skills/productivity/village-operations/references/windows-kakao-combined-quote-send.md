# Windows Kakao combined-quote send

Use when staff asks to send multiple registered quotes for one customer on Windows
(e.g. `권현재 최근 2건 견적서 보내주자` → preview → bare `보내`).

Companion of `village-batch-quote-kakao-send.md` and `kakao-quote-pdf-send-pitfalls.md`
with the verified Windows CDP path from 2026-08-17.

## Decision rules

1. Preview each trade with official GAS `previewQuote` first; customer send only after
   explicit approval of that version (`보내` / `발송` / `승인`).
2. “최근 N건” = sort customer trades by checkout desc, take top N. Show tradeIds + VAT totals.
3. Bare `보내` on a multi-trade preview = **one combined PDF once** to the customer Kakao room.
   Do **not** loop `sendEstimate`/Popbill Alimtalk unless staff says `거래별 알림톡`.
4. Internal preview approval ≠ automatic Alimtalk.

## Windows execution path (verified)

1. Resolve candidates via schedule webapp `tradeCandidates` (follow redirects; use Python
   `urllib` if curl/JSON piping is flaky on Git Bash).
2. `previewQuote` per trade → download official PDFs → CSV readback of totals.
3. Merge PDFs with `pypdf` (`PdfWriter`) into one file under
   `%LOCALAPPDATA%/hermes/tmp/village-quotes/...`.
4. Set CDP env before worker imports:
   - `KAKAO_REMOTE_DEBUGGING_PORT=9223`
   - `KAKAO_DEVTOOLS_URL=http://127.0.0.1:9223`
   Without these, `openKakaoTargetChatViaDevtools` returns `devtools_unavailable` /
   `missing_cdp_base_url` even when port 9223 `/json/list` is healthy.
5. Open room: `ensureKakaoChannelManagerTab` → `openKakaoTargetChatViaDevtools`
   (`customer_name` / `room_title`). Confirm title like `권현재 - 빌리지 - 카카오비즈니스 파트너센터`.
6. **File first:** `attachKakaoFilesViaDevtools(target, [combinedPdf])` on exactly one
   file input (worker already breaks after first assignment).
7. Optional short text second only after file evidence:
   `sendKakaoMessageViaDevtools(text, nav, { attachmentPaths: [] })`.
8. Do **not** rely on bridge `POST /manual-send` for PDFs — it does not forward
   `attachmentPaths`. Prefer direct attach APIs (file-first) over stock
   `sendKakaoMessageViaDevtools` with attachments (that helper currently sends text first).

## Verification (required)

Room-body evidence only counts as sent:

- Exact customer room title + chat id
- Combined filename **stem** visible (Kakao often splits `name` and `.pdf` across lines;
  exact full-name `includes` can false-negative)
- Size/`용량` and/or `유효기간` and/or new `저장하기` row in the tail
- Optional follow-up text after the file bubble

Helper traps:

- `attached:true` with `selectedFileCount:0` + `sendClicked:false` can still mean
  auto-send success (`files_assigned_via_datatransfer`) — confirm body, not flags.
- If the combined bubble is already in the tail from a partial earlier attempt, **do not
  re-upload**; only add missing text if needed.

## Report shape

Short staff report: customer · combined filename · tradeIds + totals · room title ·
body evidence (time of file + text). State that Alimtalk loop was not used.
