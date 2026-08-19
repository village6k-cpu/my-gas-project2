> **[정책 우선 고지 2026-08-12]** 이 문서의 인프라 자가 재시작/복구 지시(맥 방언 원문)는 2026-08-11 사장님 정책으로 대체됨 — **치유는 워치독 소유, 업무 턴 중 자가수리 금지** (SKILL.md 'Infrastructure incident guard'가 우선). 원문은 참고용으로 보존.

# Village Kakao customer document send: DOM file-input fallback

Use this when Kakao Channel Manager customer document sending stalls on macOS Open panels or DevTools is unavailable.

## Durable lesson

For customer requests for Village bankbook copy / business registration certificate, send the image/file messages first, then send the explanatory text. Kakao Manager often renders sent image messages as `저장하기` in DOM text rather than exposing filenames.

## Reliable fallback used in-session

1. Confirm the target window is the normal automation Chrome profile (`🤖 자동화 크롬`), never staff Chrome.
2. If DevTools is unavailable but AppleScript JavaScript is disabled, enable Chrome “Allow JavaScript from Apple Events” with cua-driver page action `enable_javascript_apple_events` after explicit user authorization.
3. Navigate directly to the known Kakao chat URL when available, or search/open the row first.
4. Use DOM JavaScript to set the Kakao file input instead of fighting macOS Open panel:
   - Locate `input[type="file"].uploadInput` or first `input[type="file"]`.
   - Construct a `File` from base64 bytes.
   - Assign with `DataTransfer`: `dt.items.add(file); input.files = dt.files;`.
   - Dispatch bubbling `input` and `change` events.
5. Repeat for each file, waiting for Kakao to upload after each change. Verify DOM tail for `저장하기` entries and/or visible image markers.
6. Only after files are posted, fill `textarea#chatWrite` or `textarea[placeholder*="메시지"]`, dispatch `input`/`change`, then click the enabled `전송` button.
7. Final verification should check the actual target conversation body for:
   - two new attachment indicators (`저장하기` can be the only text evidence), and
   - the explanatory text after the attachments.

## Pitfalls

- CUA/macOS Open panel can leave stale `열기` windows and can silently mis-click rows/buttons; treat `attached:true` from a helper as insufficient unless the conversation body shows attachment evidence.
- Kakao DOM may show `저장하기`, `1`, or image placeholders instead of the original local filename.
- If a routine macOS automation approval/accessibility prompt appears during Village automation and the user has already authorized handling it, resolve it and continue rather than stopping; do not type secrets into prompts.
