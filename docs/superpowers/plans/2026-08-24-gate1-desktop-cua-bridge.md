# Gate 1 — Codex app-server Desktop CUA bridge

## Outcome

Prove and preserve the smallest user-visible vertical slice after Gate 0: one local request creates
one short-lived Codex work thread, invokes one fixed Desktop CUA action read-only, returns a strict boolean result,
and cleans up its owned child process.

## Scope challenge

- Reuse the installed Codex `app-server` JSON-RPC surface and configured `node_repl` MCP server.
- Reuse Gate 0's pinned Codex executable; do not introduce another runtime selector.
- Keep fixed CUA code outside the model. A prompt is not a mechanical action boundary.
- Keep one fixed action (`desktop_readiness`) implicit in the CLI. A general request router would be
  premature before Slack intake and HomeTax action contracts exist.
- No SQLite ledger, Socket Mode, LaunchAgent, HomeTax, credential handling, login, issuance,
  modification, file upload, GAS, Sheets, or Slack send in Gate 1.

## Architecture

```text
local CLI request
  -> pinned codex app-server --stdio
  -> initialize / thread-start(ephemeral, read-only)
  -> wait for matching per-thread node_repl ready notification
  -> direct mcpServer/tool/call with fixed node_repl.js
  -> @oai/sky list_apps + one get_app_state when Chrome is running
  -> strict four-boolean result validation
  -> pending request ID and protocol phase must match exactly
  -> exact all-false infrastructure miss may repeat once; partial capability never repeats
  -> all-true validation
  -> stdin close, then identity-checked TERM/KILL only if needed
  -> one redacted Gate 1 record
```

The app-server transport is the adapter boundary. A future Slack receiver may invoke this module,
but it must not gain direct CUA, raw screen, credential, or arbitrary-prompt authority.

## Failure modes

- Executable drift: reject any production path other than the Gate 0 pin.
- Protocol/thread/action failure: `BLOCKED/command_failed` with no subprocess text.
- Missing, extra, oversized, or mismatched evidence: `BLOCKED/malformed_evidence`.
- A valid false capability: `BLOCKED/not_available`.
- Deadline: `BLOCKED/timeout` only after confirmed cleanup.
- Unconfirmed cleanup or PID/start-identity drift: `BLOCKED/cleanup_incomplete`; do not signal a
  mismatched or reused PID.

## Test plan

- Strict PASS serializer and unknown-field rejection.
- Full fake app-server handshake, ephemeral/read-only thread parameters, direct fixed MCP action,
  strict result, and graceful cleanup.
- False, partial, extra-field, and redaction cases.
- Early child error, duplicate/unsolicited response ID denial, and incomplete-stdio child cleanup.
- One all-false cold-start retry; no retry for a valid partial capability result.
- Matching per-thread `node_repl` readiness is required before fixed-action dispatch.
- Pinned production executable enforcement.
- Timeout TERM cleanup, identity mismatch denial, stable TERM/KILL escalation, and PID reuse denial
  before KILL.
- One live read-only run after unit tests; persist only the strict output record and a short report.

## Stop condition

Stop when the unit suite passes, one safe live run is strict `PASS`, cleanup is true, and an
independent review finds no material issue. Do not start Slack or HomeTax work in this gate.
