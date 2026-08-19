> **[정책 우선 고지 2026-08-12]** 이 문서의 인프라 자가 재시작/복구 지시(맥 방언 원문)는 2026-08-11 사장님 정책으로 대체됨 — **치유는 워치독 소유, 업무 턴 중 자가수리 금지** (SKILL.md 'Infrastructure incident guard'가 우선). 원문은 참고용으로 보존.

# Kakao standard document attachment runbook

Use this when customers ask for Village `통장사본`, `계좌사본`, `사업자등록증`, or equivalent wording.

## Durable lesson

Text auto-reply and file attachment are separate Kakao Channel Manager actions. A successful text send is not enough: verify that the two stored image files were selected/uploaded and the Kakao attachment send button was clicked.

Stored files:

- `~/.hermes/village-documents/customer-request-docs/village_woori_bankbook_copy.jpeg`
- `~/.hermes/village-documents/customer-request-docs/village_business_registration_certificate.jpeg`

## Preferred automation path

1. Use the `🤖 자동화 크롬` Kakao automation profile, not `💁🏻 직원용 크롬`.
2. Prefer Chrome DevTools/CDP when available (`KAKAO_REMOTE_DEBUGGING_PORT`, usually `127.0.0.1:9223`):
   - navigate/open target Kakao room by verified customer hint;
   - send the standard text;
   - use `DOM.setFileInputFiles` on `input[type="file"]` with both stored file paths;
   - click the Kakao attachment send button;
   - return success only when attachment selection/send action is observed.
3. If DevTools is unavailable but Chrome Apple Events JavaScript is enabled, a reliable fallback is direct DOM upload in `🤖 자동화 크롬`:
   - open the exact room URL or click the exact chat-list row, then verify `document.title` contains the target name and `location.href` contains the expected chat id;
   - for each stored JPEG, create a `File` from base64 bytes, assign it to `document.querySelector('input[type="file"].uploadInput')` with a `DataTransfer`, then dispatch `input` and `change` events;
   - Kakao Channel Manager may auto-send the image after the `change` event; wait until the room body `저장하기` count increases by 1 per file before proceeding;
   - after both attachment count increases are observed, fill `textarea#chatWrite`, dispatch `input/change`, click enabled `전송`, and verify the final tail contains two new `저장하기` entries before the text.
4. If DevTools/Apple-Events DOM upload is unavailable and CUA fallback is explicitly allowed, use the Kakao message composer file button and the macOS Open panel:
   - capture/get the target conversation window state first;
   - click the file button near the composer bottom-left;
   - use `Cmd+Shift+G` in the Open panel, paste/select the exact file path, press Return/Open;
   - after the attachment preview appears, click Kakao `전송`;
   - repeat per file if multi-select is unreliable.

## Verification / safety gates

- **Duplicate-send / wrong-topic guard:** standard document auto-send must trigger only when the **latest customer turn itself directly asks Village to send our docs**. A bare `사업자등록증` in a 세금계산서 turn can mean the customer is uploading *their* business-registration PDF, not asking for Village's. Auto-send only for direct request wording near `통장사본/계좌사본`, or clearly Village-owned docs such as `빌리지렌탈샵의 사업자/통장사본 부탁`. Do not trigger from older visible history, `감사합니다`, 세금계산서/입금 follow-up, customer PDF filenames, email addresses, or `발행해주세요` turns. If any later staff/outbound message already says `요청하신 통장 사본과 사업자등록증 ...드립니다`, block with an already-sent reason instead of sending again.
- Do not report `sent=true` just because the text bubble is visible; attachments require their own result object/log evidence.
- If the route says `attachment_paths_require_devtools_target` or `conversation_target_missing`, no customer file was sent. Fix the automation target/profile or CUA attachment fallback before retrying.
- After patching worker code in this area, run both:
  - `npm run check` in `tools/ai-browser-worker`
  - `npm test` in `tools/ai-browser-worker`
- Avoid interacting with `💁🏻 직원용 크롬` for browser/Kakao automation; if captures or windows show that profile, stop and re-target automation Chrome before testing customer-facing sends.
- Add/keep a hard runtime guard for customer-facing Kakao sends: set `KAKAO_REQUIRE_AUTOMATION_CHROME_PROFILE=1` and have the worker refuse CUA sends unless the captured Chrome AX tree contains `🤖 자동화 크롬`. This prevents a fallback path from silently using the staff Chrome profile.
- If `🤖 자동화 크롬` opens to `카카오계정` / `계정 정보 입력` / `비밀번호 입력`, stop and ask the user to log in there. Do not type credentials, do not fall back to `💁🏻 직원용 크롬`, and do not claim the test send happened.
- When normal Chrome profile mode makes DevTools unavailable on `127.0.0.1:9223`, CUA fallback is acceptable only after the automation-profile guard passes. Use the bottom-left composer file button, macOS Open panel (`Cmd+Shift+G` to exact file path), then click Kakao `전송` for each attachment.
- Treat CUA/Open-panel attachment as **unverified until the chat body visibly shows the sent photo/file thumbnail(s)**. A worker result such as `file_selected_return_pressed_via_cua`, a dismissed/undismissed Open panel, or the prior text bubble is not enough. Re-capture the target conversation and confirm all of these before reporting success: `🤖 자동화 크롬` in the window title/tree, no `열기` file-picker window in front, the latest text bubble if one was sent, and visible `사진`/image thumbnail evidence in the same customer room.
- Be careful with overlapping Chrome profiles/windows during verification: Kakao can open the same customer room in `💁🏻 직원용 크롬` after a click or focus change. If a verification screenshot/tree says `💁🏻 직원용 크롬`, discard it for automation proof and re-open/re-capture the room from the `🤖 자동화 크롬` main list.
- If the macOS Open panel remains after attempting a file selection, assume the file was **not** attached. First close/cancel the panel cleanly, then retry with a more reliable path (DevTools/CDP file input if available; otherwise manual CUA with visible row selection and enabled Open button). Do not send extra text-only retries to the customer while debugging attachments.
