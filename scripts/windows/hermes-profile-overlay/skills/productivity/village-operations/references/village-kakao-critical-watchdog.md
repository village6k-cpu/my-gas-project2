> **[정책 우선 고지 2026-08-12]** 이 문서의 인프라 자가 재시작/복구 지시(맥 방언 원문)는 2026-08-11 사장님 정책으로 대체됨 — **치유는 워치독 소유, 업무 턴 중 자가수리 금지** (SKILL.md 'Infrastructure incident guard'가 우선). 원문은 참고용으로 보존.

# Village Kakao DOM watcher critical watchdog

Session-derived operational detail for the Village Kakao Channel Manager automation.

## Dedicated Chrome profile

Use a persistent, isolated Chrome profile directory for this automation:

```text
/Users/village6k/.village-kakao-channel-manager-profile
```

Configure it through the bridge env file:

```bash
VILLAGE_KAKAO_CHROME_DIR=/Users/village6k/.village-kakao-channel-manager-profile
```

Do **not** use real Chrome Guest mode for Kakao automation. Guest mode is isolated, but it loses login/session/extension state when closed, which makes the watcher unreliable. The right pattern is a dedicated persistent profile that behaves like a separate browser identity but survives restarts.

## First-time setup in the dedicated profile

1. Start the automation launcher:

```bash
cd /Users/village6k/my-gas-project2
./scripts/kakao-automation start
```

2. In the opened Chrome profile, log in to Kakao Channel Manager and complete 2FA if prompted.
3. Install the DOM watcher extension in that same profile:
   - Open `chrome://extensions`
   - Enable Developer mode
   - Load unpacked:

```text
/Users/village6k/my-gas-project2/tools/kakao-dom-watcher-extension
```

4. Keep the Kakao Channel Manager chats page open:

```text
https://business.kakao.com/_xhPMls/chats
```

## Critical watchdog pattern

The critical watchdog script lives at:

```text
/Users/village6k/.hermes/scripts/village_kakao_dom_watchdog.py
```

The Hermes cron job is:

```text
job_id: 586500703edc
schedule: every 2m
deliver: origin,all
no_agent: true
```

The script should stay silent when healthy. On recoverable failures (bridge down, DevTools/profile/tab missing, worker stuck/timeouts, events-without-jobs, jobs-without-results), it first runs `cd /Users/village6k/my-gas-project2 && ./scripts/kakao-automation restart`, waits for the appropriate grace period, and rechecks. If recovery succeeds, it prints a short `자동복구 완료` notice for Hermes delivery; if recovery still fails, it prints the critical alert and also triggers local macOS critical alert/sound/voice.

## What the watchdog checks

Check more than `/health`; a green bridge can still hide a dead action pipeline.

- bridge health unreachable / ok=false
- worker stuck for more than 10 minutes
- failed worker runs
- expected dedicated Chrome profile not running
- old/wrong Village Kakao Chrome profile also running
- Chrome DevTools unreachable
- Kakao `/chats` tab missing
- Kakao login/2FA tab detected
- watcher extension heartbeat missing for more than 5 minutes after bridge startup
- recent Kakao live-looking events but no jobs
- jobs exist but no worker results

## SMS/iMessage escalation

The watchdog supports SMS/iMessage escalation when a target phone is configured. Prefer reading the number from:

```text
/Users/village6k/.village-kakao-automation/watchdog-sms-to.txt
```

with mode `600`, or from env var:

```bash
VILLAGE_KAKAO_ALERT_SMS_TO=010...
```

Normalize Korean mobile numbers before sending by converting `010...` to `+82...`.

If `imsg` is installed, prefer:

```bash
imsg send --to "+82..." --text "..." --service auto
```

If `imsg` is unavailable, fallback to macOS Messages AppleScript:

```applescript
tell application "Messages"
  send "..." to buddy "+82..."
end tell
```

If installing `imsg` via Homebrew is blocked by outdated Command Line Tools, the durable fix is to update Command Line Tools in System Settings or reinstall them with:

```bash
sudo rm -rf /Library/Developer/CommandLineTools
sudo xcode-select --install
```

Do not record “imsg does not work” as a permanent tool limitation; it is a setup-state problem.
