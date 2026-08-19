> **[정책 우선 고지 2026-08-12]** 이 문서의 인프라 자가 재시작/복구 지시(맥 방언 원문)는 2026-08-11 사장님 정책으로 대체됨 — **치유는 워치독 소유, 업무 턴 중 자가수리 금지** (SKILL.md 'Infrastructure incident guard'가 우선). 원문은 참고용으로 보존.

# Village Kakao DOM watcher critical alerts

Use this as session-specific operational detail under the RPA automation skill.

## Dedicated browser profile

- Automation should use the persistent Chrome profile named `수이`.
- Current profile dir: `/Users/village6k/.village-kakao-channel-manager-profile`.
- Config key in the Kakao bridge `.env`: `VILLAGE_KAKAO_CHROME_DIR=/Users/village6k/.village-kakao-channel-manager-profile`.
- Real Chrome Guest mode is not appropriate because it loses login/session state when closed.

## Critical watchdog

- Cron job: `586500703edc` (`Village Kakao DOM watcher CRITICAL watchdog`).
- Script: `~/.hermes/scripts/village_kakao_dom_watchdog.py`.
- Frequency: every 2 minutes.
- Healthy behavior: silent.
- Failure behavior: Hermes/gateway delivery, macOS critical alert, sound, voice, and SMS/iMessage via `imsg` when configured.

## SMS/iMessage hardening pattern

When the user reports that SMS did not arrive:

1. Do not trust `imsg send` output alone. Treat `sent` as only a local handoff signal until the user confirms receipt.
2. Confirm iMessage/Messages is logged in on the Mac.
3. If `brew install steipete/tap/imsg` fails because Command Line Tools are outdated, check `softwareupdate --list` and install the listed `Command Line Tools for Xcode ...` update.
4. Install/verify `imsg` (`brew install steipete/tap/imsg`, `imsg --version`).
5. If `imsg chats` reports `authorization denied (code: 23)`, grant Full Disk Access to the running terminal/parent app and Automation permission for Messages. Sending may still work, but DB verification will not.
6. Send a direct test with `imsg send --to <E164> --text <test> --service auto --region KR` and ask the user to confirm receipt.
7. Make watchdog SMS code use absolute-path fallbacks such as `/opt/homebrew/bin/imsg` because cron environments may have a reduced PATH.

## Alert conditions worth checking

- bridge health unreachable or `ok=false`
- wrong Chrome profile or no expected profile process
- Kakao `/chats` tab missing
- Kakao login/2FA tab visible
- watcher heartbeat missing for more than 5 minutes
- recent Kakao events but no jobs
- jobs but no worker results
- worker stuck for more than 10 minutes
