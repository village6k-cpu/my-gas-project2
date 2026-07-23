<!-- WINDOWS_EXECUTION_ADAPTER -->
## Windows execution adapter

This canonical RPA skill remains scoped to the `kakaoworker` profile. It diagnoses and recovers the dedicated Kakao Chrome, extension heartbeat, loopback bridge, queue, and worker process tree on Windows.

- Runtime: `C:\Village\my-gas-project2-worktrees\ax2-hermes-final`
- Chrome user-data-dir: `C:\Users\ssper\AppData\Local\Village\chrome-kakao`
- CDP: `127.0.0.1:9223`
- DOM bridge: `127.0.0.1:8787`

The profile `terminal` runs Git Bash. Use the Windows status/recovery scripts
with `/c/Village/...`; invoke PowerShell only as
`powershell.exe -NoProfile -Command ...`. Do not use `launchctl`, AppleScript,
or macOS UI automation. Keep `AI_WORKER_LIVE=0` and
`AI_WORKER_AUTO_SEND=0` unless the owner separately authorizes background
automation.

This RPA health skill does not define the authorization policy for interactive Village business operations. If the current user explicitly asks for a reservation, schedule, payment, document, or tax action, defer to the root `village-operations` workflow and its exact action/readback gates. Do not load this profile-scoped skill into ordinary Slack business questions.
