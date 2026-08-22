# Gateway/service self-restart recovery pattern

Use this when the automation being diagnosed is the same service that is carrying the current chat, so a normal restart would kill the agent before it can verify or report.

## Pattern

1. Triage first while the gateway is still alive:
   - service manager status (`hermes gateway status`, Scheduled Task status: `schtasks.exe /Query /TN Hermes_Gateway /V /FO LIST`, likewise `Hermes_Gateway_Kakaoworker_Native`)
   - scheduler status if jobs depend on the gateway (`hermes cron status`)
   - recent gateway/agent logs for repeating errors
   - platform token/API reachability where safe (for Slack Socket Mode, `apps.connections.open` is a non-sending token probe)
2. If a restart is needed, create a detached recovery script before restarting. The script should:
   - sleep briefly so the current turn can finish tool dispatch
   - capture old PID
   - restart/kickstart the supervisor (ONLY via `powershell.exe -NoProfile -File C:\Village\my-gas-project2\scripts\windows\restart-hermes-gateway.ps1` — it stops, then re-ignites via the `Hermes_Gateway`/`Hermes_Gateway_Kakaoworker_Native` scheduled tasks for clean lineage; raw `hermes gateway restart` from an agent shell is FORBIDDEN — Redirection Guard inherits into the new gateway and breaks skills junctions with 448)
   - wait for the new process
   - verify service status, cron/scheduler status, and platform connectivity
   - inspect post-restart log tail for recurrence of the exact error class
   - send a concise recovery report through an out-of-band channel that does not depend on the restarted gateway when possible (for this setup, BlueBubbles REST stays on the Mac relay — on Windows report via a Slack agent channel instead, one status line per incident)
3. Run the recovery script detached as a one-shot Scheduled Task (`schtasks.exe /Create /TN <name> /TR <cmd> /SC ONCE /ST HH:MM /F && schtasks.exe /Run /TN <name>`) with completion notification if available.
4. Do not claim “fixed” until the script’s verification has completed or the out-of-band report has been sent.

## Verification checklist

- PID changed or supervisor reports a fresh healthy process.
- `hermes gateway status` says running and service definition matches the current install.
- `hermes cron status` confirms jobs will fire through the gateway.
- Platform-specific connectivity probe succeeds:
  - Slack Socket Mode: `apps.connections.open` returns `ok: true` and a `wss://...` URL.
  - BlueBubbles/iMessage: execution stays on the Mac relay; on Windows send a small status report via a Slack agent channel instead, only when the user explicitly asked for recovery/reporting.
- The repeating log signature that triggered recovery does not reappear after the restart window.

## Pitfalls

- A gateway can be “running” while one platform loop is wedged. Check platform logs, not just Scheduled Task (`schtasks.exe /Query`) status.
- If the current chat is inside the service being restarted, a synchronous restart can drop the final answer. Use a detached verifier/reporter.
- Do not record one-off missing credentials or transient provider outages as durable rules; record the probe/retry pattern.
- Keep the user-facing report short during an outage: cause, action, verified state, remaining risk.
