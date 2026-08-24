# Task 2 report — terminal and temporary LaunchAgent probe runners

## Implementation summary

Implemented the fixed, read-only Codex probe for both terminal and temporary user LaunchAgent
execution. Both paths import the same frozen payload and emit only the Task 1 `makeProbe()`
contract. The terminal runner uses an absolute Codex path, `exec --ephemeral --json`, bounded
timeout handling, and identity/path-checked process-group termination. JSONL parsing retains only
the two approved boolean capability fields and never serializes subprocess output or errors.

The LaunchAgent runner creates a private temporary directory and one-shot plist, bootstraps only
`gui/$UID`, waits with a deadline, boots out its exact generated label in `finally`, and removes
only its own directory. Tests inject spawn and launchctl implementations; no GUI or launchctl was
invoked.

## Files changed

- `tools/local-cua-clerk/gate0/codex-probe-runner.mjs`
- `tools/local-cua-clerk/gate0/codex-probe-runner.test.mjs`
- `tools/local-cua-clerk/gate0/launch-agent-probe.mjs`
- `tools/local-cua-clerk/gate0/launch-agent-probe.test.mjs`
- `tools/local-cua-clerk/gate0/README.md`

## Verification

Command: `node --test tools/local-cua-clerk/gate0/*.test.mjs && git diff --check`

Result after review fixes: 19 tests passed, 0 failed, 0 skipped; `git diff --check` passed.

Review fixes: pinned production Codex/runner paths with explicit test-only overrides, mandatory
captured/rechecked child executable and start identity, nonzero-exit and false-capability denial,
SIGTERM/SIGKILL bounded escalation, and unconditional exact-label bootout after bootstrap attempt.
Adversarial tests cover all of those cases plus partial bootstrap, success/timeout cleanup, and
repeated/idempotent cleanup behavior. The final targeted fix also proves zero-spawn on a hung
identity preflight, preserves a cleanup reserve after delayed identity capture, and waits for the
exact child handle to close after post-spawn identity failure. If that child does not close after
bounded TERM/KILL through its own handle, the evidence says `cleanup_incomplete`; no group signal
or cleanup success is claimed.

Review-fix commits: `c4e7d8c` and current identity/escalation fix commit.

## Concerns

- Live Codex, GUI, and launchctl execution was intentionally not performed; that belongs to Task 4.
- Process termination is fail-closed when the child PID or executable/start identity does not match;
  the live `ChildProcess` path records the pinned executable through Node's spawn metadata.
- The LaunchAgent plist invokes the runner CLI, which then invokes the pinned Codex binary; no
  persistent agent or broad cleanup path is used.
- Start identity is captured through an injectable reader and re-read immediately before both
  TERM and KILL; the default reader uses the OS `ps` start time, and missing identity fails closed.
- An absolute deadline begins before spawn; `/bin/ps` identity reads are bounded to remaining time,
  and identity-read timers are cleared on completion so a hung reader cannot keep the runner alive.
- A bounded current-process identity preflight prevents spawning when identity inspection is
  unavailable; observation and TERM/KILL cleanup share one absolute deadline and reserved cleanup
  window.
