> **[정책 우선 고지 2026-08-12]** 이 문서의 인프라 자가 재시작/복구 지시(맥 방언 원문)는 2026-08-11 사장님 정책으로 대체됨 — **치유는 워치독 소유, 업무 턴 중 자가수리 금지** (SKILL.md 'Infrastructure incident guard'가 우선). 원문은 참고용으로 보존.

# Village Kakao profile-safe room navigation

Use this when a task requires opening a Kakao customer room and reading/sending/attaching in the browser.

## Rule

Never rely on a generic `Google Chrome` capture for Kakao customer work. The user expects all Village Kakao/browser automation to target `🤖 자동화 크롬` (normal Chrome Profile 3), never `💁🏻 직원용 크롬`.

## Verification before any input

1. Run or use an equivalent profile-aware status check:
   - `python3 tools/kakao-dom-bridge/automation-login-recover.py --status-only --json`
2. Require all of:
   - `summary.profileName` includes `🤖 자동화 크롬`
   - `summary.chosen.pid` and `summary.chosen.windowId` are present
   - `chatOk: true` and `watcherVisible: true` when doing normal Kakao operations
3. Bind CUA calls to that exact `pid`/`window_id`.
4. Re-check the AX title/header after navigation; it should include the intended customer name/room title.

If the captured title/profile marker is staff Chrome or missing, stop and retarget before clicking or typing. Do not “quickly search” in the wrong profile.

## Navigation pattern for room evidence

- Use watcher/events data only to discover a likely room URL or customer hint.
- Prefer DevTools/page JavaScript navigation inside the verified automation window, e.g. setting `location.href` to the specific `https://business.kakao.com/_.../chats/...` URL, rather than address-bar typing.
- After navigation, wait for the title/header to change and verify `hintMatched`/room header before reading chat text.
- If the page remains on the previous customer after attempted navigation, discard that evidence and retry with a safer navigation path. Do not reuse the previous room’s text under the new customer name.

## Failure posture

If the exact room body cannot be verified:

- Report `본문 미확인` / `target conversation not verified`.
- Do not write `확인요청`, send Kakao messages, or claim the customer context was checked.
- If the user is already frustrated, do not narrate a long debugging story; acknowledge the profile/verification guard and give the next concrete action/result.

## Regression guard idea

Worker/window-picking tests should include both profiles:

- staff popup/list window title: `... (💁🏻 직원용 크롬)` → must be excluded
- automation popup/list window title: `... (🤖 자동화 크롬)` → must be preferred

Tests should also reject `opened_target_chat` unless the extracted live conversation evidence matches the intended customer hint.