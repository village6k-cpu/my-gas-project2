# Kakao shared browser lifetime

## Incident and cause

The 2026-09-07 22:41 Slack registration request took 992.6 seconds. The
session log proves CDP connection refusal during photo inspection, recovery
waiting, and repeated navigation. The watchdog restarted Chrome at 22:49
and 22:54. The old compacted tab audit retained timestamps but discarded
closed targets and outcomes, so the exact historical Chrome exit cannot be
attributed conclusively to one close call.

Reproduction of the executable cleanup functions identified these defects:

- The original sweep could close the last Kakao control page.
- The first fix checked the Kakao Gateway queue, but not Slack Hermes, which
  uses the same browser outside that queue.
- The target/list and idle checks could become obsolete while awaiting CDP
  or Gateway status; a failed PUT also retried GET using obsolete checks.
- Worker-owned popup cleanup had the same shared-client and stale-target gap.

## Persistent protection

- Keep the earlier main-list and Kakao in-flight work protection.
- Read the root Hermes native `gateway_state.json` before cleanup and again
  after awaited work. Require a valid live Gateway PID, running/draining
  lifecycle and exactly zero active agents. Missing/unreadable/invalid state
  defers optional cleanup; it does not block an agent or its tools.
- Re-read CDP targets before closing. Preserve the target if its URL changed
  or a separate Kakao main list no longer exists.
- Use a single GET close attempt. A later sweep must obtain fresh evidence;
  do not retry a failed close with an unchecked fallback request.
- Apply the same root-idle and target protection to worker-owned CDP cleanup.
- Retain bounded timestamps, closed target IDs, skip reason and errors in
  the cleanup audit. Do not retain customer titles or conversation URLs.

The Windows runtime contract sets `HERMES_HOME` to `%LOCALAPPDATA%/hermes`.
The shared reader uses that root, not the Kakao profile. Native Hermes writes
activity on turn boundaries rather than a periodic heartbeat, so an arbitrary
age limit would incorrectly classify a long idle Gateway as unhealthy.

This change does not modify model, prompts, skills, reasoning, search scope,
customer data, or reply permissions. It is not a browser ownership lock and
does not promise protection against an unrelated client explicitly closing
Chrome, OS crashes, or all future sources of latency.

## Regression verification

Tests exercise the actual cleanup functions with isolated CDP/status I/O,
and the shared reader with real temporary state files and a live test PID.
They cover active Slack work, new work during awaited status, changed/last
targets, malformed status, no fallback retry, normal idle cleanup, and audits.

```powershell
node --test tools/ai-browser-worker/worker.test.mjs tools/kakao-dom-bridge/server.test.mjs test/windows-kakao-live-recovery-action.test.mjs
```

Deploy only the browser-lifetime patch into the separately managed Windows
production tree; preserve other live worker patches. Back up and hash the
previous artifacts, verify all queues/applications and root Gateway idle,
then restart only the owned bridge. Verify file hashes, new bridge PID,
unchanged Chrome/root/Kakao Gateway PIDs, direct CDP authentication/watcher,
and natural cleanup cycles. Never replay a customer write for this test.
