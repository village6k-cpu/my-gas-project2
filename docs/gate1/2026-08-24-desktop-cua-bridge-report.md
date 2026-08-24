# Gate 1 Desktop CUA bridge report

## Verdict

**PASS for the Gate 1 local bridge only.** One local command created an ephemeral Codex app-server
thread, dispatched the fixed read-only `node_repl` action, received four true CUA booleans, strictly
validated the result, and confirmed child cleanup.

This does not upgrade the whole Slack employee or HomeTax workflow to autonomous PASS. Slack intake,
request deduplication/ledger, stable employee identity, authentication handoff, and every HomeTax
read/mutation action remain later gates.

## Live evidence

- Artifact: `docs/gate1/2026-08-24-desktop-cua-bridge-evidence.json`
- Schema: `gate1-desktop-cua/v1`
- Run ID: `7cd30f0bcf02bba2`
- Result: `PASS`
- Cleanup: confirmed true

No page text, AX tree, screenshot, screenshot URL, app list, thread/turn id, MCP arguments, subprocess
output, or credentials are present in the artifact.

## Investigation and fix

The first design asked a model turn to generate the fixed CUA check. Safe live runs produced
all-false, all-true, then all-false results with the same boundary. A direct fixed
`mcpServer/tool/call` returned all true, proving that CUA itself was available and the model-owned
action was the wrong layer.

After moving the action out of the model, the first direct live call produced an exact all-false
infrastructure result and the immediate second call passed. The bridge now retries exactly once only
when all four values are false, the signature of this observed cold-start miss. A valid partial
capability result, malformed result, or command error never receives that retry.

The pinned 0.147.0 stdio response envelope is exactly `{id,result|error}` rather than echoing the
request's `jsonrpc` field. A final live run also exposed a startup race: `thread/start` can complete
before the per-thread `node_repl` MCP server is ready. The bridge now waits for a matching
`mcpServer/startupStatus/updated` ready event before dispatching the fixed action.

## Safety boundary

- Pinned Codex 0.147.0 absolute executable only.
- Ephemeral thread, read-only sandbox, no approval prompts.
- Fixed JavaScript contains `list_apps` and at most one `get_app_state`; no click, type, key, scroll,
  navigation, login, submission, or mutation method.
- Exact four-boolean result, 1 KiB result cap, 64 KiB event buffer cap, no raw subprocess retention.
- Each app-server response must match the single pending request ID and phase; duplicate or unsolicited
  responses fail closed. The MCP result envelope permits only the defined content/meta fields.
- Graceful stdin close first. Before TERM and again before KILL, executable, PID, and captured process
  start identity must still match. Reuse/mismatch receives no further signal.

## Verification

- `node --test tools/local-cua-clerk/gate0/*.test.mjs tools/local-cua-clerk/gate1/*.test.mjs`
- Result: 71 passed, 0 failed.
- Safe live command: `node tools/local-cua-clerk/gate1/desktop-cua-bridge.mjs`
- Result: strict `PASS`, all nine evidence booleans true.

## Next gate

Build a Slack-only intake shell around this module: one fixed employee identity, request ID and
deduplication, allowlisted action routing, short-lived Codex execution, and result posting. Keep
HomeTax/login outside until that shell can round-trip a synthetic non-credential request.
