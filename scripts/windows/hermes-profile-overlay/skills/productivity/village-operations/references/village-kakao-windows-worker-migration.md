# Village Kakao worker migration to Windows while Mac keeps SMS/BlueBubbles

Use this when the user wants to move only the Kakao response automation off the Mac, while keeping the Mac as the Hermes/SMS/BlueBubbles control plane.

## Recommended target architecture

Keep the Mac as the control/relay host:

- Hermes default gateway / Heyvilly main agent
- BlueBubbles + SMS/iMessage control path
- Slack main gateway/session continuity
- Optional watchdog that checks the Windows Kakao bridge over LAN and reports by SMS

Move only the Kakao runtime to Windows:

- Dedicated Chrome profile for Kakao Channel Manager
- DOM watcher extension/content script
- `tools/kakao-dom-bridge/server.mjs` on port 8787
- `tools/ai-browser-worker/worker.mjs`
- Hermes `kakaoworker` profile used as a CLI worker, not necessarily a gateway
- Kakao auto-reply / 확인요청 / Slack-card action pipeline

This is much simpler and safer than moving all Hermes state. Treat it as moving the Kakao worker, not the whole agent.

## Cutover sequence

1. Install Hermes, Node, Git, Chrome on Windows.
2. Export/import only the `kakaoworker` Hermes profile if possible; re-auth model/OAuth if needed.
3. Clone `my-gas-project2` on Windows.
4. Copy `tools/kakao-dom-bridge/.env`, then rewrite paths to Windows paths with forward slashes.
5. Start with safe gates off:
   - `AI_WORKER_LIVE=0`
   - `AI_WORKER_AUTO_SEND=0`
6. Use a dedicated Windows Chrome user-data dir/profile; do not copy the macOS Chrome profile/cookies.
7. Prefer CDP/DevTools control on Windows:
   - `KAKAO_REMOTE_DEBUGGING_PORT=9223`
   - `KAKAO_DEVTOOLS_URL=http://127.0.0.1:9223`
   - `KAKAO_WORKER_CONTROL_MODE=devtools_only`
8. Load the DOM watcher extension from the repo and log into Kakao Channel Manager in that dedicated Chrome profile.
9. Run the bridge and verify, in order:
   - `/health` ok
   - `heartbeats.ndjson` fresh
   - `events.ndjson` gets real Kakao preview changes
   - `jobs.ndjson` created after debounce
   - `worker-results.ndjson` created in dry-run
   - Slack card/follow-up gates present if needed
10. Stop only the Mac Kakao bridge/automation, not the Mac Hermes gateway or BlueBubbles.
11. Switch Windows to live:
   - `AI_WORKER_LIVE=1`
   - `AI_WORKER_AUTO_SEND=1`
12. Verify no duplicate Mac/Windows Kakao workers are running before trusting live auto-send.

## Windows-specific implementation notes

- `open-automation-chrome.sh` and `scripts/kakao-automation` are macOS-oriented (`open`, launchd, AppleScript/osascript, pgrep/lsof assumptions). For a durable Windows setup, add Windows-specific PowerShell runners instead of forcing those scripts unchanged.
- Keep Windows Chrome automation simple and isolated: one dedicated user-data dir, one Kakao profile, one remote-debugging port.
- `kakaoworker` on Windows can be CLI-only; do not start a second Hermes gateway unless explicitly needed. This avoids Slack bot-token/session conflicts with the Mac default gateway.
- BlueBubbles/SMS remains on Mac. If Windows must be controlled by SMS, have Mac Hermes call Windows `/health` over LAN or SSH/PowerShell remoting to run a restart script.
- Use forward slashes in config/env paths where possible: `C:/Users/Agent/my-gas-project2`.

## Safety pitfalls

- Never run Mac and Windows Kakao bridges live at the same time; duplicate customer replies are possible.
- Do not copy macOS Chrome profiles to Windows; login/session/cookie encryption is OS-bound and usually breaks.
- Do not migrate SMS/BlueBubbles for this partial move; keeping it on Mac is the point of the simplified plan.
- Do not claim recovery from bridge liveness alone. Verify fresh heartbeats/events/jobs/worker-results and, for live mode, actual `auto-replies.ndjson` or Kakao chat body evidence.
- Start dry-run first even if the user mainly wants speed; live auto-send is the final step, not the first test.
